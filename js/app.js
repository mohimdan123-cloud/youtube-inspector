/** Tube Inspector: UI controller. */
import { $, h, clear, icon, toast, put } from './dom.js';
import * as P from './pipeline.js';
import { analyzeVideoId, askQuestion, AppError } from './analyze.js';
import { createApi, normalizeBackend } from './api.js';
import * as S from './storage.js';

const state = { settings: S.loadSettings(), current: null, chat: [], view: 'home', run: 0, askBusy: false };
const api = createApi(() => state.settings);
const VIEWS = ['home', 'progress', 'transcript', 'result', 'ask', 'settings'];

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

const ytUrl = (id, t) => `https://www.youtube.com/watch?v=${id}` + (t ? `&t=${Math.floor(t)}s` : '');
const fmtDur = (s) => (s ? P.fmtTime(s, s >= 3600) : '');
const TYPES = { talk: ['Talk', 'teal'], music: ['Music', 'blue'], notext: ['No text content', 'grey'] };
const friendly = (e) => (e instanceof AppError ? e.userMessage : 'Something went wrong. Please try again.');

function typeChip(kind, small = false) {
  const [text, tone] = TYPES[kind] || TYPES.talk;
  return h('span', { class: `chip ${small ? 'sm ' : ''}${tone}` }, text);
}
function labelChip(id, small = false) {
  const l = P.LABELS[id];
  return h('span', { class: `chip ${small ? 'sm ' : ''}${l.tone}` }, l.text);
}
function ytLink(id, t, kids, cls) {
  return h('a', { href: ytUrl(id, t), target: '_blank', rel: 'noopener', class: cls }, kids);
}
function backBtn(onClick) {
  return h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Back', onClick }, icon('back', 22));
}
const spacer = () => h('span', { style: { width: '44px', flex: 'none' } });

function analysisSettings() {
  const s = state.settings;
  return { lang: s.lang, order: s.provider === 'auto' ? undefined : [s.provider], useVideo: s.useVideo };
}
function applyTheme() {
  document.documentElement.dataset.theme = state.settings.theme === 'system' ? 'system' : 'dark';
}
function persist() {
  S.saveSettings(state.settings);
}

/* ------------------------------------------------------------------ */
/* navigation                                                          */
/* ------------------------------------------------------------------ */

function show(name) {
  for (const v of VIEWS) $('#v-' + v).hidden = v !== name;
  state.view = name;
  window.scrollTo(0, 0);
  if (name === 'home') renderHome();
}
function go(name, replace = false) {
  if (replace) history.replaceState({ v: name }, '');
  else history.pushState({ v: name }, '');
  show(name);
}
window.addEventListener('popstate', (e) => {
  let v = (e.state && e.state.v) || 'home';
  if (v === 'progress' || v === 'transcript') v = 'home';
  if ((v === 'result' || v === 'ask') && !state.current) v = 'home';
  if (v === 'home') state.run++; // cancels a running analysis
  show(v);
});

/* ------------------------------------------------------------------ */
/* home                                                                */
/* ------------------------------------------------------------------ */

function renderHome() {
  const s = state.settings;
  $('#setup-card').hidden = !!normalizeBackend(s.backend);
  const names = { gemini: 'Gemini', cloudflare: 'Cloudflare AI', groq: 'Groq', openrouter: 'OpenRouter' };
  const text = s.provider === 'auto' ? 'Model: Auto (Gemini first, then Groq)' : `Model: ${names[s.provider]} only`;
  clear($('#model-line')).append(h('span', { class: 'dot-live' }), h('span', {}, text));
  renderRecent();
}

async function renderRecent() {
  const items = await S.listRecent();
  $('#recent-wrap').hidden = !items.length;
  const list = clear($('#recent'));
  for (const it of items) {
    list.append(
      h(
        'div',
        { class: 'recent-item' },
        h(
          'button',
          {
            type: 'button',
            class: 'recent-open',
            onClick: async () => {
              const rec = await S.getRecord(it.id, it.lang);
              if (rec) openRecord(rec);
            },
          },
          h('img', { class: 'thumb-sm', src: it.thumb, alt: '', loading: 'lazy' }),
          h(
            'div',
            { class: 'recent-text' },
            h('div', { class: 'recent-title ellipsis', dir: 'auto' }, it.title || it.id),
            h('div', { class: 'recent-meta' }, typeChip(it.kind, true), fmtDur(it.durationSec))
          )
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'recent-del',
            'aria-label': 'Remove from history',
            onClick: async () => {
              await S.deleteRecord(it.key);
              renderRecent();
            },
          },
          icon('x', 18)
        )
      )
    );
  }
}

