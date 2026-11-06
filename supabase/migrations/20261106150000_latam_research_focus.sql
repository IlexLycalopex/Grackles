-- Deep dive focus: what the reader asked a dive to lean towards ("tango and
-- San Telmo", "fly fishing near town"), kept with the dive so the list of
-- earlier dives says what each one was for. Empty for a general briefing.

alter table public.lx_research
  add column focus text not null default '' check (char_length(focus) <= 200);
