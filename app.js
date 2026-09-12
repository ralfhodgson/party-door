// Party door check-in. Three views on one page, chosen by the link:
//   #door/<key>  security: search + check in
//   #add/<key>   trusted people: add walk-ins
//   #host/<key>  host: dashboard, edit, import, export, settings
import { createDemoStore } from './store-demo.js';
import { parseCsv, buildGuests, norm, splitName, cleanPhone, cleanHandle } from './partiful.js';

// Storage that never throws (private browsing, blocked site data, restricted frames).
const safeStore = (getter) => {
  let s = null;
  try { s = getter(); } catch { s = null; }
  return {
    get: (k) => { try { return s ? s.getItem(k) : null; } catch { return null; } },
    set: (k, v) => { try { if (s) s.setItem(k, v); } catch { /* ignore */ } },
    del: (k) => { try { if (s) s.removeItem(k); } catch { /* ignore */ } },
  };
};
const LS = safeStore(() => window.localStorage);
const SS = safeStore(() => window.sessionStorage);
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const appEl = $('#app'), sheetEl = $('#sheet'), overlayEl = $('#overlay'), toastEl = $('#toast');
const params = new URLSearchParams(location.search);
const DEMO = params.get('demo') === '1' || !window.FIREBASE_CONFIG;
const NOSW = params.get('nosw') === '1' || DEMO;
const VIEW_ROLE = { door: 'door', add: 'adder', host: 'host' };
const ALLOWED = { door: ['door', 'adder', 'host'], add: ['adder', 'host'], host: ['host'] };
const STATIC_FIELDS = ['name', 'first', 'last', 'search', 'phone3', 'rsvp', 'source', 'pink', 'plusOf', 'plusIndex', 'plusTotal', 'plusNamed', 'note', 'handle', 'inviter'];

const S = {
  store: null, role: 'none', view: null, mounted: null,
  guests: new Map(), kids: new Map(), meta: {}, status: { online: true, pending: false },
  query: '', tab: 'search', station: '',
  priv: new Map(), hostTab: 'live', hostQuery: '', sheet: null, toastTimer: null, toastUndo: null,
  pin: null, importPreview: null, confirmDelete: null,
};

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nowIso = () => new Date().toISOString();
const tokens = (s) => norm(s).split(' ').filter(Boolean);
const newId = (p) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const handleOf = (g) => (g.handle ? '@' + String(g.handle).replace(/^@+/, '') : '');
const firstName = (g) => g.first || String(g.name || '').split(' ')[0] || 'them';
function fmtTime(iso) { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }
function fmtDateTime(iso) { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
function friendlyErr(e) {
  const s = String((e && (e.code || e.message)) || e || '');
  if (/permission|denied/i.test(s)) return 'this link is not allowed to do that';
  if (/operation-not-allowed|admin-restricted/i.test(s)) return 'anonymous sign-in is switched off in Firebase (Authentication → Sign-in method → Anonymous)';
  if (/network-request-failed|unavailable|offline/i.test(s)) return 'no connection to the database';
  return s.slice(0, 140);
}
function write(promise, failMsg) { if (promise && promise.catch) promise.catch((e) => toast(`${esc(failMsg)}: ${esc(friendlyErr(e))}`, 'err', { ms: 6000 })); }

// Damerau-Levenshtein distance <= 1 (one typo, missing/extra letter or swapped pair).
function within1(a, b) {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (edits) return false;
    edits = 1;
    if (la === lb) { if (a[i + 1] === b[j] && a[i] === b[j + 1]) { i += 2; j += 2; } else { i++; j++; } }
    else if (la > lb) i++; else j++;
  }
  return edits === 0 || (i === la && j === lb);
}

// Every field is searchable. Weights: the guest's own name > handle/email > inviter/note.
// Handles and emails also match on substring, since they are often run together ("ameliaclarke99").
const FIELD_WEIGHT = { name: 1, handle: 0.8, email: 0.8, inviter: 0.4, note: 0.4 };
function scoreGuest(qt, g) {
  let score = 0;
  for (const q of qt) {
    let best = 0;
    for (const { t, kind } of g._toks) {
      const w = FIELD_WEIGHT[kind] || 0.4;
      let s = 0;
      if (t === q) s = 10;
      else if (t.startsWith(q)) s = 6;
      else if ((kind === 'handle' || kind === 'email') && q.length >= 3 && t.includes(q)) s = 5;
      else if (q.length >= 4) {
        if (Math.abs(t.length - q.length) <= 1 && within1(q, t)) s = 3;
        else if (t.length > q.length && within1(q, t.slice(0, q.length))) s = 2;
      }
      s *= w;
      if (s > best) best = s;
    }
    if (!best) return 0;
    score += best;
  }
  if (g._toks.length && g._toks[0].kind === 'name' && g._toks[0].t.startsWith(qt[0])) score += 1;
  return score;
}

function indexGuests() {
  const kids = new Map();
  const nameCount = new Map();
  for (const g of S.guests.values()) {
    if (!g.search) g.search = norm(g.name);
    nameCount.set(g.search, (nameCount.get(g.search) || 0) + 1);
    if (g.plusOf) { if (!kids.has(g.plusOf)) kids.set(g.plusOf, []); kids.get(g.plusOf).push(g); }
  }
  for (const arr of kids.values()) arr.sort((a, b) => (a.plusIndex || 0) - (b.plusIndex || 0) || String(a.name).localeCompare(String(b.name)));
  S.kids = kids;
  for (const g of S.guests.values()) {
    const toks = tokens(g.name).map((t) => ({ t, kind: 'name' }));
    if (g.handle) { const h = norm(g.handle).replace(/ /g, ''); toks.push({ t: h, kind: 'handle' }); for (const t of tokens(g.handle)) if (t !== h) toks.push({ t, kind: 'handle' }); }
    const inv = g.plusOf ? S.guests.get(g.plusOf) : null;
    g._inviterName = inv ? inv.name : (g.inviter || '');
    if (g._inviterName) for (const t of tokens(g._inviterName)) toks.push({ t, kind: 'inviter' });
    if (g.note) for (const t of tokens(g.note)) toks.push({ t, kind: 'note' });
    const p = S.priv.get(g.id);
    if (p && p.email) { const e = String(p.email).toLowerCase(); toks.push({ t: e.replace(/[^a-z0-9]/g, ''), kind: 'email' }); for (const t of tokens(e)) toks.push({ t, kind: 'email' }); }
    g._digits = ((p && p.phone) ? String(p.phone).replace(/\D/g, '') : '') || g.phone3 || '';
    g._toks = toks;
    g._dupCount = nameCount.get(g.search) || 0;
    g._dup = g._dupCount > 1;
  }
}

function search(q) {
  const qn = norm(q);
  if (!qn) return [];
  const out = [];
  if (/^\d{2,}$/.test(qn.replace(/ /g, ''))) {
    const d = qn.replace(/ /g, '');
    for (const g of S.guests.values()) if (g._digits && (g._digits.includes(d) || (g.phone3 && d.endsWith(g.phone3)))) out.push({ g, score: g._digits.endsWith(d) ? 6 : 5 });
  } else {
    const qt = qn.split(' ');
    for (const g of S.guests.values()) { const sc = scoreGuest(qt, g); if (sc) out.push({ g, score: sc }); }
  }
  out.sort((a, b) => b.score - a.score || (a.g.checkedIn === b.g.checkedIn ? 0 : a.g.checkedIn ? 1 : -1) || String(a.g.name).localeCompare(String(b.g.name)));
  return out.slice(0, 40).map((x) => x.g);
}

function stats() {
  const st = { total: 0, arrived: 0, pinkTotal: 0, pinkGiven: 0, overrides: 0, walkins: 0, walkinsArrived: 0, plus: 0, plusArrived: 0, byStation: new Map() };
  for (const g of S.guests.values()) {
    st.total++;
    if (g.checkedIn) { st.arrived++; const k = g.checkedInBy || 'Unknown'; st.byStation.set(k, (st.byStation.get(k) || 0) + 1); }
    if (g.pink) st.pinkTotal++;
    if (g.pinkGiven) { st.pinkGiven++; if (!g.pink) st.overrides++; }
    if (g.source === 'walkin') { st.walkins++; if (g.checkedIn) st.walkinsArrived++; }
    if (g.plusOf) { st.plus++; if (g.checkedIn) st.plusArrived++; }
  }
  return st;
}

