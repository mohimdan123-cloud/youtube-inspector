/**
 * Pure logic for the Video Summarizer: parsing, chunking, prompts, labels, retrieval.
 * No DOM and no network here, so it runs in the browser and in Node tests.
 */

/* ------------------------------------------------------------------ */
/* Labels                                                              */
/* ------------------------------------------------------------------ */

// tone -> colour family used by the UI
export const LABELS = {
  marketing: { text: 'Marketing', tone: 'amber', help: 'the video is mainly an advertisement for a product, brand or the creator\'s own business' },
  possible_marketing: { text: 'Possible marketing', tone: 'amber', help: 'promotional, but not clearly an advertisement' },
  sponsored: { text: 'Sponsored', tone: 'amber', help: 'contains a sponsor integration or paid promotion, disclosed or evident' },
  affiliate: { text: 'Affiliate links', tone: 'amber', help: 'pushes affiliate or referral links or discount codes' },
  paid_service: { text: 'Promotes a paid service', tone: 'amber', help: 'sells or pushes a paid course, coaching, membership, signal group or app' },
  clickbait: { text: 'Clickbait title', tone: 'coral', help: 'the title or thumbnail promise is exaggerated, withheld or not delivered' },
  possibly_misleading: { text: 'Possibly misleading', tone: 'coral', help: 'some claims look unsupported or one-sided' },
  misleading: { text: 'Misleading', tone: 'coral', help: 'clearly false or deceptive claims (only with strong evidence)' },
  opinion: { text: 'Opinion', tone: 'grey', help: 'mostly the speaker\'s opinion rather than established facts' },
  satire: { text: 'Satire', tone: 'grey', help: 'comedy or parody' },
  get_rich_quick: { text: 'Get-rich-quick', tone: 'coral', help: 'promises fast or easy wealth' },
  income_claims: { text: 'Income claims', tone: 'coral', help: 'specific earnings claims without evidence' },
  trading_signals: { text: 'Trading or crypto signals', tone: 'coral', help: 'trading, forex or crypto tips or paid signals' },
  fake_urgency: { text: 'Fake urgency', tone: 'coral', help: 'pressure such as "only today" or "limited spots"' },
  engagement_bait: { text: 'Engagement bait', tone: 'amber', help: 'begging for likes, comments or follows, or cliffhangers to keep people watching' },
  no_red_flags: { text: 'No red flags found', tone: 'green', help: 'none of the above applies and the claims looked reasonable' },
};

export const MATCH_TEXT = { high: 'Good match', medium: 'Partial match', low: 'Low match' };

/* ------------------------------------------------------------------ */
/* Time helpers                                                        */
/* ------------------------------------------------------------------ */

export function fmtTime(sec, forceHours = false) {
  const total = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0 || forceHours) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

export function parseTime(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.round(v));
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/^\[|\]$/g, '');
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s));
  const m = /^(?:(\d{1,2}):)?(\d{1,3}):(\d{2})(?:\.\d+)?$/.exec(s);
  if (!m) return null;
  return (m[1] ? parseInt(m[1], 10) * 3600 : 0) + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
}

/* ------------------------------------------------------------------ */
/* Input parsing                                                       */
/* ------------------------------------------------------------------ */

const ID_RE = /^[\w-]{11}$/;

export function parseVideoId(input) {
  if (!input) return null;
  let s = String(input).trim();
  if (ID_RE.test(s)) return s;
  const found = s.match(/https?:\/\/[^\s]+/i);
  if (found) s = found[0];
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  if (host === 'youtu.be') {
    const id = u.pathname.split('/')[1] || '';
    return ID_RE.test(id) ? id : null;
  }
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const v = u.searchParams.get('v');
    if (v && ID_RE.test(v)) return v;
    const m = u.pathname.match(/^\/(?:shorts|live|embed|v)\/([\w-]{11})/);
    if (m) return m[1];
  }
  return null;
}

