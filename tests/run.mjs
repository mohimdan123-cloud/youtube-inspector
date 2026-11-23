// Run with: node tests/run.mjs
import assert from 'node:assert/strict';
import * as P from '../js/pipeline.js';
import { analyzeVideoId, askQuestion, AppError, limitsFrom } from '../js/analyze.js';
import * as W from '../worker/core.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/* ------------------------------------------------------------------ */
/* pipeline                                                            */
/* ------------------------------------------------------------------ */

test('parseVideoId handles every common link shape', () => {
  const id = 'dQw4w9WgXcQ';
  for (const s of [
    id,
    `https://www.youtube.com/watch?v=${id}`,
    `youtube.com/watch?v=${id}&t=42s`,
    `https://youtu.be/${id}?si=abc`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/live/${id}?feature=share`,
    `https://music.youtube.com/watch?v=${id}&list=x`,
    `Check this out https://youtu.be/${id} wow`,
  ]) assert.equal(P.parseVideoId(s), id, s);
  for (const s of ['', 'hello', 'https://example.com/watch?v=dQw4w9WgXcQ', 'https://youtube.com/watch?v=short']) assert.equal(P.parseVideoId(s), null, s);
});

test('time helpers round-trip', () => {
  assert.equal(P.fmtTime(75), '1:15');
  assert.equal(P.fmtTime(4325), '1:12:05');
  assert.equal(P.fmtTime(75, true), '0:01:15');
  assert.equal(P.parseTime('1:12:05'), 4325);
  assert.equal(P.parseTime('12:05'), 725);
  assert.equal(P.parseTime('[0:07]'), 7);
  assert.equal(P.parseTime(90), 90);
  assert.equal(P.parseTime('abc'), null);
});

test('parseCaptions reads json3 and xml, and decodes entities', () => {
  const j = JSON.stringify({ events: [{ tStartMs: 1000, segs: [{ utf8: 'Hello' }, { utf8: ' world' }] }, { tStartMs: 5000 }, { tStartMs: 9000, segs: [{ utf8: 'it&#39;s' }] }] });
  assert.deepEqual(P.parseCaptions(j), [[1, 'Hello world'], [9, 'it&#39;s']]);
  const x = '<transcript><text start="2.5" dur="1">Tom &amp;amp; Jerry</text><text start="7" dur="2">&amp;#39;quoted&amp;#39;</text></transcript>';
  const got = P.parseCaptions(x);
  assert.equal(got[0][0], 3);
  assert.equal(got[0][1], 'Tom & Jerry');
  assert.equal(got[1][1], "'quoted'");
  assert.deepEqual(P.parseCaptions(''), []);
});

test('nonSpeechRatio spots music-only caption tracks', () => {
  assert.equal(P.nonSpeechRatio([[0, '[Music]'], [5, '♪♪'], [9, '(applause)']]), 1);
  assert.equal(P.nonSpeechRatio([[0, 'hello there'], [5, '[Music]']]), 0.5);
  assert.equal(P.nonSpeechRatio([]), 1);
});

test('chunkLines never exceeds the limit and keeps every line', () => {
  const lines = Array.from({ length: 400 }, (_, i) => ({ t: i * 20, text: 'word '.repeat(30).trim() }));
  const chunks = P.chunkLines(lines, 5000);
  assert.ok(chunks.length > 5);
  for (const c of chunks) assert.ok(c.text.length <= 5000, `chunk ${c.text.length}`);
  assert.equal(chunks.reduce((n, c) => n + c.lines, 0), 400);
  // one huge line gets split
  const big = P.chunkLines([{ t: 0, text: 'a '.repeat(10000) }], 3000);
  assert.ok(big.length >= 7);
  for (const c of big) assert.ok(c.text.length <= 3000);
});

test('parseManualTranscript: timed, untimed, and approximate', () => {
  const timed = '0:00\nHello and welcome\n0:20\nToday we talk about habits\n0:45\nFirst habit\n1:10\nSecond habit';
  const r = P.parseManualTranscript(timed, 100);
  assert.equal(r.hasTimes, true);
  assert.equal(r.approx, false);
  assert.equal(r.lines[0].t, 0);
  const inline = '[0:00] one two\n[0:30] three four\n[1:00] five six';
  assert.equal(P.parseManualTranscript(inline).lines.length, 3);
  const plain = 'This is a long paragraph. '.repeat(100);
  const u = P.parseManualTranscript(plain, 600);
  assert.equal(u.approx, true);
  assert.ok(u.lines[u.lines.length - 1].t < 600);
  const none = P.parseManualTranscript(plain, 0);
  assert.equal(none.hasTimes, false);
});