async function start(input) {
  const id = P.parseVideoId(input);
  if (!id) {
    toast('That does not look like a YouTube link.');
    return;
  }
  if (!normalizeBackend(state.settings.backend)) await autodetectLocalBackend();
  if (!normalizeBackend(state.settings.backend)) {
    toast('Add your backend address first.');
    openSettings();
    return;
  }
  const cached = await S.getRecord(id, state.settings.lang);
  if (cached) {
    openRecord(cached);
    return;
  }
  runAnalysis(id);
}

/* ------------------------------------------------------------------ */
/* running an analysis                                                 */
/* ------------------------------------------------------------------ */

function renderProgress(id) {
  const root = clear($('#v-progress'));
  put(root, 
    h('header', { class: 'topbar' }, backBtn(() => history.back()), h('span', { class: 'topbar-title' }, 'Working on it'), spacer()),
    h(
      'div',
      { class: 'progress-box' },
      h('img', { class: 'thumb-lg', src: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, alt: '' }),
      h('div', { class: 'progress-msg', id: 'pg-msg', 'aria-live': 'polite' }, 'Starting...'),
      h('div', { class: 'bar indet', id: 'pg-bar' }, h('i', { style: { width: '0%' } })),
      h('div', { class: 'progress-note', id: 'pg-note' }),
      h('p', { class: 'muted small' }, 'Long videos take a little longer. Keep this screen open.')
    )
  );
}

function updateProgress(p) {
  if (!p) return;
  if (p.message) $('#pg-msg') && ($('#pg-msg').textContent = p.message);
  if (typeof p.pct === 'number' && $('#pg-bar')) {
    $('#pg-bar').classList.remove('indet');
    $('#pg-bar').firstChild.style.width = Math.round(p.pct * 100) + '%';
  }
  if (typeof p.note === 'string' && $('#pg-note')) $('#pg-note').textContent = p.note;
}

async function runAnalysis(id, { manualText = null } = {}) {
  const token = ++state.run;
  renderProgress(id);
  if (state.view !== 'progress') go('progress', state.view === 'transcript');
  try {
    const res = await analyzeVideoId({
      id,
      api,
      settings: analysisSettings(),
      manualText,
      onProgress: (p) => token === state.run && updateProgress(p),
    });
    if (token !== state.run) return;
    if (res.status === 'done') {
      await S.saveRecord(res.record);
      openRecord(res.record, true);
      return;
    }
    renderTranscriptNeeded(id, res.meta, res.reason, res.detail);
    go('transcript', true);
  } catch (e) {
    if (token !== state.run) return;
    if (e instanceof AppError && e.code === 'cancelled') return;
    renderFailure(e, id, manualText);
  }
}

function renderFailure(e, id, manualText) {
  const root = clear($('#v-progress'));
  const known = e instanceof AppError;
  const details = known ? e.details : String((e && e.message) || e);
  const fixSettings = known && ['setup', 'auth', 'network', 'config'].includes(e.code);
  put(root, 
    h('header', { class: 'topbar' }, backBtn(() => history.back()), h('span', { class: 'topbar-title' }, 'Could not finish'), spacer()),
    h(
      'div',
      { class: 'err-box' },
      h('img', { class: 'thumb-lg', src: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, alt: '' }),
      h('p', { class: 'progress-msg' }, friendly(e)),
      h('button', { type: 'button', class: 'btn btn-primary btn-lg', onClick: () => runAnalysis(id, { manualText }) }, icon('refresh', 18), 'Try again'),
      fixSettings && h('button', { type: 'button', class: 'btn', onClick: openSettings }, 'Open settings'),
      !manualText && h('button', { type: 'button', class: 'btn', onClick: () => { renderTranscriptNeeded(id, null, 'manual'); go('transcript', true); } }, 'Paste a transcript instead'),
      details ? h('details', {}, h('summary', {}, 'Technical details'), h('pre', {}, typeof details === 'string' ? details : JSON.stringify(details, null, 2).slice(0, 1800))) : null
    )
  );
}

