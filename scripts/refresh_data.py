#!/usr/bin/env python3
"""
The Larder — weekly data refresh.

Pulls the USDA Local Food Portal directories (farmers markets, on-farm markets,
CSAs, food hubs) and the USDA SNAP Retailer Locator around each anchor ZIP,
keeps community-type SNAP vendors (farmers markets, co-ops, incentive-program
participants), adds the hand-picked vendors in data/community_vendors.json,
checks each website for a public Shopify catalog, and writes
data/local_sources.json for the Larder to read from its own site.
No relays, no runtime dependency on third parties.

Safety rule: if a refresh comes back with nothing, the previous file is kept
and the job exits non-zero so GitHub flags the failed run (and emails the owner).

Standard library only. Run:  USDA_API_KEY=... python scripts/refresh_data.py
"""
import difflib
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "local_sources.json")
CONFIG = os.path.join(ROOT, "data", "regions.json")
ZIPS = os.path.join(ROOT, "data", "zips.json")
CURATED = os.path.join(ROOT, "data", "community_vendors.json")
SNAP_URL = os.environ.get(
    "SNAP_URL",
    "https://services1.arcgis.com/RLQu0rK7h4kbsBq5/arcgis/rest/services/snap_retailer_location_data/FeatureServer/0/query")
COOP_RE = re.compile(r"\bco-?op\b|\bco op\b|\bcooperative\b", re.I)

USDA_BASE = os.environ.get("USDA_BASE", "https://www.usdalocalfoodportal.com/api")
API_KEY = os.environ.get("USDA_API_KEY", "").strip()
DIRECTORIES = {
    "farmersmarket": "Farmers Market",
    "onfarmmarket": "On-Farm Market",
    "csa": "CSA",
    "foodhub": "Food Hub",
}
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/129.0 Safari/537.36",
    "Accept": "application/json,text/html;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}
KEEP_FIELDS = [
    "listing_id", "listing_name", "brief_desc", "listing_desc", "media_website",
    "location_address", "location_city", "location_state", "location_zipcode",
    "location_x", "location_y", "updatetime",
]
MAX_PRODUCTS = 250


def log(*a):
    print(*a, flush=True)


def get(url, timeout=30):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read().decode("utf-8", "replace")


def load_regions():
    with open(CONFIG) as f:
        return json.load(f)["anchors"]


def fetch_directory(kind, zip_code, radius):
    q = urllib.parse.urlencode({"apikey": API_KEY, "zip": zip_code, "radius": radius})
    url = f"{USDA_BASE}/{kind}/?{q}"
    for attempt in range(3):
        try:
            status, body = get(url)
            if "apikey error" in body.lower():
                raise RuntimeError("USDA rejected the API key")
            data = json.loads(body)
            rows = data if isinstance(data, list) else data.get("data", [])
            return rows
        except RuntimeError:
            raise
        except Exception as e:  # network blip, 5xx, bad JSON: retry
            log(f"  {kind} {zip_code}: attempt {attempt + 1} failed: {e}")
            time.sleep(3 * (attempt + 1))
    return None


STATE_ABBR = {
    "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR", "california": "CA", "colorado": "CO",
    "connecticut": "CT", "delaware": "DE", "district of columbia": "DC", "florida": "FL", "georgia": "GA",
    "hawaii": "HI", "idaho": "ID", "illinois": "IL", "indiana": "IN", "iowa": "IA", "kansas": "KS",
    "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD", "massachusetts": "MA",
    "michigan": "MI", "minnesota": "MN", "mississippi": "MS", "missouri": "MO", "montana": "MT",
    "nebraska": "NE", "nevada": "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM",
    "new york": "NY", "north carolina": "NC", "north dakota": "ND", "ohio": "OH", "oklahoma": "OK",
    "oregon": "OR", "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
    "tennessee": "TN", "texas": "TX", "utah": "UT", "vermont": "VT", "virginia": "VA", "washington": "WA",
    "west virginia": "WV", "wisconsin": "WI", "wyoming": "WY",
}


