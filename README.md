# Party door check-in

A web page for the door team. Opens in Safari or Chrome on any iPad or phone,
no login, no app store. Several devices work at once and stay in sync within a
second or two. Ticks survive a dropped connection and sync when it comes back.

Three links, each doing one job:

| Link | Who has it | Can do |
|---|---|---|
| **Door** `…/#door/<doorKey>` | security | scroll or search the list, check people in, undo, see the wristband colour to hand over, name an unnamed plus-one |
| **Add** `…/#add/<addKey>` | you and whoever you trust to add people on the night | everything Door can, plus add walk-ins (and edit or delete the ones they added) |
| **Host** `…/#host/<hostKey>` | you | everything: live dashboard, edit and delete anyone, import the list, export a spreadsheet, settings. Behind a 4-digit PIN on the device. |

A device opens its link once; after that it keeps its role even if the page is
reloaded or added to the home screen. The keys are checked server-side by the
database rules, so a door iPad cannot add or delete people even if someone pokes
at it.

Wristbands: everyone who is checked in gets **blue**. People flagged pink get
**blue + pink**; the screen shows a large split blue/pink block before the
check-in button so the right bands are in hand.

## Try it without any setup (demo mode)

While `firebase-config.js` is still `null` the app runs in demo mode: serve the
folder, open `index.html` and a demo menu offers the Door, Add and Host views
with sample names. Open two tabs to see live sync between them. Demo data lives
in the browser only.

```sh
cd party-door && python3 -m http.server 8080
# then http://localhost:8080/?demo=1#door/x
```

## One-off setup (about ten minutes)

### 1. Firebase project (free tier is plenty)

1. Go to <https://console.firebase.google.com>, **Add project**, name it (for example `party-door`), turn Google Analytics off, create.
2. **Build → Authentication → Get started → Sign-in method → Anonymous → Enable → Save.**
3. **Build → Firestore Database → Create database.** Location `europe-west2 (London)`. Start in **production mode**.
4. **Firestore → Rules** tab: replace everything with the contents of `firestore.rules` and **Publish**.
5. **Firestore → Data** tab: **Start collection** with ID `private`, document ID `config`, and three string fields `doorKey`, `addKey`, `hostKey`. Generate values with `node tools/make-keys.mjs` (or any long random strings). Save.
6. **Project settings (gear) → General → Your apps → Web (`</>`)**, register the app (no Hosting), then copy the `firebaseConfig` object.
7. Paste it into `firebase-config.js` so the file reads `window.FIREBASE_CONFIG = { apiKey: "...", ... };`
8. **Authentication → Settings → Authorized domains**: add the domain the page will be served from (for GitHub Pages, `<user>.github.io`).

### 2. Hosting

This repository is served by GitHub Pages from the `gh-pages` branch at
<https://ralfhodgson.github.io/party-door/>. Only code lives here, never guest
data. To deploy a change, commit on `main` and run `tools/deploy.sh`, which
pushes `main` and mirrors it to `gh-pages`. Bump `CACHE` in `sw.js` whenever you
deploy so devices with the page cached pick up the new version.

### 3. Load the guest list

Either upload the Partiful CSV directly on the Host view **Import** tab, or
prepare it first:

```sh
node tools/import-partiful.mjs RUSH2026_guests.csv --pink pink.txt --out guests.json
```

`pink.txt` is one full name per line for the pink wristbands. The tool reports
statuses seen, plus-ones linked, duplicate names and any pink names it could not
find on the list. Upload `guests.json` on the Import tab. Re-importing is safe:
check-ins are kept, names and colours are updated.

Only rows whose status is Approved/Going are imported. Emails and phone numbers
go to a host-only collection; door devices see the name, the Instagram handle
(as a tiebreaker for duplicate names) and who invited a plus-one.

## On the night

- Open the Door link on the iPad, optionally **Share → Add to Home Screen** for a full-screen app. Nothing to set up.
- The whole list sits under the search box in alphabetical order, so staff can scroll or type. Type a few letters of anything you know about them: first or last name, Instagram handle, who invited them, or a word from their note. Typos of a letter or two still match. Tap the person. Check the colour block. Tap **Check in**. The search clears for the next guest.
- Plus-ones show under their inviter and can be checked in together or one at a time.
- **Recent arrivals** tab: undo a mistaken tick.
- Green dot = live. Amber = syncing. Red = offline; ticks are kept on the device and sync when the connection returns.
- Not on the list? Only the Add link can add them. Whoever holds it types the name (and pink if applicable); the person appears on every door iPad immediately.

## Afterwards

Host view → **Export** downloads a CSV of everyone with arrival time, where the
tick came from (door, add link or host), wristbands, walk-ins and contact details.

## Files

- `index.html`, `styles.css`, `app.js` — the app (door, add and host views)
- `store-firebase.js` — Firestore data layer (anonymous auth, offline cache, role claims)
- `store-demo.js` — in-browser stand-in with sample data
- `firestore.rules` — the security rules; the actual access control
- `partiful.js` — CSV parsing and guest-list building, shared by the tool and the Import tab
- `tools/import-partiful.mjs`, `tools/make-keys.mjs`, `tools/build-vendor.sh`
- `vendor/firebase.js` — self-contained Firebase SDK bundle (rebuild with the script above)
- `sw.js` — service worker so the shell loads even if the network is down at that moment