function renderTranscriptNeeded(id, meta, reason, detail) {
  const root = clear($('#v-transcript'));
  const texts = {
    blocked: ['YouTube would not share the captions', 'YouTube often refuses caption requests that come from cloud servers. You can paste the transcript yourself.'],
    none: ['No captions on this video', 'If someone speaks in it, paste a transcript below, or turn on video mode in Settings so Gemini can listen to it.'],
    video_failed: ['Gemini could not watch this video', detail || 'The free video quota may be used up, or the video is restricted.'],
    manual: ['Paste a transcript', 'Use this when the automatic route did not work.'],
  };
  const [head, body] = texts[reason] || texts.manual;
  const ta = h('textarea', { class: 'textarea', id: 'ta-transcript', placeholder: 'Paste the transcript here', 'aria-label': 'Transcript text' });
  put(root, 
    h('header', { class: 'topbar' }, backBtn(() => history.back()), h('span', { class: 'topbar-title' }, 'Transcript'), spacer()),
    h('img', { class: 'thumb-lg', src: (meta && meta.thumb) || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, alt: '' }),
    meta && meta.title ? h('div', { class: 'title', dir: 'auto' }, meta.title) : null,
    h('div', { class: 'stack tight' }, h('h2', { class: 'h2' }, head), h('p', { class: 'muted' }, body)),
    h(
      'ol',
      { class: 'muted small', style: { margin: '0', paddingInlineStart: '20px', display: 'flex', flexDirection: 'column', gap: '4px' } },
      h('li', {}, 'Open the video in YouTube or Safari.'),
      h('li', {}, 'Tap the description, then "Show transcript".'),
      h('li', {}, 'Select the text, copy it, and paste it below.')
    ),
    ta,
    h(
      'button',
      {
        type: 'button',
        class: 'btn btn-primary btn-lg',
        onClick: () => {
          if (ta.value.trim().length < 80) {
            toast('Paste the transcript first.');
            return;
          }
          runAnalysis(id, { manualText: ta.value });
        },
      },
      'Summarize transcript'
    )
  );
}

/* ------------------------------------------------------------------ */
/* result                                                              */
/* ------------------------------------------------------------------ */

function openRecord(rec, replace = false) {
  state.current = rec;
  state.chat = Array.isArray(rec.chat) ? rec.chat : [];
  renderResult();
  go('result', replace);
}

function summaryText(rec) {
  if (rec.kind === 'music') return rec.music.summary;
  if (rec.kind === 'talk') return rec.analysis.summary;
  return 'This video has no spoken or written text to analyze.';
}

async function shareCurrent() {
  const rec = state.current;
  const text = summaryText(rec);
  if (navigator.share) {
    try {
      await navigator.share({ title: rec.meta.title, text, url: ytUrl(rec.id) });
    } catch {
      /* cancelled */
    }
    return;
  }
  try {
    await navigator.clipboard.writeText(`${rec.meta.title}\n${text}\n${ytUrl(rec.id)}`);
    toast('Summary copied');
  } catch {
    toast('Could not copy');
  }
}

function sourceNote(rec) {
  const base = {
    captions: rec.autoCaptions ? 'From auto-generated captions' : 'From the captions',
    video: 'Watched by Gemini',
    pasted: 'From the transcript you pasted',
    metadata: 'From the title and description only',
  }[rec.source];
  return [base, rec.approx ? 'times are estimated' : null].filter(Boolean).join(' · ');
}

function renderResult() {
  const rec = state.current;
  const root = clear($('#v-result'));
  const hero = ytLink(
    rec.id,
    0,
    [
      h('img', { src: rec.meta.thumb, alt: '' }),
      h('span', { class: 'play-badge' }, icon('play', 24)),
      rec.meta.durationSec ? h('span', { class: 'dur-badge' }, fmtDur(rec.meta.durationSec)) : null,
    ],
    'hero-media'
  );
  hero.setAttribute('aria-label', 'Open the video on YouTube');
  put(root, 
    h(
      'header',
      { class: 'topbar' },
      backBtn(() => history.back()),
      h('span', { class: 'topbar-title' }, 'Summary'),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Share summary', onClick: shareCurrent }, icon('share', 20))
    ),
    h(
      'div',
      { class: 'stack' },
      hero,
      h('h1', { class: 'title', dir: 'auto' }, rec.meta.title || 'Untitled video'),
      h('div', { class: 'byline' }, typeChip(rec.kind), rec.meta.author ? h('span', { class: 'muted', dir: 'auto' }, rec.meta.author) : null),
      h('div', { class: 'source-note' }, sourceNote(rec))
    )
  );

  if (rec.kind === 'talk') {
    const a = rec.analysis;
    put(root, labelsCard(a), summaryBlock(a), clickbaitCard(a), timelineCard(rec), topicsCard(rec));
  } else if (rec.kind === 'music') {
    put(root, musicCard(rec));
  } else {
    put(root, noTextCard(rec));
  }

  put(root, 
    h(
      'div',
      { class: 'stack tight' },
      h('button', { type: 'button', class: 'link-btn', onClick: () => runAnalysis(rec.id) }, icon('refresh', 16), ' Analyze again'),
      rec.providers && rec.providers.length ? h('p', { class: 'muted small' }, 'Written by ' + rec.providers.join(', ')) : null
    )
  );
  if (rec.kind !== 'notext') put(root, askBar(rec));
}

