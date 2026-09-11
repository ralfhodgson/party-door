#!/usr/bin/env sh
# Rebuilds vendor/firebase.js: a single self-contained ES module bundle of the
# Firebase Web SDK pieces the app uses (app, auth, firestore). Self-hosting it
# means the door page has no dependency on Google's CDN at run time and the
# service worker can cache it. Run from party-door/.
set -eu
TMP="$(mktemp -d)"
cat > "$TMP/package.json" <<'JSON'
{ "name": "vendor-build", "private": true, "type": "module" }
JSON
cat > "$TMP/entry.js" <<'JS'
export { initializeApp } from "firebase/app";
export { getAuth, signInAnonymously, onAuthStateChanged } from "firebase/auth";
export {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, memoryLocalCache,
  collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc, writeBatch,
  onSnapshot, query, where, orderBy, limit, deleteField, connectFirestoreEmulator
} from "firebase/firestore";
JS
( cd "$TMP" && npm install firebase@12.19.0 esbuild@0.25.9 --no-audit --no-fund --loglevel=error \
  && npx esbuild entry.js --bundle --format=esm --minify --target=es2020 --outfile=firebase.js )
mkdir -p vendor && cp "$TMP/firebase.js" vendor/firebase.js
echo "vendor/firebase.js rebuilt ($(wc -c < vendor/firebase.js) bytes)"
