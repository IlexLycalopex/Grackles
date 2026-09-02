-- Talking to the reading list.
--
-- One turn, one call, and the same posture as platform.search: the model writes
-- a plan, the app runs it, and the page renders the rows. No record is sent, so
-- `sends_records` is false and no project has to consent to anything — which is
-- the whole reason the window can be cheap and the answers can be trusted.
--
-- The alternative, feeding results back so the model can narrate them, is what
-- most chat features are. It would put every project behind the consent gate,
-- double the cost of every turn, and introduce a model asserting things about
-- somebody's books that they would then have to check. The rows are already on
-- the page; a paragraph about them is not an improvement.
--
-- A turn may propose a change to read state. It never makes one: the action
-- arrives at the page as a button with a count on it, and the write goes
-- through the same bulk path a person could have used by hand.

insert into public.ai_features
  (key, app, name, max_tokens, min_role, provider, model,
   default_max_usd, default_max_calls, prompt_allowance_tokens, sends_records)
values
  ('reading.chat', 'reading-list', 'Ask the reading list',
   -- A plan plus one line measures around 200 completion tokens; 500 is the
   -- ceiling that keeps a runaway answer from being a runaway bill.
   500, 'editor', 'minimax', 'minimax-m3',
   -- One call per turn. A conversation is many jobs of one rather than one job
   -- of many, which is what keeps a window somebody leaves open from holding a
   -- reservation against their month.
   0.020000, 1,
   -- The vocabulary is most of the prompt and it is long: every column of every
   -- source, plus the rules. Measured against the search prompt it shares.
   3000,
   false)
on conflict (key) do nothing;

-- On for every Reading List that exists, at the feature's own defaults.
insert into public.ai_workspace_features (workspace_id, feature, enabled)
select w.id, 'reading.chat', true
from public.workspaces w
where w.app = 'reading-list'
on conflict (workspace_id, feature) do nothing;
