/** Settings in localStorage; saved summaries in IndexedDB (with an in-memory fallback). */

export const DEFAULTS = { backend: '', token: '', lang: 'auto', provider: 'auto', useVideo: true, theme: 'dark' };

function lsGet(k) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function lsSet(k, v) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode: settings last for this session only */
  }
}

let memSettings = null;
export function loadSettings() {
  if (memSettings) return { ...memSettings };
  try {
    return { ...DEFAULTS, ...JSON.parse(lsGet('ti.settings') || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}
export function saveSettings(s) {
  memSettings = { ...s };
  lsSet('ti.settings', JSON.stringify(s));
}
export function flag(name) {
  return lsGet('ti.flag.' + name) === '1';
}
export function setFlag(name) {
  lsSet('ti.flag.' + name, '1');
}

/* ---------------- records ---------------- */

const memRec = new Map();
const memIdx = new Map();
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    try {
      if (typeof indexedDB === 'undefined') throw new Error('no indexedDB');
      const r = indexedDB.open('tube-inspector', 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('records', { keyPath: 'key' });
        r.result.createObjectStore('index', { keyPath: 'key' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error('blocked'));
    } catch (e) {
      reject(e);
    }
  });
  return dbPromise;
}

const wrap = (req) =>
  new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });

const keyOf = (id, lang) => `${id}:${lang}`;

function lightOf(rec) {
  const first = rec.kind === 'talk' && rec.analysis && rec.analysis.labels[0];
  return {
    key: keyOf(rec.id, rec.lang),
    id: rec.id,
    lang: rec.lang,
    title: rec.meta.title,
    author: rec.meta.author,
    thumb: rec.meta.thumb,
    durationSec: rec.meta.durationSec,
    kind: rec.kind,
    createdAt: rec.createdAt,
    labelId: first ? first.id : null,
  };
}

export async function saveRecord(rec) {
  const key = keyOf(rec.id, rec.lang);
  const full = { ...rec, key };
  const light = lightOf(rec);
  memRec.set(key, full);
  memIdx.set(key, light);
  try {
    const db = await openDB();
    const tx = db.transaction(['records', 'index'], 'readwrite');
    tx.objectStore('records').put(full);
    tx.objectStore('index').put(light);
    await new Promise((res, rej) => {
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    });
    await trim(db);
  } catch {
    /* kept in memory for this session */
  }
}

async function trim(db, keep = 60) {
  const all = await wrap(db.transaction('index').objectStore('index').getAll());
  if (all.length <= keep) return;
  all.sort((a, b) => b.createdAt - a.createdAt);
  const drop = all.slice(keep);
  const tx = db.transaction(['records', 'index'], 'readwrite');
  for (const d of drop) {
    tx.objectStore('records').delete(d.key);
    tx.objectStore('index').delete(d.key);
    memRec.delete(d.key);
    memIdx.delete(d.key);
  }
}

export async function getRecord(id, lang) {
  const key = keyOf(id, lang);
  try {
    const db = await openDB();
    const r = await wrap(db.transaction('records').objectStore('records').get(key));
    if (r) return r;
  } catch {
    /* fall back to memory */
  }
  return memRec.get(key) || null;
}

export async function listRecent(limit = 30) {
  let all = [];
  try {
    const db = await openDB();
    all = await wrap(db.transaction('index').objectStore('index').getAll());
  } catch {
    all = [...memIdx.values()];
  }
  if (!all.length) all = [...memIdx.values()];
  return all.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

export async function deleteRecord(key) {
  memRec.delete(key);
  memIdx.delete(key);
  try {
    const db = await openDB();
    const tx = db.transaction(['records', 'index'], 'readwrite');
    tx.objectStore('records').delete(key);
    tx.objectStore('index').delete(key);
  } catch {
    /* ignore */
  }
}

export async function clearAll() {
  memRec.clear();
  memIdx.clear();
  try {
    const db = await openDB();
    const tx = db.transaction(['records', 'index'], 'readwrite');
    tx.objectStore('records').clear();
    tx.objectStore('index').clear();
  } catch {
    /* ignore */
  }
}

export async function saveChat(id, lang, chat) {
  const rec = await getRecord(id, lang);
  if (!rec) return;
  rec.chat = chat.filter((m) => !m.pending).slice(-30);
  await saveRecord(rec);
}