export function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Raw caption file (json3 or XML) -> [[startSeconds, text], ...] */
export function parseCaptions(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  if (s[0] === '{') {
    let d;
    try {
      d = JSON.parse(s);
    } catch {
      return [];
    }
    const out = [];
    for (const ev of d.events || []) {
      if (!ev.segs) continue;
      const text = ev.segs.map((x) => x.utf8 || '').join('').replace(/\s*\n\s*/g, ' ').trim();
      if (text) out.push([Math.round((ev.tStartMs || 0) / 1000), text]);
    }
    return out;
  }
  const out = [];
  const clean = (x) => decodeEntities(decodeEntities(x.replace(/<[^>]+>/g, ''))).replace(/\s+/g, ' ').trim();
  let m;
  const re = /<text\b[^>]*?\bstart="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  while ((m = re.exec(s))) {
    const text = clean(m[2]);
    if (text) out.push([Math.round(parseFloat(m[1])), text]);
  }
  if (!out.length) {
    const re2 = /<p\b[^>]*?\bt="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
    while ((m = re2.exec(s))) {
      const text = clean(m[2]);
      if (text) out.push([Math.round(parseInt(m[1], 10) / 1000), text]);
    }
  }
  return out;
}

/** Share of caption cues that contain no words, e.g. [Music] or note symbols. */
export function nonSpeechRatio(segs) {
  if (!segs.length) return 1;
  let n = 0;
  for (const [, text] of segs) {
    const stripped = text.replace(/\[[^\]]*\]|\([^)]*\)|[♪♫]/g, '');
    if (!/\p{L}/u.test(stripped)) n++;
  }
  return n / segs.length;
}

/** Join consecutive cues into lines of roughly `win` seconds. */
export function mergeSegments(segs, win = 20) {
  const lines = [];
  let cur = null;
  for (const [t, text] of segs) {
    if (!cur) cur = { t, text };
    else if (t - cur.t >= win) {
      lines.push(cur);
      cur = { t, text };
    } else cur.text += ' ' + text;
  }
  if (cur) lines.push(cur);
  return lines;
}

export function fmtLine(l, forceHours = false) {
  return l.t == null ? l.text : `[${fmtTime(l.t, forceHours)}] ${l.text}`;
}

export function linesToText(lines, forceHours = false) {
  return lines.map((l) => fmtLine(l, forceHours)).join('\n');
}

function splitLong(l, max) {
  if (l.text.length <= max) return [l];
  const parts = [];
  let rest = l.text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    parts.push({ t: l.t, text: rest.slice(0, cut).trim() });
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push({ t: l.t, text: rest });
  return parts;
}

/** Split lines into chunks no longer than maxChars (counting the timestamp prefixes). */
export function chunkLines(lines, maxChars, forceHours = false) {
  const chunks = [];
  let buf = [];
  let size = 0;
  const flush = () => {
    if (!buf.length) return;
    chunks.push({ from: buf[0].t, to: buf[buf.length - 1].t, text: linesToText(buf, forceHours), lines: buf.length });
    buf = [];
    size = 0;
  };
  for (const l0 of lines) {
    for (const l of splitLong(l0, Math.max(200, Math.floor(maxChars * 0.8)))) {
      const s = fmtLine(l, forceHours).length + 1;
      if (size + s > maxChars) flush();
      buf.push(l);
      size += s;
    }
  }
  flush();
  return chunks;
}

