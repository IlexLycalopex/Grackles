import { createBrowserClient } from '@supabase/ssr';
import type { Database } from '../database.types';

/**
 * Client-side Supabase, for the few things that genuinely need to happen in
 * the browser — file uploads to Storage, and later realtime.
 *
 * Ordinary reads and writes should go through a server route instead: the
 * server already has the session and can validate before touching the
 * database. Reach for this only when the server cannot do the job.
 */
export function createSupabaseBrowserClient() {
  return createBrowserClient<Database>(
    import.meta.env.PUBLIC_SUPABASE_URL,
    import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY
  );
}