// ---------- actions ----------
function checkIn(id) {
  const g = S.guests.get(id);
  if (!g || g.checkedIn) return false;
  const at = nowIso();
  const patch = { checkedIn: true, checkedInAt: at, checkedInBy: S.station || 'Door', checkedInByUid: S.store.uid, updatedAt: at };
  if (g.pink) { patch.pinkGiven = true; patch.pinkGivenAt = at; }
  write(S.store.updateGuest(id, patch), `Could not check in ${g.name}`);
  S.store.logEvent({ type: 'checkin', guestId: id, name: g.name, station: S.station || 'Door', pink: !!g.pink });
  return true;
}
function undoCheckIn(id) {
  const g = S.guests.get(id);
  if (!g || !g.checkedIn) return;
  write(S.store.updateGuest(id, { checkedIn: false, checkedInAt: null, checkedInBy: null, checkedInByUid: null, pinkGiven: false, pinkGivenAt: null, updatedAt: nowIso() }), `Could not undo ${g.name}`);
  S.store.logEvent({ type: 'undo', guestId: id, name: g.name, station: S.station || 'Door' });
}
function setPinkGiven(id, val) {
  const g = S.guests.get(id);
  if (!g) return;
  write(S.store.updateGuest(id, { pinkGiven: !!val, pinkGivenAt: val ? nowIso() : null, updatedAt: nowIso() }), 'Could not update pink');
  S.store.logEvent({ type: val ? 'pink' : 'unpink', guestId: id, name: g.name, station: S.station || 'Door', override: !g.pink });
}
function nameGuest(id, name) {
  const g = S.guests.get(id);
  name = String(name || '').trim();
  if (!g || !name) return;
  const { first, last } = splitName(name);
  write(S.store.updateGuest(id, { name, first, last, search: norm(name), plusNamed: true, updatedAt: nowIso() }), 'Could not save the name');
}

// ---------- boot & routing ----------
function parseRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  const [view, ...rest] = h.split('/');
  return { view: VIEW_ROLE[view] ? view : null, key: rest.length ? decodeURIComponent(rest.join('/')) : '' };
}
const defaultView = (role) => (role === 'host' ? 'host' : role === 'adder' ? 'add' : role === 'door' ? 'door' : null);

async function boot() {
  if ('serviceWorker' in navigator && !NOSW) navigator.serviceWorker.register('./sw.js').catch(() => {});
  try {
    if (DEMO) S.store = await createDemoStore();
    else { const m = await import('./store-firebase.js'); S.store = await m.createFirebaseStore(window.FIREBASE_CONFIG); }
  } catch (e) {
    renderGate('Could not start', `The app could not connect. ${esc(friendlyErr(e))}`, true);
    return;
  }
  const route = parseRoute();
  if (route.key && route.view) {
    renderGate('Activating link…', 'One moment.');
    let ok = false;
    try { ok = await S.store.claimRole(VIEW_ROLE[route.view], route.key); }
    catch (e) { renderGate('No connection', esc(e.message || 'Connect to the internet and reload.'), true); return; }
    if (!ok) { renderGate('This link is not valid', 'Check the whole link was copied, or ask the host for a fresh one.', true); return; }
  }
  S.role = (await S.store.refreshRole()) || 'none';
  const view = route.view || defaultView(S.role);
  if (!view && DEMO) { renderDemoChooser(); return; }
  if (!view || !ALLOWED[view].includes(S.role)) {
    renderGate('This device needs a link', S.role === 'none'
      ? 'Open the door, add-guests or host link you were sent. A device only needs to open its link once.'
      : `This device has the <b>${esc(S.role)}</b> link, which does not open the ${esc(view || '')} view. Ask the host for the right link.`);
    return;
  }
  await enterView(view);
}

async function enterView(view) {
  S.view = view;
  S.store.onStatus((st) => { S.status = st; renderDot(); });
  S.store.onMeta((m) => { S.meta = m || {}; document.title = S.meta.name ? `${S.meta.name} · Door` : 'Door'; if (S.mounted) refresh('meta'); });
  S.store.onGuests((map) => { S.guests = map; indexGuests(); if (S.mounted) refresh('guests'); },
    () => renderGate('Access problem', 'This device is not allowed to see the list any more. Open the link you were sent again.', true));
  if (S.view === 'host') { try { S.priv = await S.store.loadPrivate(); } catch { S.priv = new Map(); } indexGuests(); }
  mount();
}

// Demo mode only: no link needed, pick a view. Data is sample data kept in this browser.
function renderDemoChooser() {
  S.mounted = null;
  appEl.innerHTML = `<div class="gate"><h1>Demo: choose a view</h1>
    <p class="muted">Sample names only, saved in this browser. Open two tabs (say Door and Host) to watch them stay in sync. The real version opens straight into the right view from its link.</p>
    <div class="stationpick" style="grid-template-columns:1fr">
      <button class="btn primary" data-act="demo-enter" data-view="door">Door: security check-in</button>
      <button class="btn" data-act="demo-enter" data-view="add">Add guests on the night</button>
      <button class="btn" data-act="demo-enter" data-view="host">Host: dashboard, import, export</button>
    </div>
    <p class="muted" style="margin-top:18px">Tip: on an iPad, use Share → Add to Home Screen for a full-screen app.</p></div>`;
}
async function demoEnter(view) {
  await S.store.claimRole(VIEW_ROLE[view], 'demo');
  S.role = VIEW_ROLE[view];
  try { history.replaceState(null, '', `#${view}/demo`); } catch { /* sandboxed frames may refuse */ }
  await enterView(view);
}
function demoSwitch() {
  try { SS.del('pd-demo-role'); SS.del('pd-unlocked'); history.replaceState(null, '', location.pathname + location.search); } catch { /* ignore */ }
  closeSheet();
  S.role = 'none'; S.view = null; S.mounted = null;
  renderDemoChooser();
}

function mount() {
  closeSheet();
  // One door: the label just says where the action came from (door iPad, add link, host).
  S.station = S.view === 'door' ? 'Door' : S.view === 'add' ? 'Add link' : 'Host';
  if (S.view === 'host') {
    if (!LS.get('pd-pin')) { renderPinGate('set'); return; }
    if (SS.get('pd-unlocked') !== '1') { renderPinGate('enter'); return; }
  }
  if (S.view === 'door') mountDoor();
  else if (S.view === 'add') mountAdd();
  else mountHost();
}

function refresh(kind) {
  if (S.mounted === 'door') { renderHeader(); renderResults(); renderRecent(); }
  else if (S.mounted === 'add') { renderHeader(); renderOwnList(); renderResults(); }
  else if (S.mounted === 'host') { renderHeader(); renderHostPane(false); }
  if (S.sheet && S.sheet.type === 'guest') renderSheet();
  if (kind === 'meta' && S.mounted === 'host' && S.hostTab === 'settings' && !$('#s-name:focus')) renderHostPane(true);
}

// ---------- gates ----------
function renderGate(title, body, showReload) {
  S.mounted = null;
  appEl.innerHTML = `<div class="gate"><h1>${esc(title)}</h1><p class="muted">${body}</p>${showReload ? '<button class="btn primary" data-act="reload">Reload</button>' : ''}${DEMO ? '<p class="muted" style="margin-top:24px">Demo mode. Try <code>#door/x</code>, <code>#add/x</code> or <code>#host/x</code>.</p>' : ''}</div>`;
}

function renderPinGate(mode, msg) {
  S.mounted = null;
  const first = S.pin && S.pin.mode === 'confirm' ? S.pin.first : '';
  S.pin = { mode, buf: '', first };
  const titles = { set: 'Choose a 4-digit host PIN', confirm: 'Enter it again', enter: 'Host PIN' };
  appEl.innerHTML = `<div class="gate center"><h1>${titles[mode]}</h1><p class="muted">${msg || (mode === 'enter' ? 'Protects editing, deleting and export on this device.' : 'Needed each time the host view opens on this device.')}</p>
    <div class="pindots">${[0, 1, 2, 3].map(() => '<span></span>').join('')}</div>
    <div class="pinpad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => `<button class="btn" data-act="pin-digit" data-d="${d}">${d}</button>`).join('')}<button class="btn ghost" data-act="pin-back">⌫</button><button class="btn" data-act="pin-digit" data-d="0">0</button><span></span></div></div>`;
}
function pinDigit(d) {
  if (!S.pin) return;
  S.pin.buf = (S.pin.buf + d).slice(0, 4);
  $$('.pindots span').forEach((el, i) => el.classList.toggle('on', i < S.pin.buf.length));
  if (S.pin.buf.length < 4) return;
  const buf = S.pin.buf;
  if (S.pin.mode === 'set') { S.pin = { mode: 'confirm', buf: '', first: buf }; renderPinGate('confirm'); return; }
  if (S.pin.mode === 'confirm') {
    if (buf === S.pin.first) { LS.set('pd-pin', buf); SS.set('pd-unlocked', '1'); S.pin = null; mount(); }
    else { S.pin = null; renderPinGate('set', 'The PINs did not match. Try again.'); }
    return;
  }
  if (buf === LS.get('pd-pin')) { SS.set('pd-unlocked', '1'); S.pin = null; mount(); }
  else renderPinGate('enter', 'Wrong PIN. Try again.');
}

