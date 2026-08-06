"""The nine markdown sessions as one JSON document.

This is the migration's record: everything the markdown held, in the shape the
tables hold it. It goes into the repo so the import is reproducible and so
there is something to diff against if a broadcast ever looks wrong.
"""
import glob, json, os, re, sys, yaml

SRC = "/workspace/ilexlycalopex/wbpr/src/content/sessions"


def split_front_matter(text):
    m = re.match(r"^---\n(.*?)\n---\n(.*)$", text, re.S)
    assert m, "no frontmatter"
    return yaml.safe_load(m.group(1)), m.group(2)


def parse_body(body):
    blocks, notes = {}, ""
    for part in re.split(r"^## ", body, flags=re.M)[1:]:
        head, _, rest = part.partition("\n")
        rest = re.sub(r"\n---\s*$", "", rest.strip()).strip()
        m = re.match(r"Block\s+(\d+)", head)
        if m:
            blocks[int(m.group(1))] = rest
        elif "Personal Notes" in head:
            notes = rest
        else:
            raise AssertionError(f"unrecognised section: {head!r}")
    return blocks, notes


sessions = []
files = sorted(glob.glob(os.path.join(SRC, "*.md")))
assert len(files) == 9, f"expected 9 sessions, found {len(files)}"

for path in files:
    fm, body = split_front_matter(open(path).read())
    prose, personal = parse_body(body)
    s = fm["session"]
    co = fm.get("coordinates") or [None, None]
    st = fm.get("session_stats") or {}
    fmb = fm.get("blocks") or []
    assert set(prose) == set(range(1, len(fmb) + 1)), f"session {s}: block mismatch"

    out_blocks = []
    for i, b in enumerate(fmb, 1):
        ct = b.get("caller_type") or "none"
        cc = b.get("caller_coords") or [None, None]
        on = ct != "none"
        out_blocks.append({
            "position": i,
            "time_label": b.get("time", ""),
            "caller_type": ct,
            # The check constraint refuses these on a block with no caller, and
            # a couple of sources leave a stale card behind after the roll.
            "caller_card": b.get("caller_card", "") if on else "",
            "caller_card_meaning": b.get("caller_card_meaning", "") if on else "",
            "caller_location": b.get("caller_location", "") if on else "",
            "caller_lat": cc[0],
            "caller_lon": cc[1],
            "caller_location_confidence": b.get("caller_location_confidence") or "unknown",
            "phenomenon_ref": b.get("phenomenon_ref", ""),
            "notes": prose[i],
            "prompts": [
                {"position": j, "card": p["card"], "tone": p.get("tone", "")}
                for j, p in enumerate(b.get("prompts") or [], 1)
            ],
            "tracks": [
                {"position": j, "title": t["title"], "artist": t.get("artist", ""),
                 "url": t.get("url", ""), "source": t.get("source", ""),
                 "notes": t.get("notes", "")}
                for j, t in enumerate(b.get("playlist") or [], 1)
            ],
        })

    sessions.append({
        "session": s,
        "slug": f"wbpr-s{s:02d}",
        "station": fm["station"],
        "call_sign": fm["call_sign"],
        "location": fm["location"],
        "lat": co[0], "lon": co[1],
        "date": str(fm["date"]),
        "start_time": fm["start_time"],
        "end_time": fm["end_time"],
        "duration_minutes": fm.get("duration_minutes"),
        "atmospheric_conditions": fm.get("atmospheric_conditions", ""),
        "veil_status": fm["veil_status"],
        "veil_intensity": fm.get("veil_intensity"),
        "dawn_colour": st.get("dawn_colour", ""),
        "veil_at_close": st.get("veil_at_close", ""),
        "personal_notes": personal,
        "tags": fm.get("tags") or [],
        "blocks": out_blocks,
        "phenomena": [
            {"key": p["key"], "name": p["name"], "status": p["status"],
             "confidence": p["confidence"], "locations": p.get("locations") or [],
             "lat": (p.get("coords") or [None, None])[0],
             "lon": (p.get("coords") or [None, None])[1],
             "notes": p.get("notes", ""), "tags": p.get("tags") or []}
            for p in fm.get("phenomena_log") or []
        ],
    })

sessions.sort(key=lambda x: x["session"])
os.makedirs(os.path.dirname(sys.argv[1]), exist_ok=True)
with open(sys.argv[1], "w") as fh:
    json.dump(sessions, fh, indent=1, ensure_ascii=False)
    fh.write("\n")

nb = sum(len(s["blocks"]) for s in sessions)
print(f"{len(sessions)} sessions, {nb} blocks, "
      f"{sum(len(b['prompts']) for s in sessions for b in s['blocks'])} prompts, "
      f"{sum(len(b['tracks']) for s in sessions for b in s['blocks'])} tracks, "
      f"{sum(len(s['phenomena']) for s in sessions)} phenomena")
print(f"{os.path.getsize(sys.argv[1]):,} bytes")
