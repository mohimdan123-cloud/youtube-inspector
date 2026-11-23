// Tube Inspector backend, single-file version for pasting into the Cloudflare dashboard editor.
// Generated from core.js + worker.js. Do not edit by hand.
/**
 * Tube Inspector backend logic. worker.js (the Cloudflare entry point) and server.mjs (the local
 * PC server) both call handleRequest().
 *
 * Endpoints (all JSON, CORS enabled):
 *   GET  /api/health            -> liveness check (no auth)
 *   GET  /api/info              -> which providers are configured + size limits
 *   GET  /api/video?id=VIDEOID  -> video metadata + raw caption data (if YouTube allows it)
 *   POST /api/llm               -> one LLM call, with automatic provider failover
 *
 * Secrets / variables (wrangler secret put NAME, or [vars] in wrangler.toml):
 *   APP_TOKEN            shared secret the app must send (strongly recommended)
 *   GEMINI_API_KEY       Google AI Studio key        (free tier)
 *   GROQ_API_KEY         console.groq.com key         (free tier)
 *   OPENROUTER_API_KEY   openrouter.ai key            (free ":free" models)
 *   ALLOWED_ORIGIN       e.g. https://yourname.github.io  (default: *)
 *   PROVIDER_ORDER       default "gemini,groq,openrouter"
 *   GEMINI_FAST_MODELS / GEMINI_SMART_MODELS / GEMINI_VIDEO_MODELS
 *   GROQ_FAST_MODELS / GROQ_SMART_MODELS / OPENROUTER_MODELS   (comma separated)
 *
 * Free tiers and model names change often: every model list is a failover list,
 * and a model that returns "not found / no access" is skipped for 30 minutes.
 */

const VERSION = '1.0.0';

const CLIENTS = {
  ANDROID: {
    name: 'ANDROID',
    id: '3',
    version: '20.10.38',
    ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip',
    extra: { androidSdkVersion: 30 },
  },
  IOS: {
    name: 'IOS',
    id: '5',
    version: '20.10.4',
    ua: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
    extra: { deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.2.22D82' },
  },
};

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15';

// Models that returned "not found / no access" recently (isolate-local, best effort).
const badModels = new Map();

const MAX_BODY = 4_000_000; // characters; the biggest legitimate request is ~700k

// Never wait forever on an upstream service.
const tmo = (ms) => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);

async function handleRequest(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, '') || '/';

      if (path === '/' || path === '/api/health') {
        return json({ ok: true, name: 'tube-inspector-backend', version: VERSION }, 200, cors);
      }
      if (!authorized(request, env)) return json({ error: 'unauthorized' }, 401, cors);

      if (path === '/api/info') return json(info(env), 200, cors);

      if (path === '/api/video' && request.method === 'GET') {
        const out = await getVideo(url.searchParams.get('id'), url.searchParams.get('lang') || 'en');
        return json(out, 200, cors);
      }

      if (path === '/api/llm' && request.method === 'POST') {
        let body;
        try {
          const raw = await request.text();
          if (raw.length > MAX_BODY) return json({ error: 'too_large', maxChars: 1000, detail: 'Request body is too big.' }, 413, cors);
          body = JSON.parse(raw);
        } catch {
          return json({ error: 'bad_request', detail: 'Body must be JSON' }, 400, cors);
        }
        const { status, payload } = await runLLM(body, env);
        return json(payload, status, cors);
      }

      return json({ error: 'not_found' }, 404, cors);
    } catch (e) {
      const status = e && e.status ? e.status : 500;
      return json({ error: e && e.code ? e.code : 'server_error', detail: String((e && e.message) || e) }, status, cors);
    }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

function httpError(status, code, message) {
  const e = new Error(message || code);
  e.status = status;
  e.code = code;
  return e;
}