/** Parse a transcript the user pasted. Handles "0:12 text", "[0:12] text" and YouTube's alternating copy format. */
export function parseManualTranscript(text, durationSec = 0) {
  const rows = String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const tsRe = /^\[?((?:\d{1,2}:)?\d{1,2}:\d{2})\]?\s*(.*)$/;
  const segs = [];
  let cur = null;
  for (const row of rows) {
    const m = tsRe.exec(row);
    if (m) {
      if (cur) segs.push(cur);
      cur = { t: parseTime(m[1]), text: m[2] || '' };
    } else if (cur) cur.text += (cur.text ? ' ' : '') + row;
  }
  if (cur) segs.push(cur);
  const timed = segs.filter((s) => s.text);
  if (timed.length >= 3) {
    return { lines: mergeSegments(timed.map((s) => [s.t, s.text])), hasTimes: true, approx: false };
  }
  // No usable timestamps: cut into paragraphs and spread them over the duration when we know it.
  const flat = rows.join(' ').replace(/\s+/g, ' ').trim();
  const pieces = [];
  let rest = flat;
  while (rest.length > 0) {
    let cut = rest.length > 500 ? rest.indexOf('. ', 400) : -1;
    if (cut === -1 || cut > 700) cut = Math.min(rest.length, 500);
    else cut += 1;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  const lines = pieces.map((p, i) => ({ t: durationSec ? Math.round((i / pieces.length) * durationSec) : null, text: p }));
  return { lines, hasTimes: !!durationSec, approx: !!durationSec };
}

/* ------------------------------------------------------------------ */
/* Video metadata helpers                                              */
/* ------------------------------------------------------------------ */

export function detectMusic(meta) {
  const title = String(meta.title || '');
  const author = String(meta.author || '');
  if (/ - topic$/i.test(author) || /vevo$/i.test(author)) return true;
  if (/\b(official (music )?video|official audio|lyrics? video|official visuali[sz]er|audio only)\b|[(\[]\s*(official )?(lyrics?|audio|visuali[sz]er)\s*[)\]]/i.test(title)) return true;
  if (String(meta.category || '').toLowerCase() === 'music' && (meta.durationSec || 0) < 20 * 60) return true;
  return false;
}

/** Creator chapters from the description ("0:00 Intro" lines). */
export function parseChapters(desc, durationSec = 0) {
  const out = [];
  const re = /^\s*[\[(]?((?:\d{1,2}:)?\d{1,2}:\d{2})[\])]?\s*[-–—:|·.)]*\s*(.{2,120}?)\s*$/;
  for (const line of String(desc || '').split(/\r?\n/)) {
    const m = re.exec(line);
    if (!m) continue;
    const t = parseTime(m[1]);
    if (t == null) continue;
    out.push({ t, label: m[2].replace(/^[-–—:|·.)\s]+/, '').trim() });
  }
  if (out.length < 3 || out[0].t > 5) return [];
  for (let i = 1; i < out.length; i++) if (out[i].t <= out[i - 1].t) return [];
  if (durationSec && out[out.length - 1].t > durationSec) return [];
  return out;
}

export function descriptionSignals(desc, paidPromo = false) {
  const d = String(desc || '');
  const links = d.match(/https?:\/\/\S+/g) || [];
  const aff = links.filter((l) => /amzn\.to|amazon\.[a-z.]+\/\S*tag=|geni\.us|shareasale|clickbank|sjv\.io|tidd\.ly|[?&](ref|aff|affiliate|partner)[=_]|\/(ref|aff|go|recommends)\//i.test(l)).length;
  return {
    links: links.length,
    affiliateLinks: aff,
    discountCode: /\b(use|with)\s+(the\s+)?(code|coupon)\b|\bpromo\s*code\b|\bdiscount\s*code\b|\b\d{1,2}%\s*off\b/i.test(d),
    sponsorMention: /\b(sponsor(ed|ship)?|paid (promotion|partnership)|in partnership with)\b|#ad\b|#sponsored/i.test(d),
    courseOrCoaching: /\b(course|coaching|masterclass|mentorship|join (my|the) (discord|membership|community)|limited spots)\b/i.test(d),
    paidPromo: !!paidPromo,
  };
}

/* ------------------------------------------------------------------ */
/* JSON from models                                                    */
/* ------------------------------------------------------------------ */

export function parseJSONLoose(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a === -1 || b === -1 || b < a) throw new Error('No JSON object in the answer');
  s = s.slice(a, b + 1);
  try {
    return JSON.parse(s);
  } catch {
    s = s.replace(/,\s*([}\]])/g, '$1').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
    return JSON.parse(s);
  }
}

