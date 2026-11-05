-- LatAm's Duolingo sync, hourly.
--
-- Hourly because a day's XP is the difference between snapshots: the closer
-- the last one before midnight, the less of a late lesson lands on the wrong
-- day. :07 past, off the hour and clear of JPOD's 04:47.
--
-- Like JPOD's schedule, nothing secret is here. It reuses Vault's
-- jpod_sync_secret (the function checks the same JPOD_SYNC_SECRET) and reads
-- its address from one more Vault entry, created once:
--
--   select vault.create_secret('https://<ref>.supabase.co/functions/v1/latam-duolingo-sync',
--                              'latam_duolingo_sync_url');

select cron.schedule(
  'latam-duolingo-sync',
  '7 * * * *',
  $job$
    select net.http_post(
      url     := (select decrypted_secret from vault.decrypted_secrets where name = 'latam_duolingo_sync_url'),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'jpod_sync_secret')
      ),
      body    := '{}'::jsonb,
      timeout_milliseconds := 30000
    )
  $job$
);