function corsHeaders(request, env) {
  const origin = request.headers.get('origin') || '';
  const allowed = String((env && env.ALLOWED_ORIGIN) || '*')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
  let allow = '*';
  if (!allowed.includes('*')) allow = allowed.includes(origin.replace(/\/$/, '')) ? origin : allowed[0] || 'null';
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

function authorized(request, env) {
  if (!env || !env.APP_TOKEN) return true;
  const got = request.headers.get('authorization') || '';
  const want = 'Bearer ' + env.APP_TOKEN;
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

const csv = (s) =>
  String(s || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/* ------------------------------------------------------------------ */
/* providers                                                           */
/* ------------------------------------------------------------------ */

function getProviders(env) {
  const list = [];
  if (env.GEMINI_API_KEY) {
    list.push({
      id: 'gemini',
      kind: 'gemini',
      key: env.GEMINI_API_KEY,
      limits: { fast: 600000, smart: 600000 },
      models: {
        fast: csv(env.GEMINI_FAST_MODELS || 'gemini-2.5-flash-lite'),
        smart: csv(env.GEMINI_SMART_MODELS || 'gemini-2.5-flash,gemini-3.5-flash'),
        video: csv(env.GEMINI_VIDEO_MODELS || env.GEMINI_SMART_MODELS || 'gemini-2.5-flash,gemini-3.5-flash'),
      },
    });
  }
  if (env.GROQ_API_KEY) {
    list.push({
      id: 'groq',
      kind: 'openai',
      base: 'https://api.groq.com/openai/v1',
      key: env.GROQ_API_KEY,
      // Groq's free tier caps tokens per minute, so a single request must stay small.
      limits: { fast: 11000, smart: 22000 },
      models: {
        fast: csv(env.GROQ_FAST_MODELS || 'llama-3.1-8b-instant'),
        smart: csv(env.GROQ_SMART_MODELS || 'llama-3.3-70b-versatile'),
      },
    });
  }
  if (env.OPENROUTER_API_KEY) {
    const models = csv(
      env.OPENROUTER_MODELS ||
        'meta-llama/llama-3.3-70b-instruct:free,openai/gpt-oss-120b:free,google/gemma-3-27b-it:free'
    );
    list.push({
      id: 'openrouter',
      kind: 'openai',
      base: 'https://openrouter.ai/api/v1',
      key: env.OPENROUTER_API_KEY,
      headers: { 'HTTP-Referer': 'https://github.com/', 'X-Title': 'Video Summarizer' },
      limits: { fast: 60000, smart: 90000 },
      models: { fast: models, smart: models },
    });
  }
  const order = csv(env.PROVIDER_ORDER || 'gemini,groq,openrouter');
  list.sort((a, b) => rank(order, a.id) - rank(order, b.id));
  return list;
}

const rank = (order, id) => {
  const i = order.indexOf(id);
  return i === -1 ? 99 : i;
};

function info(env) {
  const ps = getProviders(env);
  return {
    ok: true,
    version: VERSION,
    tokenRequired: !!env.APP_TOKEN,
    video: ps.some((p) => p.id === 'gemini'),
    providers: ps.map((p) => ({ id: p.id, limits: p.limits, models: p.models })),
  };
}

/** Parse "retry in 12s", "7.6s", "250ms", "1m3s" style hints. Returns seconds or null. */
function parseRetryAfter(headers, text) {
  const h = headers && headers.get && headers.get('retry-after');
  if (h && !isNaN(Number(h))) return Math.ceil(Number(h));
  const s = String(text || '');
  let m = s.match(/"retryDelay"\s*:\s*"([\d.]+)s"/);
  if (m) return Math.ceil(parseFloat(m[1]));
  m = s.match(/try again in\s+(?:(\d+)m)?\s*([\d.]+)?\s*(ms|s)?/i);
  if (m && (m[1] || m[2])) {
    const mins = m[1] ? parseInt(m[1], 10) : 0;
    let secs = m[2] ? parseFloat(m[2]) : 0;
    if (m[3] === 'ms') secs = secs / 1000;
    return Math.max(1, Math.ceil(mins * 60 + secs));
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* LLM router                                                          */
/* ------------------------------------------------------------------ */

async function runLLM(body, env) {
  if (!body || typeof body.user !== 'string' || !body.user) {
    return { status: 400, payload: { error: 'bad_request', detail: 'Missing "user" text' } };
  }
  const req = {
    system: String(body.system || ''),
    user: body.user,
    json: !!body.json,
    tier: body.tier === 'fast' ? 'fast' : 'smart',
    maxOutputTokens: Math.min(Math.max(parseInt(body.maxOutputTokens, 10) || 2048, 64), 16000),
    temperature: typeof body.temperature === 'number' ? body.temperature : 0.2,
    video: body.video && body.video.url ? body.video : null,
  };

  const all = getProviders(env);
  if (!all.length) {
    return { status: 500, payload: { error: 'no_keys', detail: 'No API keys are configured on the backend.' } };
  }

  let chain = all;
  if (Array.isArray(body.order) && body.order.length) {
    const wanted = body.order.map(String);
    chain = wanted.map((id) => all.find((p) => p.id === id)).filter(Boolean);
  }
  if (req.video) chain = chain.filter((p) => p.id === 'gemini');
  if (!chain.length) {
    return {
      status: 400,
      payload: { error: 'provider_unavailable', detail: req.video ? 'Video mode needs GEMINI_API_KEY.' : 'No matching provider.' },
    };
  }

  const size = req.system.length + req.user.length;
  const skipped = [];
  const attempts = [];
  let retryAfter = null;
  let maxLimit = 0;
  let sizeSkips = 0;

  // Pass 1 skips models that failed with an auth/not-found error recently. If that leaves nothing to try,
  // pass 2 tries them anyway: a recently rejected model beats a made-up "too large" error.
  for (const pass of [1, 2]) {
    let blockedCount = 0;
    for (const p of chain) {
      const limit = req.video ? p.limits.smart : p.limits[req.tier];
      maxLimit = Math.max(maxLimit, limit);
      if (size > limit) {
        if (pass === 1) {
          skipped.push(p.id);
          sizeSkips++;
        }
        continue;
      }
      const models = req.video ? p.models.video : p.models[req.tier];
      for (const model of models) {
        const bad = badModels.get(model);
        if (pass === 1 && bad && bad.until > Date.now()) {
          blockedCount++;
          continue;
        }
        const r = p.kind === 'gemini' ? await callGemini(p, model, req) : await callOpenAI(p, model, req);
        if (r.ok) {
          badModels.delete(model);
          return {
            status: 200,
            payload: { text: r.text, provider: p.id, model, truncated: !!r.truncated, skipped },
          };
        }
        attempts.push({ provider: p.id, model, status: r.status, kind: r.kind, detail: String(r.detail || '').slice(0, 300) });
        // Wrong model names stay out for 30 minutes; rejected keys or permissions only for 3 minutes.
        if (r.kind === 'bad_model') badModels.set(model, { until: Date.now() + (r.status === 404 ? 30 : 3) * 60 * 1000 });
        if (r.kind === 'rate' && r.retryAfter != null) {
          retryAfter = retryAfter == null ? r.retryAfter : Math.min(retryAfter, r.retryAfter);
        }
        if (r.kind === 'rate' && r.retryAfter == null) retryAfter = retryAfter == null ? 20 : retryAfter;
      }
    }
    if (attempts.length || !blockedCount) break;
  }

  if (!attempts.length) {
    // Nothing was even tried. Only call it "too large" when the size really ruled every provider out.
    if (sizeSkips) return { status: 413, payload: { error: 'too_large', maxChars: maxLimit, skipped } };
    return { status: 502, payload: { error: 'all_failed', attempts, skipped, detail: 'No model could be tried.' } };
  }
  if (retryAfter != null) {
    return { status: 429, payload: { error: 'busy', retryAfter, attempts, skipped } };
  }
  if (attempts.every((a) => a.kind === 'too_large')) {
    return { status: 413, payload: { error: 'too_large', maxChars: Math.max(1000, Math.floor(size * 0.6)), attempts, skipped } };
  }
  return { status: 502, payload: { error: 'all_failed', attempts, skipped } };
}

function classify(status, text) {
  if (status === 429) return 'rate';
  if (status === 413) return 'too_large';
  if (status === 404 || status === 403 || status === 401) return 'bad_model';
  if (status === 400 && /not found|not supported|permission|does not exist|decommission|deprecat/i.test(text)) return 'bad_model';
  if (status === 400 && /too large|too long|exceeds|context length|token/i.test(text)) return 'too_large';
  return 'error';
}

async function callGemini(p, model, req) {
  const parts = [];
  if (req.video) {
    const v = req.video;
    const meta = {};
    if (Number.isFinite(v.startSec)) meta.startOffset = `${Math.max(0, Math.floor(v.startSec))}s`;
    if (Number.isFinite(v.endSec)) meta.endOffset = `${Math.max(1, Math.floor(v.endSec))}s`;
    if (Number.isFinite(v.fps)) meta.fps = v.fps;
    const part = { fileData: { fileUri: String(v.url) } };
    if (Object.keys(meta).length) part.videoMetadata = meta;
    parts.push(part);
  }
  parts.push({ text: req.user });

  const gen = { temperature: req.temperature, maxOutputTokens: req.maxOutputTokens };
  if (req.json) gen.responseMimeType = 'application/json';
  if (req.video) gen.mediaResolution = 'MEDIA_RESOLUTION_LOW';
  gen.thinkingConfig = { thinkingBudget: 0 };

  const body = { contents: [{ role: 'user', parts }], generationConfig: gen };
  if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const send = () =>
    fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': p.key },
      body: JSON.stringify(body),
      signal: tmo(req.video ? 170000 : 70000),
    });

  let res;
  try {
    res = await send();
    // Some models reject optional knobs; strip them once and retry.
    if (res.status === 400) {
      const t = await res.clone().text();
      let changed = false;
      if (/thinking/i.test(t) && gen.thinkingConfig) (delete gen.thinkingConfig, (changed = true));
      if (/media.?resolution/i.test(t) && gen.mediaResolution) (delete gen.mediaResolution, (changed = true));
      if (/fps/i.test(t) && parts[0].videoMetadata && 'fps' in parts[0].videoMetadata) (delete parts[0].videoMetadata.fps, (changed = true));
      if (changed) res = await send();
    }
  } catch (e) {
    return { ok: false, kind: 'error', status: 0, detail: 'network: ' + e.message };
  }

  const text = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, kind: classify(res.status, text), retryAfter: parseRetryAfter(res.headers, text), detail: text };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, status: 502, kind: 'error', detail: 'Gemini returned non-JSON' };
  }
  if (data.promptFeedback && data.promptFeedback.blockReason) {
    return { ok: false, status: 422, kind: 'error', detail: 'Blocked: ' + data.promptFeedback.blockReason };
  }
  const cand = data.candidates && data.candidates[0];
  const out = ((cand && cand.content && cand.content.parts) || [])
    .filter((x) => typeof x.text === 'string' && !x.thought)
    .map((x) => x.text)
    .join('');
  if (!out) return { ok: false, status: 502, kind: 'error', detail: 'Empty answer (' + ((cand && cand.finishReason) || 'no candidate') + ')' };
  return { ok: true, text: out, truncated: cand.finishReason === 'MAX_TOKENS' };
}