/* ------------------------------------------------------------------ */
/* Prompts                                                             */
/* ------------------------------------------------------------------ */

const SYS =
  'You help a viewer find out what a YouTube video really contains before they spend time on it. ' +
  'Be concrete, neutral and brief. Never quote song lyrics or long passages. ' +
  'Reply with one JSON object only: no markdown, no commentary.';

export function langRule(lang) {
  if (lang === 'en') return 'Write every text value in English.';
  if (lang === 'ar') return 'Write every text value in clear Modern Standard Arabic. Keep JSON keys, label ids and timestamps in English characters.';
  return 'Write every text value in the same language as the video\'s speech (English if unsure). Keep JSON keys, label ids and timestamps in English characters.';
}

const LABEL_HELP = Object.entries(LABELS)
  .map(([id, l]) => `${id}: ${l.help}`)
  .join('\n');

function context(ctx) {
  const m = ctx.meta;
  const sig = ctx.signals || {};
  const lines = [
    `Title: ${m.title || '(unknown)'}`,
    `Channel: ${m.author || '(unknown)'}`,
    `Length: ${ctx.durationSec ? fmtTime(ctx.durationSec, ctx.durationSec >= 3600) : 'unknown'}`,
  ];
  if (m.category) lines.push(`Category: ${m.category}`);
  const flags = [];
  if (sig.paidPromo) flags.push('creator ticked "includes paid promotion"');
  if (sig.sponsorMention) flags.push('description mentions a sponsor');
  if (sig.affiliateLinks) flags.push(`${sig.affiliateLinks} affiliate-style link(s) in description`);
  if (sig.discountCode) flags.push('discount code in description');
  if (sig.courseOrCoaching) flags.push('description mentions a course, coaching or membership');
  lines.push(`Description signals: ${flags.length ? flags.join('; ') : 'none found'}`);
  if (ctx.chapters && ctx.chapters.length) {
    lines.push('Creator chapters: ' + ctx.chapters.map((c) => `${fmtTime(c.t, ctx.durationSec >= 3600)} ${c.label}`).join(' | '));
  }
  if (m.description) lines.push('Description (start): ' + String(m.description).replace(/\s+/g, ' ').slice(0, 900));
  return lines.join('\n');
}

const FINAL_SCHEMA = `Return JSON with exactly these keys:
{
 "summary": "ONE sentence (max 35 words) saying what the video actually delivers",
 "overview": "3-4 sentences: the broader meaning and what a viewer would learn",
 "clickbait": {"match": "high|medium|low", "note": "one sentence comparing the title's promise with what the video delivers"},
 "labels": [{"id": "<label id>", "likelihood": 0-100, "why": "one short sentence with the evidence"}],
 "timeline": [{"t": "h:mm:ss", "type": "chapter|key|promise|sponsor", "label": "2-6 words", "end": "h:mm:ss (sponsor only, optional)"}],
 "topics": [{"t": "h:mm:ss", "title": "3-7 words", "detail": "1-2 sentences", "pitch": false}]
}
Rules:
- 4-10 topics in time order covering the whole video (up to 12 if longer than 2 hours). "pitch": true only for sales pitches or ads.
- timeline: include the chapters, up to 4 "key" moments, ONE "promise" entry only if the title's promise is actually delivered at a specific time (otherwise leave it out), and "sponsor" entries (with "end") for ad or sales segments.
- Labels (use at most 4, strongest first). Allowed ids and meanings:
${LABEL_HELP}
- likelihood is how sure you are (100 = certain). Use "misleading" only with clear evidence, otherwise "possibly_misleading". Use "no_red_flags" only when no other label applies.
- Base every judgement on what is said or shown, not on the channel's reputation.`;

