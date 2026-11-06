-- Lecturas: fetch and grade new articles nightly at 05:41 UTC.
--
--   select vault.create_secret('https://<ref>.supabase.co/functions/v1/latam-reader-fetch',
--                              'latam_reader_fetch_url');

select cron.schedule(
  'latam-reader-fetch',
  '41 5 * * *',
  $job$
    select net.http_post(
      url     := (select decrypted_secret from vault.decrypted_secrets where name = 'latam_reader_fetch_url'),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'jpod_sync_secret')
      ),
      body    := '{}'::jsonb,
      timeout_milliseconds := 150000
    )
  $job$
);
