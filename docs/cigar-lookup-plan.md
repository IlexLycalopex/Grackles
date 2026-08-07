# Looking a cigar up

A plan, not an implementation. It covers the search box the Cigar Lounge does
not have, the model lookup behind it, and the quick-add path from a lookup into
the humidor.

Two things were asked for and they turn out to be one feature seen from two
ends:

- find a cigar by brand, name or dimensions and get back what is known about it
  — tasting notes, a Cigar Aficionado rating, wrapper, size, origin;
- use the same thing to put a cigar in the humidor without typing eleven fields.

Both are *identify a cigar, then hand its details to something*. The something
is a page in one case and a prefilled form in the other. So there is one
endpoint, one cache, and two surfaces.

## The three-stage search, cheapest first

The largest token saving available is not calling the model. Every query goes
through three stages and stops at the first one that answers:

**Stage 0 — your own lounge.** Free, and it is the right answer more often than
it sounds: the cigar you are looking up is frequently one you already have a
record of. Filter the loaded `cl_cigars` for the workspace on brand, name,
vitola and ring gauge. This costs nothing because both list pages already load
every entry — the filter is a client-side pass over data that is on the page.

**Stage 1 — the shared reference cache.** A single Postgres select against
`cl_cigar_reference`, keyed on a canonical form of brand + name + size. The
dimensions of a Partagás Serie D No. 4 are a fact about the world, not about a
workspace, so this table is global: the second person to look one up pays
nothing, and an active lounge trends toward free.

**Stage 2 — one call to M3.** Only reached on a genuine miss, and only when
somebody presses a button.

That last clause matters more than anything else in this document. **The lookup
must never fire on keystroke.** A debounced type-ahead against a paid endpoint
is how a feature like this becomes expensive, and it would be spending money to
answer queries the user is still in the middle of writing. Stages 0 and 1 run as
you type; stage 2 is a button that says what it does.

## The call, and why it is shaped this way

Everything here is the argument `lib/wbpr-deck.ts` already makes, applied to a
different problem: send the model the thing only it can supply, and nothing it
would merely be repeating back.

**Stateless.** One system message, one user message. Unlike the desk, a lookup
carries no history — there is no conversation, and no reason to pay for one.

**The system prompt is the whole schema and never varies.** The rules, the JSON
shape and the accuracy instructions live in the system message, byte-identical
on every call, so a provider-side prefix cache has something to hold. The user
turn is the query and nothing else, typically under twenty tokens. Putting the
schema in the user turn instead would cost the same tokens and defeat the cache.

**`thinking: { type: 'disabled' }`.** Already the default in `lib/minimax.ts`.
Recalling facts about a cigar is not a reasoning task, and M3 turns adaptive
thinking on when the parameter is omitted.

**`max_tokens: 400`, `temperature: 0.2`.** The reply below measures around 250
tokens; 400 is the ceiling that keeps a runaway answer from being a runaway
bill. Low temperature because this is recall, not improvisation — it also makes
two people looking up the same cigar more likely to cache the same answer.

**One full record, alternates by name only.** An ambiguous query gets the best
match in full plus up to two alternates as bare names. Returning three complete
records triples the completion tokens to answer a question the user has not
asked yet; clicking an alternate is a second lookup, which will usually hit the
cache.

**Nothing is asked for that the app already knows.** No slug, no date, no echo
of the query, no restating of the workspace's own data. This is the write-up
rule from `wbpr/log.ts` — the model supplies only what it alone knows.

Estimated cost of an uncached lookup: roughly 450 prompt tokens and 250
completion tokens. These are estimates and the point of the token columns on the
table is that they get replaced with measurements.

**`response_format` is not usable here.** JSON-schema structured output is
documented for MiniMax-Text-01 and is not reliably supported by M3 on the
OpenAI-compatible path — sending it appears to be silently ignored rather than
rejected, which is the worst failure mode. So the shape is instructed in the
prompt and the response is parsed tolerantly, exactly as `parseLog` in
`wbpr/log.ts` already does: take the first `{` to the last `}`. That function
should move to a shared helper rather than being written twice.

## Accuracy: what it is asked for, and what it is not

The Cigar Lounge is a record somebody keeps. The die-roll argument in the README
applies with full force — a model asked for a number returns a *plausible* one.
The defence is in four layers, three of which cost nothing.

**1. The model never touches your own fields.** `cl_cigars.rating` is your
0–5, and no suggestion writes to it. Model output lands in reference columns
that are visibly not yours.

