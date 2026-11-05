-- JPOD's daily sync, on a schedule.
--
-- The work is done by the `jpod-sync` Edge Function
-- (supabase/functions/jpod-sync). This only rings its bell once a day, through
-- pg_net, which is why it is its own migration: it is the one part of JPOD the
-- local suite cannot run, because tests/baseline.sql has neither extension.
--
-- Nothing secret is written here. The function's address and the shared
-- secret it checks are read from Vault at the moment the job runs, so this
-- file is the same for every environment and the values never reach the repo.
-- Before the first run, create both once in the SQL editor:
--
--   select vault.create_secret('https://<ref>.supabase.co/functions/v1/jpod-sync', 'jpod_sync_url');
--   select vault.create_secret('<a long random string>', 'jpod_sync_secret');
--
-- and give the function the same string as its JPOD_SYNC_SECRET. Until both
-- exist the job fails harmlessly each morning, and says so in
-- cron.job_run_details.
--
-- 04:47 UTC is before six in London in both summer and winter, off the hour so
-- it does not queue behind everything else scheduled on the hour.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'jpod-sync',
  '47 4 * * *',
  $job$
    select net.http_post(
      url     := (select decrypted_secret from vault.decrypted_secrets where name = 'jpod_sync_url'),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-jpod-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'jpod_sync_secret')
      ),
      body    := '{}'::jsonb,
      timeout_milliseconds := 60000
    )
  $job$
);
