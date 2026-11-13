import {
  buildRows, rootLocations, filterRows, sortRows, groupByLocation, groupByType,
  toCsv, formatIsk, formatNum, timeAgo, OFFICE_TYPE_ID,
} from './lib.js';

// ---------------------------------------------------------------- config
const CFG = window.EVEASSETS_CONFIG || {};
const SSO = 'https://login.eveonline.com/v2/oauth';
const ESI = 'https://esi.evetech.net';
const IMG = 'https://images.evetech.net';
const SCOPES = [
  'esi-assets.read_assets.v1',
  'esi-assets.read_corporation_assets.v1',
  'esi-universe.read_structures.v1',
  'esi-corporations.read_divisions.v1',
  'esi-characters.read_corporation_roles.v1',
];
const JITA_STATION = 60003760;
const STALE_MS = 60 * 60 * 1000;        // ESI caches assets for 1 hour
const ROW_CAP = 300;                    // rows rendered per group before "show all"
const redirectUri = () => CFG.redirectUri || `${location.origin}/`;
const configured = () => CFG.clientId && !/PASTE/i.test(CFG.clientId);

// ---------------------------------------------------------------- storage
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn('localStorage full?', k, e); } },
};

const idb = (() => {
  let dbp;
  const open = () => (dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open('eveassets', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('snapshots');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('snapshots', mode);
      const req = fn(t.objectStore('snapshots'));
      t.oncomplete = () => res(req?.result);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    all: () => run('readonly', s => s.getAll()),
    put: (k, v) => run('readwrite', s => s.put(v, k)),
    del: k => run('readwrite', s => s.delete(k)),
  };
})();

// ---------------------------------------------------------------- state
const state = {
  chars: ls.get('ea.chars', {}),          // id -> { id, name, corpId, corpName, isDirector, access, refresh, exp }
  disabled: ls.get('ea.disabled', {}),    // ownerKey -> true when unticked
  priceMode: ls.get('ea.priceMode', 'jita_sell'),
  groupBy: ls.get('ea.groupBy', 'location'),
  locSort: ls.get('ea.locSort', 'value_desc'),
  snapshots: {},                          // ownerKey -> snapshot
  errors: {},                             // ownerKey -> message
  busy: null,                             // status text while working
  q: '', location: '', division: '',
  sort: { key: 'value', dir: -1 },
  expanded: new Set(), showAll: new Set(), flatLimit: 500,
  rows: [],
  jitaFailed: false,
};
const names = ls.get('ea.names', {});      // id -> name (types, stations, systems, corps) or null if invalid
const structs = ls.get('ea.structs', {});  // structureId -> { ok, name, ts }
const prices = { avg: {}, jita: {} };

const saveChars = () => ls.set('ea.chars', state.chars);
let namesTimer;
const saveNamesSoon = () => { clearTimeout(namesTimer); namesTimer = setTimeout(() => ls.set('ea.names', names), 500); };

// ---------------------------------------------------------------- helpers
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function decodeJwt(token) {
  const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(decodeURIComponent(escape(atob(part + '='.repeat((4 - part.length % 4) % 4)))));
}

async function pool(items, size, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

function toast(msg, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 9000 : 4000);
}

function setBusy(text) { state.busy = text; renderStatus(); }

// ---------------------------------------------------------------- SSO (PKCE, no client secret)
async function login() {
  if (!configured()) { toast('Add your EVE application Client ID to config.js first.', 'error'); return; }
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const st = b64url(crypto.getRandomValues(new Uint8Array(16)));
  sessionStorage.setItem('ea.pkce', JSON.stringify({ verifier, state: st }));
  const p = new URLSearchParams({
    response_type: 'code', redirect_uri: redirectUri(), client_id: CFG.clientId,
    scope: SCOPES.join(' '), code_challenge: challenge, code_challenge_method: 'S256', state: st,
  });
  location.href = `${SSO}/authorize?${p}`;
}

async function tokenRequest(params) {
  const r = await fetch(`${SSO}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...params, client_id: CFG.clientId }),
  });
  if (!r.ok) {
    const err = new Error(`EVE login failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

function storeToken(tok, existing = {}) {
  const jwt = decodeJwt(tok.access_token);
  const id = Number(String(jwt.sub).split(':').pop());
  const c = state.chars[id] = { ...existing, ...state.chars[id], id, name: jwt.name };
  Object.assign(c, {
    access: tok.access_token,
    refresh: tok.refresh_token || c.refresh,
    exp: jwt.exp * 1000,
    scopes: [].concat(jwt.scp || []),
    needsLogin: false,
  });
  saveChars();
  return id;
}

async function handleCallback(params) {
  const saved = JSON.parse(sessionStorage.getItem('ea.pkce') || 'null');
  sessionStorage.removeItem('ea.pkce');
  history.replaceState(null, '', location.pathname);
  if (params.get('error')) throw new Error(`EVE login: ${params.get('error_description') || params.get('error')}`);
  if (!saved || saved.state !== params.get('state')) throw new Error('Login check failed (state mismatch). Please add the character again.');
  const tok = await tokenRequest({ grant_type: 'authorization_code', code: params.get('code'), code_verifier: saved.verifier });
  return storeToken(tok);
}

const refreshing = {};
async function getToken(id) {
  const c = state.chars[id];
  if (!c) throw new Error('Unknown character');
  if (c.access && c.exp - 60_000 > Date.now()) return c.access;
  return (refreshing[id] ??= (async () => {
    try {
      const tok = await tokenRequest({ grant_type: 'refresh_token', refresh_token: c.refresh });
      storeToken(tok, c);
      return state.chars[id].access;
    } catch (e) {
      if (e.status === 400 || e.status === 401) { c.needsLogin = true; saveChars(); }
      throw e;
    } finally {
      delete refreshing[id];
    }
  })());
}

// ---------------------------------------------------------------- ESI
async function esi(path, { charId, method = 'GET', body, query } = {}) {
  const url = new URL(ESI + path);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
  for (let attempt = 0; attempt < 4; attempt++) {
    const headers = { Accept: 'application/json', 'X-Compatibility-Date': CFG.compatibilityDate || '2025-09-30' };
    if (charId) headers.Authorization = `Bearer ${await getToken(charId)}`;
    if (body) headers['Content-Type'] = 'application/json';
    const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (r.ok) return { data: await r.json(), pages: Number(r.headers.get('X-Pages')) || 1, expires: Date.parse(r.headers.get('Expires')) || null };

    const wait = Number(r.headers.get('Retry-After') || r.headers.get('X-ESI-Error-Limit-Reset')) || 2 ** attempt;
    if (r.status === 420 || r.status === 429 || r.status >= 500) { await sleep(Math.min(wait, 60) * 1000); continue; }
    if (r.status === 401 && charId && attempt === 0) { state.chars[charId].exp = 0; continue; }
    // Back off before ESI's error budget (100 errors/min) runs out and blocks us.
    const remain = r.headers.get('X-ESI-Error-Limit-Remain');
    if (remain !== null && Number(remain) < 15) await sleep(Math.min(wait, 60) * 1000);
    let detail = '';
    try { detail = (await r.json()).error || ''; } catch { /* not JSON */ }
    const err = new Error(`ESI ${r.status} on ${path}${detail ? `: ${detail}` : ''}`);
    err.status = r.status;
    throw err;
  }
  throw new Error(`ESI kept failing on ${path}; try again in a few minutes.`);
}

async function esiPaged(path, opts) {
  const first = await esi(path, { ...opts, query: { page: 1 } });
  const out = [...first.data];
  const rest = Array.from({ length: first.pages - 1 }, (_, i) => i + 2);
  const pages = {};
  await pool(rest, 4, async p => { pages[p] = (await esi(path, { ...opts, query: { page: p } })).data; });
  for (const p of rest) out.push(...pages[p]);
  return { data: out, expires: first.expires };
}

async function resolveNames(ids) {
  const need = [...new Set(ids)].filter(id => id > 0 && id < 2 ** 31 && !(id in names));
  const resolve = async chunk => {
    if (!chunk.length) return;
    try {
      const { data } = await esi('/universe/names', { method: 'POST', body: chunk });
      for (const n of data) names[n.id] = n.name;
      for (const id of chunk) if (!(id in names)) names[id] = null;
    } catch (e) {
      if (e.status !== 404) throw e;
      if (chunk.length === 1) { names[chunk[0]] = null; return; }   // one bad id poisons the whole batch: split
      const m = chunk.length >> 1;
      await resolve(chunk.slice(0, m));
      await resolve(chunk.slice(m));
    }
  };
  for (let i = 0; i < need.length; i += 1000) await resolve(need.slice(i, i + 1000));
  saveNamesSoon();
}

async function resolveStructures(ids, charId) {
  const now = Date.now();
  const need = [...new Set(ids)].filter(id => {
    const s = structs[id];
    return !s || (!s.ok && now - s.ts > 24 * 3600e3) || (s.ok && now - s.ts > 7 * 24 * 3600e3);
  });
  await pool(need, 3, async id => {
    try {
      const { data } = await esi(`/universe/structures/${id}`, { charId });
      structs[id] = { ok: true, name: data.name, ts: now };
    } catch (e) {
      structs[id] = { ok: false, ts: now, status: e.status };
    }
  });
  ls.set('ea.structs', structs);
}

const typeName = id => names[id] || `Type ${id}`;
function locationName(id) {
  if (structs[id]?.ok) return structs[id].name;
  if (names[id]) return names[id];
  if (id === 2004) return 'Asset Safety';
  if (id >= 1e12) return `Structure (no docking access) ${id}`;
  return `Location ${id}`;
}

// ---------------------------------------------------------------- prices
async function loadPrices(typeIds) {
  const avgCache = ls.get('ea.prices', null);
  if (avgCache && Date.now() - avgCache.ts < 6 * 3600e3) prices.avg = avgCache.avg;
  else {
    try {
      const { data } = await esi('/markets/prices');
      prices.avg = Object.fromEntries(data.map(p => [p.type_id, p.average_price ?? p.adjusted_price ?? 0]));
      ls.set('ea.prices', { ts: Date.now(), avg: prices.avg });
    } catch (e) { console.warn('ESI prices failed', e); if (avgCache) prices.avg = avgCache.avg; }
  }

  let jc = ls.get('ea.jita', null);
  if (!jc || Date.now() - jc.ts > 3600e3) jc = { ts: Date.now(), map: {} };
  prices.jita = jc.map;
  if (state.priceMode === 'esi_avg') return;
  const missing = [...new Set(typeIds)].filter(id => !(id in jc.map));
  state.jitaFailed = false;
  const chunks = [];
  for (let i = 0; i < missing.length; i += 200) chunks.push(missing.slice(i, i + 200));
  await pool(chunks, 3, async chunk => {
    try {
      const r = await fetch(`https://market.fuzzwork.co.uk/aggregates/?station=${JITA_STATION}&types=${chunk.join(',')}`);
      if (!r.ok) throw new Error(r.status);
      const data = await r.json();
      for (const id of chunk) {
        const d = data[id];
        jc.map[id] = { b: parseFloat(d?.buy?.max) || 0, s: parseFloat(d?.sell?.min) || 0 };
      }
    } catch (e) {
      state.jitaFailed = true;
      console.warn('Jita prices failed', e);
    }
  });
  ls.set('ea.jita', jc);
}

function unitPrice(typeId, isBpc) {
  if (isBpc) return 0;   // copies have no meaningful market price
  const j = prices.jita[typeId];
  if (state.priceMode === 'jita_sell' && j?.s) return j.s;
  if (state.priceMode === 'jita_buy' && j?.b) return j.b;
  return prices.avg[typeId] || 0;
}

// ---------------------------------------------------------------- owners & fetching
function owners() {
  const list = [];
  const corps = new Map();
  for (const c of Object.values(state.chars)) {
    list.push({ key: `c:${c.id}`, kind: 'char', id: c.id, name: c.name, viaChar: c.id });
    if (c.isDirector && c.corpId && !corps.has(c.corpId) && !c.needsLogin) {
      corps.set(c.corpId, { key: `k:${c.corpId}`, kind: 'corp', id: c.corpId, name: c.corpName || `Corporation ${c.corpId}`, viaChar: c.id });
    }
  }
  return [...list, ...corps.values()];
}

async function updateCharInfo(id) {
  const c = state.chars[id];
  const { data: pub } = await esi(`/characters/${id}`);
  c.corpId = pub.corporation_id;
  await resolveNames([c.corpId]);
  c.corpName = names[c.corpId] || `Corporation ${c.corpId}`;
  try {
    const { data } = await esi(`/characters/${id}/roles`, { charId: id });
    c.isDirector = (data.roles || []).includes('Director');
  } catch { c.isDirector = false; }
  saveChars();
}

async function fetchOwner(o) {
  const base = o.kind === 'char' ? `/characters/${o.id}` : `/corporations/${o.id}`;
  const { data: assets, expires } = await esiPaged(`${base}/assets`, { charId: o.viaChar });

  const ids = new Set(assets.map(a => a.item_id));
  const parents = new Set(assets.filter(a => ids.has(a.location_id)).map(a => a.location_id));
  const nameIds = assets
    .filter(a => a.is_singleton && a.type_id !== OFFICE_TYPE_ID && (parents.has(a.item_id) || /^(Hangar|CorpSAG\d)$/.test(a.location_flag)))
    .map(a => a.item_id);
  const itemNames = {};
  for (let i = 0; i < nameIds.length; i += 1000) {
    try {
      const { data } = await esi(`${base}/assets/names`, { method: 'POST', body: nameIds.slice(i, i + 1000), charId: o.viaChar });
      for (const n of data) if (n.name && n.name !== 'None') itemNames[n.item_id] = n.name;
    } catch (e) { console.warn('asset names failed', e); }
  }

  const divisions = {};
  if (o.kind === 'corp') {
    try {
      const { data } = await esi(`/corporations/${o.id}/divisions`, { charId: o.viaChar });
      for (const h of data.hangar || []) if (h.name) divisions[h.division] = h.name;
    } catch (e) { console.warn('divisions failed', e); }
  }

  const roots = rootLocations(assets);
  await resolveNames([...assets.map(a => a.type_id), ...roots]);
  await resolveStructures(roots.filter(id => id >= 1e12), o.viaChar);

  const now = Date.now();
  const expiresAt = expires && expires > now ? expires : now + STALE_MS;
  const snap = { ownerKey: o.key, ownerName: o.name, kind: o.kind, fetchedAt: now, expiresAt, assets, itemNames, divisions };
  state.snapshots[o.key] = snap;
  await idb.put(o.key, snap);
}

async function refresh(list, { charInfo = true } = {}) {
  if (state.busy) return;
  try {
    if (charInfo) {
      const charIds = [...new Set(list.map(o => o.viaChar))];
      for (const id of charIds) {
        setBusy(`Checking ${state.chars[id]?.name}…`);
        try { await updateCharInfo(id); } catch (e) { state.errors[`c:${id}`] = e.message; }
      }
      // A character may have just gained Director: pick up the corp entry too.
      for (const o of owners()) if (!list.some(x => x.key === o.key) && charIds.includes(o.viaChar)) list.push(o);
    }
    for (const o of list) {
      setBusy(`Loading ${o.name} assets…`);
      delete state.errors[o.key];
      try { await fetchOwner(o); } catch (e) { state.errors[o.key] = e.message; toast(`${o.name}: ${e.message}`, 'error'); }
      renderOwners();
    }
    setBusy('Pricing…');
    await loadPrices(allTypeIds());
  } finally {
    setBusy(null);
    rebuild();
  }
}

// When ESI will hand out fresh data for this owner (asset data is cached up to 1 hour).
const nextUpdate = o => {
  const snap = state.snapshots[o.key];
  if (!snap) return 0;
  return snap.expiresAt || snap.fetchedAt + STALE_MS;
};
const activeOwners = () => owners().filter(o => !state.chars[o.viaChar]?.needsLogin);
// One shared refresh time: when the owner whose ESI cache expires last is ready, refresh everyone together.
const refreshAt = () => Math.max(0, ...activeOwners().map(nextUpdate));

function fmtCountdown(ms) {
  const t = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), sec = t % 60;
  const pad = n => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function updateTimers() {
  const btn = $('#refreshBtn');
  const list = activeOwners();
  if (state.busy || !list.length) { btn.textContent = 'Refresh'; btn.disabled = true; return; }
  const left = refreshAt() - Date.now();
  btn.disabled = left > 0;
  btn.textContent = left > 0 ? `Next refresh in ${fmtCountdown(left)}` : 'Refresh';
  btn.title = left > 0 ? 'ESI is still serving cached asset data. Refresh unlocks when every owner has fresh data available.' : '';
}

const allTypeIds = () => Object.values(state.snapshots).flatMap(s => s.assets.map(a => a.type_id));

async function removeChar(id) {
  const c = state.chars[id];
  if (!c || !confirm(`Remove ${c.name}? Saved tokens and cached assets for this character are deleted from this browser.`)) return;
  delete state.chars[id];
  saveChars();
  await idb.del(`c:${id}`);
  delete state.snapshots[`c:${id}`];
  if (c.corpId && !owners().some(o => o.key === `k:${c.corpId}`)) {
    await idb.del(`k:${c.corpId}`);
    delete state.snapshots[`k:${c.corpId}`];
  }
  rebuild();
}

// ---------------------------------------------------------------- rows
function rebuild() {
  const ctx = { typeName, locationName, unitPrice };
  state.rows = owners()
    .filter(o => !state.disabled[o.key] && state.snapshots[o.key])
    .flatMap(o => buildRows({ ...state.snapshots[o.key], ownerName: o.name }, ctx));
  render();
}

function filtered() {
  return filterRows(state.rows, { q: state.q, location: state.location, division: state.division });
}

// ---------------------------------------------------------------- render
function render() {
  renderStatus();
  renderOwners();
  const rows = filtered();
  renderStats(rows);
  renderFilterOptions();
  renderContent(rows);
}

function renderStatus() {
  $('#status').textContent = state.busy || '';
  $('#status').classList.toggle('working', !!state.busy);
  updateTimers();
  $('#setup').hidden = configured();
}

function renderOwners() {
  const list = owners();
  if (!list.length) {
    $('#owners').innerHTML = '<p class="empty">No characters yet. Use <b>Add character</b> to log in with EVE Online.</p>';
    return;
  }
  $('#owners').innerHTML = list.map(o => {
    const snap = state.snapshots[o.key];
    const c = state.chars[o.viaChar];
    const img = o.kind === 'char' ? `${IMG}/characters/${o.id}/portrait?size=64` : `${IMG}/corporations/${o.id}/logo?size=64`;
    const err = state.errors[o.key];
    const parts = [];
    if (c?.needsLogin && o.kind === 'char') parts.push('<span class="warn">Login expired. Add again</span>');
    else if (err) parts.push(`<span class="warn" title="${esc(err)}">Last refresh failed, hover for detail</span>`);
    parts.push(snap ? `${formatNum(snap.assets.length)} items · updated ${timeAgo(snap.fetchedAt)}` : 'Not loaded yet');
    const meta = parts.join('<br>');
    return `<div class="owner ${o.kind}">
      <label><input type="checkbox" data-owner="${o.key}" ${state.disabled[o.key] ? '' : 'checked'}>
        <img src="${img}" alt="" loading="lazy">
        <span><b>${esc(o.name)}</b><small>${o.kind === 'corp' ? `Corporation · via ${esc(c?.name)}<br>` : ''}${meta}</small></span>
      </label>
      ${o.kind === 'char' ? `<button class="icon" data-remove="${o.id}" title="Remove character">×</button>` : ''}
    </div>`;
  }).join('');
  updateTimers();
}

function renderStats(rows) {
  const value = rows.reduce((s, r) => s + r.value, 0);
  const locs = new Set(rows.map(r => r.locationId)).size;
  const types = new Set(rows.map(r => r.typeId)).size;
  const label = { jita_sell: 'Jita sell', jita_buy: 'Jita buy', esi_avg: 'ESI average' }[state.priceMode];
  $('#stats').innerHTML = `
    <div class="stat"><span>Estimated value</span><b>${formatIsk(value)} ISK</b><small>${label} prices</small></div>
    <div class="stat"><span>Item stacks</span><b>${formatNum(rows.length)}</b></div>
    <div class="stat"><span>Item types</span><b>${formatNum(types)}</b></div>
    <div class="stat"><span>Locations</span><b>${formatNum(locs)}</b></div>`;
  $('#notice').innerHTML = state.jitaFailed && state.priceMode !== 'esi_avg'
    ? '<div class="banner small">Some Jita prices could not be loaded, so those items use ESI average prices.</div>' : '';
}

function renderFilterOptions() {
  const locs = groupByLocation(state.rows);
  const sel = $('#locationFilter');
  sel.innerHTML = '<option value="">All locations</option>' +
    locs.map(g => `<option value="${g.id}" ${String(g.id) === state.location ? 'selected' : ''}>${esc(g.name)} (${formatIsk(g.value)})</option>`).join('');
  const divs = [...new Set(state.rows.map(r => r.division).filter(Boolean))].sort();
  $('#divisionFilter').innerHTML = '<option value="">All divisions</option>' +
    divs.map(d => `<option ${d === state.division ? 'selected' : ''}>${esc(d)}</option>`).join('');
  $('#divisionFilter').hidden = !divs.length;
  $('#groupBy').value = state.groupBy;
  $('#locSort').value = state.locSort;
  $('#locSortField').hidden = state.groupBy !== 'location';
  $('#priceMode').value = state.priceMode;
}

const th = (key, label, cls = '') => {
  const on = state.sort.key === key;
  return `<th class="${cls} sortable ${on ? 'on' : ''}" data-sort="${key}">${label}${on ? (state.sort.dir < 0 ? ' ▾' : ' ▴') : ''}</th>`;
};

function itemCell(r) {
  return `<td><div class="item"><span>${esc(r.name)}${r.isBpc ? ' <i class="tag">BPC</i>' : ''}${r.customName ? `<small>“${esc(r.customName)}”</small>` : ''}</span></div></td>`;
}

function rowHtml(r, showLoc) {
  const where = [r.container, r.slot].filter(Boolean).join(' · ');
  return `<tr>${itemCell(r)}
    <td class="num">${formatNum(r.qty)}</td>
    ${showLoc ? `<td>${esc(r.location)}</td>` : ''}
    <td class="dim">${esc(where)}</td>
    <td class="dim">${esc(r.division)}</td>
    <td class="dim">${esc(r.owner)}</td>
    <td class="num dim">${r.unit ? formatIsk(r.unit) : '—'}</td>
    <td class="num">${r.value ? formatIsk(r.value) : '—'}</td></tr>`;
}

const head = showLoc => `<thead><tr>${th('name', 'Item')}${th('qty', 'Qty', 'num')}${showLoc ? th('location', 'Location') : ''}
  <th>Container / slot</th><th>Division</th>${th('owner', 'Owner')}${th('unit', 'Unit', 'num')}${th('value', 'Value', 'num')}</tr></thead>`;

function sortGroups(groups) {
  const by = {
    value_desc: (a, b) => b.value - a.value,
    value_asc: (a, b) => a.value - b.value,
    stacks_desc: (a, b) => b.rows.length - a.rows.length,
    name_asc: (a, b) => a.name.localeCompare(b.name),
  }[state.locSort] || ((a, b) => b.value - a.value);
  return [...groups].sort(by);
}

function renderContent(rows) {
  const el = $('#content');
  if (!state.rows.length) {
    el.innerHTML = `<div class="empty big">${Object.keys(state.chars).length
      ? (state.busy ? 'Loading assets…' : 'No assets loaded. Press <b>Refresh</b>.')
      : 'Add a character to see your assets.'}</div>`;
    return;
  }
  if (!rows.length) { el.innerHTML = '<div class="empty big">Nothing matches these filters.</div>'; return; }

  if (state.groupBy === 'type') {
    const groups = sortRows(groupByType(rows), state.sort);
    const shown = groups.slice(0, state.flatLimit);
    el.innerHTML = `<table><thead><tr>${th('name', 'Item')}${th('qty', 'Total qty', 'num')}${th('locations', 'Locations', 'num')}<th>Owners</th>${th('unit', 'Unit', 'num')}${th('value', 'Value', 'num')}</tr></thead><tbody>
      ${shown.map(g => `<tr class="click" data-type-name="${esc(g.name)}" title="Show where these are">${itemCell(g)}
        <td class="num">${formatNum(g.qty)}</td><td class="num">${g.locations}</td><td class="dim">${esc(g.owner)}</td>
        <td class="num dim">${g.unit ? formatIsk(g.unit) : '—'}</td><td class="num">${g.value ? formatIsk(g.value) : '—'}</td></tr>`).join('')}
      </tbody></table>${groups.length > shown.length ? `<button class="more" data-more>Show more (${formatNum(groups.length - shown.length)} left)</button>` : ''}`;
    return;
  }

  if (state.groupBy === 'none') {
    const sorted = sortRows(rows, state.sort);
    const shown = sorted.slice(0, state.flatLimit);
    el.innerHTML = `<table>${head(true)}<tbody>${shown.map(r => rowHtml(r, true)).join('')}</tbody></table>
      ${sorted.length > shown.length ? `<button class="more" data-more>Show more (${formatNum(sorted.length - shown.length)} left)</button>` : ''}`;
    return;
  }

  const total = rows.reduce((s, r) => s + r.value, 0);
  const groups = sortGroups(groupByLocation(rows));
  const autoOpen = !!(state.q || state.location) || groups.length === 1;
  el.innerHTML = groups.map(g => {
    const open = autoOpen || state.expanded.has(g.id);
    let body = '';
    if (open) {
      const sorted = sortRows(g.rows, state.sort);
      const shown = state.showAll.has(g.id) ? sorted : sorted.slice(0, ROW_CAP);
      body = `<table>${head(false)}<tbody>${shown.map(r => rowHtml(r, false)).join('')}</tbody></table>
        ${sorted.length > shown.length ? `<button class="more" data-showall="${g.id}">Show all ${formatNum(sorted.length)} stacks</button>` : ''}`;
    }
    return `<section class="group ${open ? 'open' : ''}">
      <button class="group-head" data-loc="${g.id}"><span class="caret">${open ? '▾' : '▸'}</span>
        <span class="gname">${esc(g.name)}</span><span class="share" title="Share of the total value shown">${total ? `${(g.value / total * 100).toFixed(1)}%` : ''}</span><span class="dim">${formatNum(g.rows.length)} ${g.rows.length === 1 ? 'stack' : 'stacks'}</span><b>${formatIsk(g.value)} ISK</b></button>
      ${body}</section>`;
  }).join('');
}

// ---------------------------------------------------------------- events
function bindUi() {
  $('#addBtn').addEventListener('click', login);
  $('#refreshBtn').addEventListener('click', () => { if (Date.now() >= refreshAt()) refresh(activeOwners()); });
  let t;
  $('#search').addEventListener('input', e => { clearTimeout(t); t = setTimeout(() => { state.q = e.target.value.trim(); state.flatLimit = 500; render(); }, 200); });
  $('#locationFilter').addEventListener('change', e => { state.location = e.target.value; render(); });
  $('#divisionFilter').addEventListener('change', e => { state.division = e.target.value; render(); });
  $('#locSort').addEventListener('change', e => { state.locSort = e.target.value; ls.set('ea.locSort', state.locSort); render(); });
  $('#groupBy').addEventListener('change', e => { state.groupBy = e.target.value; ls.set('ea.groupBy', state.groupBy); state.flatLimit = 500; render(); });
  $('#priceMode').addEventListener('change', async e => {
    state.priceMode = e.target.value;
    ls.set('ea.priceMode', state.priceMode);
    setBusy('Pricing…');
    try { await loadPrices(allTypeIds()); } finally { setBusy(null); rebuild(); }
  });
  $('#exportBtn').addEventListener('click', () => {
    const rows = sortRows(filtered(), state.sort);
    if (!rows.length) { toast('Nothing to export.'); return; }
    const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `eve-assets-${new Date().toISOString().slice(0, 10)}.csv` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  $('#owners').addEventListener('change', e => {
    const key = e.target.dataset.owner;
    if (!key) return;
    if (e.target.checked) delete state.disabled[key]; else state.disabled[key] = true;
    ls.set('ea.disabled', state.disabled);
    rebuild();
  });
  $('#owners').addEventListener('click', e => {
    const id = e.target.closest('[data-remove]')?.dataset.remove;
    if (id) removeChar(Number(id));
  });

  $('#content').addEventListener('click', e => {
    const s = e.target.closest('[data-sort]');
    if (s) {
      const key = s.dataset.sort;
      state.sort = state.sort.key === key ? { key, dir: -state.sort.dir } : { key, dir: ['name', 'owner', 'location'].includes(key) ? 1 : -1 };
      render();
      return;
    }
    const loc = e.target.closest('[data-loc]');
    if (loc) {
      const id = Number(loc.dataset.loc);
      state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id);
      renderContent(filtered());
      return;
    }
    const all = e.target.closest('[data-showall]');
    if (all) { state.showAll.add(Number(all.dataset.showall)); renderContent(filtered()); return; }
    if (e.target.closest('[data-more]')) { state.flatLimit += 500; renderContent(filtered()); return; }
    const type = e.target.closest('[data-type-name]');
    if (type) {
      state.q = type.dataset.typeName;
      $('#search').value = state.q;
      state.groupBy = 'location';
      render();
    }
  });
}

// ---------------------------------------------------------------- start
async function init() {
  bindUi();
  try {
    for (const s of (await idb.all()) || []) state.snapshots[s.ownerKey] = s;
  } catch (e) { console.warn('IndexedDB unavailable', e); }
  prices.avg = ls.get('ea.prices', { avg: {} }).avg;
  prices.jita = ls.get('ea.jita', { map: {} }).map;
  rebuild();

  const p = new URLSearchParams(location.search);
  if (p.has('code') || p.has('error')) {
    try {
      const id = await handleCallback(p);
      toast(`Added ${state.chars[id].name}`);
      await refresh(owners().filter(o => o.viaChar === id));
      return;
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  setInterval(updateTimers, 1000);
  if (configured()) {
    if (Date.now() >= refreshAt()) refresh(activeOwners());
    else {
      const never = activeOwners().filter(o => !state.snapshots[o.key]);
      if (never.length) refresh(never);
    }
  }
}

init();