function labelsCard(a) {
  if (!a.labels.length) return null;
  const card = h('div', { class: 'card stack' }, h('span', { class: 'field-label' }, 'Labels'));
  a.labels.forEach((l, i) => {
    if (i) put(card, h('div', { class: 'card-sep' }));
    const sure = l.likelihood != null && l.likelihood < 85;
    put(card, 
      h(
        'div',
        { class: 'label-row' },
        h('div', { class: 'label-head' }, labelChip(l.id), sure ? h('span', { class: 'muted small' }, `About ${l.likelihood}% likely`) : null),
        l.why ? h('div', { class: 'label-why', dir: 'auto' }, l.why) : null
      )
    );
  });
  put(card, h('p', { class: 'muted small' }, 'These are AI estimates from the transcript and video description, not verified facts.'));
  return card;
}

function summaryBlock(a) {
  const more = a.overview && a.overview !== a.summary ? h('p', { class: 'overview', dir: 'auto', hidden: true }, a.overview) : null;
  const btn = more
    ? h(
        'button',
        {
          type: 'button',
          class: 'link-btn',
          'aria-expanded': 'false',
          onClick: () => {
            more.hidden = !more.hidden;
            btn.textContent = more.hidden ? 'More detail' : 'Less detail';
            btn.setAttribute('aria-expanded', String(!more.hidden));
          },
        },
        'More detail'
      )
    : null;
  return h('div', { class: 'stack tight' }, h('span', { class: 'eyebrow' }, 'In one sentence'), h('p', { class: 'summary-text', dir: 'auto' }, a.summary), more, btn);
}

function clickbaitCard(a) {
  if (!a.clickbait) return null;
  const c = a.clickbait;
  const width = { high: 90, medium: 55, low: 22 }[c.match];
  const color = { high: 'var(--green)', medium: 'var(--amber)', low: 'var(--coral)' }[c.match];
  return h(
    'div',
    { class: 'card stack' },
    h('div', { class: 'row-between' }, h('b', { style: { fontWeight: 500, fontSize: '14px' } }, 'Title vs. content'), h('b', { style: { fontSize: '14px', color } }, P.MATCH_TEXT[c.match])),
    h('div', { class: 'meter', role: 'img', 'aria-label': `Title match: ${P.MATCH_TEXT[c.match]}` }, h('i', { style: { width: width + '%', background: color } })),
    c.note ? h('p', { class: 'label-why', dir: 'auto' }, c.note) : null
  );
}

const TL_NAMES = { chapter: 'Chapter', key: 'Key moment', promise: "Title's promise delivered", sponsor: 'Sponsor or pitch' };

