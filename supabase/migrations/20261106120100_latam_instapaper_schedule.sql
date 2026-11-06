-- LatAm's Instapaper sync, nightly at 05:23 UTC: after JPOD (04:47), before
-- six in London in summer and winter, off the hour and off the Duolingo :07.
--
-- Reuses Vault's jpod_sync_secret; its address is one more Vault entry:
--
--   select vault.create_secret('https://<ref>.supabase.co/functions/v1/latam-instapaper-sync',
--                              'latam_instapaper_sync_url');

select cron.schedule(
  'latam-instapaper-sync',
  '23 5 * * *',
  $job$
    select net.http_post(
      url     := (select decrypted_secret from vault.decrypted_secrets where name = 'latam_instapaper_sync_url'),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'jpod_sync_secret')
      ),
      body    := '{}'::jsonb,
      timeout_milliseconds := 120000
    )
  $job$
);
