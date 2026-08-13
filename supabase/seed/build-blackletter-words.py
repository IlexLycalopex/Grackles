"""Blackletter's two word lists, for each of the three lengths, as one SQL seed.

Every word the game will ever accept or answer with is decided here and nowhere
else. The output is committed so that the lists are reviewable as a diff — the
spot-check for obscure and offensive entries is a code review, which is the only
form of it that anybody will actually do — and so that a list can be rebuilt and
compared rather than patched by hand.

Two lists per length, as Wordle has:

  guesses    everything a player may type. Broad, because being told a real word
             is not a word is the one failure that makes a word game feel broken.
  solutions  the far smaller set a puzzle may answer with. Common, unambiguous,
             and inoffensive, because a player who loses should recognise the
             word when it is revealed.

Solutions are a subset of guesses, not a separate list. `is_solution` is a flag
on the one row, so the two can never disagree about whether a solution is a
legal guess.

Sources, all fetched at build time and none at runtime:

  ENABLE    the public-domain word list behind most English word games. Already
            free of proper nouns, hyphens and apostrophes, which is most of the
            filtering the spec asks for.
  wordfreq  Zipf-scale frequencies merged from subtitles, Wikipedia, news and
            books. Preferred over a raw Google Books ngram count because books
            over-weight archaic vocabulary — the exact failure mode a solution
            list has to avoid.
  LDNOOBW   profanity and slurs, removed from solutions only. A player may guess
            them; the game will not answer with one.
  names     US given names and surnames, used as a *higher bar* rather than a
            ban. See NAME_MIN_ZIPF.

Run:  python3 build-blackletter-words.py
"""
import json
import re
import sys
import urllib.request
from datetime import date, timezone, datetime
from pathlib import Path

from wordfreq import zipf_frequency

HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
OUT_SQL = HERE / "blackletter-words.sql"
OUT_REPORT = HERE / "blackletter-words.report.json"

ENABLE_URL = "https://raw.githubusercontent.com/dolph/dictionary/master/enable1.txt"
LDNOOBW_URL = (
    "https://raw.githubusercontent.com/LDNOOBW/"
    "List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words/master/en"
)
SURNAMES_URL = (
    "https://raw.githubusercontent.com/smashew/NameDatabases/"
    "master/NamesDatabases/surnames/us.txt"
)
FIRSTNAMES_URL = (
    "https://raw.githubusercontent.com/dominictarr/random-name/master/first-names.txt"
)
# ENABLE is an American list and this is a British site. See fold_spellings().
SPELLINGS_URL = (
    "https://raw.githubusercontent.com/hyperreality/American-British-English-Translator/"
    "master/data/american_spellings.json"
)

LENGTHS = (5, 6, 7)

# How many solutions each length should end up with. Wordle ships 2,315, which
# is about six years of daily puzzles, and that is the number being matched.
#
# The knob that is actually turned is the frequency floor, solved per length to
# land on this. Doing it this way round rather than fixing one threshold for all
# three is what stops the shortest list being the thinnest: there are only 8,636
# five-letter words in ENABLE against 23,109 seven-letter ones, so one floor
# applied to both gives a five-letter pool a third short of the others.
TARGET_SOLUTIONS = 2300

# Never go below this, however short a pool comes out. A solution the loser does
# not recognise is worse than a pool that repeats a year sooner.
FLOOR_ZIPF = 2.7

# A word that is also a common personal name has to clear a higher bar.
#
# ENABLE carries plenty of surnames and given names that are legal common nouns
# — BRANT, WAUGH, GAUSS, NANCE — and frequency data cannot see the capital
# letter that would give them away, because every corpus available here is
# lowercased. What it can see is that they are marginal: they cluster just under
# Zipf 3, while the words that are genuinely both a name and an everyday noun
# sit far above it (GRACE 4.56, DAWN 4.27, CANDLE 3.88, AMBER 3.97).
#
# So this is a bar and not a ban, and that distinction is the whole point. A ban
# would take GRACE and ROSE with it, which are exactly the sort of word the game
# wants. It costs a handful of decent words at the margin — FROCK, KNOLL and
# BERET are all somebody's surname — and that is the price of not shipping a
# puzzle whose answer is a mathematician.
NAME_MIN_ZIPF = 3.5

