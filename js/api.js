/** Talks to your Cloudflare Worker. Always resolves for LLM calls; throws AppError for info/video. */
import { AppError } from './analyze.js';

export function normalizeBackend(v) {
  let s = String(v || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  return s.replace(/\/+$/, '');
}

function failFrom({ status, data }) {
  if (status === 0) return new AppError('network', "Can't reach your backend. Check the internet connection and the backend address in Settings.", data && data.detail);
  if (status === 401) return new AppError('auth', 'The access token is wrong. Check it in Settings.');
  if (status === 400 && data && data.error === 'bad_id') return new AppError('bad_id', 'That is not a valid YouTube video link.');
  return new AppError('backend', (data && data.detail) || `The backend answered with an error (${status}).`, data);
}

export function createApi(getSettings) {
  let infoCache = null;

  const base = () => normalizeBackend(getSettings().backend);

  async function http(path, init = {}, timeoutMs = 60000) {
    const b = base();
    if (!b) throw new AppError('setup', 'Add your backend address in Settings first.');
    const token = String(getSettings().token || '').trim();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(b + path, {
        ...init,
        headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(init.headers || {}) },
        signal: ctl.signal,
      });
      let data = null;
      try {
        data = await res.json();
      } catch {
        /* not JSON */
      }
      return { status: res.status, data: data || {} };
    } catch (e) {
      return { status: 0, data: { error: 'network', detail: String((e && e.message) || e) } };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async info(force = false) {
      const b = base();
      if (!force && infoCache && infoCache.base === b && Date.now() - infoCache.at < 300000) return infoCache.value;
      const r = await http('/api/info');
      if (r.status === 200 && r.data && r.data.ok) {
        infoCache = { base: b, at: Date.now(), value: r.data };
        return r.data;
      }
      if (r.status === 200) throw new AppError('backend', 'That address does not look like the Tube Inspector backend.');
      throw failFrom(r);
    },
    async video(id, lang) {
      const r = await http(`/api/video?id=${encodeURIComponent(id)}&lang=${encodeURIComponent(lang || 'en')}`, {}, 45000);
      if (r.status === 200) return r.data;
      throw failFrom(r);
    },
    async llm(body) {
      return http('/api/llm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, 200000);
    },
  };
}
