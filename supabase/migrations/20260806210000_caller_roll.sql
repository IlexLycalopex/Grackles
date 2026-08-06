-- The die face, and the removal of the line that was carrying it.
--
-- Every one of the 36 imported blocks opens its prose with a line restating
-- what the columns beside it already hold:
--
--   **Caller:** Yes (rolled 4 — standard)
--   **Caller card:** Nine of Diamonds — *mundane life grinding them down*
--
-- caller_type and caller_card are columns, so the page printed both the
-- structured version and the prose version, one above the other. That is the
-- markdown showing through: in the old site the frontmatter was invisible and
-- the body had to say it.
--
-- But the line is not purely redundant. It carries two things no column held:
--
--   the die face — "rolled 4", not merely that somebody called
--   whether a roll happened at all — "None (broadcast closed — not rolled)"
--     is a different fact from rolling a 1
--
-- So the column comes first and the prose is trimmed second. Deleting the
-- lines without this would have quietly thrown the dice away.
--
-- Null means no roll was made. 1-3 means the phone stayed quiet, which is why
-- the constraint allows a roll on a block whose caller_type is 'none'.

alter table public.wbpr_blocks
  add column caller_roll integer;

alter table public.wbpr_blocks
  add constraint wbpr_blocks_caller_roll_range
  check (caller_roll is null or caller_roll between 1 and 6);

-- Backfill from the prose that is about to be removed.
update public.wbpr_blocks
   set caller_roll = (substring(notes from '\*\*Caller:\*\*[^\n]*rolled (\d)'))::integer
 where notes ~ '\*\*Caller:\*\*[^\n]*rolled \d';

-- Then take the restated lines off the front. The pattern is anchored and
-- narrow on purpose: the opening line, an optional caller-card line directly
-- under it, and the blank line that separated them from the account itself.
-- Anything else in the prose is the account and stays.
update public.wbpr_blocks
   set notes = regexp_replace(
         notes,
         '^\*\*Caller:\*\*[^\n]*\n(\*\*Caller card:\*\*[^\n]*\n)?\s*',
         ''
       )
 where notes ~ '^\*\*Caller:\*\*';
