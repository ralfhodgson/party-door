// Security rules tests, run inside `firebase emulators:exec`.
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');

const KEYS = { doorKey: 'door-key-1', addKey: 'add-key-1', hostKey: 'host-key-1' };
const results = [];
const check = async (name, promise, expectSuccess) => {
  try { await (expectSuccess ? assertSucceeds(promise) : assertFails(promise)); results.push(`PASS  ${name}`); }
  catch (e) { results.push(`FAIL  ${name}  -> ${String(e.message || e).split('\n')[0].slice(0, 160)}`); process.exitCode = 1; }
};
const allow = (name, p) => check(name, p, true);
const deny = (name, p) => check(name, p, false);

const baseGuest = (over = {}) => ({
  id: 'g1', name: 'Test Guest', first: 'Test', last: 'Guest', search: 'test guest', phone3: '', handle: '', inviter: '', rsvp: 'going', source: 'list',
  pink: false, plusOf: null, plusIndex: null, plusTotal: 0, plusNamed: true, note: '', checkedIn: false, checkedInAt: null, checkedInBy: null, checkedInByUid: null,
  pinkGiven: false, pinkGivenAt: null, addedBy: null, addedByUid: null, createdAt: 'x', updatedAt: 'x', ...over,
});

(async () => {
  const host = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8181';
  const [h, p] = host.split(':');
  const env = await initializeTestEnvironment({ projectId: 'demo-party', firestore: { rules: fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8'), host: h, port: Number(p) } });
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.doc('private/config').set(KEYS);
    await db.doc('guests/g1').set(baseGuest());
    await db.doc('guests/g2').set(baseGuest({ id: 'g2', name: 'Guest of Test Guest', search: 'guest of test guest', plusOf: 'g1', plusIndex: 1, plusNamed: false }));
    await db.doc('guests/w_other').set(baseGuest({ id: 'w_other', name: 'Other Walkin', source: 'walkin', rsvp: 'walkin', addedBy: 'Add link', addedByUid: 'adder-2' }));
    await db.doc('private_guests/g1').set({ phone: '07000000000', email: 'a@b.c' });
    await db.doc('meta/party').set({ name: 'Party' });
    await db.doc('roles/door-1').set({ role: 'door', k: KEYS.doorKey });
    await db.doc('roles/adder-1').set({ role: 'adder', k: KEYS.addKey });
    await db.doc('roles/adder-2').set({ role: 'adder', k: KEYS.addKey });
    await db.doc('roles/host-1').set({ role: 'host', k: KEYS.hostKey });
  });

  const anon = env.unauthenticatedContext().firestore();
  const nobody = env.authenticatedContext('nobody-1').firestore();
  const door = env.authenticatedContext('door-1').firestore();
  const adder = env.authenticatedContext('adder-1').firestore();
  const hostDb = env.authenticatedContext('host-1').firestore();

  // --- no role
  await deny('unauthenticated cannot read guests', anon.collection('guests').get());
  await deny('signed-in without role cannot read guests', nobody.collection('guests').get());
  await deny('nobody can read private/config', nobody.doc('private/config').get());
  await deny('nobody can read private/config even as host', hostDb.doc('private/config').get());
  await deny('cannot claim door role with wrong key', nobody.doc('roles/nobody-1').set({ role: 'door', k: 'wrong' }));
  await deny('cannot claim host role with door key', nobody.doc('roles/nobody-1').set({ role: 'host', k: KEYS.doorKey }));
  await deny('cannot write someone else\'s role doc', nobody.doc('roles/door-1').set({ role: 'door', k: KEYS.doorKey }));
  await deny('cannot smuggle extra fields into role doc', nobody.doc('roles/nobody-1').set({ role: 'door', k: KEYS.doorKey, admin: true }));
  await allow('can claim door role with door key', nobody.doc('roles/nobody-1').set({ role: 'door', k: KEYS.doorKey, label: 'door', at: 'x' }));
  await allow('newly claimed door can read guests', nobody.collection('guests').get());
  await deny('door cannot read someone else\'s role doc', door.doc('roles/host-1').get());

  // --- door
  await allow('door reads guests', door.collection('guests').get());
  await allow('door reads meta', door.doc('meta/party').get());
  await deny('door cannot write meta', door.doc('meta/party').set({ name: 'x' }, { merge: true }));
  await allow('door checks in (allowed fields)', door.doc('guests/g1').update({ checkedIn: true, checkedInAt: 'now', checkedInBy: 'Door 1', checkedInByUid: 'door-1', pinkGiven: true, pinkGivenAt: 'now', updatedAt: 'now' }));
  await allow('door undoes check-in', door.doc('guests/g1').update({ checkedIn: false, checkedInAt: null, checkedInBy: null, checkedInByUid: null, pinkGiven: false, pinkGivenAt: null, updatedAt: 'now' }));
  await deny('door cannot change pink entitlement', door.doc('guests/g1').update({ pink: true }));
  await deny('door cannot rename a named guest', door.doc('guests/g1').update({ name: 'Renamed', first: 'Renamed', last: '', search: 'renamed' }));
  await deny('door cannot change note or source', door.doc('guests/g1').update({ note: 'x', updatedAt: 'now' }));
  await allow('door can name an unnamed plus-one', door.doc('guests/g2').update({ name: 'Real Name', first: 'Real', last: 'Name', search: 'real name', plusNamed: true, updatedAt: 'now' }));
  await deny('door cannot rename that plus-one again once named', door.doc('guests/g2').update({ name: 'Again', first: 'Again', last: '', search: 'again', plusNamed: true, updatedAt: 'now' }));
  await deny('door cannot create a guest', door.doc('guests/new1').set(baseGuest({ id: 'new1', source: 'walkin', addedByUid: 'door-1' })));
  await deny('door cannot delete a guest', door.doc('guests/g1').delete());
  await deny('door cannot read private_guests', door.doc('private_guests/g1').get());
  await deny('door cannot list private_guests', door.collection('private_guests').get());
  await allow('door can log an event', door.collection('events').add({ type: 'checkin', guestId: 'g1', at: 'now' }));
  await deny('door cannot read events', door.collection('events').get());

  // --- adder
  await allow('adder reads guests', adder.collection('guests').get());
  await allow('adder checks someone in', adder.doc('guests/g1').update({ checkedIn: true, checkedInAt: 'now', checkedInBy: 'Host', checkedInByUid: 'adder-1', updatedAt: 'now' }));
  await allow('adder creates a walk-in with own uid', adder.doc('guests/w1').set(baseGuest({ id: 'w1', name: 'Walk In', source: 'walkin', rsvp: 'walkin', addedBy: 'Add link', addedByUid: 'adder-1' })));
  await deny('adder cannot create a walk-in attributed to another uid', adder.doc('guests/w2').set(baseGuest({ id: 'w2', source: 'walkin', addedByUid: 'someone-else' })));
  await deny('adder cannot create a non-walk-in (list) guest', adder.doc('guests/w3').set(baseGuest({ id: 'w3', source: 'list', addedByUid: 'adder-1' })));
  await deny('adder cannot create a walk-in with empty name', adder.doc('guests/w4').set(baseGuest({ id: 'w4', name: '', source: 'walkin', addedByUid: 'adder-1' })));
  await allow('adder edits own walk-in freely', adder.doc('guests/w1').update({ name: 'Walk In Two', first: 'Walk', last: 'In Two', search: 'walk in two', pink: true, note: 'vip', updatedAt: 'now' }));
  await allow('adder deletes own walk-in', adder.doc('guests/w1').delete());
  await deny('adder cannot edit another adder\'s walk-in beyond door fields', adder.doc('guests/w_other').update({ pink: true }));
  await allow('adder can still check in another adder\'s walk-in', adder.doc('guests/w_other').update({ checkedIn: true, checkedInAt: 'now', checkedInBy: 'H', checkedInByUid: 'adder-1', updatedAt: 'now' }));
  await deny('adder cannot delete another adder\'s walk-in', adder.doc('guests/w_other').delete());
  await deny('adder cannot delete a list guest', adder.doc('guests/g1').delete());
  await deny('adder cannot read private_guests', adder.doc('private_guests/g1').get());
  await deny('adder cannot write meta', hostDb === null ? Promise.reject(new Error('x')) : adder.doc('meta/party').set({ name: 'x' }, { merge: true }));

  // --- host
  await allow('host reads private_guests', hostDb.collection('private_guests').get());
  await allow('host writes private_guests', hostDb.doc('private_guests/g1').set({ phone: '1', email: 'x@y.z' }, { merge: true }));
  await allow('host writes meta', hostDb.doc('meta/party').set({ name: 'RUSH 2026' }, { merge: true }));
  await allow('host imports a list guest', hostDb.doc('guests/imp1').set(baseGuest({ id: 'imp1', source: 'list' })));
  await allow('host merge-updates static fields', hostDb.doc('guests/imp1').set({ name: 'Imp One', pink: true }, { merge: true }));
  await allow('host edits any field', hostDb.doc('guests/g1').update({ pink: true, note: 'host note' }));
  await allow('host deletes a guest', hostDb.doc('guests/imp1').delete());
  await allow('host reads events', hostDb.collection('events').get());
  await deny('events cannot be edited', hostDb.collection('events').get().then((snap) => snap.docs.length ? hostDb.doc(`events/${snap.docs[0].id}`).delete() : Promise.reject(new Error('no event to test'))));

  await env.cleanup();
  console.log(results.join('\n'));
  console.log(`\n${results.filter((r) => r.startsWith('PASS')).length} passed, ${results.filter((r) => r.startsWith('FAIL')).length} failed`);
})().catch((e) => { console.error('RULES TEST CRASHED:', e); console.log(results.join('\n')); process.exit(2); });