test('parseChapters needs a real chapter list', () => {
  const d = 'Intro\n0:00 Intro\n1:30 - The problem\n[4:05] Solution\n10:00 Outro\nthanks';
  const c = P.parseChapters(d, 700);
  assert.equal(c.length, 4);
  assert.equal(c[1].label, 'The problem');
  assert.deepEqual(P.parseChapters('see 12:30 for more', 700), []);
  assert.deepEqual(P.parseChapters('1:00 a\n2:00 b\n3:00 c', 700), []); // must start at 0:00
});

test('detectMusic uses title, channel and category', () => {
  assert.equal(P.detectMusic({ title: 'Artist - Song (Official Music Video)', author: 'X', durationSec: 200 }), true);
  assert.equal(P.detectMusic({ title: 'Song', author: 'Artist - Topic' }), true);
  assert.equal(P.detectMusic({ title: 'My day', author: 'Joe', category: 'Music', durationSec: 240 }), true);
  assert.equal(P.detectMusic({ title: 'Podcast #12', author: 'Joe', category: 'Music', durationSec: 9000 }), false);
  assert.equal(P.detectMusic({ title: 'How to bake bread', author: 'Cook' }), false);
});

test('parseJSONLoose copes with fences and trailing commas', () => {
  assert.deepEqual(P.parseJSONLoose('```json\n{"a":1,}\n```'), { a: 1 });
  assert.deepEqual(P.parseJSONLoose('Sure! {"a":[1,2,]} done'), { a: [1, 2] });
  assert.throws(() => P.parseJSONLoose('no json here'));
});

test('normalizeAnalysis cleans model output', () => {
  const ctx = { durationSec: 1000, hasTimes: true, chapters: [{ t: 0, label: 'Intro' }, { t: 300, label: 'Middle' }, { t: 600, label: 'End' }] };
  const a = P.normalizeAnalysis(
    {
      summary: 'One sentence.',
      overview: 'More.',
      clickbait: { match: 'LOW', note: 'n' },
      labels: [
        { id: 'misleading', likelihood: 120, why: 'x' },
        { id: 'possibly_misleading', likelihood: 50, why: 'y' },
        { id: 'made_up', likelihood: 50 },
        { id: 'no_red_flags' },
        { id: 'misleading' },
      ],
      timeline: [
        { t: '1:30', type: 'chapter', label: 'model chapter' },
        { t: '9:00', type: 'promise', label: 'delivered' },
        { t: '9:01', type: 'promise', label: 'dup' },
        { t: '99:00', type: 'key', label: 'beyond the end' },
        { t: '3:00', type: 'sponsor', label: 'ad', end: '4:00' },
        { t: 'bad', type: 'key', label: 'x' },
      ],
      topics: [{ t: '5:00', title: 'B' }, { t: '0:10', title: 'A', detail: 'd', pitch: true }, { title: '' }],
    },
    ctx
  );
  assert.equal(a.clickbait.match, 'low');
  assert.deepEqual(a.labels.map((l) => l.id), ['misleading']); // unknown, duplicate, no_red_flags and possibly_ dropped
  assert.equal(a.labels[0].likelihood, 100);
  assert.ok(!a.timeline.some((e) => e.label === 'model chapter'), 'creator chapters replace model chapters');
  assert.equal(a.timeline.filter((e) => e.type === 'promise').length, 1);
  assert.equal(a.timeline.find((e) => e.type === 'key').t, 1000); // clamped to the video length
  assert.equal(a.timeline.find((e) => e.type === 'sponsor').end, 240);
  assert.deepEqual(a.timeline.map((e) => e.t), [...a.timeline.map((e) => e.t)].sort((x, y) => x - y));
  assert.deepEqual(a.topics.map((t) => t.title), ['A', 'B']);
  assert.equal(a.topics[0].pitch, true);
});