// ---------- shared header ----------
function headerHtml(subtitle, withStats, withStation) {
  return `<header class="top">
    <div class="brand"><h1 id="party-name"></h1><div class="sub" id="party-sub">${subtitle ? esc(subtitle) : ''}</div></div>
    ${withStats ? '<div class="stats" id="stats"></div>' : ''}
    ${DEMO ? '<button class="station" data-act="demo-switch" title="Back to the demo menu">Demo menu</button>' : ''}
    <span class="dot" id="dot"></span>
  </header>`;
}
function renderHeader() {
  const st = stats();
  const nameEl = $('#party-name');
  if (nameEl) nameEl.textContent = S.meta.name || (DEMO ? 'Demo party' : 'Party');
  const sub = $('#party-sub');
  if (sub && S.mounted === 'door') sub.textContent = [S.meta.dateLabel, S.meta.doorsOpen ? `Doors ${S.meta.doorsOpen}` : ''].filter(Boolean).join(' · ');
  const statsEl = $('#stats');
  if (statsEl) statsEl.innerHTML = `<div class="stat green"><b>${st.arrived}</b><span>arrived</span></div><div class="stat"><b>${st.total - st.arrived}</b><span>to come</span></div><div class="stat pink"><b>${st.pinkGiven}/${st.pinkTotal}</b><span>pink</span></div>`;
  renderDot();
}
function renderDot() {
  const d = $('#dot');
  if (!d) return;
  d.className = 'dot ' + (!S.status.online ? '' : S.status.pending ? 'pending' : 'online');
  d.title = !S.status.online ? 'Offline: ticks are kept on this device and will sync' : S.status.pending ? 'Syncing…' : 'Live';
}

// ---------- door view ----------
function mountDoor() {
  S.mounted = 'door';
  appEl.innerHTML = `${headerHtml('', true, true)}
  <nav class="tabs"><button data-act="tab" data-tab="search" class="${S.tab === 'search' ? 'active' : ''}">Search</button><button data-act="tab" data-tab="recent" class="${S.tab === 'recent' ? 'active' : ''}">Recent arrivals</button></nav>
  <main>
    <div id="pane-search" class="${S.tab === 'search' ? '' : 'hidden'}">
      <div class="searchbar"><input id="q" type="search" placeholder="Name, Instagram or who invited them…" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" value="${esc(S.query)}"><button class="clear" data-act="clear" aria-label="Clear search">✕</button></div>
      <ul class="results" id="results"></ul>
    </div>
    <div id="pane-recent" class="${S.tab === 'recent' ? '' : 'hidden'}"><ul class="results" id="recent"></ul></div>
  </main>`;
  wireSearch();
  refresh('all');
  setTimeout(() => { const q = $('#q'); if (q) q.focus(); }, 50);
}
function wireSearch() {
  const q = $('#q');
  if (!q) return;
  q.addEventListener('input', () => { S.query = q.value; renderResults(); });
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') q.blur(); });
}

function renderResults() {
  const ul = $('#results');
  if (!ul) return;
  const q = S.query.trim();
  const st = stats();
  if (!q) {
    if (S.mounted !== 'door') { ul.innerHTML = `<li class="hint">Type a few letters of a name, an Instagram handle, or who invited them.<br><span class="muted">${st.total - st.arrived} still to arrive · ${st.total} on the list</span></li>`; return; }
    // Nothing typed: the whole list, A to Z, so staff can scroll as well as search.
    const all = [...S.guests.values()].sort((a, b) => String(a.name).localeCompare(String(b.name), 'en', { sensitivity: 'base' }));
    let html = `<li class="hint" style="padding:8px 6px 4px">${st.total - st.arrived} still to arrive · ${st.total} on the list. Type to search, or scroll.</li>`;
    let letter = '';
    for (const g of all) {
      const L = (norm(g.name)[0] || '#').toUpperCase();
      if (L !== letter) { letter = L; html += `<li class="letter" id="letter-${L}">${L}</li>`; }
      html += rowHtml(g);
    }
    ul.innerHTML = html;
    return;
  }
  const list = search(q);
  const canAdd = S.role === 'adder' || S.role === 'host';
  if (!list.length) {
    ul.innerHTML = `<li class="hint">No one called “${esc(q)}” on the list.<br><span class="muted">Try the surname only or a shorter spelling, or ask who invited them.${canAdd ? '' : ' Only the add-guests link can add people.'}</span>${canAdd ? `<div style="margin-top:14px"><button class="btn primary" data-act="host-add" data-name="${esc(q)}">Add “${esc(q)}” as a walk-in</button></div>` : ''}</li>`;
    return;
  }
  ul.innerHTML = list.map((g) => rowHtml(g)).join('');
}
function renderRecent() {
  const ul = $('#recent');
  if (!ul) return;
  const list = [...S.guests.values()].filter((g) => g.checkedIn && g.checkedInAt).sort((a, b) => (a.checkedInAt < b.checkedInAt ? 1 : -1));
  ul.innerHTML = list.length ? list.map((g) => rowHtml(g, { undo: true })).join('') : '<li class="hint">Nobody has been checked in yet.</li>';
}
function rowHtml(g, opts = {}) {
  const pills = [];
  if (g.pink) pills.push('<span class="pill pink">PINK</span>');
  if (g.source === 'walkin') pills.push('<span class="pill walkin">Walk-in</span>');
  if (g.plusOf || g.inviter) pills.push(`<span class="pill plus">+1 of ${esc(g._inviterName || g.inviter || 'guest')}</span>`);
  const kids = S.kids.get(g.id);
  if (kids && kids.length) pills.push(`<span class="pill plus">+${kids.length}</span>`);
  if (g._dup) pills.push(`<span class="pill warn">${g._dupCount === 2 ? 'Same name twice' : 'Same name ×' + g._dupCount}</span>`);
  if (g.plusNamed === false) pills.push('<span class="pill">Name not given</span>');
  if (g.handle) pills.push(`<span class="muted">${esc(handleOf(g))}</span>`);
  if (g.phone3) pills.push(`<span class="muted">…${esc(g.phone3)}</span>`);
  if (g.note) pills.push(`<span class="muted">${esc(g.note)}</span>`);
  const right = g.checkedIn
    ? `<div class="tick">✓ In<small>${fmtTime(g.checkedInAt)}${g.checkedInBy ? ' · ' + esc(g.checkedInBy) : ''}</small></div>${opts.undo ? `<button class="btn small danger" data-act="undo" data-id="${esc(g.id)}">Undo</button>` : ''}`
    : `<button class="btn primary" data-act="open" data-id="${esc(g.id)}">Check in</button>`;
  return `<li class="row ${g.checkedIn ? 'arrived' : ''} ${g.pink ? 'pinkrow' : ''}" data-act="open" data-id="${esc(g.id)}">
    <div class="who"><div class="name">${esc(g.name)}</div><div class="meta">${pills.join('')}</div></div>${right}</li>`;
}

// ---------- sheet ----------
function openSheet(sheet) { S.sheet = sheet; S.confirmDelete = null; renderSheet(); sheetEl.classList.add('open'); overlayEl.classList.add('open'); }
function closeSheet() { S.sheet = null; S.confirmDelete = null; sheetEl.classList.remove('open'); overlayEl.classList.remove('open'); sheetEl.innerHTML = ''; }
function renderSheet() {
  if (!S.sheet) return;
  if (S.sheet.type === 'guest') {
    const typed = $('#sheet-name') ? $('#sheet-name').value : null;
    sheetEl.innerHTML = guestSheetHtml(S.sheet.id);
    if (typed && $('#sheet-name')) $('#sheet-name').value = typed;
  } else if (S.sheet.type === 'edit') sheetEl.innerHTML = editSheetHtml(S.sheet.id);
  else if (S.sheet.type === 'add') { sheetEl.innerHTML = addFormHtml(S.sheet.name || '', true); setTimeout(() => { const n = $('#a-name'); if (n) { n.focus(); } }, 30); }
}
const notFoundHtml = () => `<h2>Not found</h2><p class="muted">This guest may have been removed.</p><div class="actions"><button class="btn" data-act="close">Close</button></div>`;

