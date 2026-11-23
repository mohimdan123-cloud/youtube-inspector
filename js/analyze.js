/**
 * The orchestrator: decides how to analyse a video and talks to the backend through an
 * injected `api` object, so it can be tested without a network.
 *
 * api.info()                 -> { providers:[{id,limits:{fast,smart}}], video:boolean, ... }
 * api.video(id, lang)        -> backend /api/video JSON (throws AppError on failure)
 * api.llm(body)              -> { status, data }   (never throws for HTTP errors)
 */
import * as P from './pipeline.js';

export class AppError extends Error {
  constructor(code, userMessage, details) {
    super(userMessage);
    this.code = code;
    this.userMessage = userMessage;
    this.details = details;
  }
}

const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function limitsFrom(info, order) {
  let provs = (info && info.providers) || [];
  if (order && order.length) {
    const f = provs.filter((p) => order.includes(p.id));
    if (f.length) provs = f;
  }
  if (!provs.length) return { minFast: 11000, minSmart: 22000, maxFast: 11000, maxSmart: 22000, count: 1, video: false };
  const fast = provs.map((p) => p.limits.fast);
  const smart = provs.map((p) => p.limits.smart);
  return {
    minFast: Math.min(...fast),
    minSmart: Math.min(...smart),
    maxFast: Math.max(...fast),
    maxSmart: Math.max(...smart),
    count: provs.length,
    video: !!(info && info.video) && (!order || !order.length || order.includes('gemini')),
  };
}

/** One LLM "runner": retries, waits out rate limits, and remembers which models answered. */
export function makeRunner({ api, order, onProgress = () => {}, sleep = sleepDefault, signal }) {
  const used = new Map();

  async function call(payload, { maxWait = 150 } = {}) {
    let waited = 0;
    let netTries = 0;
    let srvTries = 0;
    for (;;) {
      if (signal && signal.aborted) throw new AppError('cancelled', 'Cancelled.');
      const body = order && order.length ? { ...payload, order } : payload;
      const { status, data } = await api.llm(body);
      const d = data || {};
      if (status === 200) {
        used.set(d.provider, d.model);
        return d;
      }
      if (status === 429) {
        const wait = clamp(Math.ceil(d.retryAfter || 15), 1, 60) + 1;
        if (waited + wait > maxWait) throw new AppError('busy', 'The free AI quota is used up for the moment. Try again in a few minutes.', d.attempts);
        onProgress({ note: `Free quota is busy, waiting ${wait}s...` });
        await sleep(wait * 1000);
        waited += wait;
        onProgress({ note: '' });
        continue;
      }
      if (status === 413) throw new AppError('too_large', 'That request was too big for the free models.', { maxChars: d.maxChars });
      if (status === 401) throw new AppError('auth', 'The access token is wrong. Check it in Settings.');
      if (status === 0) {
        if (++netTries <= 2) {
          await sleep(1500 * netTries);
          continue;
        }
        throw new AppError('network', "Can't reach your backend. Check the internet connection and the backend address in Settings.");
      }
      if (d.error === 'no_keys') throw new AppError('config', 'The backend has no AI keys yet. Add at least one key (see the README).');
      if (d.error === 'provider_unavailable') throw new AppError('config', d.detail || 'The selected provider is not set up on the backend.');
      if (status >= 500 || d.error === 'all_failed') {
        if (++srvTries <= 1) {
          await sleep(3000);
          continue;
        }
        throw new AppError('failed', 'All the free AI providers failed just now. Try again in a minute.', d.attempts || d.detail);
      }
      throw new AppError('bad_request', d.detail || 'The backend refused the request.', d);
    }
  }

  async function json(payload, opts) {
    let last = '';
    for (let i = 0; i < 2; i++) {
      const d = await call({ ...payload, json: true, temperature: i ? 0 : 0.2 }, opts);
      try {
        return { data: P.parseJSONLoose(d.text), reply: d };
      } catch {
        last = String(d.text || '').slice(0, 200);
      }
    }
    throw new AppError('bad_json', 'The AI answered in an unexpected format. Please try again.', last);
  }

  return { call, json, used };
}

/* ------------------------------------------------------------------ */
/* Building blocks                                                     */
/* ------------------------------------------------------------------ */

function makeCtx(meta, extra = {}) {
  const durationSec = meta.durationSec || 0;
  return {
    meta,
    durationSec,
    signals: P.descriptionSignals(meta.description, meta.paidPromo),
    chapters: P.parseChapters(meta.description, durationSec),
    hasTimes: true,
    ...extra,
  };
}