test('applySignals adds evidence-backed labels', () => {
  const a = { labels: [{ id: 'clickbait', likelihood: 80, why: '' }] };
  P.applySignals(a, { paidPromo: true, affiliateLinks: 3 });
  assert.deepEqual(a.labels.map((l) => l.id), ['sponsored', 'affiliate', 'clickbait']);
  const b = { labels: [{ id: 'sponsored', likelihood: 70, why: '' }] };
  P.applySignals(b, { paidPromo: true, affiliateLinks: 0 });
  assert.equal(b.labels.length, 1);
});

test('descriptionSignals finds codes, affiliates, sponsors and courses', () => {
  const s = P.descriptionSignals('Use code SAVE20 for 20% off! https://amzn.to/abc https://geni.us/x Sponsored by Acme. Join my course today', true);
  assert.equal(s.discountCode, true);
  assert.equal(s.affiliateLinks, 2);
  assert.equal(s.sponsorMention, true);
  assert.equal(s.courseOrCoaching, true);
  assert.equal(s.paidPromo, true);
});

test('retrievePassages finds the relevant part of a long transcript', () => {
  const lines = [];
  for (let i = 0; i < 600; i++) lines.push({ t: i * 20, text: i === 431 ? 'the secret habit is cold showers every morning without exception' : 'filler talk about weather and traffic number ' + i });
  const out = P.retrievePassages(lines, 'What is the secret habit?', 6000);
  assert.ok(out.length <= 6500);
  assert.ok(out.includes('cold showers'));
  const small = P.retrievePassages(lines.slice(0, 10), 'anything', 6000);
  assert.ok(small.startsWith('[0:00]'));
});

/* ------------------------------------------------------------------ */
/* fake backend that enforces the same limits as the real worker       */
/* ------------------------------------------------------------------ */

const FINAL = {
  summary: 'A long chat about routines whose "secret" habit appears late, followed by a course pitch.',
  overview: 'The host talks about routines.',
  clickbait: { match: 'low', note: 'Promise delivered late.' },
  labels: [{ id: 'paid_service', likelihood: 90, why: 'Pitches a course.' }, { id: 'clickbait', likelihood: 80, why: 'Late payoff.' }],
  timeline: [{ t: '0:00', type: 'chapter', label: 'Start' }, { t: '12:00', type: 'promise', label: 'Habit named' }, { t: '30:00', type: 'sponsor', label: 'Course pitch', end: '35:00' }],
  topics: [{ t: '0:00', title: 'Routines', detail: 'd' }, { t: '12:00', title: 'The habit', detail: 'd' }, { t: '30:00', title: 'The course', detail: 'd', pitch: true }],
};
// Realistic size: a real part-note is roughly 1 KB once it has three topics and some claims.
const PART = () => ({
  gist: 'A realistic one-sentence gist of this part of the conversation, about thirty words long, so the size is similar to a real note.',
  topics: [1, 2, 3].map((n) => ({ t: `0:${10 * n}`, title: 'A topic title of normal length ' + n, detail: 'A detail sentence that is about as long as the real ones are, which is usually a hundred and fifty characters or so in total.' })),
  moments: [{ t: '0:20', type: 'key', label: 'Moment label' }, { t: '0:50', type: 'sponsor', label: 'Ad read', end: '1:10' }],
  signals: { sponsor: 'a course', claims: ['claims you can earn a lot', 'claims it takes ten minutes'], promise: 'no, not yet' },
});