function guestSheetHtml(id) {
  const g = S.guests.get(id);
  if (!g) return notFoundHtml();
  const kids = S.kids.get(id) || [];
  const inviter = g.plusOf ? S.guests.get(g.plusOf) : null;
  const pending = [g, ...kids].filter((x) => !x.checkedIn);
  const band = g.pink ? `<div class="band pink">BLUE + PINK<small>wristbands for ${esc(firstName(g))}</small></div>` : `<div class="band blue">BLUE<small>wristband</small></div>`;
  const sub = [
    g.source === 'walkin' ? '<span class="pill walkin">Walk-in</span>' : '<span class="pill ok">On the list</span>',
    g.handle ? esc(handleOf(g)) : '', g.phone3 ? `…${esc(g.phone3)}` : '', g.note ? esc(g.note) : '',
    g.checkedIn ? `<span class="pill ok">Arrived ${fmtTime(g.checkedInAt)}${g.checkedInBy ? ' · ' + esc(g.checkedInBy) : ''}</span>` : '',
  ].filter(Boolean).join(' · ');
  const dup = g._dup ? `<div class="notice warn">Another guest has this name. Check the Instagram handle or who invited them before ticking.</div>` : '';
  const nameField = g.plusNamed === false ? `<div class="field"><label>Their name (optional, saved on check-in)</label><input id="sheet-name" placeholder="Type the plus-one's name" autocapitalize="words" autocomplete="off"></div>` : '';
  const inviterHtml = inviter ? `<div class="notice">Plus-one of <b>${esc(inviter.name)}</b>${inviter.checkedIn ? ` · arrived ${fmtTime(inviter.checkedInAt)}` : ' · not arrived yet'} <button class="btn small" data-act="open" data-id="${esc(inviter.id)}">Open ${esc(firstName(inviter))}</button></div>`
    : (g.inviter ? `<div class="notice">Plus-one of <b>${esc(g.inviter)}</b></div>` : '');
  const kidsHtml = kids.length ? `<h3 class="muted" style="margin:14px 0 4px;font-size:13px;text-transform:uppercase;letter-spacing:.06em">Coming with ${esc(firstName(g))}</h3><ul class="plist">${kids.map((k) => `<li><div class="pn">${esc(k.name)}<small>${k.pink ? 'BLUE + PINK' : 'BLUE'}${k.plusNamed === false ? ' · name not given' : ''}${k.checkedIn ? ' · arrived ' + fmtTime(k.checkedInAt) : ''}</small></div>${k.checkedIn ? `<button class="btn small" data-act="undo" data-id="${esc(k.id)}">Undo</button>` : `<button class="btn small ${k.pink ? 'pinkbtn' : 'primary'}" data-act="checkin-one" data-id="${esc(k.id)}">Check in</button>`}</li>`).join('')}</ul>` : '';
  let actions;
  if (g.checkedIn) {
    actions = `<button class="btn danger" data-act="undo" data-id="${esc(g.id)}">Undo check-in</button>
      <button class="btn ${g.pinkGiven ? '' : 'pinkbtn'}" data-act="toggle-pink" data-id="${esc(g.id)}">${g.pinkGiven ? 'Pink given ✓ (tap to unmark)' : g.pink ? 'Mark pink given' : 'Give pink anyway'}</button>
      <button class="btn ghost" data-act="close">Close</button>`;
  } else {
    const groupBtn = pending.length > 1 ? `<button class="btn ${pending.some((x) => x.pink) ? 'pinkbtn' : 'primary'}" data-act="checkin" data-id="${esc(g.id)}">Check in all ${pending.length}</button><button class="btn" data-act="checkin-one" data-id="${esc(g.id)}">Just ${esc(firstName(g))}</button>` : `<button class="btn ${g.pink ? 'pinkbtn' : 'primary'}" data-act="checkin" data-id="${esc(g.id)}">Check in</button>`;
    actions = `${groupBtn}<button class="btn ghost" data-act="close">Cancel</button>`;
  }
  const editBtn = (S.role === 'host' || (S.role === 'adder' && g.source === 'walkin' && g.addedByUid === S.store.uid)) ? `<div class="actions"><button class="btn small" data-act="edit" data-id="${esc(g.id)}">Edit details</button></div>` : '';
  return `<h2>${esc(g.name)}</h2><div class="subline">${sub}</div>${band}${dup}${nameField}${inviterHtml}${kidsHtml}<div class="actions">${actions}</div>${editBtn}`;
}

function checkInFromSheet(id, onlyOne) {
  const g = S.guests.get(id);
  if (!g) return;
  const nameInput = $('#sheet-name');
  if (nameInput && nameInput.value.trim() && g.plusNamed === false) nameGuest(id, nameInput.value);
  const kids = onlyOne ? [] : (S.kids.get(id) || []);
  const targets = [g, ...kids].filter((x) => !x.checkedIn);
  const done = targets.filter((x) => checkIn(x.id));
  if (!done.length) return;
  const anyPink = done.some((x) => x.pink);
  const label = done.length === 1 ? esc(done[0].name) : `${esc(g.name)} + ${done.length - 1}`;
  const colour = !anyPink ? 'BLUE' : done.length === 1 ? 'BLUE + PINK' : `PINK for ${done.filter((x) => x.pink).map((x) => esc(firstName(x))).join(', ')} · BLUE for all`;
  toast(`${label} ✓ &nbsp;<span style="font-weight:600">${colour}</span>`, anyPink ? 'pink' : 'blue', { undo: () => done.forEach((x) => undoCheckIn(x.id)) });
  // Ticking one member of a group: stay on the sheet so the rest can be ticked.
  const stay = onlyOne && S.sheet && S.sheet.type === 'guest' && (S.sheet.id !== id || (S.kids.get(id) || []).length > 0);
  if (stay) return;
  closeSheet();
  if (S.mounted === 'door') { S.query = ''; const q = $('#q'); if (q) { q.value = ''; q.focus(); } renderResults(); }
}

// ---------- add view ----------
function mountAdd() {
  S.mounted = 'add';
  appEl.innerHTML = `${headerHtml('Add guests on the night', false, true)}
  <main>
    <div class="card">${addFormHtml('', false)}</div>
    <div class="card"><h3>Added from this device</h3><ul class="results" id="own-list"></ul></div>
    <div class="card"><h3>Look someone up</h3><div class="searchbar"><input id="q" type="search" placeholder="Search the list…" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" value="${esc(S.query)}"><button class="clear" data-act="clear" aria-label="Clear search">✕</button></div><ul class="results" id="results"></ul></div>
  </main>`;
  wireSearch();
  refresh('all');
  setTimeout(() => { const n = $('#a-name'); if (n) n.focus(); }, 50);
}
function addFormHtml(prefill, inSheet) {
  const host = S.role === 'host';
  return `${inSheet ? '<h2>Add a walk-in</h2>' : '<h3>Add a walk-in</h3>'}
    <div class="field"><label>Full name</label><input id="a-name" autocomplete="off" autocapitalize="words" placeholder="First and last name" value="${esc(prefill)}"></div>
    <label class="switch">Pink wristband (as well as blue)<input type="checkbox" id="a-pink"></label>
    <label class="switch">They are at the door now: check in straight away<input type="checkbox" id="a-now"></label>
    <div class="field"><label>Note for the door (optional)</label><input id="a-note" autocomplete="off" placeholder="e.g. friend of Ralf, coming with Sam"></div>
    ${host ? '<div class="field"><label>Phone (host only, optional)</label><input id="a-phone" inputmode="tel" autocomplete="off"></div>' : ''}
    <div class="actions"><button class="btn primary" data-act="add-submit">Add to the list</button>${inSheet ? '<button class="btn ghost" data-act="close">Cancel</button>' : ''}</div>
    ${inSheet ? '' : '<p class="muted" style="margin:10px 0 0">Anyone you add shows on the door iPads within a second or two. Bringing people? Add each name separately.</p>'}`;
}
async function submitAdd() {
  const nameEl = $('#a-name');
  const name = nameEl ? nameEl.value.trim().slice(0, 120) : '';
  if (!name) { toast('Type a name first', 'err'); if (nameEl) nameEl.focus(); return; }
  const pink = !!($('#a-pink') && $('#a-pink').checked);
  const nowCheck = !!($('#a-now') && $('#a-now').checked);
  const note = $('#a-note') ? $('#a-note').value.trim().slice(0, 200) : '';
  const phone = $('#a-phone') ? cleanPhone($('#a-phone').value) : '';
  const { first, last } = splitName(name);
  const at = nowIso();
  const g = {
    id: newId('w'), name, first, last, search: norm(name), phone3: phone.replace(/\D/g, '').slice(-3), handle: '', inviter: '',
    rsvp: 'walkin', source: 'walkin', pink, plusOf: null, plusIndex: null, plusTotal: 0, plusNamed: true, note,
    checkedIn: nowCheck, checkedInAt: nowCheck ? at : null, checkedInBy: nowCheck ? (S.station || 'Host') : null, checkedInByUid: nowCheck ? S.store.uid : null,
    pinkGiven: nowCheck && pink, pinkGivenAt: nowCheck && pink ? at : null, addedBy: S.station || (S.role === 'host' ? 'Host' : 'Add link'), addedByUid: S.store.uid,
  };
  const priv = S.role === 'host' && phone ? { phone } : null;
  let res;
  try { res = S.store.addGuest(g, priv); } catch (e) { toast(`Could not add: ${esc(friendlyErr(e))}`, 'err'); return; }
  if (priv) S.priv.set(g.id, priv);
  S.store.logEvent({ type: 'add', guestId: g.id, name, station: g.addedBy, pink, checkedIn: nowCheck });
  const outcome = await Promise.race([res.done.then(() => 'saved', (e) => ({ error: e })), new Promise((r) => setTimeout(() => r('pending'), 4000))]);
  if (outcome && outcome.error) { toast(`Could not add ${esc(name)}: ${esc(friendlyErr(outcome.error))}`, 'err', { ms: 7000 }); return; }
  toast(`${esc(name)} added${nowCheck ? ' and checked in' : ''}${pink ? ' · <span style="font-weight:600">PINK</span>' : ''}${outcome === 'pending' ? ' · will sync when online' : ''}`, pink ? 'pink' : 'ok');
  if (S.sheet && S.sheet.type === 'add') { closeSheet(); if (S.mounted === 'door') { S.query = ''; const q = $('#q'); if (q) { q.value = ''; q.focus(); } renderResults(); } }
  else { ['a-name', 'a-note', 'a-phone'].forEach((id) => { const el = document.getElementById(id); if (el) el.value = ''; }); ['a-pink', 'a-now'].forEach((id) => { const el = document.getElementById(id); if (el) el.checked = false; }); if (nameEl) nameEl.focus(); }
}
function renderOwnList() {
  const ul = $('#own-list');
  if (!ul) return;
  const mine = [...S.guests.values()].filter((g) => g.source === 'walkin' && g.addedByUid === S.store.uid).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  ul.innerHTML = mine.length ? mine.map((g) => rowHtml(g)).join('') : '<li class="hint">Nobody added from this device yet.</li>';
}

