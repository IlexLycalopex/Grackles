# Looking a cigar up

The plan for the search box the Cigar Lounge did not have, the model lookup
behind it, and the quick-add path from a lookup into the humidor.

**Decided, and reflected below:** the Cigar Aficionado rating is dropped
entirely rather than shipped under conditions; the gate is `requireWrite` plus a
daily cap rather than owner-only.

**Built:** steps 1 through 4 — the filter box, the schema, the endpoint, the
vitola check and the lookup panel on the add form. The migrations are applied.
Step 5, the reference block on an entry's own page, is the remaining piece.

Two things were asked for and they turn out to be one feature seen from two
ends:

- find a cigar by brand, name or dimensions and get back what is known about it
  — tasting notes, wrapper, size, origin (and, as originally asked, a Cigar
  Aficionado rating; see below for why that one is not here);
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
`wbpr/log.ts` already did: take the first `{` to the last `}`. That function has
moved to `lib/json.ts` rather than being written twice.

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

**3. A local validator, no tokens.** Two halves, both built. Range bounds in
`readLookup`: no cigar is fourteen inches long or has a ring gauge of 200, so a
reply carrying one is wrong in a way that can be caught without asking anybody,
and the same bounds are CHECK constraints on the table. Then `cigar-vitolas.ts`,
which holds what a vitola is roughly the size of — a Robusto about 5″ × 50, a
Lancero about 7½″ × 38 — and is kept out of the prompt for the same reason the
deck is. It catches "Robusto, 7¼″, ring 38", where every field is individually
plausible and only their disagreement gives it away. A model handed the expected
dimensions would return them whether or not it knew this cigar's, so the table's
value is precisely that it is independent of the answer it checks.

**4. Disagreement is shown, not resolved.** A dimension that contradicts its own
vitola is reported beside the suggestion and nothing is withheld: we know the
three fields cannot all be right, and we do not know which one is wrong.
Guessing would be the same error one level up. The wider version of this — a
lookup contradicting what the workspace already recorded for the same cigar —
falls out of step 5, once an entry can show its reference row.

### The Cigar Aficionado rating: dropped

This was the one output that could genuinely mislead, and it was cut before any
of it was built. A CA score is a specific integer attributed to a named
publication, for a specific vitola, in a specific issue. M3 will produce 88, 91
or 93 with complete confidence and no signal that it invented one. Stored in a
column called `ca_rating` and rendered as "Cigar Aficionado: 92", the app would
be fabricating a citation to a real magazine.

The version that was considered and rejected required the model to name an issue
before a score was kept at all, rendered it as an unverified claim, and kept it
out of your own rating and out of the stats averages. That would probably have
worked. It is a lot of scaffolding around the single field most likely to be
wrong, and everything it protects is beside the point of the feature: the
dimensions, wrapper, origin and flavour profile are what M3 is reliable on and
are most of what makes quick-add worth having.

