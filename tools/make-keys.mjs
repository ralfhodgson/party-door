#!/usr/bin/env node
// Prints three fresh link keys. Put them in Firestore at private/config as
// doorKey / addKey / hostKey, then build the links as described in README.md.
import { randomBytes } from 'node:crypto';
const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'; // no 0/1/i/l/o to avoid misreads
function key(n = 22) {
  const b = randomBytes(n); let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[b[i] % ALPHABET.length];
  return s;
}
console.log(JSON.stringify({ doorKey: key(), addKey: key(), hostKey: key() }, null, 2));