# Words the frequency data defends but a solution list should not carry, over
# and above LDNOOBW. Additions belong here rather than in the generated SQL,
# which is rebuilt and would revert them.
#
# Everything below came out of the `rarest_solutions` report, which is what that
# field is for. Read it after every rebuild: a threshold that moves drags a new
# set of marginal words in behind it, and this is the only place they are ever
# looked at.
EXTRA_BLOCKED = {
    # Violence and death — fine words, wrong thing to open a daily puzzle with.
    "rapist", "raping", "raped", "nooses", "noose", "lynch", "lynched",
    "hanged", "corpse", "corpses", "morgue", "coffin", "coffins", "casket",
    "autopsy", "cadaver", "suicide", "abuser", "abused", "killed", "killer",
    "murder", "slaves", "slave",
    # Illness, anatomy and the mildly adult. The line is drawn at what a player
    # would rather not be shown on a Tuesday morning, not at what is rude.
    "cancer", "tumour", "tumor", "tumors", "labia", "libido", "ovaries",
    "aortic", "septa", "manhood", "groomed",
    # Not really English words in the sense a player would accept: technical
    # plurals, fragments that only exist inside a compound, and near-names.
    "scape", "nitty", "bigfoot", "delft", "masonic",
}


def fetch(url: str, name: str) -> str:
    """Download once, then reuse. The cache is gitignored; the output is not."""
    CACHE.mkdir(exist_ok=True)
    path = CACHE / name
    if not path.exists():
        print(f"  fetching {name} …", file=sys.stderr)
        with urllib.request.urlopen(url, timeout=120) as r:
            path.write_bytes(r.read())
    return path.read_text(encoding="utf-8", errors="replace")


def is_plural_of(word: str, lexicon: set[str]) -> bool:
    """Whether `word` is just the plural of a shorter word already in the list.

    Wordle keeps -s plurals out of its solutions and it is right to: a plural is
    never the interesting word, and admitting them means a third of the pool is
    the same puzzle with an S nailed to the end.

    The two carve-outs matter more than they look. A word ending in -ss is not a
    plural of anything (BRASS is not the plural of BRAS, though BRAS is a word,
    and that near-miss is exactly what a naive rule gets wrong). And -es only
    counts when the stem stands alone, so BOXES goes and SERIES stays.

    The -ies rule was added after OVARIES reached a solution list: stripping an
    -s or an -es leaves OVARIE and OVARI, neither of which is a word, so the
    plainer rules waved it through. Every -y noun in English pluralises this way,
    which made it a whole class of plural rather than one escapee.
    """
    if word.endswith("ss"):
        return False
    if word.endswith("ies") and word[:-3] + "y" in lexicon:
        return True
    if word.endswith("ves") and (word[:-3] + "f" in lexicon or word[:-3] + "fe" in lexicon):
        return True
    if word.endswith("es") and word[:-2] in lexicon:
        return True
    if word.endswith("s") and word[:-1] in lexicon:
        return True
    return False