export function promptFinal({ ctx, inputKind, input, lang }) {
  const intro =
    inputKind === 'transcript'
      ? 'Below is the full transcript with [timestamps]. Analyse the whole video.'
      : 'Below are JSON notes written for consecutive parts of the video (times are absolute). Combine them into one analysis of the whole video.';
  const body = inputKind === 'transcript' ? `TRANSCRIPT:\n${input}` : `NOTES:\n${input}`;
  return {
    system: SYS + ' ' + langRule(lang),
    user: `${context(ctx)}\n\n${intro}\n\n${FINAL_SCHEMA}\n\n${body}`,
  };
}

const PART_SCHEMA = `Return JSON:
{"gist": "one sentence",
 "topics": [{"t": "h:mm:ss", "title": "3-7 words", "detail": "one sentence"}],
 "moments": [{"t": "h:mm:ss", "type": "key|promise|sponsor", "label": "2-6 words", "end": "h:mm:ss (sponsor only, optional)"}],
 "signals": {"sponsor": "what is sold or sponsored in this part, empty string if nothing",
             "claims": ["up to 3 notable factual or income claims, very short"],
             "promise": "does this part answer what the title promises? yes/no plus a few words"}}
At most 3 topics and 2 moments. Use the timestamps exactly as written in the text. Keep it short.`;

export function promptChunk({ ctx, text, index, total, from, to, lang }) {
  const fh = ctx.durationSec >= 3600;
  return {
    system: SYS + ' ' + langRule(lang),
    user: `Video title: ${ctx.meta.title || '(unknown)'}\nThis is part ${index + 1} of ${total}, covering ${from == null ? 'the text' : fmtTime(from, fh) + ' to ' + fmtTime(to, fh)}.\n\n${PART_SCHEMA}\n\nTRANSCRIPT PART:\n${text}`,
  };
}

export function promptReduce({ ctx, input, lang }) {
  return {
    system: SYS + ' ' + langRule(lang),
    user: `Video title: ${ctx.meta.title || '(unknown)'}\nMerge these partial notes (absolute times, in order) into ONE note that covers the whole range. Keep at most 5 topics and 4 moments.\n\n${PART_SCHEMA}\n\nNOTES:\n${input}`,
  };
}

export function promptVideoWindow({ ctx, index, total, windowStart, windowEnd, lang }) {
  const clipped = windowStart != null;
  return {
    system: SYS + ' ' + langRule(lang),
    user:
      `Video title: ${ctx.meta.title || '(unknown)'}\nChannel: ${ctx.meta.author || '(unknown)'}\n` +
      (clipped ? `You are given part ${index + 1} of ${total} of the video as a clip. ` : 'You are given the whole video. ') +
      `Listen to the speech and watch the visuals. All times you return are RELATIVE TO THE START OF THE CLIP YOU SEE (0:00 = start of the clip).\n\n` +
      `Return JSON:\n{"speech": true or false (is anyone speaking or singing words in this clip),\n "music_only": true or false,\n "notes": [{"t": "m:ss", "text": "one or two dense sentences about what is said or shown, written so a reader can answer questions from it"}],\n "gist": "one sentence",\n "topics": [{"t": "m:ss", "title": "3-7 words", "detail": "one sentence"}],\n "moments": [{"t": "m:ss", "type": "key|promise|sponsor", "label": "2-6 words", "end": "m:ss (sponsor only, optional)"}],\n "signals": {"sponsor": "what is sold or sponsored here, empty string if nothing", "claims": ["up to 3 notable factual or income claims, very short"], "promise": "does this part answer what the title promises? yes/no plus a few words"}}\n` +
      `Write one note roughly every 1-2 minutes. At most 3 topics and 2 moments. If there is no speech, return an empty notes array.`,
  };
}