def clean(row, kind):
    out = {k: row.get(k) for k in KEEP_FIELDS if row.get(k) not in (None, "")}
    if "location_state" in out:
        st = str(out["location_state"]).strip()
        out["location_state"] = STATE_ABBR.get(st.lower(), st.upper() if len(st) == 2 else st)
    if "location_city" in out:
        city = str(out["location_city"]).strip()
        out["location_city"] = city.title() if city.isupper() or city.islower() else city
    out["directory_type"] = kind
    out["type_label"] = DIRECTORIES[kind]
    for k in ("location_x", "location_y"):
        try:
            out[k] = round(float(out[k]), 5)
        except (KeyError, TypeError, ValueError):
            out.pop(k, None)
    for k in ("brief_desc", "listing_desc"):
        if k in out:
            out[k] = re.sub(r"\s+", " ", str(out[k])).strip()[:240]
    return out


def miles(lat1, lon1, lat2, lon2):
    r = 3958.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def norm_name(n):
    n = re.sub(r"[^a-z0-9 ]", " ", str(n or "").lower())
    n = re.sub(r"\b(the|farmers?|market|markets|inc|llc|co|op|coop|cooperative|store|food|foods)\b", " ", n)
    return re.sub(r"\s+", " ", n).strip()


def tidy(text):
    t = re.sub(r"\s+", " ", str(text or "")).strip()
    return t.title() if t.isupper() or t.islower() else t


def fetch_snap(lat, lon, radius):
    """All SNAP-authorized retailers in a box around the anchor. None on failure."""
    dlat = radius / 69.0
    dlon = radius / (69.0 * math.cos(math.radians(lat)))
    rows, offset = [], 0
    while True:
        q = urllib.parse.urlencode({
            "where": "1=1",
            "geometry": f"{lon - dlon},{lat - dlat},{lon + dlon},{lat + dlat}",
            "geometryType": "esriGeometryEnvelope", "inSR": "4326",
            "spatialRel": "esriSpatialRelIntersects",
            "outFields": "Record_ID,Store_Name,Store_Street_Address,City,State,Zip_Code,Store_Type,Latitude,Longitude,Incentive_Program",
            "returnGeometry": "false", "orderByFields": "ObjectId",
            "resultOffset": offset, "resultRecordCount": 1000, "f": "json",
        })
        page = None
        for attempt in range(3):
            try:
                _, body = get(f"{SNAP_URL}?{q}", timeout=45)
                j = json.loads(body)
                if "error" in j:
                    raise RuntimeError(str(j["error"])[:200])
                page = j
                break
            except Exception as e:
                log(f"  SNAP page {offset}: attempt {attempt + 1} failed: {e}")
                time.sleep(3 * (attempt + 1))
        if page is None:
            return None
        feats = page.get("features") or []
        rows.extend(f.get("attributes") or {} for f in feats)
        if not feats or not page.get("exceededTransferLimit"):
            break
        offset += len(feats)
        if offset > 100000:
            break
    return rows


def snap_label(a):
    """Community-type SNAP vendors only; plain chain/convenience stores are left out."""
    stype = a.get("Store_Type") or ""
    name = a.get("Store_Name") or ""
    if re.search(r"farmer", stype, re.I):
        return "Farmers Market"
    if COOP_RE.search(name):
        return "Food Co-op"
    if (a.get("Incentive_Program") or "").strip():
        return "Grocer"
    return None


def snap_record(a, label):
    return {
        "listing_id": f"snap-{a.get('Record_ID')}",
        "listing_name": tidy(a.get("Store_Name")),
        "location_address": tidy(a.get("Store_Street_Address")),
        "location_city": tidy(a.get("City")),
        "location_state": (a.get("State") or "").upper(),
        "location_zipcode": a.get("Zip_Code"),
        "location_x": round(float(a["Longitude"]), 5),
        "location_y": round(float(a["Latitude"]), 5),
        "directory_type": "community",
        "type_label": label,
        "snap": True,
        **({"incentive": tidy(a["Incentive_Program"])} if (a.get("Incentive_Program") or "").strip() else {}),
    }


def find_match(rec, candidates, max_mi=0.4, min_sim=0.5):
    best, best_score = None, 0
    n1 = norm_name(rec.get("listing_name"))
    for c in candidates:
        d = miles(rec["location_y"], rec["location_x"], c["location_y"], c["location_x"])
        if d > max_mi:
            continue
        n2 = norm_name(c.get("listing_name"))
        sim = difflib.SequenceMatcher(None, n1, n2).ratio() if n1 and n2 else 0
        if d < 0.05:
            sim = max(sim, 0.6)  # same spot: almost certainly the same place
        if sim >= min_sim and sim > best_score:
            best, best_score = c, sim
    return best