function timelineCard(rec) {
  const ev = rec.analysis.timeline;
  if (!rec.hasTimes || !ev.length) return null;
  const dur = rec.meta.durationSec || Math.max(...ev.map((e) => e.end || e.t), 1);
  const forceHours = dur >= 3600;
  const tf = (t) => P.fmtTime(t, forceHours);
  const pct = (t) => Math.max(0, Math.min(100, (t / dur) * 100));
  let sel = ev.findIndex((e) => e.type === 'promise');

  const track = h('div', { class: 'tl-track' }, h('div', { class: 'tl-line' }));
  for (const e of ev) {
    if (e.type === 'sponsor' && e.end) track.append(h('div', { class: 'tl-seg', style: { left: pct(e.t) + '%', width: Math.max(0.8, pct(e.end) - pct(e.t)) + '%' } }));
  }
  const dots = ev.map((e, i) =>
    h('button', { type: 'button', class: `tl-dot ${e.type}`, style: { left: pct(e.t) + '%' }, 'aria-label': `${TL_NAMES[e.type]} at ${tf(e.t)}: ${e.label}`, onClick: () => select(i) }, h('i'))
  );
  dots.forEach((d) => track.append(d));

  const detail = h('div', { class: 'tl-detail', 'aria-live': 'polite' });
  function renderDetail() {
    clear(detail);
    if (sel < 0) {
      put(detail, h('span', { class: 'muted small' }, 'Tap a dot to see what happens there.'));
    } else {
      const e = ev[sel];
      put(detail, 
        h('div', { class: 'tl-detail-head' }, h('b', {}, tf(e.t)), h('span', { class: 'muted' }, TL_NAMES[e.type] + (e.end ? ` until ${tf(e.end)}` : ''))),
        e.label ? h('div', { dir: 'auto', style: { fontSize: '15px' } }, e.label) : null,
        ytLink(rec.id, e.t, [icon('ext', 16), `Open at ${tf(e.t)}`], 'btn btn-outline')
      );
    }
    put(detail, 
      h(
        'div',
        { class: 'tl-step' },
        h('button', { type: 'button', class: 'btn', disabled: sel <= 0 ? true : null, onClick: () => select(sel - 1) }, 'Previous'),
        h('button', { type: 'button', class: 'btn', disabled: sel >= ev.length - 1 ? true : null, onClick: () => select(sel + 1) }, 'Next')
      )
    );
  }
  function select(i) {
    sel = Math.max(0, Math.min(ev.length - 1, i));
    dots.forEach((d, j) => d.classList.toggle('sel', j === sel));
    renderDetail();
  }
  dots.forEach((d, j) => d.classList.toggle('sel', j === sel));
  renderDetail();

  const present = new Set(ev.map((e) => e.type));
  const legend = h('div', { class: 'legend' });
  if (present.has('chapter')) legend.append(h('span', { class: 'c' }, h('i'), 'Chapter'));
  if (present.has('key')) legend.append(h('span', { class: 'k' }, h('i'), 'Key moment'));
  if (present.has('promise')) legend.append(h('span', { class: 'p' }, h('i'), 'Promise delivered'));
  if (present.has('sponsor')) legend.append(h('span', { class: 's' }, h('i'), 'Sponsor or pitch'));

  return h(
    'div',
    { class: 'stack' },
    h('div', { class: 'row-between' }, h('h2', { class: 'h2' }, 'Timeline'), h('span', { class: 'muted small' }, 'Tap a dot')),
    h('div', { class: 'card stack' }, track, h('div', { class: 'tl-ends' }, h('span', {}, '0:00'), h('span', {}, tf(dur))), legend, detail)
  );
}

function topicsCard(rec) {
  const a = rec.analysis;
  if (!a.topics.length) return null;
  const forceHours = (rec.meta.durationSec || 0) >= 3600;
  const wrap = h('div', { class: 'topics' });
  a.topics.forEach((t) => {
    const out = h('div', { class: 'explain', hidden: true, dir: 'auto' });
    const more = h('button', { type: 'button', class: 'btn', onClick: () => explain(t, out, more, rec, forceHours) }, icon('chat', 16), 'Explain more');
    const panel = h(
      'div',
      { class: 'topic-panel', hidden: true },
      t.detail ? h('div', { dir: 'auto' }, t.detail) : null,
      h('div', { class: 'topic-actions' }, t.t != null ? ytLink(rec.id, t.t, [icon('ext', 16), 'Open at ' + P.fmtTime(t.t, forceHours)], 'btn btn-outline') : null, more),
      out
    );
    const btn = h(
      'button',
      {
        type: 'button',
        class: 'topic-btn',
        'aria-expanded': 'false',
        onClick: () => {
          panel.hidden = !panel.hidden;
          row.classList.toggle('open', !panel.hidden);
          btn.setAttribute('aria-expanded', String(!panel.hidden));
        },
      },
      h('span', { class: 'topic-time' }, t.t != null ? P.fmtTime(t.t, forceHours) : ''),
      h('span', { class: 'topic-title', dir: 'auto' }, t.title),
      t.pitch ? h('span', { class: 'chip sm amber' }, 'Pitch') : null,
      icon('down', 20)
    );
    const row = h('div', { class: 'topic' }, btn, panel);
    wrap.append(row);
  });
  return h('div', { class: 'stack' }, h('h2', { class: 'h2' }, 'Topics'), wrap);
}

async function explain(t, out, btn, rec, forceHours) {
  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = 'Thinking...';
  clear(out);
  out.hidden = false;
  try {
    const q = `Explain in more detail what is said about "${t.title}"` + (t.t != null ? ` around [${P.fmtTime(t.t, forceHours)}]` : '') + '.';
    const r = await askAI(rec, q, []);
    out.append(renderAnswer(r.text, rec.id));
  } catch (e) {
    out.append(h('span', { class: 'muted' }, friendly(e)));
  }
  clear(btn).append(icon('chat', 16), 'Explain again');
  btn.disabled = false;
}