def fold_spellings(lexicon: set[str]) -> tuple[set[str], set[str]]:
    """Teach an American word list to speak British.

    ENABLE is American and grackles.co.uk is not, which shows up in two
    different places and has to be fixed differently in each.

    As an *answer*, SOMBER or FERVOR reads as a misspelling to the person it is
    revealed to, so the American form of a word that has a British one is
    dropped from the solution pool and the British form stands in its place.

    As a *guess* it is worse than that. SOMBRE is simply absent from ENABLE, so
    a player typing the spelling they were taught gets told it is not a word —
    the one failure that makes a word game feel broken, and the reason the guess
    list is broad in the first place. Both spellings are therefore accepted.

    Returns the British forms to add, and the American forms to bar from being
    answers. Where the two spellings differ in length they are simply different
    puzzles — COLOR is a five and COLOUR a six — and only the American one is
    barred, so the British spelling remains available at its own length.
    """
    pairs = json.loads(fetch(SPELLINGS_URL, "american_spellings.json"))
    british, american_only = set(), set()
    for us, uk in pairs.items():
        if not (re.fullmatch(r"[a-z]+", us) and re.fullmatch(r"[a-z]+", uk)):
            continue
        if us == uk:
            continue
        british.add(uk)
        # Only bar the American spelling if the British one is a real
        # alternative — otherwise a typo in the mapping silently deletes a word.
        if uk in lexicon or len(uk) in LENGTHS:
            american_only.add(us)
    return british, american_only


def qualifies(word: str, zipf: float, floor: float, names: set[str]) -> bool:
    """Whether a word is common enough to be an answer, at a given floor."""
    return zipf >= (max(floor, NAME_MIN_ZIPF) if word in names else floor)


def solve_floor(candidates: list[tuple[str, float]], names: set[str], target: int) -> float:
    """The highest frequency floor that still yields `target` solutions.

    Walked down the Zipf scale in hundredths rather than bisected, because the
    name bar makes the count a step function rather than a smooth one and the
    steps are what is being counted. Two thousand-odd iterations over a list of
    this size is nothing, and the result is exact rather than nearly right.
    """
    floor = 9.0
    while floor > FLOOR_ZIPF:
        n = sum(1 for w, z in candidates if qualifies(w, z, floor, names))
        if n >= target:
            return round(floor, 2)
        floor = round(floor - 0.01, 2)
    return FLOOR_ZIPF


def main() -> None:
    print("Blackletter word lists", file=sys.stderr)

    enable_raw = fetch(ENABLE_URL, "enable1.txt")
    ldnoobw_raw = fetch(LDNOOBW_URL, "ldnoobw-en.txt")
    names = {
        w.strip().lower()
        for url, name in ((SURNAMES_URL, "surnames.txt"), (FIRSTNAMES_URL, "first-names.txt"))
        for w in fetch(url, name).splitlines()
        if w.strip()
    }
    assert len(names) > 50_000, f"names list looks truncated: {len(names)}"

    # ENABLE is one lowercase word per line. Anything else in there is a defect
    # in the download rather than a word, so it is dropped loudly, not silently.
    lexicon = {w for w in enable_raw.split() if re.fullmatch(r"[a-z]+", w)}
    assert len(lexicon) > 150_000, f"ENABLE looks truncated: {len(lexicon)} words"

    british, american_only = fold_spellings(lexicon)
    added = {w for w in british if len(w) in LENGTHS} - lexicon
    lexicon |= added
    print(
        f"  spellings: +{len(added)} British forms as guesses, "
        f"{len(american_only)} American forms barred from answers",
        file=sys.stderr,
    )

    blocked = {w.strip().lower() for w in ldnoobw_raw.splitlines() if w.strip()}
    blocked |= EXTRA_BLOCKED
    blocked |= american_only
    # Only single words can collide with a guess; the list also carries phrases.
    blocked = {w for w in blocked if re.fullmatch(r"[a-z]+", w)}

    report: dict = {
        "generated": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "target_solutions": TARGET_SOLUTIONS,
        "name_min_zipf": NAME_MIN_ZIPF,
        "sources": {
            "enable": ENABLE_URL,
            "ldnoobw": LDNOOBW_URL,
            "surnames": SURNAMES_URL,
            "first_names": FIRSTNAMES_URL,
        },
        "lengths": {},
    }
    tables: dict[int, tuple[list[str], list[str]]] = {}

    for n in LENGTHS:
        guesses = sorted(w for w in lexicon if len(w) == n)
        assert guesses, f"no {n}-letter words"

        # Everything a solution could be before frequency has its say, so that
        # the floor is solved against the pool it will actually be applied to.
        rejected = {"plural": 0, "blocked": 0}
        candidates = []
        for w in guesses:
            if w in blocked:
                rejected["blocked"] += 1
            elif is_plural_of(w, lexicon):
                rejected["plural"] += 1
            else:
                candidates.append((w, zipf_frequency(w, "en")))

        floor = solve_floor(candidates, names, TARGET_SOLUTIONS)
        solutions = [w for w, z in candidates if qualifies(w, z, floor, names)]
        rejected["rare"] = len(candidates) - len(solutions)

        tables[n] = (solutions, guesses)
        by_zipf = sorted(solutions, key=lambda w: (zipf_frequency(w, "en"), w))
        report["lengths"][str(n)] = {
            "guesses": len(guesses),
            "solutions": len(solutions),
            "zipf_floor": floor,
            "rejected": rejected,
            # The twenty least common words that made it. If this game ever
            # ships a solution nobody recognises it will be one of these, so
            # they are printed rather than buried: this is the spot-check the
            # spec asks for, pointed at the only words it could ever find
            # anything in. Anything unfair here goes in EXTRA_BLOCKED.
            "rarest_solutions": by_zipf[:20],
        }
        print(
            f"  {n} letters: {len(solutions):>5} solutions of {len(guesses):>5} "
            f"guesses at Zipf >= {floor}  (dropped {rejected['rare']} rare, "
            f"{rejected['plural']} plural, {rejected['blocked']} blocked)",
            file=sys.stderr,
        )

    write_sql(tables, report)
    OUT_REPORT.write_text(json.dumps(report, indent=2) + "\n")
    print(f"  wrote {OUT_SQL.name} and {OUT_REPORT.name}", file=sys.stderr)