const fh = (ctx) => ctx.durationSec >= 3600;

async function combine(runner, ctx, partials, lang, limits, progress) {
  const forceHours = fh(ctx);
  const finalBudget = Math.max(5000, limits.minSmart - 7000);
  const reduceBudget = Math.max(3000, limits.minFast - 3500);
  let level = partials;
  let guard = 0;
  while (P.partialsToText(level, forceHours).length > finalBudget && level.length > 1 && guard++ < 6) {
    progress('Combining notes...');
    const groups = [];
    let cur = [];
    let size = 0;
    for (const p of level) {
      const s = P.partialsToText([p], forceHours).length + 1;
      if (cur.length >= 2 && size + s > reduceBudget) {
        groups.push(cur);
        cur = [];
        size = 0;
      }
      cur.push(p);
      size += s;
    }
    if (cur.length) groups.push(cur);
    if (groups.length >= level.length) break; // cannot shrink further
    const next = [];
    for (const g of groups) {
      if (g.length === 1) {
        next.push(g[0]);
        continue;
      }
      const prompt = P.promptReduce({ ctx, input: P.partialsToText(g, forceHours), lang });
      const { data } = await runner.json({ ...prompt, tier: 'fast', maxOutputTokens: 900 });
      next.push(P.normalizePartial(data, 0));
    }
    level = next;
  }
  progress('Writing the summary...');
  const prompt = P.promptFinal({ ctx, inputKind: 'notes', input: P.partialsToText(level, forceHours), lang });
  const { data } = await runner.json({ ...prompt, tier: 'smart', maxOutputTokens: 2600 });
  return data;
}

async function analyzeLines(runner, ctx, lines, lang, limits, progress) {
  const forceHours = fh(ctx);
  const text = P.linesToText(lines, forceHours);

  // 1) One call when the transcript fits.
  if (text.length + 7000 <= limits.maxSmart) {
    try {
      progress('Reading the whole transcript...');
      const prompt = P.promptFinal({ ctx, inputKind: 'transcript', input: text, lang });
      const { data } = await runner.json({ ...prompt, tier: 'smart', maxOutputTokens: 2600 }, { maxWait: limits.count > 1 ? 15 : 150 });
      return data;
    } catch (e) {
      if (!(e instanceof AppError) || !['too_large', 'busy'].includes(e.code)) throw e;
      progress('Splitting the transcript into parts...');
    }
  }

  // 2) Split into parts, note each part, then combine.
  const chunkChars = clamp(limits.minFast - 2500, 4000, 60000);
  const chunks = P.chunkLines(lines, chunkChars, forceHours);
  const partials = new Array(chunks.length).fill(null);
  let failed = 0;
  const workers = chunkChars >= 20000 ? 2 : 1;
  let next = 0;
  let done = 0;
  const run = async () => {
    while (next < chunks.length) {
      const i = next++;
      const c = chunks[i];
      const prompt = P.promptChunk({ ctx, text: c.text, index: i, total: chunks.length, from: c.from, to: c.to, lang });
      try {
        const { data } = await runner.json({ ...prompt, tier: 'fast', maxOutputTokens: 900 });
        partials[i] = P.normalizePartial(data, 0);
      } catch (e) {
        if (e instanceof AppError && e.code === 'bad_json') failed++;
        else throw e;
      }
      done++;
      progress(`Summarising part ${done} of ${chunks.length}...`, 0.15 + 0.7 * (done / chunks.length));
    }
  };
  await Promise.all(Array.from({ length: workers }, run));
  const good = partials.filter(Boolean);
  if (!good.length || failed > chunks.length * 0.25) {
    throw new AppError('bad_json', 'Too many parts came back unreadable. Please try again.');
  }
  return combine(runner, ctx, good, lang, limits, progress);
}

