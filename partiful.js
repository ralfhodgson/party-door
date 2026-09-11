// Partiful CSV -> guest records. Used by tools/import-partiful.mjs (Node) and by
// the host view's Import screen (browser). No dependencies.
//
// Handles the current Partiful export shape (one row per person, plus-ones as
// their own rows with an "Is Plus One Of" column) and the older shape (a
// plus-one count per guest, optionally with plus-one names).

export function norm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', i = 0, q = false;
  text = String(text).replace(/^﻿/, '');
  while (i < text.length) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } q = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { q = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => String(v).trim() !== ''));
}

export function detectColumns(header) {
  const h = header.map((x) => String(x).trim().toLowerCase());
  const find = (exclude, ...pats) => {
    for (const p of pats) {
      const i = h.findIndex((c, idx) => !exclude.includes(idx) && p.test(c));
      if (i >= 0) return i;
    }
    return -1;
  };
  const cols = {};
  cols.first = find([], /^first(\s*name)?$/, /first\s*name/);
  cols.last = find([], /^last(\s*name)?$/, /last\s*name|surname/);
  cols.name = find([], /^(full\s*)?name$/, /^guest(\s*name)?$/);
  if (cols.name < 0) cols.name = h.findIndex((c) => /name/.test(c) && !/first|last|plus|guest\s*names|host|invit/.test(c));
  cols.phone = find([], /^phone/, /phone|mobile|\btel\b/);
  cols.email = find([], /e-?mail/);
  cols.instagram = find([], /instagram|insta\b|handle/);
  cols.status = find([], /^(rsvp|status|rsvp status|response|going\??)$/, /\bstatus\b/, /rsvp(?!\s*date)|response/);
  cols.plusOf = find([], /plus\s*-?\s*one\s*of/, /guest\s*of/, /invited\s*by/);
  cols.plusNames = find([cols.plusOf], /(plus|\+)\s*-?\s*ones?.*names?/, /guest\s*names/, /names? of (additional|extra)/);
  cols.plus = find([cols.plusOf, cols.plusNames], /^(plus|\+)\s*-?\s*ones?$/, /(plus|\+)\s*-?\s*ones?(?!.*(name|of))/, /additional guests|extra guests|guest count|party size|# ?guests|number of guests/);
  cols.checkedIn = find([], /check(ed)?[\s-]*in/);
  cols.note = find([cols.instagram, cols.email], /^note/, /note|comment|message|dietary/);
  return cols;
}

export function hash10(str) {
  // Two FNV-1a passes with different mixing -> 10 hex chars. Stable ids across re-imports.
  let a = 0x811c9dc5, b = 0x1b873593;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    a ^= c; a = Math.imul(a, 0x01000193) >>> 0;
    b ^= c; b = Math.imul(b, 0x01000193) >>> 0; b ^= b >>> 13;
  }
  return (a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')).slice(0, 10);
}

export function cleanPhone(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  const plus = s.startsWith('+');
  s = s.replace(/\D/g, '');
  if (!s) return '';
  if (plus) return '+' + s;
  if (s.startsWith('44') && s.length === 12) return '+' + s;
  return s;
}

export function cleanHandle(raw) {
  return String(raw || '').trim().replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/[\/?#].*$/, '').replace(/^@+/, '').trim().slice(0, 40);
}

export function splitName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] || '', last: parts.slice(1).join(' ') };
}

export function splitNames(s) {
  return String(s || '').split(/\s*(?:,|;|\/|\n|&| and | \+ )\s*/i).map((x) => x.trim()).filter(Boolean);
}

const DEFAULT_STATUSES = ['going', 'yes', 'approved', 'accepted', 'attending', 'confirmed', 'checked in'];

/**
 * rows: parsed CSV rows (first row = header)
 * opts: { statuses: string[] accepted RSVP statuses (lowercase substrings),
 *         pinkNames: string[] full names entitled to pink,
 *         plusInheritPink: bool, allStatuses: bool }
 * returns { guests, report, cols }
 */