export function promptMusic({ ctx, captionSample, lang }) {
  return {
    system: SYS + ' ' + langRule(lang),
    user:
      `${context(ctx)}\n\nThis looks like a music video. ` +
      (captionSample ? `Caption text (may be the lyrics, use it only to understand the theme):\n${captionSample}\n\n` : '') +
      `Return JSON:\n{"subject": "what the song is about, as a short phrase", "summary": "ONE sentence beginning like 'A song about ...' in the output language", "artist": "artist or band if known", "track": "song title if known", "mood": "genre and mood in a few words", "cues": ["up to 4 short facts from the title or description: featured artists, album, playlist, release context"]}\n` +
      `Describe themes in your own words and never quote lyrics. If something is unknown, use an empty string.`,
  };
}

export function promptAsk({ ctx, analysis, material, history, question, lang }) {
  const outline = (analysis.topics || []).map((t) => `${t.t != null ? fmtTime(t.t, ctx.durationSec >= 3600) + ' ' : ''}${t.title}`).join('; ');
  const hist = (history || [])
    .slice(-3)
    .map((h) => `Q: ${h.q}\nA: ${String(h.a).slice(0, 500)}`)
    .join('\n');
  return {
    system:
      'You answer questions about one YouTube video using ONLY the material provided (transcript excerpts or notes). ' +
      'Be brief: 1-4 sentences unless the user asks for detail. When you refer to a moment, write its timestamp in square brackets exactly as shown in the material, e.g. [1:12:05]. ' +
      'If the material does not answer the question, say so plainly. Never invent facts. ' +
      (lang === 'en' ? 'Answer in English.' : lang === 'ar' ? 'Answer in Arabic.' : 'Answer in the language of the question.'),
    user:
      `Video: ${ctx.meta.title || '(unknown)'}\nSummary: ${analysis.summary || ''}\nOutline: ${outline}\n\nMATERIAL:\n${material}\n\n` +
      (hist ? `Earlier in this conversation:\n${hist}\n\n` : '') +
      `Question: ${question}`,
  };
}

/* ------------------------------------------------------------------ */
/* Normalising model output                                            */
/* ------------------------------------------------------------------ */

const TYPES = new Set(['chapter', 'key', 'promise', 'sponsor']);

const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