function musicCard(rec) {
  const m = rec.music;
  const rows = [];
  if (m.artist) rows.push(h('dt', {}, 'Artist'), h('dd', { dir: 'auto' }, m.artist));
  if (m.track) rows.push(h('dt', {}, 'Track'), h('dd', { dir: 'auto' }, m.track));
  if (m.mood) rows.push(h('dt', {}, 'Style'), h('dd', { dir: 'auto' }, m.mood));
  return h(
    'div',
    { class: 'card big-card' },
    h('span', { class: 'eyebrow' }, 'Song'),
    h('p', { class: 'summary-text', dir: 'auto' }, m.summary || 'A song.'),
    rows.length ? h('dl', { class: 'kv', style: { margin: '0' } }, rows) : null,
    m.cues.length ? h('ul', { class: 'overview', style: { margin: '0', paddingInlineStart: '20px' }, dir: 'auto' }, m.cues.map((c) => h('li', {}, c))) : null,
    h('p', { class: 'muted small' }, 'Themes are described in our own words. Lyrics are never quoted.')
  );
}

function noTextCard(rec) {
  const why = rec.source === 'video' ? 'Gemini watched it and found no speech.' : 'Its captions contain no words.';
  return h(
    'div',
    { class: 'card big-card' },
    h('div', { class: 'notext-icon' }, icon('mute', 26)),
    h('h2', { class: 'h2' }, 'No text content'),
    h('p', { class: 'overview' }, 'This video has no spoken or written text to analyze. ' + why),
    h('button', { type: 'button', class: 'btn', onClick: () => { renderTranscriptNeeded(rec.id, rec.meta, 'manual'); go('transcript'); } }, 'Paste a transcript anyway')
  );
}

function suggestionsFor(rec) {
  if (rec.kind === 'music') return ['What is the song about?', 'Who is involved?'];
  const list = ['What is the main takeaway?', 'Does it deliver what the title promises?'];
  if (rec.analysis && (rec.analysis.timeline.some((e) => e.type === 'sponsor') || rec.analysis.topics.some((t) => t.pitch))) list.push('What is being sold?');
  else list.push('Is anything being sold?');
  return list;
}

function askBar(rec) {
  return h(
    'div',
    { class: 'askbar' },
    h('button', { type: 'button', class: 'ask-fake', onClick: () => openAsk() }, h('span', {}, 'Ask about this video'), h('span', { class: 'send-btn', 'aria-hidden': 'true' }, icon('up', 20)))
  );
}

/* ------------------------------------------------------------------ */
/* ask                                                                 */
/* ------------------------------------------------------------------ */

async function askAI(rec, question, history) {
  const info = await api.info();
  return askQuestion({ record: rec, question, history, settings: analysisSettings(), api, info, onProgress: () => {} });
}

function renderAnswer(text, id) {
  const body = h('div', { dir: 'auto', style: { whiteSpace: 'pre-wrap' } }, text);
  const out = h('div', { class: 'msg-a' }, body);
  const times = [];
  const re = /\[((?:\d{1,2}:)?\d{1,3}:\d{2})\]/g;
  let m;
  while ((m = re.exec(text))) {
    const t = P.parseTime(m[1]);
    if (t != null && !times.includes(t)) times.push(t);
  }
  if (times.length) out.append(h('div', { class: 'ts-row' }, times.slice(0, 6).map((t) => ytLink(id, t, P.fmtTime(t, t >= 3600), 'ts-chip'))));
  return out;
}

function renderAsk() {
  const rec = state.current;
  const root = clear($('#v-ask'));
  const input = h('input', { class: 'ask-input', type: 'text', id: 'ask-input', placeholder: 'Ask about this video', 'aria-label': 'Your question', autocomplete: 'off', enterkeyhint: 'send' });
  const send = h('button', { type: 'submit', class: 'send-btn', 'aria-label': 'Send question' }, icon('up', 22));
  put(root, 
    h(
      'div',
      { class: 'ask-head' },
      backBtn(() => history.back()),
      h('div', { class: 'ask-head-text' }, h('b', { class: 'ellipsis', dir: 'auto' }, rec.meta.title || 'This video'), h('div', { class: 'row' }, typeChip(rec.kind, true)))
    ),
    h('div', { class: 'messages', id: 'messages', 'aria-live': 'polite' }),
    h(
      'form',
      {
        class: 'ask-form',
        onSubmit: (e) => {
          e.preventDefault();
          const q = input.value;
          input.value = '';
          sendQuestion(q);
        },
      },
      input,
      send
    )
  );
  renderMessages();
}