export function buildGuests(rows, opts = {}) {
  const header = rows[0] || [];
  const cols = opts.cols || detectColumns(header);
  const statuses = (opts.statuses && opts.statuses.length ? opts.statuses : DEFAULT_STATUSES).map((s) => s.toLowerCase());
  const pinkSet = new Map((opts.pinkNames || []).map((n) => [norm(n), n]));
  const pinkMatched = new Set();
  const report = {
    rows: rows.length - 1, imported: 0, plusOnes: 0, plusUnnamed: 0, plusUnlinked: 0, skippedStatus: 0, skippedNoName: 0,
    duplicatesIdentical: 0, duplicateNames: 0, statusCounts: {}, pinkUnmatched: [], pinkAmbiguous: [], columns: {},
  };
  for (const [k, v] of Object.entries(cols)) if (v >= 0) report.columns[k] = header[v];

  const get = (row, i) => (i >= 0 && i < row.length ? String(row[i]).trim() : '');
  const records = []; // { name, email, handle, phone, plusOf (name), note, plusCount, plusNames, rowIndex }
  const seenIdentical = new Set();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    let name = get(row, cols.name);
    if (!name && (cols.first >= 0 || cols.last >= 0)) name = `${get(row, cols.first)} ${get(row, cols.last)}`.trim();
    if (!name) { report.skippedNoName++; continue; }
    const status = get(row, cols.status);
    report.statusCounts[status || '(blank)'] = (report.statusCounts[status || '(blank)'] || 0) + 1;
    if (!opts.allStatuses && cols.status >= 0 && !statuses.some((s) => status.toLowerCase().includes(s))) { report.skippedStatus++; continue; }
    const rec = {
      name, email: get(row, cols.email).toLowerCase(), handle: cleanHandle(get(row, cols.instagram)), phone: cleanPhone(get(row, cols.phone)),
      plusOf: get(row, cols.plusOf), note: cols.note >= 0 ? get(row, cols.note).slice(0, 200) : '',
      plusCount: parseInt(get(row, cols.plus), 10) || 0, plusNames: cols.plusNames >= 0 ? splitNames(get(row, cols.plusNames)) : [], rowIndex: r,
    };
    const identity = [norm(rec.name), rec.email, rec.handle.toLowerCase(), rec.phone, norm(rec.plusOf)].join('|');
    if (seenIdentical.has(identity)) { report.duplicatesIdentical++; continue; }
    seenIdentical.add(identity);
    rec.id = 'g_' + hash10(identity);
    records.push(rec);
  }
  // Guard against hash collisions between non-identical rows.
  const usedIds = new Set();
  for (const rec of records) { let id = rec.id, n = 2; while (usedIds.has(id)) id = `${rec.id}_${n++}`; rec.id = id; usedIds.add(id); }

  const mains = records.filter((r) => !r.plusOf);
  const byName = new Map();
  for (const m of mains) { const k = norm(m.name); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(m); }

  const guests = [];
  const pinkFor = (name) => { const k = norm(name); if (pinkSet.has(k)) { pinkMatched.add(k); return true; } return false; };
  const plusIndexByParent = new Map();

  for (const m of mains) {
    const { first, last } = splitName(m.name);
    const pink = pinkFor(m.name);
    guests.push({
      id: m.id, name: m.name, first, last, search: norm(m.name), phone: m.phone, phone3: m.phone.replace(/\D/g, '').slice(-3), email: m.email, handle: m.handle,
      rsvp: 'going', source: 'list', pink, plusOf: null, plusIndex: null, plusTotal: 0, plusNamed: true, note: m.note, inviter: '',
    });
    report.imported++;
    // Older export shape: a count (and maybe names) of plus-ones per guest.
    const total = Math.max(m.plusCount, m.plusNames.length);
    for (let k = 1; k <= total; k++) {
      const pn = m.plusNames[k - 1] || '';
      const pname = pn || `Guest of ${m.name}`;
      const ps = splitName(pn);
      guests.push({
        id: `${m.id}_p${k}`, name: pname, first: ps.first, last: ps.last, search: norm(pname), phone: '', phone3: '', email: '', handle: '',
        rsvp: 'going', source: 'list', pink: (pn && pinkFor(pn)) || (!!opts.plusInheritPink && pink), plusOf: m.id, plusIndex: k, plusTotal: 0, plusNamed: !!pn, note: '', inviter: m.name,
      });
      report.plusOnes++;
      if (!pn) report.plusUnnamed++;
    }
    if (total) guests.find((g) => g.id === m.id).plusTotal = total;
  }

  // Current export shape: plus-ones are their own rows naming their inviter.
  for (const p of records.filter((r) => r.plusOf)) {
    const candidates = byName.get(norm(p.plusOf)) || [];
    const parent = candidates[0] || null;
    if (!parent) report.plusUnlinked++;
    const { first, last } = splitName(p.name);
    const parentGuest = parent ? guests.find((g) => g.id === parent.id) : null;
    const idx = parent ? (plusIndexByParent.get(parent.id) || 0) + 1 : null;
    if (parent) plusIndexByParent.set(parent.id, idx);
    const pink = pinkFor(p.name) || (!!opts.plusInheritPink && !!(parentGuest && parentGuest.pink));
    guests.push({
      id: p.id, name: p.name, first, last, search: norm(p.name), phone: p.phone, phone3: p.phone.replace(/\D/g, '').slice(-3), email: p.email, handle: p.handle,
      rsvp: 'going', source: 'list', pink, plusOf: parent ? parent.id : null, plusIndex: idx, plusTotal: 0, plusNamed: true, note: p.note, inviter: p.plusOf,
    });
    if (parentGuest) parentGuest.plusTotal = idx;
    report.plusOnes++;
  }

  // Same display name appearing more than once (kept; flagged on the door).
  const nameCount = new Map();
  for (const g of guests) nameCount.set(g.search, (nameCount.get(g.search) || 0) + 1);
  report.duplicateNames = [...nameCount.values()].filter((c) => c > 1).length;
  for (const [nk, original] of pinkSet) {
    if (!pinkMatched.has(nk)) report.pinkUnmatched.push(original);
    else if ((nameCount.get(nk) || 0) > 1) report.pinkAmbiguous.push(original);
  }
  return { guests, report, cols };
}
