// Demo store: same interface as store-firebase.js, but everything lives in this
// browser (localStorage) and syncs between tabs with BroadcastChannel, so the
// live-sync behaviour can be seen without a Firebase project. Any key works.

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
const KEY = 'party-door-demo-v2';
const CH = 'party-door-demo';

const FIRST = ['Amelia', 'Oliver', 'Isla', 'George', 'Ava', 'Noah', 'Mia', 'Leo', 'Grace', 'Arthur', 'Freya', 'Oscar',
  'Ivy', 'Harry', 'Poppy', 'Jack', 'Sophie', 'Charlie', 'Ella', 'Alfie', 'Chloe', 'Freddie', 'Lily', 'Theo',
  'Evie', 'Archie', 'Rosie', 'Henry', 'Zara', 'Finley', 'Maya', 'Louis', 'Layla', 'Hugo', 'Aisha', 'Ethan',
  'Priya', 'Tom', 'Hannah', 'Sam', 'Kai', 'Ruby', 'Ben', 'Nia', 'Josh', 'Sienna', 'Dan', 'Molly'];
const LAST = ['Clarke', 'Patel', 'Hughes', 'Okafor', 'Murphy', 'Bennett', 'Khan', 'Evans', 'Walsh', 'Nguyen', 'Price',
  'Thompson', 'Ahmed', 'Hodgson', 'Reid', 'Chen', 'Morgan', 'Barnes', 'Doyle', 'Shaw', 'Sharma', 'Foster', 'Griffiths', 'Lawson'];