def site_origin(website):
    if not website:
        return None
    w = website.strip()
    if not re.match(r"^https?://", w, re.I):
        w = "https://" + w
    try:
        p = urllib.parse.urlparse(w)
        if not p.netloc or "." not in p.netloc:
            return None
        if any(s in p.netloc.lower() for s in ("facebook.com", "instagram.com", "localharvest.org", "google.com")):
            return None
        return f"https://{p.netloc.lower()}"
    except Exception:
        return None


def check_shopify(origin):
    """Return trimmed product list if the site exposes a public Shopify catalog, else None."""
    try:
        status, body = get(origin + "/products.json?limit=250", timeout=15)
        j = json.loads(body)
        prods = j.get("products")
        if not isinstance(prods, list):
            return None
    except Exception:
        return None
    out = []
    for pr in prods:
        title = (pr.get("title") or "").strip()
        if not title or re.search(r"gift card|donation|membership|subscription", title, re.I):
            continue
        variants = [v for v in (pr.get("variants") or [])
                    if v.get("available") is not False and _price(v) > 0]
        if not variants:
            continue
        v = min(variants, key=_price)
        unit = v.get("title") if v.get("title") and v.get("title") != "Default Title" else (pr.get("product_type") or "each")
        out.append({"t": title[:80], "p": round(_price(v), 2), "u": str(unit)[:24]})
        if len(out) >= MAX_PRODUCTS:
            break
    return out


def _price(v):
    try:
        return float(v.get("price"))
    except (TypeError, ValueError):
        return 0.0


