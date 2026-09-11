# Tests

```sh
cd party-door/tests && npm install
```

**Security rules** (needs Java for the Firestore emulator). Exercises every allow/deny
path for the door, add and host roles against `../firestore.rules`:

```sh
npm run rules
```

**Browser QA** (Playwright + Chromium). Serve `party-door/` on port 8080 first
(`python3 -m http.server 8080` from that folder), then:

```sh
npm run qa -- /path/to/partiful-export.csv     # or omit to use fixtures/sample.csv
```

Runs the door, add and host views in demo mode on iPad and phone viewports,
checks search (including typos), group check-in, undo, live sync between tabs,
import/re-import safety, export and the PIN. Screenshots land in `screenshots/`.