function renderMessages() {
  const box = $('#messages');
  if (!box) return;
  const rec = state.current;
  clear(box);
  if (!state.chat.length) {
    put(box, 
      h('p', { class: 'empty-hint' }, 'Ask anything about this video. Answers come from the transcript, with timestamps you can tap.'),
      h('div', { class: 'stack tight' }, suggestionsFor(rec).map((q) => h('button', { type: 'button', class: 'pill-btn', onClick: () => sendQuestion(q) }, q)))
    );
    return;
  }
  for (const m of state.chat) {
    put(box, h('div', { class: 'msg-q', dir: 'auto' }, m.q));
    if (m.pending) put(box, h('div', { class: 'msg-a pending' }, 'Thinking...'));
    else if (m.error) put(box, h('div', { class: 'msg-a pending' }, m.a));
    else put(box, renderAnswer(m.a, rec.id));
  }
  box.scrollTop = box.scrollHeight;
}

function openAsk(initial) {
  renderAsk();
  go('ask');
  if (initial) sendQuestion(initial);
  else $('#ask-input') && $('#ask-input').focus();
}

async function sendQuestion(q) {
  q = String(q || '').trim();
  if (!q || state.askBusy) return;
  const rec = state.current;
  const history = state.chat.filter((m) => !m.pending && !m.error && m.a).map((m) => ({ q: m.q, a: m.a }));
  const msg = { q, a: null, pending: true };
  state.chat.push(msg);
  state.askBusy = true;
  renderMessages();
  try {
    const r = await askAI(rec, q, history);
    msg.a = r.text || 'No answer came back.';
  } catch (e) {
    msg.a = friendly(e);
    msg.error = true;
  }
  msg.pending = false;
  state.askBusy = false;
  if (state.current === rec) renderMessages();
  S.saveChat(rec.id, rec.lang, state.chat.filter((m) => !m.error));
}

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

function openSettings() {
  renderSettings();
  go('settings');
}

function renderSettings() {
  const s = state.settings;
  const root = clear($('#v-settings'));
  const backend = h('input', { class: 'input', id: 's-backend', type: 'url', inputmode: 'url', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', placeholder: 'https://tube-inspector-backend.yourname.workers.dev', value: s.backend });
  const token = h('input', { class: 'input', id: 's-token', type: 'password', autocomplete: 'off', autocapitalize: 'none', placeholder: 'The APP_TOKEN you set on the backend', value: s.token });
  const lang = select('s-lang', s.lang, [['auto', 'Same language as the video'], ['en', 'English'], ['ar', 'العربية (Arabic)']]);
  const provider = select('s-provider', s.provider, [['auto', 'Auto (Gemini, Cloudflare AI, Groq, OpenRouter)'], ['gemini', 'Gemini only'], ['cloudflare', 'Cloudflare AI only'], ['groq', 'Groq only'], ['openrouter', 'OpenRouter only']]);
  const theme = select('s-theme', s.theme, [['dark', 'Dark'], ['system', 'Follow the phone setting']]);
  const video = h('input', { type: 'checkbox', id: 's-video', role: 'switch' });
  video.checked = s.useVideo !== false;
  const out = h('p', { class: 'test-out', 'aria-live': 'polite' });

  const commit = () => {
    state.settings = {
      ...state.settings,
      backend: normalizeBackend(backend.value),
      token: token.value.trim(),
      lang: lang.value,
      provider: provider.value,
      theme: theme.value,
      useVideo: video.checked,
    };
    backend.value = state.settings.backend;
    persist();
    applyTheme();
  };
  [backend, token, lang, provider, theme, video].forEach((el) => el.addEventListener('change', commit));

  const test = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-outline btn-block',
      onClick: async () => {
        commit();
        out.className = 'test-out';
        out.textContent = 'Testing...';
        try {
          const info = await api.info(true);
          const names = info.providers.map((p) => p.id);
          out.className = 'test-out good';
          out.textContent =
            `Connected. AI providers ready: ${names.length ? names.join(', ') : 'none yet'}.` +
            (info.video ? ' Video mode is available.' : '') +
            (info.tokenRequired || /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(state.settings.backend)
              ? ''
              : ' Warning: the backend has no access token, so anyone with its address could use your keys.');
        } catch (e) {
          out.className = 'test-out bad';
          out.textContent = friendly(e);
        }
      },
    },
    'Test connection'
  );

  put(root, 
    h('header', { class: 'topbar' }, backBtn(() => history.back()), h('span', { class: 'topbar-title' }, 'Settings'), spacer()),
    h('div', { class: 'field' }, h('label', { class: 'field-label', for: 's-backend' }, 'Backend address'), backend, h('span', { class: 'hint' }, 'The address of your Cloudflare Worker.')),
    h('div', { class: 'field' }, h('label', { class: 'field-label', for: 's-token' }, 'Access token'), token, h('span', { class: 'hint' }, 'Stored only on this phone.')),
    test,
    out,
    h('div', { class: 'card-sep' }),
    h('div', { class: 'field' }, h('label', { class: 'field-label', for: 's-lang' }, 'Summary language'), lang),
    h('div', { class: 'field' }, h('label', { class: 'field-label', for: 's-provider' }, 'AI provider'), provider),
    h(
      'div',
      { class: 'switch-row' },
      h('label', { class: 't', for: 's-video' }, h('span', {}, 'Let Gemini watch videos without captions'), h('span', { class: 'hint' }, 'Uses your free Gemini video quota (about 8 hours of video per day).')),
      h('span', { class: 'switch' }, video, h('i'))
    ),
    h('div', { class: 'field' }, h('label', { class: 'field-label', for: 's-theme' }, 'Appearance'), theme),
    h('div', { class: 'card-sep' }),
    h(
      'button',
      {
        type: 'button',
        class: 'btn btn-danger btn-block',
        onClick: async () => {
          if (!confirm('Delete all saved summaries from this phone?')) return;
          await S.clearAll();
          state.current = null;
          toast('Saved summaries deleted');
        },
      },
      'Delete saved summaries'
    ),
    h('p', { class: 'muted small' }, 'Tube Inspector 1.0. AI labels are estimates, not fact-checks.')
  );
}