function makeBackend({ limits = { gemini: { fast: 600000, smart: 600000 }, groq: { fast: 11000, smart: 22000 } }, video = true, captionRaw = null, meta = {}, captionStatus = 'ok', busyFirst = 0, geminiBusyAlways = false } = {}) {
  const calls = [];
  let busyLeft = busyFirst;
  const providers = Object.entries(limits).map(([id, l]) => ({ id, limits: l }));
  const api = {
    calls,
    async info() {
      return { ok: true, providers, video, tokenRequired: true };
    },
    async video(id) {
      return {
        id,
        meta: { id, title: 'The One Habit (SHOCKING)', author: 'Chan', durationSec: 3000, description: '', category: '', thumb: 'x', ...meta },
        captionStatus,
        raw: captionRaw,
        track: { lang: 'en', auto: true },
        reason: 'blocked',
      };
    },
    async llm(body) {
      const size = (body.system || '').length + body.user.length;
      calls.push({ size, tier: body.tier, video: !!body.video, body });
      if (busyLeft > 0) {
        busyLeft--;
        return { status: 429, data: { error: 'busy', retryAfter: 2 } };
      }
      let chain = Object.keys(limits);
      if (body.order) chain = body.order.filter((x) => limits[x]);
      if (body.video) chain = chain.filter((x) => x === 'gemini');
      if (geminiBusyAlways) chain = chain.filter((x) => x !== 'gemini');
      const ok = chain.filter((x) => size <= (body.video ? limits[x].smart : limits[x][body.tier]));
      if (!ok.length) return chain.length ? { status: 413, data: { error: 'too_large', maxChars: 1000 } } : { status: 429, data: { error: 'busy', retryAfter: 5 } };
      const u = body.user;
      let text;
      if (u.includes('Listen to the speech')) text = JSON.stringify({ speech: true, music_only: false, notes: [{ t: '0:30', text: 'The host talks about habits.' }, { t: '5:00', text: 'He names the habit.' }], gist: 'g', topics: [{ t: '0:10', title: 'T', detail: 'd' }], moments: [], signals: { sponsor: '', claims: [], promise: 'no' } });
      else if (u.includes('Merge these partial notes')) text = JSON.stringify(PART());
      else if (u.includes('TRANSCRIPT PART:')) text = JSON.stringify(PART());
      else if (u.includes('music video')) text = JSON.stringify({ subject: 'lost love', summary: 'A song about lost love.', artist: 'Band', track: 'Song', mood: 'slow rock', cues: ['feat. Guest'] });
      else if (u.includes('Question:')) text = 'He names it at [1:12:05] and sells a course from [2:21:00].';
      else text = JSON.stringify(FINAL);
      return { status: 200, data: { text, provider: ok[0], model: 'm', truncated: false } };
    },
  };
  return api;
}

const talkCaptions = (n, perLine = 120) =>
  JSON.stringify({ events: Array.from({ length: n }, (_, i) => ({ tStartMs: i * 5000, segs: [{ utf8: ('word' + i + ' ').repeat(Math.ceil(perLine / 9)).slice(0, perLine) }] })) });

const noSleep = async () => {};

test('orchestrator: short transcript is one call', async () => {
  const api = makeBackend({ captionRaw: talkCaptions(200) });
  const res = await analyzeVideoId({ id: 'aaaaaaaaaaa', api, settings: { lang: 'en' }, sleep: noSleep });
  assert.equal(res.status, 'done');
  assert.equal(res.record.kind, 'talk');
  assert.equal(res.record.source, 'captions');
  assert.equal(api.calls.length, 1);
  assert.equal(res.record.analysis.summary, FINAL.summary);
  assert.ok(res.record.analysis.timeline.some((e) => e.type === 'sponsor' && e.end === 2100));
  assert.ok(res.record.lines.length > 10);
});

test('orchestrator: Groq-only free limits split a 3-hour transcript, every request fits, and it combines', async () => {
  const api = makeBackend({ limits: { groq: { fast: 11000, smart: 22000 } }, captionRaw: talkCaptions(2200, 120), meta: { durationSec: 11000 } });
  const res = await analyzeVideoId({ id: 'bbbbbbbbbbb', api, settings: { lang: 'en' }, sleep: noSleep });
  assert.equal(res.status, 'done');
  const fast = api.calls.filter((c) => c.tier === 'fast');
  const smart = api.calls.filter((c) => c.tier === 'smart');
  assert.ok(fast.length >= 15, 'many chunk calls: ' + fast.length);
  assert.equal(smart.length, 1, 'one final call');
  for (const c of api.calls) assert.ok(c.size <= (c.tier === 'fast' ? 11000 : 22000), `request of ${c.size} chars exceeded the limit`);
  assert.ok(api.calls.some((c) => c.body.user.includes('Merge these partial notes')), 'hierarchical reduce was needed');
});