export function normalizeAnalysis(raw, ctx) {
  const dur = ctx.durationSec || 0;
  const hasTimes = ctx.hasTimes !== false;
  const clampT = (v) => {
    const t = parseTime(v);
    if (t == null) return null;
    return dur ? Math.min(t, dur) : t;
  };

  const out = {
    summary: str(raw.summary, 500) || str(raw.overview, 300),
    overview: str(raw.overview, 1200),
    clickbait: null,
    labels: [],
    timeline: [],
    topics: [],
  };

  const cb = raw.clickbait || {};
  const match = String(cb.match || '').toLowerCase();
  if (['high', 'medium', 'low'].includes(match)) out.clickbait = { match, note: str(cb.note, 300) };

  const seen = new Set();
  for (const item of Array.isArray(raw.labels) ? raw.labels : []) {
    const id = typeof item === 'string' ? item : item && item.id;
    if (!LABELS[id] || seen.has(id)) continue;
    seen.add(id);
    const lk = item && Number(item.likelihood);
    out.labels.push({
      id,
      likelihood: Number.isFinite(lk) ? Math.max(0, Math.min(100, Math.round(lk))) : null,
      why: str(item && item.why, 240),
    });
    if (out.labels.length >= 5) break;
  }
  if (out.labels.length > 1) out.labels = out.labels.filter((l) => l.id !== 'no_red_flags');
  if (out.labels.some((l) => l.id === 'misleading')) out.labels = out.labels.filter((l) => l.id !== 'possibly_misleading');

  if (hasTimes) {
    let tl = [];
    for (const e of Array.isArray(raw.timeline) ? raw.timeline : []) {
      const t = clampT(e && e.t);
      if (t == null) continue;
      const type = TYPES.has(e.type) ? e.type : 'chapter';
      const item = { t, type, label: str(e.label, 60) };
      const end = e.end != null ? clampT(e.end) : null;
      if (type === 'sponsor' && end != null && end > t) item.end = end;
      tl.push(item);
    }
    if (ctx.chapters && ctx.chapters.length) {
      tl = tl.filter((e) => e.type !== 'chapter').concat(ctx.chapters.map((c) => ({ t: c.t, type: 'chapter', label: c.label.slice(0, 60) })));
    }
    tl.sort((a, b) => a.t - b.t);
    const dedup = [];
    let promiseSeen = false;
    for (const e of tl) {
      if (e.type === 'promise') {
        if (promiseSeen) continue;
        promiseSeen = true;
      }
      if (dedup.some((d) => d.type === e.type && Math.abs(d.t - e.t) < 3)) continue;
      dedup.push(e);
    }
    out.timeline = dedup.slice(0, 40);
  }

  for (const t of Array.isArray(raw.topics) ? raw.topics : []) {
    const title = str(t && t.title, 90);
    if (!title) continue;
    out.topics.push({ t: hasTimes ? clampT(t.t) : null, title, detail: str(t.detail, 360), pitch: !!t.pitch });
  }
  out.topics.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
  if (!out.topics.length && ctx.chapters && ctx.chapters.length && hasTimes) {
    out.topics = ctx.chapters.slice(0, 12).map((c) => ({ t: c.t, title: c.label.slice(0, 90), detail: '', pitch: false }));
  }
  out.topics = out.topics.slice(0, 14);
  return out;
}

export function normalizeMusic(raw) {
  return {
    subject: str(raw.subject, 160),
    summary: str(raw.summary, 400) || (raw.subject ? `A song about ${str(raw.subject, 160)}.` : ''),
    artist: str(raw.artist, 120),
    track: str(raw.track, 160),
    mood: str(raw.mood, 120),
    cues: (Array.isArray(raw.cues) ? raw.cues : []).map((c) => str(c, 160)).filter(Boolean).slice(0, 4),
  };
}

/** Clean a partial note (chunk or video window) and shift its times by `offset` seconds. */
export function normalizePartial(raw, offset = 0) {
  const shift = (v) => {
    const t = parseTime(v);
    return t == null ? null : t + offset;
  };
  const p = {
    gist: str(raw.gist, 300),
    topics: [],
    moments: [],
    signals: {
      sponsor: str(raw.signals && raw.signals.sponsor, 200),
      claims: (raw.signals && Array.isArray(raw.signals.claims) ? raw.signals.claims : []).map((c) => str(c, 160)).filter(Boolean).slice(0, 3),
      promise: str(raw.signals && raw.signals.promise, 160),
    },
  };
  for (const t of Array.isArray(raw.topics) ? raw.topics : []) {
    const at = shift(t && t.t);
    if (at != null && t.title) p.topics.push({ t: at, title: str(t.title, 90), detail: str(t.detail, 200) });
  }
  for (const m of Array.isArray(raw.moments) ? raw.moments : []) {
    const at = shift(m && m.t);
    if (at == null) continue;
    const item = { t: at, type: str(m.type, 12), label: str(m.label, 60) };
    const end = m.end != null ? shift(m.end) : null;
    if (end != null && end > at) item.end = end;
    p.moments.push(item);
  }
  return p;
}

/** Compact, time-formatted JSON for the combine step. */
export function partialsToText(partials, forceHours = false) {
  const f = (t) => fmtTime(t, forceHours);
  return partials
    .map((p) =>
      JSON.stringify({
        gist: p.gist,
        topics: p.topics.map((t) => ({ t: f(t.t), title: t.title, detail: t.detail })),
        moments: p.moments.map((m) => ({ t: f(m.t), type: m.type, label: m.label, ...(m.end ? { end: f(m.end) } : {}) })),
        signals: p.signals,
      })
    )
    .join('\n');
}