async function callOpenAI(p, model, req) {
  const body = {
    model,
    messages: [
      ...(req.system ? [{ role: 'system', content: req.system }] : []),
      { role: 'user', content: req.user },
    ],
    temperature: req.temperature,
    max_tokens: req.maxOutputTokens,
  };
  if (req.json) body.response_format = { type: 'json_object' };
  const send = () =>
    fetch(p.base + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + p.key, ...(p.headers || {}) },
      body: JSON.stringify(body),
      signal: tmo(70000),
    });

  let res;
  try {
    res = await send();
    if (res.status === 400 && body.response_format) {
      const t = await res.clone().text();
      if (/response_format|json/i.test(t)) {
        delete body.response_format;
        res = await send();
      }
    }
  } catch (e) {
    return { ok: false, kind: 'error', status: 0, detail: 'network: ' + e.message };
  }

  const text = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, kind: classify(res.status, text), retryAfter: parseRetryAfter(res.headers, text), detail: text };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, status: 502, kind: 'error', detail: 'Provider returned non-JSON' };
  }
  const choice = data.choices && data.choices[0];
  const out = choice && choice.message && choice.message.content;
  if (!out) return { ok: false, status: 502, kind: 'error', detail: 'Empty answer' };
  return { ok: true, text: out, truncated: choice.finish_reason === 'length' };
}