test('orchestrator: falls back to parts when the big model is busy', async () => {
  const api = makeBackend({ captionRaw: talkCaptions(1200, 120), geminiBusyAlways: true });
  const res = await analyzeVideoId({ id: 'ccccccccccc', api, settings: { lang: 'en' }, sleep: noSleep });
  assert.equal(res.status, 'done');
  assert.ok(api.calls.filter((c) => c.tier === 'fast').length > 3);
  for (const c of api.calls.slice(1)) assert.ok(c.size <= 22000);
});

test('orchestrator: waits out a rate limit and retries', async () => {
  const api = makeBackend({ captionRaw: talkCaptions(50), busyFirst: 2 });
  const waits = [];
  const notes = [];
  const res = await analyzeVideoId({ id: 'ddddddddddd', api, settings: {}, sleep: async (ms) => waits.push(ms), onProgress: (p) => p.note && notes.push(p.note) });
  assert.equal(res.status, 'done');
  assert.equal(waits.length, 2);
  assert.ok(waits[0] >= 2000);
  assert.ok(notes.length >= 1);
});

test('orchestrator: gives up politely when quota never returns', async () => {
  const api = makeBackend({ limits: { groq: { fast: 11000, smart: 22000 } }, captionRaw: talkCaptions(50), busyFirst: 999 });
  await assert.rejects(analyzeVideoId({ id: 'eeeeeeeeeee', api, settings: {}, sleep: noSleep }), (e) => e instanceof AppError && e.code === 'busy');
});

test('orchestrator: no captions + video mode uses 30-minute windows', async () => {
  const api = makeBackend({ captionStatus: 'blocked', captionRaw: null, meta: { durationSec: 4000 } });
  const res = await analyzeVideoId({ id: 'fffffffffff', api, settings: { lang: 'en' }, sleep: noSleep });
  assert.equal(res.status, 'done');
  assert.equal(res.record.source, 'video');
  const vids = api.calls.filter((c) => c.video);
  assert.equal(vids.length, 3);
  assert.deepEqual(vids.map((c) => c.body.video.startSec), [0, 1800, 3600]);
  assert.equal(vids[2].body.video.endSec, 4000);
  assert.ok(res.record.lines.some((l) => l.t >= 1800), 'later windows are shifted to absolute time');
  assert.ok(vids[0].body.video.url.includes('fffffffffff'));
});

test('orchestrator: a short video is watched whole (no offsets)', async () => {
  const api = makeBackend({ captionStatus: 'none', meta: { durationSec: 600 } });
  await analyzeVideoId({ id: 'ggggggggggg', api, settings: {}, sleep: noSleep });
  const v = api.calls.find((c) => c.video);
  assert.equal(v.body.video.startSec, undefined);
});

test('orchestrator: no captions and no Gemini asks for a transcript', async () => {
  const api = makeBackend({ limits: { groq: { fast: 11000, smart: 22000 } }, video: false, captionStatus: 'blocked' });
  const res = await analyzeVideoId({ id: 'hhhhhhhhhhh', api, settings: {}, sleep: noSleep });
  assert.equal(res.status, 'needs_transcript');
  assert.equal(res.reason, 'blocked');
  const none = await analyzeVideoId({ id: 'hhhhhhhhhhh', api: makeBackend({ video: false, captionStatus: 'none' }), settings: { useVideo: false }, sleep: noSleep });
  assert.equal(none.reason, 'none');
});

test('orchestrator: music videos become a song card', async () => {
  const api = makeBackend({ captionRaw: talkCaptions(30), meta: { title: 'Band - Song (Official Music Video)', durationSec: 200 } });
  const res = await analyzeVideoId({ id: 'iiiiiiiiiii', api, settings: { lang: 'en' }, sleep: noSleep });
  assert.equal(res.record.kind, 'music');
  assert.equal(res.record.music.summary, 'A song about lost love.');
  assert.ok(res.record.lines.some((l) => /Artist: Band/.test(l.text)));
});

test('orchestrator: caption tracks with no words become "no text content"', async () => {
  const raw = JSON.stringify({ events: Array.from({ length: 40 }, (_, i) => ({ tStartMs: i * 4000, segs: [{ utf8: '[Music]' }] })) });
  const api = makeBackend({ captionRaw: raw });
  const res = await analyzeVideoId({ id: 'jjjjjjjjjjj', api, settings: {}, sleep: noSleep });
  assert.equal(res.record.kind, 'notext');
  assert.equal(api.calls.length, 0, 'no AI call needed');
});