**2. Null is a correct answer, and the prompt says so.** Every field may come
back null, with an instruction that an omitted value is better than a guessed
one. Anything null is simply not offered for prefill.

**3. A local validator, no tokens.** Vitola names carry conventional dimensions
— a Robusto is about 5″ × 50, a Lancero about 7½″ × 38. A small table in
`lib/cigar-vitolas.ts` (kept out of the prompt, for the same reason the deck is)
checks the returned vitola against the returned length and ring gauge. A
"Robusto, 7¼″, ring 38" is caught for free and flagged rather than offered. This
also gives the dimensions search something real to match against.

**4. Disagreement is shown, not resolved.** When a lookup contradicts what the
workspace already recorded for the same cigar, both are displayed. A human
decides; the app does not silently prefer the newer claim.

### The Cigar Aficionado rating specifically

This is the one output that could genuinely mislead, and it deserves its own
decision rather than being carried along with the rest. A CA score is a specific
integer attributed to a named publication, for a specific vitola, in a specific
issue. M3 will produce 88, 91 or 93 with complete confidence and no signal that
it invented one. Stored in a column called `ca_rating` and rendered as
"Cigar Aficionado: 92", the app would be fabricating a citation to a real
magazine.

The recommendation is to ship it, under three conditions:

- **No issue, no score.** The model must return the year or issue alongside the
  number, and the route drops the rating when it cannot. Real reviews have a
  date; invented ones generally do not, and this is the cheapest strong filter
  available.
- **It renders as a claim, not a fact.** "Cigar Aficionado 92 (2019) — suggested,
  unverified" with a one-press clear, until somebody confirms it.
- **It never becomes your rating**, and it never appears in the stats page
  averages, which are about what you thought of a cigar.

If that reads as too much scaffolding for the value, the alternative is to drop
the CA score and keep the rest — the dimensions, wrapper, origin and flavour
profile are the parts M3 is actually reliable on, and they are most of what
makes quick-add worth having. That is a judgement call worth making before any
code is written rather than after.

## The reply shape

```json
{
  "brand": "Partagás",
  "line": "Serie D",
  "name": "Serie D No. 4",
  "vitola": "Robusto",
  "length_inches": 4.9,
  "ring_gauge": 50,
  "wrapper": "Cuban",
  "binder": "Cuban",
  "filler": "Cuban",
  "country": "Cuba",
  "factory": null,
  "strength": "full",
  "flavour": "Earth, cocoa, black pepper, a leathery finish.",
  "ca_rating": 92,
  "ca_issue": "2018",
  "confidence": "high",
  "alternates": ["Partagás Serie E No. 2", "Partagás Serie P No. 2"]
}
```

`length_inches` is a number so it can be compared and validated; the form's
`length_text` keeps whatever the box says, which is the existing convention and
is not being changed. `strength` is constrained to the three values `STRENGTHS`
already defines, so it drops straight into the select.

## Schema

One new table, global rather than workspace-scoped:

```sql
create table public.cl_cigar_reference (
  id           uuid primary key default gen_random_uuid(),
  key          text not null unique,        -- canonical brand + name + size
  query        text not null,               -- what was actually typed
  brand        text not null default '',
  line         text not null default '',
  name         text not null default '',
  vitola       text not null default '',
  length_inches numeric,
  ring_gauge   integer,
  wrapper      text not null default '',
  binder       text not null default '',
  filler       text not null default '',
  country      text not null default '',
  factory      text not null default '',
  strength     text check (strength is null or strength in ('mild','medium','full')),
  flavour      text not null default '',
  ca_rating    integer check (ca_rating is null or ca_rating between 50 and 100),
  ca_issue     text not null default '',
  confidence   text not null default 'low',
  alternates   text[] not null default '{}',
  model        text not null,
  prompt_tokens     integer not null default 0,
  completion_tokens integer not null default 0,
  looked_up_by uuid not null references public.profiles(id),
  created_at   timestamptz not null default now()
);
```

Token counts are columns for the same reason they are on
`wbpr_agent_sessions`: protecting token usage is only a real property if
somebody can see what was spent, and the provider returns exact figures a word
count would only approximate.

RLS: select to `authenticated`, insert to `authenticated`, **no update or
delete**. Insert-only is what makes a shared table safe enough — one member
cannot rewrite what another member's lookup found, only add alongside it, and
every row carries who asked for it. A stale or wrong row is corrected by a
platform admin, not by whoever happens to look next. The trade is deliberate and
worth restating: this table is a cache of claims, never an authority.

