// Firebase store: Firestore with offline persistence + anonymous auth.
// A device claims a role (door / adder / host) by writing roles/{uid} with the
// key from the link it opened; firestore.rules checks that key against
// private/config and enforces what each role may do. The rules are the
// security boundary; nothing in this file is.

import * as F from './vendor/firebase.js';

const CLAIM_TIMEOUT_MS = 15000;

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

export async function createFirebaseStore(config) {
  const app = F.initializeApp(config);
  const auth = F.getAuth(app);
  let db;
  try {
    db = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) });
  } catch {
    db = F.initializeFirestore(app, { localCache: F.memoryLocalCache() });
  }
  if (config.emulator) F.connectFirestoreEmulator(db, config.emulator.host || '127.0.0.1', config.emulator.port || 8080);

  // Reuse the persisted anonymous user if there is one; otherwise create one.
  const existing = await new Promise((resolve) => {
    let off = () => {};
    const t = setTimeout(() => { off(); resolve(null); }, 4000);
    off = F.onAuthStateChanged(auth, (u) => { clearTimeout(t); off(); resolve(u); }, () => { clearTimeout(t); resolve(null); });
  });
  const user = existing || (await F.signInAnonymously(auth)).user;
  const uid = user.uid;

  const statusListeners = new Set();
  let status = { online: navigator.onLine !== false, pending: false };
  let seenServer = false;
  const setStatus = (patch) => { status = { ...status, ...patch }; statusListeners.forEach((cb) => cb(status)); };
  window.addEventListener('online', () => setStatus({ online: true }));
  window.addEventListener('offline', () => setStatus({ online: false }));

  const store = {
    mode: 'firebase',
    uid,
    role: 'none',

    async claimRole(role, key) {
      const body = { role, k: String(key), label: role, ua: (navigator.userAgent || '').slice(0, 120), at: new Date().toISOString() };
      try {
        await withTimeout(F.setDoc(F.doc(db, 'roles', uid), body), CLAIM_TIMEOUT_MS, 'No connection. Connect to the internet to activate this link, then reload.');
        store.role = role;
        return true;
      } catch (e) {
        if (/permission|denied/i.test(String((e && (e.code || e.message)) || e))) return false;
        throw e;
      }
    },

    async refreshRole() {
      try {
        const snap = await withTimeout(F.getDoc(F.doc(db, 'roles', uid)), 8000, 'timeout');
        store.role = snap.exists() ? (snap.data().role || 'none') : 'none';
      } catch {
        store.role = store.role || 'none';
      }
      return store.role;
    },

    onGuests(cb, onError) {
      return F.onSnapshot(F.collection(db, 'guests'), { includeMetadataChanges: true }, (snap) => {
        const map = new Map();
        snap.forEach((d) => map.set(d.id, { ...d.data(), id: d.id }));
        if (!snap.metadata.fromCache) seenServer = true;
        setStatus({ online: !snap.metadata.fromCache || (!seenServer && status.online), pending: snap.metadata.hasPendingWrites });
        cb(map);
      }, (err) => { if (onError) onError(err); });
    },

    onMeta(cb, onError) {
      return F.onSnapshot(F.doc(db, 'meta', 'party'), (snap) => cb(snap.exists() ? snap.data() : {}), (err) => { if (onError) onError(err); });
    },

    onStatus(cb) { statusListeners.add(cb); cb(status); return () => statusListeners.delete(cb); },

    // Write promises resolve when the server acknowledges. The UI must not
    // block on them: the snapshot listener shows the change immediately.
    updateGuest(id, patch) { return F.updateDoc(F.doc(db, 'guests', id), clean(patch)); },

    addGuest(g, priv) {
      const id = g.id || F.doc(F.collection(db, 'guests')).id;
      const at = new Date().toISOString();
      const writes = [F.setDoc(F.doc(db, 'guests', id), clean({ ...g, id, createdAt: at, updatedAt: at }))];
      if (priv && store.role === 'host') writes.push(F.setDoc(F.doc(db, 'private_guests', id), clean(priv), { merge: true }));
      return { id, done: Promise.all(writes) };
    },

    deleteGuest(id) {
      const p = F.deleteDoc(F.doc(db, 'guests', id));
      if (store.role === 'host') F.deleteDoc(F.doc(db, 'private_guests', id)).catch(() => {});
      return p;
    },

    setMeta(patch) { return F.setDoc(F.doc(db, 'meta', 'party'), clean(patch), { merge: true }); },

    // items: [{ id, doc, merge, priv }]. merge=true updates static fields only
    // (keeps check-in state); merge=false writes the full document.
    async importGuests(items, onProgress) {
      const CHUNK = 240; // up to 2 writes per item; Firestore batch limit is 500
      for (let i = 0; i < items.length; i += CHUNK) {
        const batch = F.writeBatch(db);
        const at = new Date().toISOString();
        for (const it of items.slice(i, i + CHUNK)) {
          const ref = F.doc(db, 'guests', it.id);
          if (it.merge) batch.set(ref, clean({ ...it.doc, updatedAt: at }), { merge: true });
          else batch.set(ref, clean({ ...it.doc, id: it.id, createdAt: at, updatedAt: at }));
          if (it.priv) batch.set(F.doc(db, 'private_guests', it.id), clean(it.priv), { merge: true });
        }
        await batch.commit();
        if (onProgress) onProgress(Math.min(items.length, i + CHUNK), items.length);
      }
      return { count: items.length };
    },

    async loadPrivate() {
      const snap = await F.getDocs(F.collection(db, 'private_guests'));
      const map = new Map();
      snap.forEach((d) => map.set(d.id, d.data() || {}));
      return map;
    },

    setPrivate(id, priv) { return F.setDoc(F.doc(db, 'private_guests', id), clean(priv), { merge: true }); },

    logEvent(evt) {
      F.addDoc(F.collection(db, 'events'), clean({ ...evt, uid, at: new Date().toISOString() })).catch(() => {});
    },

    async loadEvents() {
      const snap = await F.getDocs(F.query(F.collection(db, 'events'), F.orderBy('at', 'desc'), F.limit(2000)));
      const out = [];
      snap.forEach((d) => out.push(d.data()));
      return out;
    },
  };
  return store;
}