async function analyzeByWatching(runner, ctx, lang, limits, progress) {
  const dur = ctx.durationSec;
  const WIN = 1800;
  const n = dur > 0 ? Math.max(1, Math.ceil(dur / WIN)) : 1;
  const url = `https://www.youtube.com/watch?v=${ctx.meta.id}`;
  const partials = [];
  const lines = [];
  let speech = false;
  let musicOnly = false;
  for (let i = 0; i < n; i++) {
    const start = n === 1 ? null : i * WIN;
    const end = n === 1 ? null : Math.min(dur, (i + 1) * WIN);
    progress(n === 1 ? 'Gemini is watching the video...' : `Gemini is watching part ${i + 1} of ${n}...`, 0.1 + 0.75 * (i / n));
    const prompt = P.promptVideoWindow({ ctx, index: i, total: n, windowStart: start, windowEnd: end, lang });
    const video = { url };
    if (start != null) {
      video.startSec = start;
      video.endSec = end;
    }
    const { data } = await runner.json({ ...prompt, video, tier: 'smart', maxOutputTokens: 2200 });
    const offset = start || 0;
    if (data.speech !== false) speech = true;
    if (data.music_only === true && i === 0) musicOnly = true;
    for (const nt of Array.isArray(data.notes) ? data.notes : []) {
      const t = P.parseTime(nt && nt.t);
      const text = typeof (nt && nt.text) === 'string' ? nt.text.trim() : '';
      if (t != null && text) lines.push({ t: t + offset, text });
    }
    partials.push(P.normalizePartial(data, offset));
  }
  if (!speech && !lines.length) return { silent: true, musicOnly };
  return { partials, lines, musicOnly };
}

function finishTalk(raw, ctx, signals) {
  const a = P.normalizeAnalysis(raw, ctx);
  if (!a.summary) throw new AppError('bad_json', 'The AI did not return a summary. Please try again.');
  return P.applySignals(a, signals);
}