// ---------- edit sheet (host, or adder for own walk-ins) ----------
function editSheetHtml(id) {
  const g = S.guests.get(id);
  if (!g) return notFoundHtml();
  const p = S.priv.get(id) || {};
  const host = S.role === 'host';
  return `<h2>Edit guest</h2><div class="subline">${g.source === 'walkin' ? 'Walk-in' : 'On the list'}${g._inviterName ? ` · plus-one of ${esc(g._inviterName)}` : ''}${g.checkedIn ? ` · arrived ${fmtTime(g.checkedInAt)}${g.checkedInBy ? ' (' + esc(g.checkedInBy) + ')' : ''}` : ' · not arrived'}</div>
    <div class="field"><label>Name</label><input id="e-name" value="${esc(g.name)}" autocapitalize="words" autocomplete="off"></div>
    <label class="switch">Pink wristband (as well as blue)<input type="checkbox" id="e-pink" ${g.pink ? 'checked' : ''}></label>
    <div class="field"><label>Note for the door</label><input id="e-note" value="${esc(g.note || '')}" autocomplete="off"></div>
    ${host ? `<div class="field"><label>Instagram handle</label><input id="e-handle" value="${esc(g.handle || '')}" autocomplete="off" autocapitalize="off"></div>
    <div class="field"><label>Phone (host only)</label><input id="e-phone" inputmode="tel" value="${esc(p.phone || '')}" autocomplete="off"></div>
    <div class="field"><label>Email (host only)</label><input id="e-email" inputmode="email" value="${esc(p.email || '')}" autocomplete="off" autocapitalize="off"></div>` : ''}
    <div class="actions"><button class="btn primary" data-act="save-edit" data-id="${esc(id)}">Save</button>${g.checkedIn ? `<button class="btn" data-act="undo" data-id="${esc(id)}">Undo check-in</button>` : `<button class="btn" data-act="checkin-one" data-id="${esc(id)}">Check in</button>`}<button class="btn ghost" data-act="close">Cancel</button></div>
    <div class="actions"><button class="btn danger" data-act="delete-guest" data-id="${esc(id)}">${S.confirmDelete === id ? 'Tap again to delete permanently' : 'Delete guest'}</button></div>`;
}
function saveEdit(id) {
  const g = S.guests.get(id);
  if (!g) return;
  const name = $('#e-name').value.trim().slice(0, 120);
  if (!name) { toast('Name cannot be empty', 'err'); return; }
  const { first, last } = splitName(name);
  const patch = { name, first, last, search: norm(name), pink: $('#e-pink').checked, note: $('#e-note').value.trim().slice(0, 200), plusNamed: true, updatedAt: nowIso() };
  if (S.role === 'host') {
    patch.handle = cleanHandle($('#e-handle').value);
    const phone = cleanPhone($('#e-phone').value), email = $('#e-email').value.trim().toLowerCase();
    patch.phone3 = phone.replace(/\D/g, '').slice(-3);
    write(S.store.setPrivate(id, { phone, email }), 'Could not save contact details');
    S.priv.set(id, { ...(S.priv.get(id) || {}), phone, email });
  }
  write(S.store.updateGuest(id, patch), 'Could not save');
  S.store.logEvent({ type: 'edit', guestId: id, name, station: S.station || 'Host' });
  closeSheet();
  toast('Saved', 'ok');
}
function deleteGuest(id) {
  if (S.confirmDelete !== id) { S.confirmDelete = id; renderSheet(); return; }
  const g = S.guests.get(id);
  const kids = S.kids.get(id) || [];
  write(S.store.deleteGuest(id), 'Could not delete');
  for (const k of kids) write(S.store.updateGuest(k.id, { plusOf: null, inviter: g ? g.name : k.inviter || '', updatedAt: nowIso() }), 'Could not update plus-one');
  S.store.logEvent({ type: 'delete', guestId: id, name: g ? g.name : id, station: S.station || 'Host' });
  closeSheet();
  toast(`Deleted ${esc(g ? g.name : '')}`, 'ok');
}