So the prompt forbids ratings, scores, prices, awards and attribution to any
publication — in those words, and with the reason attached, because "never give
a score" on its own invites a model to comply with the letter of it. There is no
column for one to land in either way.

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
  "flavour": "Earth, cocoa and black pepper over a leathery finish.",
  "confidence": "high",
  "alternates": ["Partagás Serie E No. 2"]
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
  confidence   text not null default 'low',
  alternates   text[] not null default '{}',
  model        text not null,
  prompt_tokens     integer not null default 0,
  completion_tokens integer not null default 0,
  workspace_id uuid references public.workspaces(id) on delete set null,
  looked_up_by uuid not null references public.profiles(id),
  created_at   timestamptz not null default now()
);
```

`workspace_id` is attribution, not scope: it records which lounge paid for the
lookup so the daily cap has something to count, and every signed-in reader still
sees every row. See `supabase/migrations/20260807120000_cigar_reference.sql` for
what was actually written, which adds the range CHECKs and the indexes.

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

So: `requireWrite`, not owner-only — plus a per-workspace daily cap of 50, which
is far above ordinary use and far below anything alarming. The cap is what makes
the looser gate defensible.

Both checks belong in the API route, because a page check protects the button
rather than the URL that spends money. As built, both also live in the insert
policy on the table: the route's copies exist to produce a sentence instead of a
`42501`, and the policy is the thing that actually holds. Cache hits do not
count against the cap, because they do not insert — which is the right
incentive.

The cap took two more migrations to actually work, and the way it failed is the
part worth carrying forward. Written as a `count(*)` subquery inside the policy
over the table the policy guards, it is `42P17` — infinite recursion — and the
symptom is not a leaky cap but a table that refuses every insert. It reads
correctly. It was asserted to work here, in the README and in the migration's
own comments before anybody ran it, which is the actual lesson: a claim about
what the database enforces is worth exactly one query to check.

## Order of work

1. ✅ **Local search, no model.** Filter box on the log and the humidor. Ships
   value on its own and was the fallback if everything below were deferred.
2. ✅ **Schema and endpoint.** `cl_cigar_reference`, the migration, and
   `POST /api/cigars/:workspace/lookup` with the cache check, gate and cap.
   `lib/cigar-lookup.ts` holds the prompt, the parser and the validator.
3. ✅ **The vitola table** and the dimensions validator. Two halves: range
   bounds in `readLookup`, which catch a ring gauge of 200, and
   `lib/cigar-vitolas.ts`, which catches a "Robusto, 7¼″, ring 38" — three
   individually plausible fields that disagree with each other.
4. ✅ **The lookup panel on `new.astro`** and prefill.
5. ⬜ **The reference page** and the entry-page block.
6. ✅ **README section**, in the shape of the WBPR agent one — what the model is
   asked for, what it is not, and what a lookup costs.

Step 5 is the only one left, and nothing depends on it: an entry filled from a
lookup already carries `reference_id`, so the block is a join away whenever it
gets written.

## Files

| | |
|---|---|
| ✅ `supabase/migrations/20260807120000_cigar_reference.sql` | new table, RLS, the cap, `cl_cigars.reference_id` |
| ✅ `src/lib/cigar-search.ts` | new — fold, parse a query, match, one matcher for both sides |
| ✅ `src/lib/cigar-lookup.ts` | new — prompt, parse, validate, canonical key, cache ranking |
| ✅ `src/lib/json.ts` | new — `parseJsonObject` and `oneOf`, lifted from `wbpr/log.ts` |
| ✅ `src/pages/api/cigars/[workspace]/lookup.ts` | new — gate, cache, one call, cap |
| ✅ `src/components/cl/CigarFilter.astro` | new — the filter box and its script |
| ✅ `src/components/cl/CigarCard.astro` | `data-search`, `data-length`, `data-ring` |
| ✅ `src/pages/cigars/[workspace]/index.astro`, `humidor.astro` | the filter box |
| ✅ `src/styles/cigar-lounge.css` | the filter box |
| ✅ `src/lib/database.types.ts` | the new table, by hand — regenerate once the migration is applied |
| ✅ `supabase/migrations/20260807140000_cigar_lookup_cap.sql` | the cap, rewritten so it can run |
| ✅ `supabase/migrations/20260807150000_cigar_reference_grants.sql` | revoking the DML the defaults had granted |
| ✅ `src/lib/cigar-vitolas.ts` | vitola dimensions, out of the prompt |
| ✅ `src/components/cl/CigarLookup.astro` | the panel, its script and the prefill |
| ✅ `src/pages/cigars/[workspace]/new.astro` | the panel, and `reference_id` on insert |
| ⬜ `src/pages/cigars/[workspace]/lookup.astro` | the reference page |
| ⬜ `src/pages/cigars/[workspace]/cigar/[cigar].astro` | the reference block on an entry |

## Open questions

- **Whether M3 can be grounded.** MiniMax has offered a built-in `web_search`
  tool on some models; whether M3 supports it on this endpoint is unconfirmed
  and the docs host is unreachable from here. If it does, it changes the
  accuracy story substantially and costs tokens, and the two would need weighing
  against each other. Everything here is designed to work without it.
- **Whether the cache should ever expire.** A cigar's dimensions do not change.
  A discontinued line and a re-blended one do. Insert-only with a `created_at`
  leaves the door open without deciding now.
- **What the filter should do at scale.** It filters what the page already
  holds, which is right while a lounge is a few hundred entries and wrong at a
  few thousand. The matcher is in a module both sides import specifically so
  that day is a change of caller rather than a rewrite.