/* ------------------------------------------------------------------ */
/* YouTube: metadata + captions                                        */
/* ------------------------------------------------------------------ */

async function innertubePlayer(id, client) {
  const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    signal: tmo(15000),
    headers: {
      'content-type': 'application/json',
      'user-agent': client.ua,
      'x-youtube-client-name': client.id,
      'x-youtube-client-version': client.version,
      origin: 'https://www.youtube.com',
    },
    body: JSON.stringify({
      context: { client: { clientName: client.name, clientVersion: client.version, hl: 'en', gl: 'US', utcOffsetMinutes: 0, ...client.extra } },
      videoId: id,
      contentCheckOk: true,
      racyCheckOk: true,
    }),
  });
  if (!res.ok) throw new Error(client.name + ' player HTTP ' + res.status);
  return res.json();
}

function metaFromPlayer(player, id) {
  const d = player.videoDetails || {};
  const mf = (player.microformat && player.microformat.playerMicroformatRenderer) || {};
  return {
    id,
    title: d.title || (mf.title && mf.title.simpleText) || '',
    author: d.author || mf.ownerChannelName || '',
    durationSec: parseInt(d.lengthSeconds || mf.lengthSeconds || '0', 10) || 0,
    description: d.shortDescription || (mf.description && mf.description.simpleText) || '',
    category: mf.category || '',
    isLive: !!(d.isLive || d.isLiveContent) && !(parseInt(d.lengthSeconds || '0', 10) > 0),
    paidPromo: !!player.paidContentOverlay,
    thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
  };
}