def main():
    if not API_KEY:
        log("ERROR: USDA_API_KEY is not set.")
        return 2

    anchors = load_regions()
    previous = []
    if os.path.exists(OUT):
        try:
            with open(OUT) as f:
                previous = json.load(f).get("sources", [])
        except Exception:
            previous = []
    by_id = {}
    failures = 0
    failed_kinds = set()
    for a in anchors:
        for kind in DIRECTORIES:
            log(f"USDA {kind} around {a['zip']} ({a['radius']} mi)…")
            try:
                rows = fetch_directory(kind, a["zip"], a["radius"])
            except RuntimeError as e:
                log(f"ERROR: {e}")
                return 3
            if rows is None:
                failures += 1
                failed_kinds.add(kind)
                continue
            log(f"  {len(rows)} listings")
            for r in rows:
                c = clean(r, kind)
                if "location_x" not in c or "location_y" not in c:
                    continue
                key = f"{kind}:{c.get('listing_id') or c.get('listing_name')}"
                by_id[key] = c

    if not by_id:
        log("ERROR: the USDA returned nothing this run; keeping the previous data file.")
        return 4

    # A directory that failed this week keeps last week's listings instead of vanishing.
    carried = 0
    for old in previous:
        if old.get("directory_type") in failed_kinds:
            key = f"{old['directory_type']}:{old.get('listing_id') or old.get('listing_name')}"
            if key not in by_id:
                by_id[key] = old
                carried += 1
    if carried:
        log(f"Carried over {carried} listings from last refresh for: {', '.join(sorted(failed_kinds))}")

    # ── SNAP community vendors ──
    zips = {}
    try:
        with open(ZIPS) as f:
            zips = json.load(f)["zips"]
    except Exception as e:
        log(f"WARNING: could not read zips.json: {e}")
    snap_types = Counter()
    snap_ok = True
    snap_kept = {}
    for a in anchors:
        c = zips.get(a["zip"])
        if not c:
            log(f"WARNING: anchor ZIP {a['zip']} not in zips.json; skipping SNAP for it")
            continue
        log(f"SNAP retailers around {a['zip']} ({a['radius']} mi)…")
        rows = fetch_snap(c[0], c[1], a["radius"])
        if rows is None:
            snap_ok = False
            failures += 1
            continue
        log(f"  {len(rows)} retailers in area")
        for r in rows:
            snap_types[r.get("Store_Type") or "?"] += 1
            try:
                lat, lon = float(r["Latitude"]), float(r["Longitude"])
            except (KeyError, TypeError, ValueError):
                continue
            if miles(c[0], c[1], lat, lon) > a["radius"]:
                continue
            label = snap_label(r)
            if label:
                snap_kept[r.get("Record_ID")] = snap_record(r, label)

    usda = list(by_id.values())
    merged_flags = 0
    added_community = 0
    if snap_ok:
        for rec in snap_kept.values():
            match = find_match(rec, usda)
            if match:  # already listed by the USDA directory: just mark it
                match["snap"] = True
                if rec.get("incentive"):
                    match["incentive"] = rec["incentive"]
                merged_flags += 1
            else:
                by_id[f"community:{rec['listing_id']}"] = rec
                added_community += 1
    else:
        # SNAP data unavailable this week: keep last week's community vendors and SNAP flags.
        prev_flags = {f"{o['directory_type']}:{o.get('listing_id') or o.get('listing_name')}": o
                      for o in previous}
        for key, rec in by_id.items():
            old = prev_flags.get(key)
            if old and old.get("snap"):
                rec["snap"] = True
                if old.get("incentive"):
                    rec["incentive"] = old["incentive"]
        for o in previous:
            if o.get("directory_type") == "community" and not o.get("curated"):
                by_id[f"community:{o.get('listing_id')}"] = o
                carried += 1
        log("SNAP data unavailable; carried over last week's community vendors and SNAP flags.")
    log(f"  SNAP: {len(snap_kept)} community vendors; {merged_flags} matched USDA listings, {added_community} added")

    # ── Hand-picked community vendors (always included) ──
    try:
        with open(CURATED) as f:
            curated = json.load(f).get("vendors", [])
    except Exception:
        curated = []
    for i, v in enumerate(curated):
        rec = {k: v[k] for k in v if not k.startswith("_")}
        rec.update({"listing_id": f"curated-{i}", "directory_type": "community", "curated": True})
        rec.setdefault("type_label", "Community Vendor")
        snap_hit = find_match(rec, list(snap_kept.values()), max_mi=0.5, min_sim=0.45) if snap_ok else None
        if not snap_ok:  # keep last week's SNAP status for pinned vendors during an outage
            old = next((o for o in previous if o.get("curated") and o.get("listing_name") == rec.get("listing_name")), None)
            if old and old.get("snap"):
                rec["snap"] = True
                if old.get("incentive"):
                    rec["incentive"] = old["incentive"]
        if snap_hit:
            rec["snap"] = True
            if snap_hit.get("incentive"):
                rec["incentive"] = snap_hit["incentive"]
            by_id.pop(f"community:{snap_hit['listing_id']}", None)
        by_id[f"community:curated-{i}"] = rec

    sources = list(by_id.values())
    if not sources:
        log("ERROR: refresh returned no listings; keeping the previous data file.")
        return 4

    # Online catalog check (Shopify), one request per distinct website
    origins = {}
    for s in sources:
        o = site_origin(s.get("media_website"))
        if o:
            origins.setdefault(o, []).append(s)
    log(f"Checking {len(origins)} websites for public catalogs…")
    with ThreadPoolExecutor(max_workers=8) as ex:
        results = dict(zip(origins, ex.map(check_shopify, origins)))
    online = 0
    for o, prods in results.items():
        if prods:
            online += 1
            for s in origins[o]:
                s["shop_origin"] = o
                s["catalog"] = prods
    log(f"  {online} of {len(origins)} sell online with public prices")

    payload = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "anchors": anchors,
        "counts": {
            "listings": len(sources),
            "websites_checked": len(origins),
            "online_catalogs": online,
            "directory_failures": failures,
            "carried_over": carried,
            "snap_community_vendors": len(snap_kept),
            "snap_flags_on_usda": merged_flags,
            "snap_added": added_community,
            "snap_available": snap_ok,
        },
        "snap_store_types": dict(snap_types.most_common(25)),
        "sources": sorted(sources, key=lambda s: (s["directory_type"], s.get("listing_name", ""))),
    }
    tmp = OUT + ".tmp"
    with open(tmp, "w") as f:
        json.dump(payload, f, separators=(",", ":"), ensure_ascii=False)
    os.replace(tmp, OUT)
    log(f"Wrote {len(sources)} listings to data/local_sources.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