test('orchestrator: pasted transcript works and marks approximate times', async () => {
  const api = makeBackend({ captionStatus: 'blocked' });
  const text = 'Welcome to the show. '.repeat(120);
  const res = await analyzeVideoId({ id: 'kkkkkkkkkkk', api, settings: {}, manualText: text, sleep: noSleep });
  assert.equal(res.status, 'done');
  assert.equal(res.record.source, 'pasted');
  assert.equal(res.record.approx, true);
});

test('orchestrator: unavailable and live videos stop early', async () => {
  const api = makeBackend();
  api.video = async () => ({ id: 'x', meta: null, unavailable: 'Private video', captionStatus: 'blocked' });
  await assert.rejects(analyzeVideoId({ id: 'lllllllllll', api, settings: {}, sleep: noSleep }), (e) => e.code === 'unavailable');
  const live = makeBackend({ meta: { isLive: true } });
  await assert.rejects(analyzeVideoId({ id: 'lllllllllll', api: live, settings: {}, sleep: noSleep }), (e) => e.code === 'live');
});

test('orchestrator: bad JSON is retried once, then reported', async () => {
  const api = makeBackend({ captionRaw: talkCaptions(30) });
  let n = 0;
  const orig = api.llm.bind(api);
  api.llm = async (b) => (++n === 1 ? { status: 200, data: { text: 'sorry, here you go: not json', provider: 'gemini', model: 'm' } } : orig(b));
  const res = await analyzeVideoId({ id: 'mmmmmmmmmmm', api, settings: {}, sleep: noSleep });
  assert.equal(res.status, 'done');
  const bad = makeBackend({ captionRaw: talkCaptions(30) });
  bad.llm = async () => ({ status: 200, data: { text: 'nope', provider: 'gemini', model: 'm' } });
  await assert.rejects(analyzeVideoId({ id: 'mmmmmmmmmmm', api: bad, settings: {}, sleep: noSleep }), (e) => e.code === 'bad_json');
});

test('askQuestion keeps the prompt inside the smallest provider limit', async () => {
  const api = makeBackend({ limits: { groq: { fast: 11000, smart: 22000 } }, captionRaw: talkCaptions(2200), meta: { durationSec: 11000 } });
  const res = await analyzeVideoId({ id: 'nnnnnnnnnnn', api, settings: {}, sleep: noSleep });
  api.calls.length = 0;
  const info = await api.info();
  const r = await askQuestion({ record: res.record, question: 'What is word1500?', history: [{ q: 'a', a: 'b' }], settings: {}, api, info, sleep: noSleep });
  assert.ok(r.text.includes('[1:12:05]'));
  assert.ok(api.calls[0].size <= 22000, 'size ' + api.calls[0].size);
});

test('limitsFrom respects a forced provider', () => {
  const info = { providers: [{ id: 'gemini', limits: { fast: 600000, smart: 600000 } }, { id: 'groq', limits: { fast: 11000, smart: 22000 } }], video: true };
  assert.equal(limitsFrom(info, ['groq']).maxSmart, 22000);
  assert.equal(limitsFrom(info, ['groq']).video, false);
  assert.equal(limitsFrom(info, undefined).maxSmart, 600000);
});

/* ------------------------------------------------------------------ */
/* worker                                                              */
/* ------------------------------------------------------------------ */

const realFetch = globalThis.fetch;
const withFetch = async (fn, body) => {
  globalThis.fetch = fn;
  try {
    return await body();
  } finally {
    globalThis.fetch = realFetch;
  }
};
const jres = (obj, status = 200, headers = {}) => new Response(typeof obj === 'string' ? obj : JSON.stringify(obj), { status, headers });
const geminiOK = (text) => jres({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] });
const openaiOK = (text) => jres({ choices: [{ message: { content: text }, finish_reason: 'stop' }] });