/* ------------------------------------------------------------------ */
/* Retrieval for questions                                             */
/* ------------------------------------------------------------------ */

const STOP = new Set(
  'the and for are but not you all any can had her was one our out has have what when where which who why how does did with that this from they been were will would there their about into than then them these those say said video he she his him its also just really very much more most some such only own same too'.split(
    ' '
  )
);

const tokenize = (s) =>
  String(s)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !STOP.has(w));

/**
 * Pick the transcript passages most relevant to a question, up to `budget` characters.
 * Returns the whole transcript when it already fits.
 */
export function retrievePassages(lines, question, budget, forceHours = false) {
  if (!lines.length) return '';
  const total = lines.reduce((n, l) => n + l.text.length + 12, 0);
  if (total <= budget) return linesToText(lines, forceHours);

  const passages = [];
  let cur = [];
  let len = 0;
  for (const l of lines) {
    cur.push(l);
    len += l.text.length + 12;
    if (len >= 1000) {
      passages.push(cur);
      cur = [];
      len = 0;
    }
  }
  if (cur.length) passages.push(cur);

  const sizes = passages.map((p) => p.reduce((n, l) => n + l.text.length + 12, 0));
  const qTerms = [...new Set(tokenize(question))];
  const toks = passages.map((p) => tokenize(p.map((l) => l.text).join(' ')));
  const df = new Map();
  for (const tk of toks) for (const w of new Set(tk)) df.set(w, (df.get(w) || 0) + 1);

  const scores = toks.map((tk) => {
    const tf = new Map();
    for (const w of tk) tf.set(w, (tf.get(w) || 0) + 1);
    let s = 0;
    for (const q of qTerms) {
      const f = tf.get(q) || 0;
      if (f) s += (1 + Math.log(f)) * Math.log(1 + passages.length / (1 + (df.get(q) || 0)));
    }
    return s;
  });

  let order;
  if (scores.every((s) => s === 0)) {
    // No word overlap (for example a question in another language): sample evenly.
    const step = Math.max(1, Math.ceil(total / budget));
    order = passages.map((_, i) => i).filter((i) => i % step === 0);
  } else {
    order = passages.map((_, i) => i).sort((a, b) => scores[b] - scores[a] || a - b);
  }

  const picked = [];
  let used = 0;
  for (const i of order) {
    if (used + sizes[i] > budget) continue;
    picked.push(i);
    used += sizes[i];
  }
  picked.sort((a, b) => a - b);
  let out = '';
  let prev = -2;
  for (const i of picked) {
    if (i !== prev + 1 && out) out += '\n...\n';
    out += (out && i === prev + 1 ? '\n' : '') + linesToText(passages[i], forceHours);
    prev = i;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Evidence that does not need an AI                                   */
/* ------------------------------------------------------------------ */

/** Add labels backed by hard evidence from the video page (paid-promotion tick, affiliate links). */
export function applySignals(analysis, signals) {
  if (!signals) return analysis;
  const has = (...ids) => analysis.labels.some((l) => ids.includes(l.id));
  const add = [];
  if (signals.paidPromo && !has('sponsored', 'marketing')) {
    add.push({ id: 'sponsored', likelihood: 95, why: 'The creator ticked "includes paid promotion" on YouTube.' });
  }
  if (signals.affiliateLinks >= 2 && !has('affiliate')) {
    add.push({ id: 'affiliate', likelihood: 85, why: `${signals.affiliateLinks} affiliate-style links in the description.` });
  }
  if (add.length) {
    analysis.labels = add
      .concat(analysis.labels.filter((l) => l.id !== 'no_red_flags'))
      .slice(0, 5);
  }
  return analysis;
}