function norm(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function now() { return new Date().toISOString(); }
function rid(p) { return `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }

function seed() {
  const guests = {}, priv = {};
  let n = 0;
  const t0 = Date.now() - 55 * 60 * 1000;
  for (let i = 0; i < 48; i++) {
    const first = FIRST[i % FIRST.length], last = LAST[(i * 7) % LAST.length];
    const name = `${first} ${last}`;
    const id = `g_demo${String(i).padStart(3, '0')}`;
    const pink = i % 6 === 0;
    const plusTotal = i % 5 === 0 ? 1 + (i % 2) : 0;
    const checkedIn = i % 4 === 1;
    guests[id] = {
      id, name, first, last, search: norm(name), phone3: '', handle: i % 3 === 0 ? `${first.toLowerCase()}.${last.toLowerCase()}` : '', inviter: '',
      rsvp: 'going', source: 'list', pink, plusOf: null, plusIndex: null, plusTotal, plusNamed: true,
      note: i === 9 ? 'Friend of Ralf, arriving late' : '',
      checkedIn, checkedInAt: checkedIn ? new Date(t0 + (n++) * 4 * 60 * 1000).toISOString() : null,
      checkedInBy: checkedIn ? 'Door' : null, checkedInByUid: null,
      pinkGiven: checkedIn && pink, pinkGivenAt: null, addedBy: null, addedByUid: null, createdAt: now(), updatedAt: now(),
    };
    priv[id] = { email: `${first.toLowerCase()}.${last.toLowerCase()}@example.com`, phone: '' };
    for (let k = 1; k <= plusTotal; k++) {
      const pid = `${id}_p${k}`;
      const named = !(k === 1 && i % 10 === 5);
      const pname = named ? `${FIRST[(i + 13 * k) % FIRST.length]} ${LAST[(i + 5 * k) % LAST.length]}` : `Guest of ${name}`;
      guests[pid] = {
        ...guests[id], id: pid, name: pname, first: named ? pname.split(' ')[0] : '', last: named ? pname.split(' ')[1] : '',
        search: norm(pname), handle: '', inviter: name, pink: false, plusOf: id, plusIndex: k, plusTotal: 0, plusNamed: named, note: '',
        checkedIn: false, checkedInAt: null, checkedInBy: null, pinkGiven: false,
      };
    }
  }
  // A second "Amelia Clarke" to show the same-name flag.
  guests.g_demo_dup = { ...guests.g_demo000, id: 'g_demo_dup', handle: 'ameliac_', checkedIn: false, checkedInAt: null, checkedInBy: null, pinkGiven: false, pink: false, plusTotal: 0 };
  const w = rid('w');
  guests[w] = {
    id: w, name: 'Jordan Wells', first: 'Jordan', last: 'Wells', search: 'jordan wells', phone3: '', handle: '', inviter: '', rsvp: 'walkin', source: 'walkin',
    pink: true, plusOf: null, plusIndex: null, plusTotal: 0, plusNamed: true, note: 'Added by Ralf on the night',
    checkedIn: false, checkedInAt: null, checkedInBy: null, checkedInByUid: null, pinkGiven: false, pinkGivenAt: null,
    addedBy: 'Host', addedByUid: 'demo-host', createdAt: now(), updatedAt: now(),
  };
  return { guests, priv, events: [], meta: { name: 'Demo party', dateLabel: 'Sat 20 Sep', doorsOpen: '20:00' } };
}

function load() { try { const s = LS.get(KEY); return s ? JSON.parse(s) : null; } catch { return null; } }
function save(state) { try { LS.set(KEY, JSON.stringify(state)); } catch { /* blocked or full: keep in memory */ } }

export async function createDemoStore() {
  let state = load() || seed();
  save(state);
  const listeners = { guests: new Set(), meta: new Set() };
  let bc = null;
  try { bc = 'BroadcastChannel' in self ? new BroadcastChannel(CH) : null; } catch { bc = null; }
  let uid = SS.get('pd-demo-uid');
  if (!uid) { uid = rid('demo'); SS.set('pd-demo-uid', uid); }

  const toMap = () => new Map(Object.entries(state.guests).map(([id, g]) => [id, { ...g }]));
  const emit = (kind) => {
    if (kind === 'guests') listeners.guests.forEach((cb) => cb(toMap()));
    if (kind === 'meta') listeners.meta.forEach((cb) => cb({ ...state.meta }));
  };
  const commit = (kind) => { save(state); emit(kind); if (bc) bc.postMessage({ kind }); };
  if (bc) bc.onmessage = (e) => { state = load() || state; emit(e.data.kind); };

  const store = {
    mode: 'demo',
    uid,
    role: SS.get('pd-demo-role') || 'none',
    async claimRole(role, key) {
      if (!key || !['door', 'adder', 'host'].includes(role)) return false;
      store.role = role; SS.set('pd-demo-role', role); return true;
    },
    async refreshRole() { store.role = SS.get('pd-demo-role') || 'none'; return store.role; },
    onGuests(cb) { listeners.guests.add(cb); cb(toMap()); return () => listeners.guests.delete(cb); },
    onMeta(cb) { listeners.meta.add(cb); cb({ ...state.meta }); return () => listeners.meta.delete(cb); },
    onStatus(cb) { cb({ online: navigator.onLine !== false, pending: false }); return () => {}; },
    async updateGuest(id, patch) {
      if (!state.guests[id]) throw new Error('Guest not found');
      state.guests[id] = { ...state.guests[id], ...patch, updatedAt: now() }; commit('guests');
    },
    addGuest(g, priv) {
      const id = g.id || rid('w');
      state.guests[id] = { ...g, id, createdAt: now(), updatedAt: now() };
      if (priv) state.priv[id] = { ...(state.priv[id] || {}), ...priv };
      commit('guests');
      return { id, done: Promise.resolve() };
    },
    async deleteGuest(id) { delete state.guests[id]; delete state.priv[id]; commit('guests'); },
    async setMeta(patch) { state.meta = { ...state.meta, ...patch }; commit('meta'); },
    async importGuests(items, onProgress) {
      items.forEach((it, i) => {
        const existing = state.guests[it.id];
        state.guests[it.id] = it.merge && existing ? { ...existing, ...it.doc, updatedAt: now() } : { ...it.doc, id: it.id, createdAt: now(), updatedAt: now() };
        if (it.priv) state.priv[it.id] = { ...(state.priv[it.id] || {}), ...it.priv };
        if (onProgress && (i % 50 === 0 || i === items.length - 1)) onProgress(i + 1, items.length);
      });
      commit('guests'); return { count: items.length };
    },
    async loadPrivate() { return new Map(Object.entries(state.priv)); },
    async setPrivate(id, priv) { state.priv[id] = { ...(state.priv[id] || {}), ...priv }; save(state); },
    logEvent(evt) { state.events.push({ ...evt, at: now(), uid }); if (state.events.length > 3000) state.events.splice(0, 500); save(state); },
    async loadEvents() { return state.events.slice(); },
    async resetDemo() { state = seed(); commit('guests'); commit('meta'); },
  };
  return store;
}