test('worker: Gemini rate limit fails over to Groq', async () => {
  const seen = [];
  await withFetch(async (url) => {
    seen.push(String(url));
    if (String(url).includes('generativelanguage')) return jres({ error: { details: [{ retryDelay: '7s' }] } }, 429);
    return openaiOK('hello');
  }, async () => {
    const { status, payload } = await W.runLLM({ user: 'hi', tier: 'fast' }, { GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q' });
    assert.equal(status, 200);
    assert.equal(payload.provider, 'groq');
    assert.equal(payload.text, 'hello');
  });
  assert.ok(seen[0].includes('generativelanguage'));
});

test('worker: oversize requests skip small providers; busy gives a retry hint', async () => {
  await withFetch(async () => jres({ error: { details: [{ retryDelay: '12s' }] } }, 429), async () => {
    const { status, payload } = await W.runLLM({ user: 'x'.repeat(300000), tier: 'smart' }, { GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q' });
    assert.equal(status, 429);
    assert.equal(payload.retryAfter, 12);
    assert.deepEqual(payload.skipped, ['groq']);
  });
  const only = await W.runLLM({ user: 'x'.repeat(30000), tier: 'smart' }, { GROQ_API_KEY: 'q' });
  assert.equal(only.status, 413);
});

test('worker: unknown model is skipped and remembered', async () => {
  const urls = [];
  await withFetch(async (url) => {
    urls.push(String(url));
    if (String(url).includes('gemini-old')) return jres({ error: { message: 'models/gemini-old is not found' } }, 404);
    return geminiOK('ok');
  }, async () => {
    const env = { GEMINI_API_KEY: 'g', GEMINI_SMART_MODELS: 'gemini-old,gemini-new' };
    const a = await W.runLLM({ user: 'hi' }, env);
    assert.equal(a.payload.model, 'gemini-new');
    const before = urls.length;
    await W.runLLM({ user: 'hi' }, env);
    assert.equal(urls.length - before, 1, 'second call went straight to the good model');
  });
});

test('worker: video requests go to Gemini only, with fileData and offsets', async () => {
  let sent = null;
  await withFetch(async (url, init) => {
    sent = JSON.parse(init.body);
    return geminiOK('{"speech":true}');
  }, async () => {
    const { status, payload } = await W.runLLM({ user: 'watch', json: true, video: { url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', startSec: 1800, endSec: 3600 } }, { GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q' });
    assert.equal(status, 200);
    assert.equal(payload.provider, 'gemini');
  });
  const part = sent.contents[0].parts[0];
  assert.equal(part.fileData.fileUri, 'https://www.youtube.com/watch?v=aaaaaaaaaaa');
  assert.equal(part.videoMetadata.startOffset, '1800s');
  assert.equal(part.videoMetadata.endOffset, '3600s');
  assert.equal(sent.generationConfig.responseMimeType, 'application/json');
  const noKey = await W.runLLM({ user: 'x', video: { url: 'u' } }, { GROQ_API_KEY: 'q' });
  assert.equal(noKey.status, 400);
});

test('worker: helper functions', () => {
  assert.equal(W.parseRetryAfter(new Headers({ 'retry-after': '9' }), ''), 9);
  assert.equal(W.parseRetryAfter(new Headers(), 'Please try again in 7.6s.'), 8);
  assert.equal(W.parseRetryAfter(new Headers(), 'try again in 1m3s'), 63);
  assert.equal(W.parseRetryAfter(new Headers(), 'nothing'), null);
  assert.equal(W.isoDuration('PT1H2M3S'), 3723);
  assert.equal(W.isoDuration('PT45S'), 45);
  assert.equal(W.decodeEntities('a &amp; b &#39;c&#39; &#x41;'), "a & b 'c' A");
  const h1 = W.corsHeaders(new Request('https://x', { headers: { origin: 'https://me.github.io' } }), { ALLOWED_ORIGIN: 'https://me.github.io' });
  assert.equal(h1['access-control-allow-origin'], 'https://me.github.io');
  const h2 = W.corsHeaders(new Request('https://x', { headers: { origin: 'https://evil.com' } }), { ALLOWED_ORIGIN: 'https://me.github.io' });
  assert.equal(h2['access-control-allow-origin'], 'https://me.github.io');
});

test('worker: token protects the API but not /api/health', async () => {
  const env = { APP_TOKEN: 'secret', GEMINI_API_KEY: 'g' };
  const call = (path, headers = {}) => W.handleRequest(new Request('https://w.example' + path, { headers }), env);
  assert.equal((await call('/api/health')).status, 200);
  assert.equal((await call('/api/info')).status, 401);
  assert.equal((await call('/api/info', { authorization: 'Bearer wrong' })).status, 401);
  const ok = await call('/api/info', { authorization: 'Bearer secret' });
  assert.equal(ok.status, 200);
  const info = await ok.json();
  assert.equal(info.video, true);
  assert.equal(info.tokenRequired, true);
  assert.equal(JSON.stringify(info).includes('"g"'), false, 'keys are never returned');
  assert.equal((await W.handleRequest(new Request('https://w.example/api/video?id=bad', { headers: { authorization: 'Bearer secret' } }), env)).status, 400);
  assert.equal((await W.handleRequest(new Request('https://w.example/api/llm', { method: 'OPTIONS' }), env)).status, 204);
});

test('worker: getVideo returns metadata and captions (ANDROID client)', async () => {
  const caption = talkCaptions(20);
  await withFetch(async (url, init) => {
    const u = String(url);
    if (u.includes('/youtubei/v1/player')) {
      assert.match(init.headers['user-agent'], /android/i);
      return jres({
        playabilityStatus: { status: 'OK' },
        videoDetails: { title: 'T', author: 'A', lengthSeconds: '600', shortDescription: '0:00 Intro' },
        microformat: { playerMicroformatRenderer: { category: 'Education' } },
        captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: 'https://www.youtube.com/api/timedtext?v=aaaaaaaaaaa&lang=en', languageCode: 'en', kind: 'asr', name: { simpleText: 'English (auto-generated)' } }, { baseUrl: 'https://www.youtube.com/api/timedtext?v=aaaaaaaaaaa&lang=ar', languageCode: 'ar', name: { simpleText: 'Arabic' } }] } },
      });
    }
    if (u.includes('timedtext')) {
      assert.ok(u.includes('fmt=json3'));
      return jres(caption);
    }
    throw new Error('unexpected ' + u);
  }, async () => {
    const v = await W.getVideo('aaaaaaaaaaa', 'en');
    assert.equal(v.captionStatus, 'ok');
    assert.equal(v.meta.title, 'T');
    assert.equal(v.meta.durationSec, 600);
    assert.equal(v.meta.category, 'Education');
    assert.equal(v.track.lang, 'en');
    assert.equal(v.track.auto, true);
    assert.ok(P.parseCaptions(v.raw).length >= 20);
    const ar = await W.getVideo('aaaaaaaaaaa', 'ar');
    assert.equal(ar.track.lang, 'ar', 'manual Arabic track preferred');
  });
});

test('worker: getVideo reports blocked captions and falls back to the watch page', async () => {
  await withFetch(async (url) => {
    const u = String(url);
    if (u.includes('/youtubei/v1/player')) return jres({ playabilityStatus: { status: 'LOGIN_REQUIRED' } });
    if (u.includes('/watch?v=')) return new Response('<meta property="og:title" content="Fallback &amp; Title"><meta itemprop="duration" content="PT12M30S"><meta property="og:description" content="Hello">', { status: 200 });
    throw new Error('unexpected ' + u);
  }, async () => {
    const v = await W.getVideo('bbbbbbbbbbb', 'en');
    assert.equal(v.captionStatus, 'blocked');
    assert.equal(v.meta.title, 'Fallback & Title');
    assert.equal(v.meta.durationSec, 750);
  });
  await withFetch(async (url) => {
    const u = String(url);
    if (u.includes('/youtubei/v1/player')) return jres({ playabilityStatus: { status: 'OK' }, videoDetails: { title: 'T', lengthSeconds: '100' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: 'https://www.youtube.com/api/timedtext?v=x', languageCode: 'en' }] } } });
    return new Response('', { status: 200 }); // YouTube's silent empty answer
  }, async () => {
    const v = await W.getVideo('ccccccccccc', 'en');
    assert.equal(v.captionStatus, 'blocked');
    assert.equal(v.meta.title, 'T');
  });
  await assert.rejects(W.getVideo('nope', 'en'), (e) => e.status === 400);
});

/* ------------------------------------------------------------------ */

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log('  ok   ' + name);
  } catch (e) {
    failed++;
    console.log('  FAIL ' + name + '\n       ' + String((e && e.stack) || e).split('\n').slice(0, 6).join('\n       '));
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
