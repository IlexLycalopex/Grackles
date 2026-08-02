-- Backup of Listening Party 2026, weeks 33-52, taken 2026-08-02 before deletion.
--
-- These rows were placeholder slots for the rest of the 2026 season. They were
-- removed so the "Add a pick" button can create each week by hand as it comes
-- round: lp_selections has a unique index on (season_id, week, contributor_id),
-- so a placeholder sitting in a slot makes the insert fail with a duplicate key.
--
-- Nine of them carried Jamie's forward picks and the "also considering" notes.
-- Run this file against the grackles project to put all twenty back exactly as
-- they were. Season and contributor are looked up by slug, so it does not
-- depend on the old row ids.

insert into lp_selections
  (workspace_id, season_id, contributor_id, week, year_slot, album, artist, status, notes)
select
  se.workspace_id, se.id, c.id, v.week, v.year_slot, v.album, v.artist, 'upcoming', v.notes
from lp_seasons se
join lp_contributors c on c.workspace_id = se.workspace_id
join (values
  (33, 2016, 'jamie', 'Not to Disappear',               'Daughter',                     ''),
  (34, 2016, 'nick',  '',                               '',                             ''),
  (35, 2017, 'jamie', 'Lotta Sea Lice',                 'Courtney Barnett & Kurt Vile', ''),
  (36, 2017, 'nick',  '',                               '',                             ''),
  (37, 2018, 'jamie', 'Be the Cowboy',                  'Mitski',                       'Also considering: Ex:Re – Ex:Re; Cusp – Alela Diane'),
  (38, 2018, 'nick',  '',                               '',                             ''),
  (39, 2019, 'jamie', 'Ghosteen',                       'Nick Cave & The Bad Seeds',    'Also considering: Heard It in a Past Life – Maggie Rogers'),
  (40, 2019, 'nick',  '',                               '',                             ''),
  (41, 2020, 'jamie', 'Fetch the Bolt Cutters',         'Fiona Apple',                  ''),
  (42, 2020, 'nick',  '',                               '',                             ''),
  (43, 2021, 'jamie', 'Sometimes I Might Be Introvert', 'Little Simz',                  'Also considering: Chemtrails Over the Country Club – Lana Del Rey'),
  (44, 2021, 'nick',  '',                               '',                             ''),
  (45, 2022, 'jamie', '',                               '',                             ''),
  (46, 2022, 'nick',  '',                               '',                             ''),
  (47, 2023, 'jamie', 'The Moon Also Rises',            'Johnny Flynn',                 ''),
  (48, 2023, 'nick',  '',                               '',                             ''),
  (49, 2024, 'jamie', 'Dance, No One''s Watching',      'Ezra Collective',              ''),
  (50, 2024, 'nick',  '',                               '',                             ''),
  (51, 2025, 'jamie', 'Music Is Invisible',             'Tourist',                      'Also considering: Lux – Rosalía'),
  (52, 2025, 'nick',  '',                               '',                             '')
) as v(week, year_slot, contributor_slug, album, artist, notes)
  on c.slug = v.contributor_slug
where se.slug = '2026';