// ---------- host view ----------
const HOST_TABS = ['live', 'guests', 'pink', 'import', 'export', 'settings'];
function mountHost() {
  S.mounted = 'host';
  appEl.innerHTML = `${headerHtml('Host view', true, false)}
  <nav class="tabs">${HOST_TABS.map((t) => `<button data-act="host-tab" data-tab="${t}" class="${S.hostTab === t ? 'active' : ''}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</nav>
  <main id="host-main"></main>`;
  renderHostPane(true);
  refresh('all');
}
function renderHostPane(full) {
  const main = $('#host-main');
  if (!main) return;
  switch (S.hostTab) {
    case 'live': main.innerHTML = liveHtml(); break;
    case 'guests':
      if (full || !$('#hq')) { main.innerHTML = guestsPaneHtml(); const hq = $('#hq'); hq.addEventListener('input', () => { S.hostQuery = hq.value; renderHostGuestList(); }); }
      renderHostGuestList();
      break;
    case 'pink':
      if (full || !$('#pink-paste')) { main.innerHTML = pinkHtml(); const pq = $('#pq'); pq.addEventListener('input', () => { S.pinkQuery = pq.value; renderPinkLists(); }); }
      renderPinkLists();
      break;
    case 'import': if (full || !$('#import-file')) main.innerHTML = importHtml(); break;
    case 'export': if (full || !$('#export-msg') || !$('#export-msg').innerHTML) main.innerHTML = exportHtml(); break;
    case 'settings': if (full || !$('#s-name')) main.innerHTML = settingsHtml(); break;
  }
}
function barsHtml() {
  const times = [...S.guests.values()].filter((g) => g.checkedIn && g.checkedInAt).map((g) => new Date(g.checkedInAt).getTime()).filter((t) => !isNaN(t)).sort((a, b) => a - b);
  if (!times.length) return '<div class="muted">No arrivals yet</div>';
  const slot = 15 * 60 * 1000;
  const start = Math.floor(times[0] / slot) * slot;
  const end = Math.floor(Math.max(times[times.length - 1], Date.now()) / slot) * slot;
  const n = Math.min(48, Math.floor((end - start) / slot) + 1);
  const counts = new Array(n).fill(0);
  for (const t of times) { const i = Math.floor((t - start) / slot); if (i >= 0 && i < n) counts[i]++; }
  const max = Math.max(...counts, 1);
  return `<div class="bars">${counts.map((c) => `<div style="height:${Math.max(2, Math.round((c / max) * 100))}%"><span>${c || ''}</span></div>`).join('')}</div>
    <div class="axis"><span>${fmtTime(new Date(start).toISOString())}</span><span>${fmtTime(new Date(start + (n - 1) * slot).toISOString())}</span></div>`;
}
function liveHtml() {
  const st = stats();
  const recent = [...S.guests.values()].filter((g) => g.checkedIn && g.checkedInAt).sort((a, b) => (a.checkedInAt < b.checkedInAt ? 1 : -1)).slice(0, 40);
  const pct = st.total ? Math.round((st.arrived / st.total) * 100) : 0;
  return `<div class="grid">
    <div class="kpi"><b>${st.arrived}</b><span>arrived of ${st.total} (${pct}%)</span></div>
    <div class="kpi"><b>${st.total - st.arrived}</b><span>still to come</span></div>
    <div class="kpi pink"><b>${st.pinkGiven}</b><span>pink given of ${st.pinkTotal} entitled${st.overrides ? ` · ${st.overrides} extra` : ''}</span></div>
    <div class="kpi"><b>${st.walkinsArrived}<span style="font-size:16px;color:var(--muted)">/${st.walkins}</span></b><span>walk-ins arrived</span></div>
    <div class="kpi"><b>${st.plusArrived}<span style="font-size:16px;color:var(--muted)">/${st.plus}</span></b><span>plus-ones arrived</span></div>
  </div>
  <div class="card"><h3>Arrivals per 15 minutes</h3>${barsHtml()}</div>
  <div class="card"><h3>Latest arrivals</h3><ul class="feed">${recent.map((g) => `<li data-act="open" data-id="${esc(g.id)}" style="cursor:pointer"><time>${fmtTime(g.checkedInAt)}</time><span class="fn">${esc(g.name)}</span>${g.pink ? '<span class="pill pink">PINK</span>' : ''}${g.source === 'walkin' ? '<span class="pill walkin">Walk-in</span>' : ''}<span class="muted">${esc(g.checkedInBy || '')}</span></li>`).join('') || '<li class="muted">Nobody yet</li>'}</ul></div>`;
}
function guestsPaneHtml() {
  return `<div class="inline" style="margin-bottom:8px"><div class="searchbar" style="flex:1"><input id="hq" type="search" placeholder="Search everyone…" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" value="${esc(S.hostQuery)}"><button class="clear" data-act="host-clear" aria-label="Clear search">✕</button></div><button class="btn primary" data-act="host-add">Add guest</button></div>
    <div class="inline muted" id="host-filters" style="margin:6px 0 4px;font-size:13px">${['all', 'pink', 'walkin', 'notarrived', 'arrived', 'dup'].map((f) => `<button class="pill ${S.hostFilter === f || (!S.hostFilter && f === 'all') ? 'blue' : ''}" data-act="host-filter" data-f="${f}">${{ all: 'All', pink: 'Pink', walkin: 'Walk-ins', notarrived: 'Not arrived', arrived: 'Arrived', dup: 'Same name' }[f]}</button>`).join('')}</div>
    <ul class="results" id="host-list"></ul>`;
}
function renderHostGuestList() {
  const ul = $('#host-list');
  if (!ul) return;
  const f = S.hostFilter || 'all';
  let list = S.hostQuery.trim() ? search(S.hostQuery) : [...S.guests.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  list = list.filter((g) => f === 'all' || (f === 'pink' && g.pink) || (f === 'walkin' && g.source === 'walkin') || (f === 'notarrived' && !g.checkedIn) || (f === 'arrived' && g.checkedIn) || (f === 'dup' && g._dup));
  const hostRow = (g) => {
    const p = S.priv.get(g.id) || {};
    const extra = [p.phone ? esc(p.phone) : '', p.email ? esc(p.email) : ''].filter(Boolean).join(' · ');
    return rowHtml(g).replace('</div></div>', `${extra ? `<div class="muted" style="font-size:12px;margin-top:4px">${extra}</div>` : ''}</div></div>`).replace('data-act="open"', 'data-act="edit"').replace(`<button class="btn primary" data-act="open"`, `<button class="btn small" data-act="edit"`).replace('>Check in</button>', '>Edit</button>');
  };
  if (!list.length) { ul.innerHTML = '<li class="hint">No one matches.</li>'; return; }
  if (S.hostQuery.trim()) { ul.innerHTML = list.map(hostRow).join(''); return; }
  // Nothing typed: everyone, A to Z, no cap.
  let html = `<li class="hint" style="padding:8px 6px 4px">${list.length} ${list.length === 1 ? 'person' : 'people'}. Type to search, or scroll.</li>`, letter = '';
  for (const g of list) {
    const L = (norm(g.name)[0] || '#').toUpperCase();
    if (L !== letter) { letter = L; html += `<li class="letter">${L}</li>`; }
    html += hostRow(g);
  }
  ul.innerHTML = html;
}
// ---------- pink wristband management (host) ----------
function pinkHtml() {
  return `<div class="card"><h3>Pink wristbands</h3>
    <p class="muted" id="pink-count"></p>
    <p class="muted">Scroll the list and tap <b>Make pink</b> or <b>Remove pink</b>. Changes reach the door straight away.</p>
    <details id="pink-paste-box"><summary class="btn small">Paste a list of names instead</summary>
      <p class="muted" style="margin:10px 0 4px">One full name per line, spelt as on the guest list. Names not found are reported and nothing else changes.</p>
      <div class="field"><textarea id="pink-paste" placeholder="Amelia Clarke&#10;Ben Khan&#10;…"></textarea></div>
      <label class="switch">Their plus-ones get pink too<input type="checkbox" id="pink-inherit"></label>
      <div class="actions"><button class="btn pinkbtn" data-act="pink-apply" data-mode="add">Add these to pink</button><button class="btn" data-act="pink-apply" data-mode="replace">Replace the pink list with these</button></div>
      <div id="pink-result"></div>
    </details></div>
    <div class="searchbar"><input id="pq" type="search" placeholder="Search by name, Instagram or inviter…" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" value="${esc(S.pinkQuery || '')}"><button class="clear" data-act="pink-clear" aria-label="Clear search">✕</button></div>
    <div class="inline muted" id="pink-filters" style="margin:8px 0 4px;font-size:13px"></div>
    <ul class="results" id="pink-list"></ul>`;
}
function pinkRowHtml(g) {
  const kids = S.kids.get(g.id) || [];
  const pills = [
    g.pink ? '<span class="pill pink">PINK</span>' : '',
    g.pinkGiven ? '<span class="pill ok">Pink given</span>' : '',
    g.source === 'walkin' ? '<span class="pill walkin">Walk-in</span>' : '',
    g._inviterName ? `<span class="pill plus">+1 of ${esc(g._inviterName)}</span>` : '',
    kids.length ? `<span class="pill plus">+${kids.length}</span>` : '',
    g._dup ? '<span class="pill warn">Same name</span>' : '',
    g.handle ? `<span class="muted">${esc(handleOf(g))}</span>` : '',
  ].filter(Boolean).join('');
  return `<li class="row ${g.pink ? 'pinkrow' : ''}" data-act="edit" data-id="${esc(g.id)}"><div class="who"><div class="name">${esc(g.name)}</div><div class="meta">${pills}</div></div>
    <button class="btn small ${g.pink ? '' : 'pinkbtn'}" data-act="pink-set" data-id="${esc(g.id)}" data-v="${g.pink ? '0' : '1'}">${g.pink ? 'Remove pink' : 'Make pink'}</button></li>`;
}
function renderPinkLists() {
  const st = stats();
  const count = $('#pink-count');
  if (count) count.textContent = `${st.pinkTotal} ${st.pinkTotal === 1 ? 'person is' : 'people are'} down for pink · ${st.pinkGiven} handed out so far · ${st.total} on the list.`;
  const f = S.pinkFilter || 'all';
  const filters = $('#pink-filters');
  if (filters) filters.innerHTML = [['all', `Everyone (${st.total})`], ['pink', `Pink only (${st.pinkTotal})`], ['notpink', `Not pink (${st.total - st.pinkTotal})`]].map(([k, label]) => `<button class="pill ${f === k ? 'blue' : ''}" data-act="pink-filter" data-f="${k}">${label}</button>`).join('');
  const list = $('#pink-list');
  if (!list) return;
  const q = (S.pinkQuery || '').trim();
  let people = q ? search(q) : [...S.guests.values()].sort((a, b) => String(a.name).localeCompare(String(b.name), 'en', { sensitivity: 'base' }));
  people = people.filter((g) => f === 'all' || (f === 'pink' && g.pink) || (f === 'notpink' && !g.pink));
  if (!people.length) { list.innerHTML = `<li class="hint">${q ? 'No one matches.' : f === 'pink' ? 'Nobody is down for pink yet. Tap Make pink on someone, or paste a list.' : 'Nobody here.'}</li>`; return; }
  if (q) { list.innerHTML = people.map(pinkRowHtml).join(''); return; }
  let html = '', letter = '';
  for (const g of people) {
    const L = (norm(g.name)[0] || '#').toUpperCase();
    if (L !== letter) { letter = L; html += `<li class="letter">${L}</li>`; }
    html += pinkRowHtml(g);
  }
  list.innerHTML = html;
}
function setPink(id, v) {
  const g = S.guests.get(id);
  if (!g) return;
  write(S.store.updateGuest(id, { pink: !!v, updatedAt: nowIso() }), 'Could not update pink');
  S.store.logEvent({ type: v ? 'pink-add' : 'pink-remove', guestId: id, name: g.name, station: 'Host' });
}
async function applyPinkList(mode) {
  const names = ($('#pink-paste').value || '').split(/\r?\n|;/).map((s) => s.trim()).filter(Boolean);
  const out = $('#pink-result');
  if (!names.length) { toast('Paste at least one name first', 'err'); return; }
  const inherit = $('#pink-inherit').checked;
  const want = new Map(names.map((n) => [norm(n), n]));
  const matched = new Set(), hits = new Map(), target = new Set();
  for (const g of S.guests.values()) { const k = g.search || norm(g.name); if (want.has(k)) { target.add(g.id); matched.add(k); hits.set(k, (hits.get(k) || 0) + 1); } }
  if (inherit) for (const g of S.guests.values()) if (g.plusOf && target.has(g.plusOf)) target.add(g.id);
  const items = [];
  for (const g of S.guests.values()) {
    const pink = mode === 'replace' ? target.has(g.id) : (!!g.pink || target.has(g.id));
    if (!!g.pink !== pink) items.push({ id: g.id, merge: true, doc: { pink } });
  }
  const unmatched = names.filter((n) => !matched.has(norm(n)));
  const ambiguous = [...hits.entries()].filter(([, c]) => c > 1).map(([k]) => want.get(k));
  out.innerHTML = '<div class="notice">Saving…</div>';
  if (items.length) { try { await S.store.importGuests(items); } catch (e) { out.innerHTML = `<div class="notice err">Could not save: ${esc(friendlyErr(e))}</div>`; return; } }
  S.store.logEvent({ type: 'pink-list', mode, names: names.length, changed: items.length, station: 'Host' });
  const added = items.filter((i) => i.doc.pink).length, removed = items.filter((i) => !i.doc.pink).length;
  out.innerHTML = `<div class="notice"><b>${matched.size} of ${names.length}</b> names found · ${added} made pink${mode === 'replace' ? ` · ${removed} removed` : ''}${inherit ? ' · plus-ones included' : ''}.
    ${ambiguous.length ? `<br>Matched more than one person, all flagged (check under Guests): ${ambiguous.map(esc).join(', ')}` : ''}
    ${unmatched.length ? `<div class="notice warn" style="margin:8px 0 0">Not found on the list, check the spelling:<br>${unmatched.map(esc).join('<br>')}</div>` : ''}</div>`;
  toast(`Pink list ${mode === 'replace' ? 'replaced' : 'updated'}: ${[...S.guests.values()].filter((g) => target.has(g.id)).length} people`, 'pink');
}

function importHtml() {
  return `<div class="card"><h3>Import the guest list</h3>
    <p class="muted">Upload the Partiful export (CSV) or a <code>guests.json</code> made with the import tool. Re-importing is safe: check-ins are kept; names and wristband colours are updated.</p>
    <div class="field"><label>File</label><input type="file" id="import-file" accept=".csv,.json,text/csv,application/json"></div>
    <div class="field"><label>Pink wristband names (one per line, optional)</label><textarea id="import-pink" placeholder="Full names exactly as they appear on the list"></textarea></div>
    <label class="switch">Plus-ones get pink if their inviter does<input type="checkbox" id="import-inherit"></label>
    <button class="btn primary wide" data-act="import-preview">Preview</button>
    <div id="import-result"></div></div>`;
}
async function importPreview() {
  const fileEl = $('#import-file');
  const file = fileEl && fileEl.files[0];
  if (!file) { toast('Choose a file first', 'err'); return; }
  const out = $('#import-result');
  out.innerHTML = '<div class="notice">Reading…</div>';
  const text = await file.text();
  const pinkNames = $('#import-pink').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  let guests, report;
  try {
    if (/\.json$/i.test(file.name) || text.trim().startsWith('[')) {
      guests = JSON.parse(text);
      if (!Array.isArray(guests)) throw new Error('JSON must be an array of guests');
      report = { imported: guests.filter((g) => !g.plusOf).length, plusOnes: guests.filter((g) => g.plusOf).length, plusUnnamed: guests.filter((g) => g.plusNamed === false).length, pinkUnmatched: [], duplicateNames: 0, skippedStatus: 0 };
      if (pinkNames.length) {
        const set = new Set(pinkNames.map(norm)), matched = new Set();
        for (const g of guests) { const k = g.search || norm(g.name); if (set.has(k)) { g.pink = true; matched.add(k); } }
        report.pinkUnmatched = pinkNames.filter((n) => !matched.has(norm(n)));
      }
    } else {
      const res = buildGuests(parseCsv(text), { pinkNames, plusInheritPink: $('#import-inherit').checked });
      guests = res.guests; report = res.report;
    }
  } catch (e) { out.innerHTML = `<div class="notice err">Could not read that file: ${esc(e.message || e)}</div>`; return; }
  guests = guests.filter((g) => g && g.id && g.name);
  if (!guests.length) { out.innerHTML = '<div class="notice err">No guests found in that file. Check it is the Partiful export with a Name column.</div>'; return; }
  const existing = guests.filter((g) => S.guests.has(g.id)).length;
  S.importPreview = guests;
  S.importPinkExplicit = pinkNames.length > 0;
  out.innerHTML = `<div class="notice"><b>${guests.length}</b> records: ${report.imported} guests and ${report.plusOnes} plus-ones${report.plusUnnamed ? ` (${report.plusUnnamed} without a name yet)` : ''}.<br>
    ${existing} already on the list (updated, check-ins kept) · ${guests.length - existing} new.<br>
    Pink entitled: <b>${guests.filter((g) => g.pink).length}</b>.
    ${report.duplicateNames ? `<br>${report.duplicateNames} names appear more than once (kept and flagged on the door).` : ''}
    ${report.skippedStatus ? `<br>${report.skippedStatus} rows skipped because their RSVP is not Approved/Going.` : ''}
    ${report.plusUnlinked ? `<br>${report.plusUnlinked} plus-ones whose inviter was not found (kept as normal guests).` : ''}
    ${report.pinkUnmatched && report.pinkUnmatched.length ? `<div class="notice warn" style="margin:8px 0 0">Pink names not found on the list:<br>${report.pinkUnmatched.map(esc).join('<br>')}</div>` : ''}
    ${report.pinkAmbiguous && report.pinkAmbiguous.length ? `<div class="notice warn" style="margin:8px 0 0">These pink names match more than one guest, all were flagged:<br>${report.pinkAmbiguous.map(esc).join('<br>')}</div>` : ''}
    </div><button class="btn green wide" data-act="import-run">Import ${guests.length} records</button><div class="progress hidden" id="import-progress"><div></div></div><div id="import-done"></div>`;
}
async function importRun() {
  const guests = S.importPreview;
  if (!guests) return;
  const btn = $('[data-act="import-run"]');
  if (btn) btn.disabled = true;
  const prog = $('#import-progress');
  if (prog) prog.classList.remove('hidden');
  const items = guests.map((g) => {
    const staticDoc = {};
    for (const k of STATIC_FIELDS) if (g[k] !== undefined) staticDoc[k] = g[k];
    const priv = (g.phone || g.email) ? { phone: g.phone || '', email: g.email || '' } : undefined;
    const existing = S.guests.get(g.id);
    if (existing) {
      // Re-import must not undo what was done in the app: keep pink flags unless a pink list was
      // given, keep host-written notes/handles when the file has none, keep names typed at the door.
      if (!S.importPinkExplicit && !g.pink) delete staticDoc.pink;
      for (const k of ['note', 'handle', 'phone3']) if (!g[k]) delete staticDoc[k];
      if (g.plusNamed === false && existing.plusNamed !== false) for (const k of ['name', 'first', 'last', 'search', 'plusNamed']) delete staticDoc[k];
      return { id: g.id, merge: true, doc: staticDoc, priv };
    }
    return { id: g.id, merge: false, priv, doc: { ...staticDoc, id: g.id, checkedIn: false, checkedInAt: null, checkedInBy: null, checkedInByUid: null, pinkGiven: false, pinkGivenAt: null, addedBy: null, addedByUid: null } };
  });
  try {
    await S.store.importGuests(items, (done, total) => { if (prog) prog.firstElementChild.style.width = `${Math.round((done / total) * 100)}%`; });
    for (const it of items) if (it.priv) S.priv.set(it.id, { ...(S.priv.get(it.id) || {}), ...it.priv });
    const doneEl = $('#import-done');
    if (doneEl) doneEl.innerHTML = `<div class="notice">Done. ${items.length} records imported.</div>`;
    S.store.logEvent({ type: 'import', count: items.length, station: 'Host' });
    toast(`Imported ${items.length} records`, 'ok');
    S.importPreview = null;
  } catch (e) {
    const doneEl = $('#import-done');
    if (doneEl) doneEl.innerHTML = `<div class="notice err">Import failed: ${esc(friendlyErr(e))}</div>`;
    if (btn) btn.disabled = false;
  }
}
function exportHtml() {
  const st = stats();
  return `<div class="card"><h3>Export</h3><p class="muted">A spreadsheet of everyone on the list with arrival time, door, wristbands, walk-ins and contact details.</p>
    <div class="actions"><button class="btn primary" data-act="export-csv">Download CSV (${st.total} rows)</button><button class="btn" data-act="export-copy">Copy as text</button></div><div id="export-msg"></div></div>`;
}
function exportRows() {
  const rows = [['Name', 'First name', 'Last name', 'Type', 'Plus-one of', 'Instagram', 'Email', 'Phone', 'Pink entitled', 'Arrived', 'Arrived at', 'Door', 'Pink given', 'Note', 'Added by', 'Id']];
  for (const g of [...S.guests.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
    const p = S.priv.get(g.id) || {};
    rows.push([g.name, g.first, g.last, g.source === 'walkin' ? 'Walk-in' : g.plusOf || g.inviter ? 'Plus-one' : 'Guest', g._inviterName || '', handleOf(g), p.email || '', p.phone || '', g.pink ? 'Yes' : 'No', g.checkedIn ? 'Yes' : 'No', g.checkedInAt ? fmtDateTime(g.checkedInAt) : '', g.checkedInBy || '', g.pinkGiven ? 'Yes' : 'No', g.note || '', g.addedBy || '', g.id]);
  }
  return rows;
}
const toCsv = (rows) => '﻿' + rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
function exportCsv() {
  const blob = new Blob([toCsv(exportRows())], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `guests-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}.csv`;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 3000);
  const m = $('#export-msg');
  if (m) m.innerHTML = '<div class="notice">Download started. On an iPad it lands in Files → Downloads.</div>';
}
async function exportCopy() {
  const tsv = exportRows().map((r) => r.join('\t')).join('\n');
  try { await navigator.clipboard.writeText(tsv); toast('Copied. Paste into a spreadsheet.', 'ok'); } catch { toast('Could not copy on this device', 'err'); }
}
function settingsHtml() {
  const m = S.meta;
  return `<div class="card"><h3>Party</h3>
    <div class="field"><label>Name (shown on every screen)</label><input id="s-name" value="${esc(m.name || '')}" autocomplete="off"></div>
    <div class="field"><label>Date line</label><input id="s-date" value="${esc(m.dateLabel || '')}" placeholder="e.g. Sat 20 Sep" autocomplete="off"></div>
    <div class="field"><label>Doors open</label><input id="s-doors" value="${esc(m.doorsOpen || '')}" placeholder="e.g. 20:00" autocomplete="off"></div>
    <button class="btn primary wide" data-act="save-settings">Save</button></div>
    <div class="card"><h3>This device</h3><p class="muted">Role <b>${esc(S.role)}</b> · device ${esc(String(S.store.uid).slice(0, 8))} · ${DEMO ? 'demo mode: data lives in this browser only' : 'live'}</p>
    <div class="actions"><button class="btn" data-act="change-pin">Change host PIN</button><button class="btn" data-act="lock">Lock host view</button>${DEMO ? '<button class="btn danger" data-act="reset-demo">Reset demo data</button>' : ''}</div></div>`;
}
function saveSettings() {
  const patch = {
    name: $('#s-name').value.trim().slice(0, 60), dateLabel: $('#s-date').value.trim().slice(0, 60), doorsOpen: $('#s-doors').value.trim().slice(0, 20),
  };
  write(S.store.setMeta(patch), 'Could not save settings');
  toast('Settings saved', 'ok');
}

// ---------- toast ----------
function toast(html, kind = 'ok', opts = {}) {
  toastEl.className = `toast show ${kind}`;
  toastEl.innerHTML = `<span>${html}</span>${opts.undo ? '<button class="btn small" data-act="toast-undo">Undo</button>' : ''}`;
  S.toastUndo = opts.undo || null;
  clearTimeout(S.toastTimer);
  S.toastTimer = setTimeout(hideToast, opts.ms || (opts.undo ? 6000 : 3500));
}
function hideToast() { toastEl.className = 'toast'; toastEl.innerHTML = ''; S.toastUndo = null; }

// ---------- events ----------
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act, id = el.dataset.id;
  switch (act) {
    case 'reload': location.reload(); break;
    case 'demo-enter': demoEnter(el.dataset.view); break;
    case 'demo-switch': demoSwitch(); break;
    case 'tab': S.tab = el.dataset.tab; $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === S.tab)); $('#pane-search').classList.toggle('hidden', S.tab !== 'search'); $('#pane-recent').classList.toggle('hidden', S.tab !== 'recent'); if (S.tab === 'recent') renderRecent(); else { const q = $('#q'); if (q) q.focus(); } break;
    case 'clear': S.query = ''; { const q = $('#q'); if (q) { q.value = ''; q.focus(); } } renderResults(); break;
    case 'host-clear': S.hostQuery = ''; { const q = $('#hq'); if (q) { q.value = ''; q.focus(); } } renderHostGuestList(); break;
    case 'host-filter': S.hostFilter = el.dataset.f; renderHostPane(true); break;
    case 'pink-apply': applyPinkList(el.dataset.mode); break;
    case 'pink-set': setPink(id, el.dataset.v === '1'); break;
    case 'pink-clear': S.pinkQuery = ''; { const q = $('#pq'); if (q) { q.value = ''; q.focus(); } } renderPinkLists(); break;
    case 'pink-filter': S.pinkFilter = el.dataset.f; renderPinkLists(); break;
    case 'open': openSheet({ type: 'guest', id }); break;
    case 'edit': openSheet({ type: 'edit', id }); break;
    case 'checkin': checkInFromSheet(id, false); break;
    case 'checkin-one': if (S.sheet && S.sheet.type === 'edit') { checkIn(id); closeSheet(); toast(`${esc((S.guests.get(id) || {}).name || '')} ✓`, 'blue'); } else checkInFromSheet(id, true); break;
    case 'undo': undoCheckIn(id); if (S.sheet && S.sheet.type === 'guest' && S.sheet.id === id) closeSheet(); if (S.sheet && S.sheet.type === 'edit') closeSheet(); toast('Check-in undone', 'ok'); break;
    case 'toggle-pink': { const g = S.guests.get(id); if (g) setPinkGiven(id, !g.pinkGiven); } break;
    case 'close': closeSheet(); break;
    case 'toast-undo': if (S.toastUndo) S.toastUndo(); hideToast(); toast('Undone', 'ok'); break;
    case 'add-submit': submitAdd(); break;
    case 'host-add': openSheet({ type: 'add', name: el.dataset.name || '' }); break;
    case 'save-edit': saveEdit(id); break;
    case 'delete-guest': deleteGuest(id); break;
    case 'host-tab': S.hostTab = el.dataset.tab; $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === S.hostTab)); renderHostPane(true); break;
    case 'import-preview': importPreview(); break;
    case 'import-run': importRun(); break;
    case 'export-csv': exportCsv(); break;
    case 'export-copy': exportCopy(); break;
    case 'save-settings': saveSettings(); break;
    case 'change-pin': renderPinGate('set'); break;
    case 'lock': SS.del('pd-unlocked'); mount(); break;
    case 'reset-demo': if (S.store.resetDemo) { S.store.resetDemo(); toast('Demo data reset', 'ok'); } break;
    case 'pin-digit': pinDigit(el.dataset.d); break;
    case 'pin-back': if (S.pin) { S.pin.buf = S.pin.buf.slice(0, -1); $$('.pindots span').forEach((s, i) => s.classList.toggle('on', i < S.pin.buf.length)); } break;
    default: break;
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && S.sheet) closeSheet();
  if (S.pin && /^[0-9]$/.test(e.key)) pinDigit(e.key);
  if (S.pin && e.key === 'Backspace') { S.pin.buf = S.pin.buf.slice(0, -1); $$('.pindots span').forEach((s, i) => s.classList.toggle('on', i < S.pin.buf.length)); }
});
overlayEl.addEventListener('click', closeSheet);
window.addEventListener('hashchange', () => location.reload());

boot();