function select(id, value, options) {
  const el = h('select', { class: 'select', id }, options.map(([v, label]) => h('option', { value: v }, label)));
  el.value = value;
  return el;
}

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

function init() {
  applyTheme();
  $('#btn-settings').append(icon('settings', 22));
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-setup').addEventListener('click', openSettings);
  $('#btn-paste').append(icon('paste', 20), 'Paste from clipboard');
  $('#tip-share').append(icon('share', 18), h('span', {}, 'Tip: a Share-sheet shortcut can send any video here in one tap (see the README).'));

  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
  if (ios && !standalone) {
    $('#tip-install').hidden = false;
    $('#tip-install').append(icon('down', 18), h('span', {}, 'Install it: tap Share in Safari, then "Add to Home Screen".'));
  }

  $('#form-url').addEventListener('submit', (e) => {
    e.preventDefault();
    start($('#url').value);
  });
  $('#btn-paste').addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      $('#url').value = text.trim();
      if (P.parseVideoId(text)) start(text);
      else toast('The clipboard does not hold a YouTube link.');
    } catch {
      $('#url').focus();
      toast('Press and hold in the box, then choose Paste.');
    }
  });

  history.replaceState({ v: 'home' }, '');
  show('home');

  takeIncomingLink();
  window.addEventListener('hashchange', takeIncomingLink);

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  autodetectLocalBackend();
}

/** A link can arrive as ?url=... or as #<link> (the easiest form for an iPhone Shortcut). */
function takeIncomingLink() {
  const qs = new URLSearchParams(location.search);
  let hashLink = location.hash.replace(/^#/, '');
  try {
    hashLink = decodeURIComponent(hashLink);
  } catch {
    /* keep the raw text */
  }
  const incoming = qs.get('url') || qs.get('text') || qs.get('u') || qs.get('v') || (P.parseVideoId(hashLink) ? hashLink : '');
  if (!incoming) return;
  history.replaceState(history.state || { v: 'home' }, '', location.pathname);
  if (P.parseVideoId(incoming)) setTimeout(() => start(incoming), 0);
}

/** When the app is served by the local PC server, connect to it automatically. */
let detecting = null;
function autodetectLocalBackend() {
  if (normalizeBackend(state.settings.backend)) return Promise.resolve();
  if (detecting) return detecting;
  detecting = (async () => {
    try {
      const r = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(2500) });
      const d = await r.json();
      if (d && d.ok && d.name === 'tube-inspector-backend') {
        state.settings.backend = location.origin;
        persist();
        if (state.view === 'home') renderHome();
      }
    } catch {
      /* not served by the local server: nothing to do */
    }
  })();
  return detecting;
}

init();
