/// <reference types="astro/client" />

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './lib/database.types';

declare global {
  namespace App {
    interface Locals {
      supabase: SupabaseClient<Database>;
      /**
       * Who is signed in, from the verified session token. Only the two
       * fields the app reads: see the note on getClaims() in middleware.ts.
       */
      user: { id: string; email?: string } | null;
    }
  }
}

interface ImportMetaEnv {
  readonly PUBLIC_SUPABASE_URL: string;
  readonly PUBLIC_SUPABASE_PUBLISHABLE_KEY: string;
  readonly SITE_URL?: string;
  /** Optional. Raises the Google Books quota used when a cover lookup falls back to it. */
  readonly GOOGLE_BOOKS_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

export {};
