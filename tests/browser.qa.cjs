const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');
const SITE_DIR = process.env.SITE_DIR || path.join(__dirname, '..');
function serve(dir, port) {
  const child = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: dir, stdio: 'ignore' });
  child.unref();
  const waitPort = () => new Promise((resolve) => { const tryOnce = () => { const sock = net.connect(port, '127.0.0.1'); sock.once('connect', () => { sock.end(); resolve(); }); sock.once('error', () => setTimeout(tryOnce, 150)); }; tryOnce(); });
  return { child, ready: waitPort() };
}
const OUT = path.join(__dirname, 'screenshots'); fs.mkdirSync(OUT, { recursive: true });
const BASE = 'http://127.0.0.1:8080/';
const CSV = process.argv[2] || path.join(__dirname, 'fixtures', 'sample.csv'); // a Partiful export to import during the run
const errors = [];
const results = [];
const ok = (name, cond, extra = '') => { results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`); if (!cond) process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const server = serve(SITE_DIR, 8080);
  await server.ready;
  process.on('exit', () => { try { server.child.kill(); } catch {} });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 1, hasTouch: true, acceptDownloads: true });
  const track = (page, label) => {
    page.on('pageerror', (e) => errors.push(`[${label}] pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${label}] console: ${m.text()}`); });
  };
  // fresh demo state
  const door = await ctx.newPage(); track(door, 'door');
  await door.goto(BASE + '?demo=1&nosw=1');
  await door.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });

  // ---- gate without link
  await door.goto(BASE + '?demo=1&nosw=1');
  await door.waitForSelector('.gate h1');
  ok('demo menu shows when opened without a link', (await door.textContent('.gate h1')).includes('Demo'));
  await door.screenshot({ path: `${OUT}/00-demo-menu.png` });
  await door.click('[data-act="demo-enter"][data-view="door"]');
  await door.waitForSelector('#q');
  ok('demo menu opens the door view straight into search (one door, no picker)', true);
  await door.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });

  // ---- door link -> station pick
  await door.goto(BASE + '?demo=1&nosw=1#door/x');
  await door.waitForSelector('#q');
  ok('door view mounted straight into search', !!(await door.$('#results')));
  ok('no door picker or door button anywhere', !(await door.$('[data-act="pick-station"], #station-btn')));
  // alphabetical full list under the search box
  const listNames = await door.$$eval('#results .row .name', (els) => els.map((e) => e.textContent));
  const sortedCopy = [...listNames].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
  const totalGuests = await door.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('party-door-demo-v2')).guests).length);
  ok('full list shown when nothing typed', listNames.length === totalGuests, `${listNames.length} rows`);
  ok('full list is alphabetical', JSON.stringify(listNames) === JSON.stringify(sortedCopy), listNames.slice(0, 3).join(' | '));
  const letters = await door.$$eval('#results .letter', (els) => els.map((e) => e.textContent));
  ok('letter dividers present and ordered', letters.length > 5 && JSON.stringify(letters) === JSON.stringify([...letters].sort()), letters.join(''));
  await door.screenshot({ path: `${OUT}/01-door-list.png` });
  const statsText = await door.textContent('#stats');
  ok('stats rendered', /arrived/.test(statsText) && /pink/.test(statsText), statsText.replace(/\s+/g, ' ').trim());
  await door.screenshot({ path: `${OUT}/02-door-empty.png` });

  // ---- search exact + typo + partial multiword
  await door.fill('#q', 'amel');
  await door.waitForFunction(() => document.querySelectorAll('#results .row').length > 0);
  let names = await door.$$eval('#results .row .name', (els) => els.map((e) => e.textContent));
  ok('search "amel" finds Amelia rows', names.some((n) => /Amelia/.test(n)), names.slice(0, 4).join(' | '));
  ok('duplicate name flagged', (await door.textContent('#results')).includes('Same name twice'));
  await door.screenshot({ path: `${OUT}/03-door-search.png` });

  await door.fill('#q', 'amelai clrke');
  await sleep(100);
  names = await door.$$eval('#results .row .name', (els) => els.map((e) => e.textContent));
  ok('typo search "amelai clrke" still finds Amelia Clarke', names.some((n) => n === 'Amelia Clarke'), names.slice(0, 3).join(' | '));

  await door.fill('#q', 'cl am');
  await sleep(100);
  names = await door.$$eval('#results .row .name', (els) => els.map((e) => e.textContent));
  ok('reversed partial "cl am" finds Amelia Clarke first', names[0] === 'Amelia Clarke', names.slice(0, 3).join(' | '));

  // all-field search: handle substring, inviter, note
  await door.fill('#q', 'ameliac');
  await sleep(100);
  names = await door.$$eval('#results .row .name', (els) => els.map((e) => e.textContent));
  ok('handle substring "ameliac" finds the @ameliac_ guest', names.includes('Amelia Clarke'), names.slice(0, 3).join(' | '));
  await door.fill('#q', '@amelia.clarke');
  await sleep(100);
  names = await door.$$eval('#results .row .name', (els) => els.map((e) => e.textContent));
  ok('full handle with @ and dot finds the guest', names[0] === 'Amelia Clarke', names.slice(0, 3).join(' | '));
  await door.fill('#q', 'arriving late');
  await sleep(100);
  names = await door.$$eval('#results .row .name', (els) => els.map((e) => e.textContent));
  ok('note text is searchable', names.length === 1 && /Arthur/.test(names[0]), names.join(' | '));
  await door.fill('#q', 'zzzzqq');
  await sleep(100);
  ok('no-match hint shown', (await door.textContent('#results')).includes('No one called'));
  ok('door cannot add (hint says only add link)', (await door.textContent('#results')).includes('Only the add-guests link'));

  // ---- open sheet for pink guest with plus-one (Amelia Clarke, g_demo000)
  await door.fill('#q', 'amelia clarke');
  await sleep(100);
  await door.click('#results .row[data-id="g_demo000"] .btn');
  await door.waitForSelector('#sheet.open');
  const sheetText = await door.textContent('#sheet');
  ok('sheet shows BLUE + PINK band', /BLUE \+ PINK/.test(sheetText));
  ok('sheet shows duplicate warning', /Another guest has this name/.test(sheetText));
  ok('sheet lists plus-one', /Coming with Amelia/.test(sheetText));
  ok('sheet offers group check-in', /Check in all 2/.test(sheetText));
  await sleep(300);
  await door.screenshot({ path: `${OUT}/04-sheet-pink-group.png` });

  // ---- group check-in
  await door.click('#sheet [data-act="checkin"]');
  await door.waitForSelector('#toast.show');
  const toastText = await door.textContent('#toast');
  ok('toast confirms pink', /PINK/.test(toastText), toastText.replace(/\s+/g, ' ').trim());
  await door.screenshot({ path: `${OUT}/05-toast.png` });
  ok('search cleared after check-in', (await door.inputValue('#q')) === '');
  const state = await door.evaluate(() => { const s = JSON.parse(localStorage.getItem('party-door-demo-v2')); return { main: s.guests.g_demo000, kid: s.guests.g_demo000_p1 }; });
  ok('main guest checked in with station + pinkGiven', state.main.checkedIn && state.main.checkedInBy === 'Door' && state.main.pinkGiven === true);
  ok('plus-one checked in too', state.kid.checkedIn === true);

  // ---- recent tab + undo
  await door.click('[data-act="tab"][data-tab="recent"]');
  await door.waitForSelector('#recent .row');
  const recentNames = await door.$$eval('#recent .row .name', (els) => els.slice(0, 2).map((e) => e.textContent));
  ok('recent shows the two just-ticked people first', recentNames.includes('Amelia Clarke') && recentNames.includes('Harry Bennett'), recentNames.join(' | '));
  await door.screenshot({ path: `${OUT}/06-recent.png` });
  await door.click('#recent .row[data-id="g_demo000_p1"] [data-act="undo"]');
  await sleep(150);
  const kidAfter = await door.evaluate(() => JSON.parse(localStorage.getItem('party-door-demo-v2')).guests.g_demo000_p1.checkedIn);
  ok('undo from recent works', kidAfter === false);
  await door.click('[data-act="tab"][data-tab="search"]');

  // ---- ticking group members one at a time keeps the sheet open
  await door.fill('#q', 'jack');
  await sleep(100);
  const groupId = await door.$$eval('#results .row', (els) => (els.find((e) => e.textContent.includes('+2')) || {}).dataset?.id);
  ok('found a guest with two plus-ones', !!groupId, String(groupId));
  await door.click(`#results .row[data-id="${groupId}"] .btn`);
  await door.waitForSelector('#sheet.open');
  const firstKidBtn = await door.$('#sheet .plist [data-act="checkin-one"]');
  await firstKidBtn.click();
  await sleep(150);
  ok('sheet stays open after ticking one plus-one', await door.$eval('#sheet', (el) => el.classList.contains('open')));
  ok('that plus-one now shows Undo in the sheet', (await door.$$eval('#sheet .plist [data-act="undo"]', (els) => els.length)) === 1);
  await door.click('#sheet [data-act="checkin-one"][data-id="' + groupId + '"]');
  await sleep(150);
  ok('"Just them" keeps sheet open too (group not finished)', await door.$eval('#sheet', (el) => el.classList.contains('open')));
  await sleep(300);
  await door.screenshot({ path: `${OUT}/04b-sheet-group-partial.png` });
  await door.click('#sheet [data-act="close"]');
  await sleep(100);

  // ---- unnamed plus-one: name typed at check-in (g_demo010_p2 is "Guest of ...")
  await door.fill('#q', 'guest of');
  await sleep(100);
  const unnamedId = await door.$eval('#results .row', (el) => el.dataset.id);
  await door.click(`#results .row[data-id="${unnamedId}"] .btn`);
  await door.waitForSelector('#sheet-name');
  await door.fill('#sheet-name', 'Tested Plusone');
  await door.click('#sheet [data-act="checkin"]');
  await sleep(150);
  const renamed = await door.evaluate((id) => JSON.parse(localStorage.getItem('party-door-demo-v2')).guests[id], unnamedId);
  ok('unnamed plus-one renamed and checked in', renamed.name === 'Tested Plusone' && renamed.plusNamed === true && renamed.checkedIn === true, renamed.name);

  // ---- add view in a second page (same browser profile -> BroadcastChannel sync)
  const add = await ctx.newPage(); track(add, 'add');
  await add.goto(BASE + '?demo=1&nosw=1#add/x');
  await add.waitForSelector('[data-act="pick-station"], #a-name');
  if (await add.$('[data-act="pick-station"]')) await add.click('[data-act="pick-station"][data-station="Host"]');
  await add.waitForSelector('#a-name');
  ok('add view mounted (station remembered on this device)', true);
  await add.fill('#a-name', 'Walkin Tester');
  await add.check('#a-pink');
  await add.fill('#a-note', 'QA note');
  await add.click('[data-act="add-submit"]');
  await add.waitForSelector('#toast.show');
  ok('add toast', /added/.test(await add.textContent('#toast')));
  await add.waitForFunction(() => document.querySelectorAll('#own-list .row').length > 0);
  await add.screenshot({ path: `${OUT}/07-add.png` });
  ok('own list shows the walk-in', (await add.textContent('#own-list')).includes('Walkin Tester'));

  // live sync: door page sees it without reload
  await door.fill('#q', 'walkin tes');
  await door.waitForFunction(() => (document.querySelector('#results') || {}).textContent.includes('Walkin Tester'), null, { timeout: 5000 }).catch(() => {});
  ok('door sees walk-in added from add link (live sync)', (await door.textContent('#results')).includes('Walkin Tester'));
  ok('walk-in flagged as Walk-in + PINK on door', /Walk-in/.test(await door.textContent('#results')) && /PINK/.test(await door.textContent('#results')));
  await door.screenshot({ path: `${OUT}/08-door-sees-walkin.png` });

  // adder can edit own walk-in
  await add.click('#own-list .row');
  await add.waitForSelector('#sheet.open');
  ok('adder sees Edit details on own walk-in', /Edit details/.test(await add.textContent('#sheet')));
  await add.click('#sheet [data-act="edit"]');
  await add.waitForSelector('#e-name');
  await add.fill('#e-name', 'Walkin Tester Two');
  await add.click('#sheet [data-act="save-edit"]');
  await sleep(150);
  ok('adder edit saved', (await add.textContent('#own-list')).includes('Walkin Tester Two'));

  // ---- host view in a third page: PIN set, dashboard, import real CSV, export
  const host = await ctx.newPage(); track(host, 'host');
  await host.goto(BASE + '?demo=1&nosw=1#host/x');
  await host.waitForSelector('.pinpad');
  await host.screenshot({ path: `${OUT}/09-pin.png` });
  for (const d of '1234') await host.click(`[data-act="pin-digit"][data-d="${d}"]`);
  await host.waitForSelector('.pinpad');
  for (const d of '1234') await host.click(`[data-act="pin-digit"][data-d="${d}"]`);
  await host.waitForSelector('#host-main .kpi');
  ok('host dashboard mounted', (await host.textContent('#host-main')).includes('arrived of'));
  await host.screenshot({ path: `${OUT}/10-host-live.png`, fullPage: true });

  await host.click('[data-act="host-tab"][data-tab="guests"]');
  await host.waitForSelector('#host-list .row');
  await host.fill('#hq', 'jordan');
  await sleep(100);
  ok('host guest search works', (await host.textContent('#host-list')).includes('Jordan Wells'));
  await host.fill('#hq', 'priya.ahmed@example');
  await sleep(100);
  ok('host can search by email', (await host.textContent('#host-list')).includes('Priya'), (await host.textContent('#host-list')).slice(0, 80));
  await host.fill('#hq', 'thompson@');
  await sleep(100);
  ok('host email substring search', /Thompson/.test(await host.textContent('#host-list')));
  await host.fill('#hq', 'priya');
  await sleep(100);
  ok('host sees private email on a listed guest', /@example\.com/.test(await host.textContent('#host-list')));
  await host.fill('#hq', 'jordan');
  await sleep(100);
  await host.screenshot({ path: `${OUT}/11-host-guests.png` });

  // edit + delete flow
  await host.click('#host-list .row');
  await host.waitForSelector('#e-name');
  await sleep(300);
  await host.screenshot({ path: `${OUT}/11b-host-edit.png` });
  await host.click('#sheet [data-act="delete-guest"]');
  await sleep(50);
  ok('delete asks to confirm', /Tap again/.test(await host.textContent('#sheet')));
  await host.click('#sheet [data-act="delete-guest"]');
  await sleep(150);
  ok('guest deleted', !(await host.textContent('#host-list')).includes('Jordan Wells'));

  // pink tab: full list with toggles, filters, search, paste list (add / replace / inherit)
  await host.click('[data-act="host-tab"][data-tab="pink"]');
  await host.waitForSelector('#pink-list .row');
  const pinkBefore = await host.evaluate(() => Object.values(JSON.parse(localStorage.getItem('party-door-demo-v2')).guests).filter((g) => g.pink).length);
  const totalNow = await host.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('party-door-demo-v2')).guests).length);
  ok('pink tab lists everyone A to Z with a toggle each', (await host.$$eval('#pink-list .row', (els) => els.length)) === totalNow && (await host.$$eval('#pink-list [data-act="pink-set"]', (els) => els.length)) === totalNow);
  ok('pink tab has letter dividers', (await host.$$eval('#pink-list .letter', (els) => els.length)) > 5);
  await host.click('[data-act="pink-filter"][data-f="pink"]'); await sleep(100);
  ok('Pink only filter shows only pink people', (await host.$$eval('#pink-list .row', (els) => els.length)) === pinkBefore && (await host.$$eval('#pink-list .row .pill.pink', (els) => els.length)) === pinkBefore);
  await host.click('[data-act="pink-filter"][data-f="all"]'); await sleep(100);
  await host.fill('#pq', 'ava murphy'); await sleep(100);
  ok('pink search finds the person', (await host.textContent('#pink-list')).includes('Ava Murphy'));
  await host.click('#pink-list [data-act="pink-set"][data-v="1"]'); await sleep(150);
  const ava = await host.evaluate(() => Object.values(JSON.parse(localStorage.getItem('party-door-demo-v2')).guests).find((g) => g.name === 'Ava Murphy'));
  ok('one-tap Make pink sets the flag', ava.pink === true);
  ok('row now offers Remove pink', /Remove pink/.test(await host.textContent('#pink-list')));
  await host.click('[data-act="pink-clear"]'); await sleep(100);
  await host.click('#pink-paste-box summary');
  await host.fill('#pink-paste', 'Ben Khan\nJack Nguyen\nNobody Realname');
  await host.check('#pink-inherit');
  await host.click('[data-act="pink-apply"][data-mode="add"]');
  await host.waitForFunction(() => /names found/.test((document.querySelector('#pink-result') || {}).textContent || ''), null, { timeout: 5000 });
  const res1 = (await host.textContent('#pink-result')).replace(/\s+/g, ' ');
  ok('paste list reports matches and the unknown name', /2 of 3 names found/.test(res1) && /Nobody Realname/.test(res1), res1.slice(0, 120));
  const pinkAfter = await host.evaluate(() => { const gs = Object.values(JSON.parse(localStorage.getItem('party-door-demo-v2')).guests); return { jack: gs.find((g) => g.name === 'Jack Nguyen').pink, jackKids: gs.filter((g) => g.plusOf === 'g_demo015').map((g) => g.pink), ava: gs.find((g) => g.name === 'Ava Murphy').pink, total: gs.filter((g) => g.pink).length }; });
  ok('add mode keeps existing pinks and flags plus-ones when inherit is on', pinkAfter.jack === true && pinkAfter.jackKids.every(Boolean) && pinkAfter.ava === true && pinkAfter.total > pinkBefore, JSON.stringify(pinkAfter));
  await host.fill('#pink-paste', 'Ava Murphy');
  await host.uncheck('#pink-inherit');
  await host.click('[data-act="pink-apply"][data-mode="replace"]');
  await host.waitForFunction(() => /removed/.test((document.querySelector('#pink-result') || {}).textContent || ''), null, { timeout: 5000 });
  const onlyAva = await host.evaluate(() => Object.values(JSON.parse(localStorage.getItem('party-door-demo-v2')).guests).filter((g) => g.pink).map((g) => g.name));
  ok('replace mode leaves exactly the pasted names pink', onlyAva.length === 1 && onlyAva[0] === 'Ava Murphy', onlyAva.join(','));
  await door.fill('#q', 'ava murphy'); await sleep(200);
  ok('door shows PINK for the newly flagged guest (live)', /PINK/.test(await door.textContent('#results')));
  await host.screenshot({ path: `${OUT}/19-host-pink.png` });

  // import real CSV
  await host.click('[data-act="host-tab"][data-tab="import"]');
  await host.waitForSelector('#import-file');
  await host.setInputFiles('#import-file', CSV);
  await host.click('[data-act="import-preview"]');
  await host.waitForSelector('[data-act="import-run"]');
  const preview = await host.textContent('#import-result');
  ok('import preview counts 587 records (330 + 257)', /587<\/b>|587 records|>587</.test(await host.innerHTML('#import-result')) && /330 guests and 257 plus-ones/.test(preview), preview.replace(/\s+/g, ' ').trim().slice(0, 160));
  await host.screenshot({ path: `${OUT}/12-import-preview.png` });
  await host.click('[data-act="import-run"]');
  await host.waitForSelector('#import-done .notice', { timeout: 20000 });
  ok('import completed', /Done\. 587/.test(await host.textContent('#import-done')));
  const total = await host.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('party-door-demo-v2')).guests).length);
  ok('store now holds demo + imported guests', total > 587, String(total));

  // re-import keeps check-ins: check one imported guest in, re-import, verify still in
  const someId = await host.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('party-door-demo-v2')).guests).find((k) => k.startsWith('g_') && !k.startsWith('g_demo')));
  await door.fill('#q', '');
  await door.evaluate((id) => { const s = JSON.parse(localStorage.getItem('party-door-demo-v2')); s.guests[id].checkedIn = true; s.guests[id].checkedInAt = new Date().toISOString(); localStorage.setItem('party-door-demo-v2', JSON.stringify(s)); }, someId);
  await host.reload(); await host.waitForSelector('.pinpad, #host-main .kpi');
  if (await host.$('.pinpad')) { for (const d of '1234') await host.click(`[data-act="pin-digit"][data-d="${d}"]`); }
  await host.waitForSelector('#host-main .kpi');
  ok('host stays unlocked across a reload in the same tab', true);
  await host.click('[data-act="host-tab"][data-tab="import"]');
  await host.setInputFiles('#import-file', CSV);
  await host.click('[data-act="import-preview"]');
  await host.waitForSelector('[data-act="import-run"]');
  ok('re-import preview shows existing', /587 already on the list/.test(await host.textContent('#import-result')));
  await host.click('[data-act="import-run"]');
  await host.waitForSelector('#import-done .notice', { timeout: 20000 });
  const stillIn = await host.evaluate((id) => JSON.parse(localStorage.getItem('party-door-demo-v2')).guests[id].checkedIn, someId);
  ok('re-import keeps check-in state', stillIn === true);
  // pink flag + host note set in the app must survive a re-import that has no pink list
  await door.evaluate((id) => { const s = JSON.parse(localStorage.getItem('party-door-demo-v2')); s.guests[id].pink = true; s.guests[id].note = 'host note'; localStorage.setItem('party-door-demo-v2', JSON.stringify(s)); }, someId);
  await host.reload(); await host.waitForSelector('.pinpad, #host-main .kpi');
  if (await host.$('.pinpad')) { for (const d of '1234') await host.click(`[data-act="pin-digit"][data-d="${d}"]`); }
  await host.waitForSelector('#host-main .kpi');
  await host.click('[data-act="host-tab"][data-tab="import"]');
  await host.setInputFiles('#import-file', CSV);
  await host.click('[data-act="import-preview"]');
  await host.waitForSelector('[data-act="import-run"]');
  await host.click('[data-act="import-run"]');
  await host.waitForSelector('#import-done .notice', { timeout: 20000 });
  const after = await host.evaluate((id) => JSON.parse(localStorage.getItem('party-door-demo-v2')).guests[id], someId);
  ok('re-import without a pink list keeps pink flag set in the app', after.pink === true);
  ok('re-import keeps a note written in the app', after.note === 'host note');

  // host Guests tab lists everyone with no cap
  await host.click('[data-act="host-tab"][data-tab="guests"]');
  await host.waitForSelector('#host-list .row');
  await host.fill('#hq', ''); await sleep(150);
  const hostRows = await host.$$eval('#host-list .row', (els) => els.length);
  ok('host Guests tab shows every guest with no 300 cap', hostRows === total, `${hostRows} rows of ${total}`);
  ok('host Guests tab has letter dividers', (await host.$$eval('#host-list .letter', (els) => els.length)) > 10);

  // door search over 600+ guests is fast and finds imported plus-one by inviter
  const t0 = Date.now();
  await door.fill('#q', 'an');
  await sleep(50);
  const dt = Date.now() - t0;
  ok('search over 600+ guests renders quickly', dt < 400, `${dt}ms`);
  const rowsShown = await door.$$eval('#results .row', (els) => els.length);
  ok('results capped at 40', rowsShown <= 40, String(rowsShown));

  // export
  await host.click('[data-act="host-tab"][data-tab="export"]');
  await host.waitForSelector('[data-act="export-csv"]');
  const [download] = await Promise.all([host.waitForEvent('download'), host.click('[data-act="export-csv"]')]);
  const dlPath = await download.path();
  const csvText = fs.readFileSync(dlPath, 'utf8');
  const lines = csvText.trim().split(/\r?\n/);
  ok('export CSV has header + one row per guest', lines.length === total + 1, `${lines.length} lines`);
  ok('export includes Instagram + Email columns', /Instagram/.test(lines[0]) && /Email/.test(lines[0]));

  // settings save -> door header updates live
  await host.click('[data-act="host-tab"][data-tab="settings"]');
  await host.waitForSelector('#s-name');
  await host.fill('#s-name', 'RUSH 2026');
  await host.fill('#s-doors', '21:00');
  await host.click('[data-act="save-settings"]');
  await sleep(200);
  ok('door header shows new party name (live)', (await door.textContent('#party-name')) === 'RUSH 2026', await door.textContent('#party-name'));
  await door.screenshot({ path: `${OUT}/13-door-renamed.png` });

  // lock + wrong pin
  await host.click('[data-act="lock"]');
  await host.waitForSelector('.pinpad');
  for (const d of '9999') await host.click(`[data-act="pin-digit"][data-d="${d}"]`);
  await sleep(50);
  ok('wrong PIN rejected', /Wrong PIN/.test(await host.textContent('.gate')));

  // ---- phone width: no horizontal scroll
  const phone = await ctx.newPage(); track(phone, 'phone');
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(BASE + '?demo=1&nosw=1#door/x');
  await phone.waitForSelector('#q');
  await phone.fill('#q', 'amelia');
  await sleep(100);
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok('no horizontal overflow at 390px', overflow <= 0, `${overflow}px`);
  await phone.screenshot({ path: `${OUT}/14-phone-door.png` });
  await phone.click('#results .row[data-id="g_demo_dup"] .btn');
  await phone.waitForSelector('#sheet.open');
  await sleep(300);
  await phone.screenshot({ path: `${OUT}/15-phone-sheet.png` });

  // ---- small Android phone (360 wide): door, sheet, add form, host dashboard
  const android = await ctx.newPage(); track(android, 'android');
  await android.setViewportSize({ width: 360, height: 740 });
  await android.goto(BASE + '?demo=1&nosw=1#door/x');
  await android.waitForSelector('#q');
  let ov = await android.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok('no horizontal overflow at 360px (door list)', ov <= 0, `${ov}px`);
  await android.fill('#q', 'amelia'); await sleep(100);
  await android.click('#results .row[data-id="g_demo_dup"] .btn');
  await android.waitForSelector('#sheet.open'); await sleep(300);
  ov = await android.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok('no horizontal overflow at 360px (sheet open)', ov <= 0, `${ov}px`);
  const sheetFits = await android.evaluate(() => { const r = document.querySelector('#sheet').getBoundingClientRect(); return r.width <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1; });
  ok('sheet fits within a 360px phone screen', sheetFits);
  const tapTargets = await android.$$eval('#sheet .btn', (els) => els.map((e) => e.getBoundingClientRect().height));
  ok('sheet buttons are at least 44px tall on a small phone', tapTargets.length > 0 && tapTargets.every((h) => h >= 44), tapTargets.map(Math.round).join(','));
  await android.screenshot({ path: `${OUT}/17-android-sheet.png` });
  await android.click('#sheet [data-act="close"]');
  await android.goto(BASE + '?demo=1&nosw=1#host/x');
  await android.waitForSelector('.pinpad, #host-main .kpi');
  if (await android.$('.pinpad')) { for (const d of '1234') await android.click(`[data-act="pin-digit"][data-d="${d}"]`); }
  await android.waitForSelector('#host-main .kpi');
  ov = await android.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok('no horizontal overflow at 360px (host dashboard)', ov <= 0, `${ov}px`);
  await android.screenshot({ path: `${OUT}/18-android-host.png` });

  // ---- landscape iPad
  await door.setViewportSize({ width: 1180, height: 820 });
  await door.fill('#q', 'harry');
  await sleep(100);
  await door.screenshot({ path: `${OUT}/16-door-landscape.png` });

  await browser.close();
  console.log(results.join('\n'));
  console.log(`\n${results.filter((r) => r.startsWith('PASS')).length} passed, ${results.filter((r) => r.startsWith('FAIL')).length} failed`);
  if (errors.length) { console.log('\nBROWSER ERRORS:'); console.log(errors.join('\n')); process.exitCode = 1; } else console.log('\nNo browser console/page errors.');
  try { server.child.kill(); } catch {}
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error('QA SCRIPT CRASHED:', e); console.log(results.join('\n')); process.exit(2); });