function buildRecord({ id, lang, meta, kind, source, runner, extra }) {
  return {
    id,
    lang,
    kind,
    source,
    meta: { title: meta.title || '', author: meta.author || '', durationSec: meta.durationSec || 0, thumb: meta.thumb || `https://i.ytimg.com/vi/${id}/hqdefault.jpg` },
    providers: [...runner.used.entries()].map(([p, m]) => `${p}/${m}`),
    createdAt: Date.now(),
    ...extra,
  };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Analyse one video.
 * opts: { id, api, settings:{lang,order,useVideo}, onProgress, sleep, signal, manualText }
 * Returns { status:'done', record } or { status:'needs_transcript', reason:'blocked'|'none', meta }.
 * Throws AppError for everything else.
 */
export async function analyzeVideoId(opts) {
  const { id, api, settings = {}, manualText = null, sleep, signal } = opts;
  const lang = settings.lang || 'auto';
  const onProgress = opts.onProgress || (() => {});
  const progress = (message, pct) => onProgress({ message, pct });
  const runner = makeRunner({ api, order: settings.order, onProgress: (p) => onProgress(p), sleep, signal });

  progress('Looking up the video...', 0.03);
  const info = await api.info();
  const limits = limitsFrom(info, settings.order);

  const v = await api.video(id, lang === 'ar' ? 'ar' : 'en');
  if (v.unavailable && !v.meta) throw new AppError('unavailable', v.unavailable);
  const meta = v.meta || { id, title: '', author: '', durationSec: 0, description: '', thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` };
  meta.id = meta.id || id;
  if (meta.isLive) throw new AppError('live', 'This is a live stream. Summaries work once it has ended.');
  const ctx = makeCtx(meta);
  const music = P.detectMusic(meta);

  const musicResult = async (captionSample, source) => {
    progress('Identifying the song...', 0.5);
    const prompt = P.promptMusic({ ctx, captionSample, lang });
    const { data } = await runner.json({ ...prompt, tier: 'fast', maxOutputTokens: 700 });
    const m = P.normalizeMusic(data);
    const lines = [
      { t: null, text: `Title: ${meta.title}` },
      { t: null, text: `Channel: ${meta.author}` },
      ...(m.artist ? [{ t: null, text: `Artist: ${m.artist}` }] : []),
      ...(m.mood ? [{ t: null, text: `Style: ${m.mood}` }] : []),
      ...(m.subject ? [{ t: null, text: `Theme: ${m.subject}` }] : []),
      ...m.cues.map((c) => ({ t: null, text: c })),
    ];
    return { status: 'done', record: buildRecord({ id, lang, meta, kind: 'music', source, runner, extra: { music: m, lines } }) };
  };

  // Transcript supplied by the user.
  if (manualText) {
    const parsed = P.parseManualTranscript(manualText, ctx.durationSec);
    if (!parsed.lines.length) throw new AppError('empty', 'That text had nothing to read.');
    ctx.hasTimes = parsed.hasTimes;
    if (music) return musicResult(manualText.slice(0, 1500), 'pasted');
    const raw = await analyzeLines(runner, ctx, parsed.lines, lang, limits, progress);
    const analysis = finishTalk(raw, ctx, ctx.signals);
    return { status: 'done', record: buildRecord({ id, lang, meta, kind: 'talk', source: 'pasted', runner, extra: { analysis, lines: parsed.lines, approx: parsed.approx, hasTimes: parsed.hasTimes } }) };
  }

  // Captions from YouTube.
  let segs = [];
  if (v.captionStatus === 'ok' && v.raw) segs = P.parseCaptions(v.raw);

  if (segs.length) {
    const words = segs.reduce((n, [, t]) => n + t.split(/\s+/).length, 0);
    const ratio = P.nonSpeechRatio(segs);
    if (music) return musicResult(segs.slice(0, 40).map((s) => s[1]).join(' ').slice(0, 1500), 'captions');
    if (ratio >= 0.85 || words < 25) {
      return { status: 'done', record: buildRecord({ id, lang, meta, kind: 'notext', source: 'captions', runner, extra: { notext: { reason: 'nospeech' }, lines: [] } }) };
    }
    const lines = P.mergeSegments(segs, 20);
    progress('Captions found.', 0.1);
    const raw = await analyzeLines(runner, ctx, lines, lang, limits, progress);
    const analysis = finishTalk(raw, ctx, ctx.signals);
    return {
      status: 'done',
      record: buildRecord({ id, lang, meta, kind: 'talk', source: 'captions', runner, extra: { analysis, lines, hasTimes: true, captionLang: v.track && v.track.lang, autoCaptions: !!(v.track && v.track.auto) } }),
    };
  }

  // No usable captions.
  if (music) return musicResult('', 'metadata');

  if (limits.video && settings.useVideo !== false) {
    if (ctx.durationSec > 6 * 3600) throw new AppError('too_long', 'This video is over 6 hours, which is too long for the free video mode. Paste a transcript instead.');
    try {
      const watched = await analyzeByWatching(runner, ctx, lang, limits, progress);
      if (watched.silent) {
        return { status: 'done', record: buildRecord({ id, lang, meta, kind: 'notext', source: 'video', runner, extra: { notext: { reason: 'nospeech' }, lines: [] } }) };
      }
      if (watched.musicOnly && !watched.lines.length) return musicResult('', 'video');
      const lines = watched.lines.length ? watched.lines : watched.partials.flatMap((p) => p.topics.map((t) => ({ t: t.t, text: `${t.title}. ${t.detail}` })));
      const raw = await combine(runner, ctx, watched.partials, lang, limits, progress);
      const analysis = finishTalk(raw, ctx, ctx.signals);
      return { status: 'done', record: buildRecord({ id, lang, meta, kind: 'talk', source: 'video', runner, extra: { analysis, lines, hasTimes: true } }) };
    } catch (e) {
      if (!(e instanceof AppError) || !['failed', 'too_large', 'busy'].includes(e.code)) throw e;
      // fall through to asking for a transcript
      return { status: 'needs_transcript', reason: 'video_failed', meta, detail: e.userMessage };
    }
  }

  return { status: 'needs_transcript', reason: v.captionStatus === 'none' ? 'none' : 'blocked', meta, detail: v.reason || '' };
}

/** Answer a question about an analysed video. */
export async function askQuestion({ record, question, history = [], settings = {}, api, info, onProgress, sleep, signal }) {
  const limits = limitsFrom(info, settings.order);
  const lang = settings.lang || 'auto';
  const runner = makeRunner({ api, order: settings.order, onProgress, sleep, signal });
  const forceHours = (record.meta.durationSec || 0) >= 3600;
  const budget = clamp(limits.minSmart - 6000, 6000, 40000);
  const material = P.retrievePassages(record.lines || [], question, budget, forceHours);
  const analysis = record.kind === 'music' ? { summary: record.music.summary, topics: [] } : record.analysis || { summary: '', topics: [] };
  const ctx = { meta: record.meta, durationSec: record.meta.durationSec || 0 };
  const prompt = P.promptAsk({ ctx, analysis, material: material || '(no transcript available)', history, question, lang });
  const d = await runner.call({ ...prompt, tier: 'smart', maxOutputTokens: 700, temperature: 0.2 });
  return { text: String(d.text || '').trim(), provider: d.provider, model: d.model };
}
