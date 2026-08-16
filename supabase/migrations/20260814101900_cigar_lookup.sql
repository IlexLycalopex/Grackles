-- The cigar lookup, brought onto the metered path.
--
-- It arrived while the governance layer was being built, on the branch this one
-- was cut from, and so it shipped with its own private cost control: a count of
-- rows written to `cl_cigar_reference` in the last day, capped at fifty per
-- lounge, checked in the route and again in the insert policy. That control is
-- good and it stays. What it is not is a budget — it counts lookups, not money,
-- it is per-lounge rather than per-payer, there is no ledger row to read
-- afterwards, and no admin can switch it off without a deploy.
--
-- Two features spending against nothing was the argument for building this
-- layer. A third would have made it decorative.
--
-- The daily cap and the envelope answer different questions and both are kept:
-- the cap is fairness inside one lounge on one day, the envelope is what the
-- payer has left this month. Neither implies the other, and a lounge can hit
-- either first.

insert into public.ai_features
  (key, app, name, max_tokens, min_role, provider, model,
   default_max_usd, default_max_calls, prompt_allowance_tokens,
   sends_records, quality_floor)
values
  ('cigars.lookup', 'cigar-lounge', 'Look a cigar up',
   -- LOOKUP_BUDGET in lib/cigar-lookup.ts. The two must agree, and lib/ai
   -- clamps to this one, so a drift makes the reply shorter rather than the
   -- reservation wrong.
   400,
   -- `canWrite`, matching the route. Deliberately looser than the desk: this is
   -- one bounded call, and an editor who cannot use quick-add has a feature
   -- that does not work for them.
   'editor', 'minimax', 'minimax-m3',
   -- One call, and a small one. The whole prompt is a fixed schema of about
   -- four hundred tokens plus a query under twenty, which is why this feature
   -- carries its own prompt allowance rather than reserving the desk's twelve
   -- thousand against a call that cannot use them.
   0.020000, 1, 800,
   -- False, and this is a judgement rather than a default left alone. What goes
   -- to the model is a phrase somebody typed into a box — "partagas serie d" —
   -- and nothing about the lounge, its entries, its members or its notes. A
   -- feature that asked what *your* cigars were would be a different answer,
   -- and would need the owner's consent before it ran.
   false,
   -- No floor. There is no deterministic check to fail: whether a model
   -- correctly recalled a Robusto's ring gauge is not something this app can
   -- verify, and `checkDimensions` reports a disagreement rather than a verdict.
   -- A floor computed from nothing would switch the feature off at random.
   null);

-- On for every lounge that exists, at the feature's own defaults.
insert into public.ai_workspace_features (workspace_id, feature, enabled)
select w.id, 'cigars.lookup', true
from public.workspaces w
where w.app = 'cigar-lounge'
on conflict (workspace_id, feature) do nothing;