def sql_array(words: list[str]) -> str:
    """A Postgres text[] literal, wrapped so the diff stays readable.

    Every word is [a-z]+ by construction, so there is nothing to escape — but
    the quoting is done properly anyway rather than relying on that, because the
    day someone widens the filter is not the day to discover this file was the
    thing holding it together.
    """
    quoted = ["'" + w.replace("'", "''") + "'" for w in words]
    lines, row = [], ""
    for q in quoted:
        if len(row) + len(q) + 2 > 76:
            lines.append("    " + row)
            row = ""
        row += q + ","
    if row:
        lines.append("    " + row)
    return "\n".join(lines).rstrip(",")


def write_sql(tables: dict[int, tuple[list[str], list[str]]], report: dict) -> None:
    parts = [
        "-- Blackletter word lists — GENERATED, do not edit by hand.",
        "--",
        "-- Rebuild with supabase/seed/build-blackletter-words.py, which is where",
        "-- the thresholds and the blocklist live. Editing this file directly means",
        "-- the next rebuild silently reverts you.",
        "--",
        f"-- Generated {report['generated']}.",
        "--",
    ]
    for n in LENGTHS:
        r = report["lengths"][str(n)]
        parts.append(f"--   {n} letters: {r['solutions']} solutions of {r['guesses']} guesses, Zipf >= {r['zipf_floor']}")
    parts += [
        "--",
        "-- Idempotent: re-running promotes a word that has become a solution and",
        "-- demotes one that has stopped being one, so a rebuild after a blocklist",
        "-- change actually takes effect instead of conflicting away to nothing.",
        "",
        "begin;",
        "",
    ]

    for n in LENGTHS:
        solutions, guesses = tables[n]
        non_solutions = [w for w in guesses if w not in set(solutions)]
        for label, words, flag in (
            ("solutions", solutions, "true"),
            ("guesses only", non_solutions, "false"),
        ):
            parts += [
                f"-- {n} letters, {label}: {len(words)}",
                "insert into public.bl_words (word, length, is_solution)",
                f"select w, {n}, {flag} from unnest(array[",
                sql_array(words),
                "]::text[]) as w",
                "on conflict (word) do update set is_solution = excluded.is_solution;",
                "",
            ]

    parts += ["commit;", ""]
    OUT_SQL.write_text("\n".join(parts))


if __name__ == "__main__":
    main()
