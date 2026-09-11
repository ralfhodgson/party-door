# Tests

```sh
cd party-door/tests && npm install
```

**Security rules** (needs Java for the Firestore emulator). Exercises every allow/deny
path for the door, add and host roles against `../firestore.rules`:

```sh
npm run rules
```

**Browser QA** (Playwright + Chromium). Starts its own local server on port 8080
(needs `python3` on the path), then:

```sh
npm run qa -- /path/to/partiful-export.csv     # or omit to use fixtures/sample.csv
```

Runs the door, add and host views in demo mode on iPad, iPhone-size and small
Android-size viewports,
checks search (including typos), group check-in, undo, live sync between tabs,
import/re-import safety, export and the PIN. Screenshots land in `screenshots/`.