On `cl_cigars`, one column: `reference_id uuid references
public.cl_cigar_reference(id) on delete set null`. The join is how an entry
shows its suggested details, which keeps the human record and the model's claims
in separate tables — and makes every claim the model ever made deletable in one
statement.

## The surfaces

**A filter box on the log and the humidor.** Client-side over the already-loaded
set. This should exist whether or not the model half is ever built, and
`facetValues` in `cigar-helpers.ts` is already sitting there unused, written for
exactly this. Promote to a Postgres `ilike` when a lounge outgrows loading
everything, which is not soon.

**A lookup panel on `/cigars/:workspace/new`.** One field, one button. Local
matches appear as you type; pressing *Look this up* spends the call. A result
prefills the form and **never overwrites a field you have already filled** —
suggestions fill blanks only, each marked as suggested until you touch it.

**A reference page**, `/cigars/:workspace/lookup` — the same endpoint without
the form, for checking a cigar you are not adding, with an *Add to humidor*
button that carries the result across.

**The entry page** gains a small reference block when `reference_id` is set,
clearly separated from what you wrote.

## The gate and the budget

WBPR's agent is owner-only, on the argument that spending tokens is the owner's
decision because it is the owner's bill. That is right for a night at the desk
and wrong here: a lookup is one small bounded call, and an editor who cannot use
quick-add has been given a feature that does not work for them.

So: `requireWrite`, not owner-only — plus a per-workspace daily cap counted in
the route from `cl_cigar_reference` rows attributed to that workspace today.
The cap is what makes the looser gate defensible. Suggest 50/day, which is far
above ordinary use and far below anything alarming.

Both checks belong in the API route. A page check protects the button, not the
URL that spends money.

## Order of work

1. **Local search, no model.** Filter box on the log and the humidor. Ships
   value on its own and is the fallback if everything below is deferred.
2. **Schema and endpoint.** `cl_cigar_reference`, the migration, and
   `POST /api/cigars/:workspace/lookup` with the cache check, gate and cap.
   `lib/cigar-lookup.ts` holds the prompt, the parser and the validator.
3. **The vitola table** and the dimensions validator.
4. **The lookup panel on `new.astro`** and prefill.
5. **The reference page** and the entry-page block.
6. **README section**, in the shape of the WBPR agent one — what the model is
   asked for, what it is not, and what a lookup costs.

Steps 1–2 are where the value is. Everything after 4 is polish.

## Files

| | |
|---|---|
| `supabase/migrations/…_cigar_reference.sql` | new table, RLS, `cl_cigars.reference_id` |
| `src/lib/cigar-lookup.ts` | new — prompt, parse, validate, canonical key |
| `src/lib/cigar-vitolas.ts` | new — vitola dimensions, out of the prompt |
| `src/pages/api/cigars/[workspace]/lookup.ts` | new — gate, cache, one call, cap |
| `src/lib/json.ts` | new — `parseJsonObject`, lifted from `wbpr/log.ts` |
| `src/lib/cigar-lounge.ts` | reference loading, local match |
| `src/lib/cigar-helpers.ts` | local search over loaded entries |
| `src/pages/cigars/[workspace]/new.astro` | the lookup panel |
| `src/pages/cigars/[workspace]/lookup.astro` | new — the reference page |
| `src/pages/cigars/[workspace]/index.astro`, `humidor.astro` | filter box |
| `src/components/cl/CigarFields.astro` | suggested-value marking |
| `src/styles/cigar-lounge.css` | panel, suggestion marks |
| `README.md` | a section on the lookup |

## Open questions

- **The CA rating, in or out.** The three conditions above, or drop it and keep
  the details M3 is reliable on. Worth deciding first — it is the only part of
  this that could put a false claim under a real magazine's name.
- **Whether M3 can be grounded.** MiniMax has offered a built-in `web_search`
  tool on some models; whether M3 supports it on this endpoint is unconfirmed
  and the docs host is unreachable from here. If it does, it changes the
  accuracy story substantially and costs tokens, and the two would need weighing
  against each other. Everything above is designed to work without it.
- **Whether the cache should ever expire.** A cigar's dimensions do not change.
  A discontinued line and a re-blended one do. Insert-only with a `created_at`
  leaves the door open without deciding now.
