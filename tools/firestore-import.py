#!/usr/bin/env python3
# Import guests.json (from tools/import-partiful.mjs) straight into the live database
# from a terminal, without opening the Host view. Usage:
#   PARTY_HOST_KEY=<host link key> python3 tools/firestore-import.py guests.json [--pink-explicit]
# --pink-explicit: the file carries the definitive pink list (otherwise existing pink flags are kept).
# Uses Python only. Re-running is safe: check-ins, pink flags, notes and door-typed names survive.
import json, os, sys, datetime, urllib.request, urllib.error
API_KEY = "AIzaSyCrG3PBLYUcQ1YmxI5edQ-gzDIgebV0RfY"
PROJECT = "party-door"
HOST_KEY = os.environ.get("PARTY_HOST_KEY") or sys.exit("Set PARTY_HOST_KEY to the host link key")
DB = f"https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)"
DOCS_PATH = f"projects/{PROJECT}/databases/(default)/documents"
STATIC = ['name','first','last','search','phone3','rsvp','source','pink','plusOf','plusIndex','plusTotal','plusNamed','note','handle','inviter']
now = lambda: datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z')

def req(method, url, body=None, token=None, ok404=False):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    if token: r.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(r, timeout=90) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        if ok404 and e.code == 404: return None
        raise SystemExit(f"{method} …{url.split('(default)')[-1][:70]} -> HTTP {e.code}: {e.read().decode()[:300]}")

def val(v):
    if v is None: return {"nullValue": None}
    if isinstance(v, bool): return {"booleanValue": v}
    if isinstance(v, int): return {"integerValue": str(v)}
    if isinstance(v, float): return {"doubleValue": v}
    if isinstance(v, str): return {"stringValue": v}
    raise TypeError(type(v))
def fields(d): return {k: val(v) for k, v in d.items()}

guests = json.load(open(sys.argv[1]))
pink_explicit = len(sys.argv) > 2 and sys.argv[2] == '--pink-explicit'

# 1. anonymous sign-in
auth = req("POST", f"https://identitytoolkit.googleapis.com/v1/accounts:signUp?key={API_KEY}", {"returnSecureToken": True})
token, uid = auth["idToken"], auth["localId"]
print("signed in as temporary device", uid[:8])

# 2. claim host role with the host key (checked by the security rules)
req("PATCH", f"{DB}/documents/roles/{uid}", {"fields": fields({"role": "host", "k": HOST_KEY, "label": "import script", "at": now()})}, token)
print("host role granted")

# 3. existing guests (so re-imports keep check-ins, pink flags, notes and door-typed names)
existing = {}
url = f"{DB}/documents/guests?pageSize=1000&mask.fieldPaths=plusNamed&mask.fieldPaths=pink"
while url:
    page = req("GET", url, token=token)
    for d in page.get("documents", []):
        f = d.get("fields", {})
        existing[d["name"].rsplit("/", 1)[1]] = {"plusNamed": f.get("plusNamed", {}).get("booleanValue", True), "pink": f.get("pink", {}).get("booleanValue", False)}
    url = f"{DB}/documents/guests?pageSize=1000&mask.fieldPaths=plusNamed&mask.fieldPaths=pink&pageToken={page['nextPageToken']}" if page.get("nextPageToken") else None
print("already in the database:", len(existing))

# 4. build writes
writes = []
new_count = merged = 0
for g in guests:
    gid = g["id"]
    static = {k: g[k] for k in STATIC if k in g}
    if gid in existing:
        ex = existing[gid]
        if not pink_explicit and not g.get("pink"): static.pop("pink", None)
        for k in ("note", "handle", "phone3"):
            if not g.get(k): static.pop(k, None)
        if g.get("plusNamed") is False and ex["plusNamed"] is not False:
            for k in ("name", "first", "last", "search", "plusNamed"): static.pop(k, None)
        static["updatedAt"] = now()
        writes.append({"update": {"name": f"{DOCS_PATH}/guests/{gid}", "fields": fields(static)}, "updateMask": {"fieldPaths": list(static.keys())}})
        merged += 1
    else:
        doc = dict(static, id=gid, checkedIn=False, checkedInAt=None, checkedInBy=None, checkedInByUid=None, pinkGiven=False, pinkGivenAt=None, addedBy=None, addedByUid=None, createdAt=now(), updatedAt=now())
        writes.append({"update": {"name": f"{DOCS_PATH}/guests/{gid}", "fields": fields(doc)}})
        new_count += 1
    if g.get("phone") or g.get("email"):
        priv = {"phone": g.get("phone") or "", "email": g.get("email") or ""}
        writes.append({"update": {"name": f"{DOCS_PATH}/private_guests/{gid}", "fields": fields(priv)}, "updateMask": {"fieldPaths": ["phone", "email"]}})

# 5. commit in batches of <= 480 writes
for i in range(0, len(writes), 480):
    req("POST", f"{DB}/documents:commit", {"writes": writes[i:i+480]}, token)
    print(f"committed {min(i+480, len(writes))}/{len(writes)} writes")
print(f"guests written: {new_count} new, {merged} updated")

# 6. party name if none set yet
meta = req("GET", f"{DB}/documents/meta/party", token=token, ok404=True)
if not meta or not meta.get("fields", {}).get("name", {}).get("stringValue"):
    req("PATCH", f"{DB}/documents/meta/party?updateMask.fieldPaths=name", {"fields": fields({"name": "RUSH 2026"})}, token)
    print("party name set to RUSH 2026 (change it in Host → Settings)")

# 7. verify count
agg = req("POST", f"{DB}/documents:runAggregationQuery", {"structuredAggregationQuery": {"structuredQuery": {"from": [{"collectionId": "guests"}]}, "aggregations": [{"count": {}, "alias": "n"}]}}, token)
count = agg[0]["result"]["aggregateFields"]["n"]["integerValue"] if isinstance(agg, list) else "?"
print("guests now in the database:", count)

# 8. remove the temporary host credential
req("DELETE", f"{DB}/documents/roles/{uid}", token=token)
print("temporary host role removed")