function pickTrack(tracks, prefer) {
  const manual = tracks.filter((t) => t.kind !== 'asr');
  const auto = tracks.filter((t) => t.kind === 'asr');
  const starts = (t, l) => String(t.languageCode || '').toLowerCase().startsWith(l);
  // Language first (a hand-made track beats an auto one in the same language), then any track.
  return (
    manual.find((t) => starts(t, prefer)) ||
    auto.find((t) => starts(t, prefer)) ||
    manual.find((t) => starts(t, 'en')) ||
    auto.find((t) => starts(t, 'en')) ||
    manual[0] ||
    auto[0] ||
    tracks[0]
  );
}

function pickMeta(html, key) {
  const i = html.indexOf(key);
  if (i === -1) return '';
  const c = html.indexOf('content="', i);
  if (c === -1 || c - i > 200) return '';
  const end = html.indexOf('"', c + 9);
  return decodeEntities(html.slice(c + 9, end));
}

function isoDuration(s) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(s));
  if (!m) return 0;
  return (parseInt(m[1] || '0', 10) * 3600) + (parseInt(m[2] || '0', 10) * 60) + parseInt(m[3] || '0', 10);
}

async function watchPageMeta(id) {
  const res = await fetch(`https://www.youtube.com/watch?v=${id}&hl=en`, {
    signal: tmo(15000),
    headers: { 'user-agent': BROWSER_UA, 'accept-language': 'en-US,en;q=0.9', cookie: 'CONSENT=YES+1; SOCS=CAI' },
  });
  if (!res.ok) throw new Error('watch page HTTP ' + res.status);
  const html = await res.text();
  const title = pickMeta(html, 'property="og:title"');
  if (!title) throw new Error('watch page had no metadata');
  const dur = pickMeta(html, 'itemprop="duration"');
  return {
    id,
    title,
    author: pickMeta(html, 'itemprop="name"') || '',
    durationSec: dur ? isoDuration(dur) : 0,
    description: pickMeta(html, 'property="og:description"'),
    category: pickMeta(html, 'itemprop="genre"'),
    isLive: false,
    paidPromo: false,
    thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    partial: true,
  };
}

async function getVideo(id, lang) {
  if (!/^[\w-]{11}$/.test(id || '')) throw httpError(400, 'bad_id', 'Not a valid YouTube video id');
  const out = { id, meta: null, captionStatus: 'blocked', track: null, raw: null, reason: '', debug: [] };

  let player = null;
  let client = CLIENTS.ANDROID;
  for (const c of [CLIENTS.ANDROID, CLIENTS.IOS]) {
    try {
      const p = await innertubePlayer(id, c);
      out.debug.push(`${c.name}: ${(p.playabilityStatus && p.playabilityStatus.status) || '?'}`);
      if (p.playabilityStatus && p.playabilityStatus.status === 'OK' && p.videoDetails) {
        player = p;
        client = c;
        break;
      }
      if (p.playabilityStatus && ['ERROR', 'UNPLAYABLE'].includes(p.playabilityStatus.status)) {
        out.unavailable = p.playabilityStatus.reason || 'This video is unavailable.';
      }
    } catch (e) {
      out.debug.push(`${c.name}: ${e.message}`);
    }
  }

  if (player) {
    out.meta = metaFromPlayer(player, id);
    const tracks =
      (player.captions && player.captions.playerCaptionsTracklistRenderer && player.captions.playerCaptionsTracklistRenderer.captionTracks) || [];
    if (!tracks.length) {
      out.captionStatus = 'none';
      out.reason = 'This video has no captions.';
    } else {
      const t = pickTrack(tracks, String(lang || 'en').toLowerCase());
      try {
        const u = new URL(t.baseUrl);
        u.searchParams.set('fmt', 'json3');
        const r = await fetch(u.toString(), { headers: { 'user-agent': client.ua, 'accept-language': 'en-US,en;q=0.9' }, signal: tmo(20000) });
        const raw = await r.text();
        if (r.ok && raw.length > 40 && raw.length < 12_000_000) {
          out.captionStatus = 'ok';
          out.raw = raw;
          out.track = { lang: t.languageCode, auto: t.kind === 'asr', name: (t.name && (t.name.simpleText || (t.name.runs && t.name.runs[0].text))) || '' };
        } else {
          out.reason = 'YouTube returned an empty caption file (it often does this for cloud servers).';
        }
      } catch (e) {
        out.reason = 'Caption download failed: ' + e.message;
      }
    }
  } else if (!out.unavailable) {
    try {
      out.meta = await watchPageMeta(id);
      out.reason = 'YouTube blocked the caption request from this server.';
    } catch (e) {
      out.debug.push('watch: ' + e.message);
      out.reason = 'Could not reach YouTube from this server.';
    }
  }
  return out;
}

export default { fetch: handleRequest };
