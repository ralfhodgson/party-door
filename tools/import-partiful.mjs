#!/usr/bin/env node
// Converts a Partiful guest-list CSV into guests.json for the host Import screen.
//
//   node tools/import-partiful.mjs guests.csv --out guests.json [--pink pink.txt]
//        [--statuses going,approved] [--all-statuses] [--plus-inherit-pink]
//
// pink.txt: one full name per line (people who get a pink wristband).
import { readFileSync, writeFileSync } from 'node:fs';
import { parseCsv, buildGuests, detectColumns } from '../partiful.js';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const flag = (name) => args.includes(name);
const csvPath = args.find((a) => !a.startsWith('--') && a.endsWith('.csv'));
if (!csvPath) { console.error('Usage: node tools/import-partiful.mjs guests.csv --out guests.json [--pink pink.txt]'); process.exit(1); }

const rows = parseCsv(readFileSync(csvPath, 'utf8'));
const pinkPath = opt('--pink');
const pinkNames = pinkPath ? readFileSync(pinkPath, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#')) : [];
const statuses = opt('--statuses', '').split(',').map((s) => s.trim()).filter(Boolean);

const { guests, report } = buildGuests(rows, { pinkNames, statuses, allStatuses: flag('--all-statuses'), plusInheritPink: flag('--plus-inherit-pink') });
const out = opt('--out', 'guests.json');
writeFileSync(out, JSON.stringify(guests, null, 1));

console.log(`Header columns detected:`, report.columns);
console.log(`Rows in CSV: ${report.rows}`);
console.log(`RSVP statuses seen:`, report.statusCounts);
console.log(`Imported main guests: ${report.imported}  (skipped by status: ${report.skippedStatus}, no name: ${report.skippedNoName}, identical duplicate rows dropped: ${report.duplicatesIdentical})`);
console.log(`Plus-ones created: ${report.plusOnes}  (without a name: ${report.plusUnnamed}, inviter not found: ${report.plusUnlinked})`);
console.log(`Names appearing more than once (kept, flagged on the door): ${report.duplicateNames}`);
console.log(`Pink entitled: ${guests.filter((g) => g.pink).length}`);
if (report.pinkUnmatched.length) console.log(`Pink names NOT found in the list (check spelling):\n  - ` + report.pinkUnmatched.join('\n  - '));
console.log(`Wrote ${guests.length} records to ${out}`);
