// Generated from the Supabase schema. Do not hand-edit — regenerate after any
// migration with:
//
//   npx supabase gen types typescript --project-id ophmsvqtzffrjmyjyzza \
//     > src/lib/database.types.ts
//
// This copy carries the schema itself. The generic Tables<>/TablesInsert<>
// helpers the CLI also emits are omitted; the aliases at the bottom cover what
// the app actually uses.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          email: string;
          display_name: string;
          avatar_url: string | null;
          is_platform_admin: boolean;
          created_at: string;
        };
        Insert: {
          id: string;
          email: string;
          display_name?: string;
          avatar_url?: string | null;
          is_platform_admin?: boolean;
          created_at?: string;
        };
        // display_name and avatar_url are the only columns `authenticated` may
        // write; email and is_platform_admin are revoked at the grant level.
        Update: {
          display_name?: string;
          avatar_url?: string | null;
        };
        Relationships: [];
      };
      app_grants: {
        Row: {
          user_id: string;
          app: Database['public']['Enums']['app_slug'];
          max_workspaces: number;
          granted_by: string | null;
          created_at: string;
        };
        // Written only by accept_invite() and service_role — there is no
        // insert/update/delete policy for `authenticated`.
        Insert: never;
        Update: never;
        Relationships: [
          {
            foreignKeyName: 'app_grants_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      workspaces: {
        Row: {
          id: string;
          app: Database['public']['Enums']['app_slug'];
          slug: string;
          name: string;
          description: string;
          visibility: Database['public']['Enums']['visibility'];
          external_url: string;
          owner_id: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          app: Database['public']['Enums']['app_slug'];
          slug: string;
          name: string;
          description?: string;
          visibility?: Database['public']['Enums']['visibility'];
          external_url?: string;
          owner_id: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          app?: Database['public']['Enums']['app_slug'];
          slug?: string;
          name?: string;
          description?: string;
          visibility?: Database['public']['Enums']['visibility'];
          external_url?: string;
          owner_id?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      workspace_members: {
        Row: {
          workspace_id: string;
          user_id: string;
          role: Database['public']['Enums']['member_role'];
          created_at: string;
        };
        Insert: {
          workspace_id: string;
          user_id: string;
          role: Database['public']['Enums']['member_role'];
          created_at?: string;
        };
        Update: {
          workspace_id?: string;
          user_id?: string;
          role?: Database['public']['Enums']['member_role'];
          created_at?: string;
        };
        // PostgREST resolves embedded selects — `workspaces(...)` — from these,
        // so they are load-bearing for types, not documentation.
        Relationships: [
          {
            foreignKeyName: 'workspace_members_workspace_id_fkey';
            columns: ['workspace_id'];
            isOneToOne: false;
            referencedRelation: 'workspaces';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'workspace_members_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      workspace_invites: {
        // workspace_id is null on a creation-only invite — one that grants the
        // right to make a project rather than membership of an existing one.
        // grant_apps is empty unless the sender is a platform admin.
        Row: {
          id: string;
          workspace_id: string | null;
          email: string;
          role: Database['public']['Enums']['member_role'];
          grant_apps: Database['public']['Enums']['app_slug'][];
          token: string;
          invited_by: string;
          created_at: string;
          expires_at: string;
          accepted_at: string | null;
          accepted_by: string | null;
        };
        Insert: {
          id?: string;
          workspace_id?: string | null;
          email: string;
          role?: Database['public']['Enums']['member_role'];
          grant_apps?: Database['public']['Enums']['app_slug'][];
          token?: string;
          invited_by: string;
          created_at?: string;
          expires_at?: string;
          accepted_at?: string | null;
          accepted_by?: string | null;
        };
        Update: {
          id?: string;
          workspace_id?: string | null;
          email?: string;
          role?: Database['public']['Enums']['member_role'];
          grant_apps?: Database['public']['Enums']['app_slug'][];
          token?: string;
          invited_by?: string;
          created_at?: string;
          expires_at?: string;
          accepted_at?: string | null;
          accepted_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'workspace_invites_workspace_id_fkey';
            columns: ['workspace_id'];
            isOneToOne: false;
            referencedRelation: 'workspaces';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'workspace_invites_invited_by_fkey';
            columns: ['invited_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      lp_contributors: {
        Row: {
          id: string;
          workspace_id: string;
          slug: string;
          name: string;
          color: string;
          user_id: string | null;
          sort_order: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          slug: string;
          name: string;
          color: string;
          user_id?: string | null;
          sort_order?: number;
          created_at?: string;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          slug?: string;
          name?: string;
          color?: string;
          user_id?: string | null;
          sort_order?: number;
          created_at?: string;
        };
        Relationships: [];
      };
      lp_seasons: {
        Row: {
          id: string;
          workspace_id: string;
          slug: string;
          title: string;
          description: string;
          total_weeks: number;
          status: string;
          sort_order: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          slug: string;
          title: string;
          description?: string;
          total_weeks: number;
          status?: string;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          slug?: string;
          title?: string;
          description?: string;
          total_weeks?: number;
          status?: string;
          sort_order?: number;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      lp_season_contributors: {
        Row: { season_id: string; contributor_id: string; sort_order: number };
        Insert: { season_id: string; contributor_id: string; sort_order?: number };
        Update: { season_id?: string; contributor_id?: string; sort_order?: number };
        Relationships: [];
      };
      lp_selections: {
        Row: {
          id: string;
          workspace_id: string;
          season_id: string;
          contributor_id: string;
          week: number;
          year_slot: number;
          album: string;
          artist: string;
          status: string;
          artwork_url: string;
          link_wikipedia: string;
          link_spotify: string;
          link_youtube: string;
          notes: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          season_id: string;
          contributor_id: string;
          week: number;
          year_slot: number;
          album?: string;
          artist?: string;
          status: string;
          artwork_url?: string;
          link_wikipedia?: string;
          link_spotify?: string;
          link_youtube?: string;
          notes?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          season_id?: string;
          contributor_id?: string;
          week?: number;
          year_slot?: number;
          album?: string;
          artist?: string;
          status?: string;
          artwork_url?: string;
          link_wikipedia?: string;
          link_spotify?: string;
          link_youtube?: string;
          notes?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      rl_years: {
        Row: {
          id: string;
          workspace_id: string;
          year: number;
          status: string;
          total_books: number | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          year: number;
          status?: string;
          total_books?: number | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          year?: number;
          status?: string;
          total_books?: number | null;
          created_at?: string;
        };
        Relationships: [];
      };
      rl_books: {
        Row: {
          id: string;
          workspace_id: string;
          year_id: string;
          order_read: number;
          title: string;
          author: string;
          pages: number | null;
          date_started: string | null;
          date_finished: string | null;
          format: string;
          year_published: number | null;
          genre: string;
          publisher: string;
          publisher_normalised: string;
          cover_url: string;
          isbn: string;
          description: string;
          tags: string[];
          notes: string;
          reading: boolean;
          coming_up: boolean;
          link_openlibrary: string;
          link_wikipedia: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          year_id: string;
          order_read: number;
          title: string;
          author?: string;
          pages?: number | null;
          date_started?: string | null;
          date_finished?: string | null;
          format?: string;
          year_published?: number | null;
          genre?: string;
          publisher?: string;
          publisher_normalised?: string;
          cover_url?: string;
          isbn?: string;
          description?: string;
          tags?: string[];
          notes?: string;
          reading?: boolean;
          coming_up?: boolean;
          link_openlibrary?: string;
          link_wikipedia?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['rl_books']['Insert']>;
        Relationships: [];
      };
      cl_cigars: {
        Row: {
          id: string;
          workspace_id: string;
          slug: string;
          status: string;
          quantity: number;
          name: string;
          brand: string;
          vitola: string;
          wrapper: string;
          length_text: string;
          ring_gauge: number | null;
          country: string;
          strength: string | null;
          bought_at: string;
          smoked_at: string;
          date_acquired: string | null;
          date_smoked: string | null;
          price_text: string;
          price_gbp: number | null;
          price_approximate: boolean;
          rating: number | null;
          pairing: string;
          note: string;
          photo_path: string;
          tasting_notes: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          slug: string;
          status?: string;
          quantity?: number;
          name: string;
          brand?: string;
          vitola?: string;
          wrapper?: string;
          length_text?: string;
          ring_gauge?: number | null;
          country?: string;
          strength?: string | null;
          bought_at?: string;
          smoked_at?: string;
          date_acquired?: string | null;
          date_smoked?: string | null;
          price_text?: string;
          price_gbp?: number | null;
          price_approximate?: boolean;
          rating?: number | null;
          pairing?: string;
          note?: string;
          photo_path?: string;
          tasting_notes?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['cl_cigars']['Insert']>;
        Relationships: [];
      };
      /**
       * WBPR — Void 1680 AM. A broadcast is a night on air; blocks, prompts,
       * tracks and phenomena hang off it. Every child carries workspace_id
       * alongside its parent so RLS reads one column without a join.
       */
      wbpr_broadcasts: {
        Row: {
          id: string;
          workspace_id: string;
          session: number;
          slug: string;
          station: string;
          call_sign: string;
          location: string;
          lat: number | null;
          lon: number | null;
          date: string;
          start_time: string;
          end_time: string;
          duration_minutes: number | null;
          atmospheric_conditions: string;
          veil_status: string;
          veil_intensity: number | null;
          dawn_colour: string;
          veil_at_close: string;
          personal_notes: string;
          tags: string[];
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          session: number;
          slug: string;
          station?: string;
          call_sign?: string;
          location?: string;
          lat?: number | null;
          lon?: number | null;
          date: string;
          start_time?: string;
          end_time?: string;
          duration_minutes?: number | null;
          atmospheric_conditions?: string;
          veil_status?: string;
          veil_intensity?: number | null;
          dawn_colour?: string;
          veil_at_close?: string;
          personal_notes?: string;
          tags?: string[];
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['wbpr_broadcasts']['Insert']>;
        Relationships: [];
      };
      wbpr_blocks: {
        Row: {
          id: string;
          workspace_id: string;
          broadcast_id: string;
          position: number;
          time_label: string;
          caller_type: string;
          caller_card: string;
          caller_card_meaning: string;
          caller_location: string;
          caller_lat: number | null;
          caller_lon: number | null;
          caller_location_confidence: string;
          caller_roll: number | null;
          phenomenon_ref: string;
          notes: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          broadcast_id: string;
          position: number;
          time_label?: string;
          caller_type?: string;
          caller_card?: string;
          caller_card_meaning?: string;
          caller_location?: string;
          caller_lat?: number | null;
          caller_lon?: number | null;
          caller_location_confidence?: string;
          caller_roll?: number | null;
          phenomenon_ref?: string;
          notes?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['wbpr_blocks']['Insert']>;
        // PostgREST resolves embedded selects from these, so they are
        // load-bearing for types rather than documentation.
        Relationships: [
          {
            foreignKeyName: 'wbpr_blocks_broadcast_id_fkey';
            columns: ['broadcast_id'];
            isOneToOne: false;
            referencedRelation: 'wbpr_broadcasts';
            referencedColumns: ['id'];
          },
        ];
      };
      wbpr_prompts: {
        Row: {
          id: string;
          workspace_id: string;
          block_id: string;
          position: number;
          card: string;
          tone: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          block_id: string;
          position: number;
          card: string;
          tone?: string;
          created_at?: string;
        };
        Update: Partial<Database['public']['Tables']['wbpr_prompts']['Insert']>;
        Relationships: [
          {
            foreignKeyName: 'wbpr_prompts_block_id_fkey';
            columns: ['block_id'];
            isOneToOne: false;
            referencedRelation: 'wbpr_blocks';
            referencedColumns: ['id'];
          },
        ];
      };
      wbpr_tracks: {
        Row: {
          id: string;
          workspace_id: string;
          block_id: string;
          position: number;
          title: string;
          artist: string;
          url: string;
          source: string;
          notes: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          block_id: string;
          position: number;
          title: string;
          artist?: string;
          url?: string;
          source?: string;
          notes?: string;
          created_at?: string;
        };
        Update: Partial<Database['public']['Tables']['wbpr_tracks']['Insert']>;
        Relationships: [
          {
            foreignKeyName: 'wbpr_tracks_block_id_fkey';
            columns: ['block_id'];
            isOneToOne: false;
            referencedRelation: 'wbpr_blocks';
            referencedColumns: ['id'];
          },
        ];
      };
      wbpr_phenomena: {
        Row: {
          id: string;
          workspace_id: string;
          broadcast_id: string;
          key: string;
          name: string;
          status: string;
          confidence: string;
          locations: string[];
          lat: number | null;
          lon: number | null;
          notes: string;
          tags: string[];
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          broadcast_id: string;
          key: string;
          name: string;
          status?: string;
          confidence?: string;
          locations?: string[];
          lat?: number | null;
          lon?: number | null;
          notes?: string;
          tags?: string[];
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['wbpr_phenomena']['Insert']>;
        Relationships: [
          {
            foreignKeyName: 'wbpr_phenomena_broadcast_id_fkey';
            columns: ['broadcast_id'];
            isOneToOne: false;
            referencedRelation: 'wbpr_broadcasts';
            referencedColumns: ['id'];
          },
        ];
      };
      /**
       * A sitting at the desk with the model, and what was said in it. Both
       * are owner-only at the policy level, not merely in the page: this is
       * the pair of tables that costs money to fill.
       */
      wbpr_agent_sessions: {
        Row: {
          id: string;
          workspace_id: string;
          broadcast_id: string | null;
          status: string;
          block: number;
          state: Json;
          prompt_tokens: number;
          completion_tokens: number;
          calls: number;
          /** The sitting's job. Null on the nine that predate metering. */
          ai_job_id: string | null;
          created_by: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          broadcast_id?: string | null;
          status?: string;
          block?: number;
          state?: Json;
          ai_job_id?: string | null;
          prompt_tokens?: number;
          completion_tokens?: number;
          calls?: number;
          created_by: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['wbpr_agent_sessions']['Insert']>;
        Relationships: [
          {
            foreignKeyName: 'wbpr_agent_sessions_broadcast_id_fkey';
            columns: ['broadcast_id'];
            isOneToOne: false;
            referencedRelation: 'wbpr_broadcasts';
            referencedColumns: ['id'];
          },
        ];
      };
      wbpr_agent_messages: {
        Row: {
          id: string;
          workspace_id: string;
          session_id: string;
          position: number;
          role: string;
          content: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          session_id: string;
          position: number;
          role: string;
          content: string;
          created_at?: string;
        };
        Update: Partial<Database['public']['Tables']['wbpr_agent_messages']['Insert']>;
        Relationships: [
          {
            foreignKeyName: 'wbpr_agent_messages_session_id_fkey';
            columns: ['session_id'];
            isOneToOne: false;
            referencedRelation: 'wbpr_agent_sessions';
            referencedColumns: ['id'];
          },
        ];
      };
      /**
       * AI governance. See docs/ai-architecture.md — the short version is that
       * the unit of control is a job rather than a call, every call belongs to
       * one, and none of these tables is written directly: the money moves
       * through ai_begin_job / ai_begin_call / ai_end_call / ai_end_job or it
       * does not move. Only `ai_jobs.cancel_requested` and the proposal
       * outcomes are writable by a client, which is why the Insert types below
       * are mostly unreachable in practice.
       */
      ai_features: {
        Row: {
          key: string;
          app: Database['public']['Enums']['app_slug'];
          name: string;
          enabled: boolean;
          max_tokens: number;
          min_role: string;
          provider: string;
          model: string;
          default_max_usd: number;
          default_max_calls: number;
          max_depth: number;
          quality_floor: number | null;
          auto_disabled_at: string | null;
          /** Null falls back to the platform default, which is sized for the desk. */
          prompt_allowance_tokens: number | null;
          /** True when the feature transmits stored records, not just what was typed. */
          sends_records: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          key: string;
          app: Database['public']['Enums']['app_slug'];
          name: string;
          enabled?: boolean;
          max_tokens: number;
          min_role?: string;
          provider?: string;
          model?: string;
          default_max_usd?: number;
          default_max_calls?: number;
          max_depth?: number;
          quality_floor?: number | null;
          auto_disabled_at?: string | null;
          prompt_allowance_tokens?: number | null;
          sends_records?: boolean;
        };
        Update: Partial<Database['public']['Tables']['ai_features']['Insert']>;
        Relationships: [];
      };
      ai_platform_settings: {
        Row: {
          id: boolean;
          enabled: boolean;
          admissions_open: boolean;
          default_monthly_usd: number;
          actor_rate_per_minute: number;
          anon_rate_per_hour: number;
          max_job_share: number;
          prompt_allowance_tokens: number;
          breaker_threshold: number;
          breaker_minutes: number;
          /** Null keeps transcripts forever, which is the default deliberately. */
          transcript_retention_days: number | null;
          /** Off by default: a preview deployment that can spend is a pull request that can spend. */
          preview_enabled: boolean;
          updated_at: string;
        };
        Insert: { id?: boolean };
        Update: Partial<Database['public']['Tables']['ai_platform_settings']['Row']>;
        Relationships: [];
      };
      ai_models: {
        Row: {
          provider: string;
          model: string;
          prompt_usd_per_mtok: number;
          completion_usd_per_mtok: number;
          effective_from: string;
          allowed: boolean;
          notes: string;
        };
        Insert: {
          provider: string;
          model: string;
          prompt_usd_per_mtok: number;
          completion_usd_per_mtok: number;
          effective_from?: string;
          allowed?: boolean;
          notes?: string;
        };
        Update: Partial<Database['public']['Tables']['ai_models']['Insert']>;
        Relationships: [];
      };
      ai_prompt_versions: {
        Row: {
          id: number;
          feature: string;
          version: number;
          hash: string;
          /** Admin-readable only; the app holds the body in code. */
          body: string;
          active: boolean;
          notes: string;
          created_at: string;
        };
        Insert: never;
        Update: { active?: boolean; notes?: string };
        Relationships: [];
      };
      ai_budgets: {
        Row: {
          user_id: string;
          /** Null means the platform default applies; zero means none. */
          monthly_usd: number | null;
          enabled: boolean;
          granted_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          user_id: string;
          monthly_usd?: number | null;
          enabled?: boolean;
          granted_by?: string | null;
        };
        Update: Partial<Database['public']['Tables']['ai_budgets']['Insert']>;
        Relationships: [];
      };
      ai_periods: {
        Row: {
          payer_id: string;
          period: string;
          reserved_usd: number;
          committed_usd: number;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      ai_workspace_features: {
        Row: {
          workspace_id: string;
          feature: string;
          enabled: boolean;
          daily_usd: number | null;
          allow_anon: boolean;
          allow_scheduled: boolean;
          /** When the owner agreed to this project's records being sent, and who. */
          consent_at: string | null;
          consent_by: string | null;
          updated_at: string;
        };
        Insert: {
          workspace_id: string;
          feature: string;
          enabled?: boolean;
          daily_usd?: number | null;
          allow_anon?: boolean;
          allow_scheduled?: boolean;
          consent_at?: string | null;
          consent_by?: string | null;
        };
        Update: Partial<Database['public']['Tables']['ai_workspace_features']['Insert']>;
        Relationships: [];
      };
      ai_jobs: {
        Row: {
          id: string;
          feature: string;
          workspace_id: string;
          class: string;
          /** Null only where the account has since been deleted. */
          payer_id: string | null;
          actor_id: string | null;
          actor_kind: string;
          actor_fingerprint: string | null;
          parent_job_id: string | null;
          root_job_id: string;
          depth: number;
          status: string;
          max_usd: number;
          max_calls: number;
          max_concurrency: number;
          deadline: string;
          spent_usd: number;
          held_usd: number;
          calls_made: number;
          items_total: number | null;
          items_done: number;
          heartbeat_at: string | null;
          cancel_requested: boolean;
          error: string | null;
          environment: string;
          idempotency_key: string | null;
          created_at: string;
          started_at: string | null;
          finished_at: string | null;
        };
        Insert: never;
        /** The one column a client may write. Everything else moves through the functions. */
        Update: { cancel_requested?: boolean };
        Relationships: [
          {
            foreignKeyName: 'ai_jobs_workspace_id_fkey';
            columns: ['workspace_id'];
            isOneToOne: false;
            referencedRelation: 'workspaces';
            referencedColumns: ['id'];
          },
        ];
      };
      ai_calls: {
        Row: {
          id: string;
          job_id: string;
          feature: string;
          workspace_id: string | null;
          /** Null only where the account has since been deleted. */
          payer_id: string | null;
          actor_id: string | null;
          provider: string;
          model: string;
          prompt_version: number | null;
          status: string;
          reserved_usd: number;
          prompt_tokens: number | null;
          completion_tokens: number | null;
          prompt_usd_per_mtok: number | null;
          completion_usd_per_mtok: number | null;
          /** Generated from the tokens and the snapshotted prices. */
          cost_usd: number | null;
          validator_status: string | null;
          validator_findings: Json | null;
          /** Answered from ai_cache: free, and recorded anyway. */
          cache_hit: boolean;
          error: string | null;
          created_at: string;
          settled_at: string | null;
        };
        Insert: never;
        Update: never;
        Relationships: [
          {
            foreignKeyName: 'ai_calls_job_id_fkey';
            columns: ['job_id'];
            isOneToOne: false;
            referencedRelation: 'ai_jobs';
            referencedColumns: ['id'];
          },
        ];
      };
      ai_job_items: {
        Row: {
          job_id: string;
          position: number;
          ref: Json;
          status: string;
          attempts: number;
          call_id: string | null;
          error: string | null;
          updated_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      ai_golden_cases: {
        Row: {
          id: string;
          feature: string;
          name: string;
          input: Json;
          expectations: Json;
          curated_from: string | null;
          created_by: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          feature: string;
          name: string;
          input: Json;
          expectations: Json;
          curated_from?: string | null;
          created_by?: string | null;
        };
        Update: Partial<Database['public']['Tables']['ai_golden_cases']['Insert']>;
        Relationships: [];
      };
      ai_golden_runs: {
        Row: {
          id: string;
          case_id: string;
          job_id: string | null;
          call_id: string | null;
          passed: boolean;
          findings: Json;
          model: string;
          prompt_version: number | null;
          created_at: string;
        };
        Insert: {
          case_id: string;
          job_id?: string | null;
          call_id?: string | null;
          passed: boolean;
          findings?: Json;
          model?: string;
          prompt_version?: number | null;
        };
        Update: never;
        Relationships: [];
      };
      ai_provider_health: {
        Row: {
          provider: string;
          model: string;
          /** Consecutive: one failure in fifty is a provider working normally. */
          consecutive_failures: number;
          /** While in the future, calls are refused without being attempted. */
          opened_until: string | null;
          last_error: string | null;
          opened_count: number;
          updated_at: string;
        };
        Insert: never;
        /** Closing it by hand is an admin action, and the only write offered. */
        Update: { opened_until?: string | null; consecutive_failures?: number };
        Relationships: [];
      };
      ai_notices: {
        Row: {
          id: string;
          kind: string;
          /** Null means the platform admins — a feature tripping is nobody's project. */
          recipient: string | null;
          subject: string;
          body: string;
          dedupe_key: string;
          created_at: string;
          sent_at: string | null;
          error: string | null;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      ai_proposals: {
        Row: {
          id: string;
          call_id: string;
          workspace_id: string;
          feature: string;
          target_table: string;
          target_id: string | null;
          proposed: Json;
          outcome: string | null;
          edit_distance: number | null;
          decided_by: string | null;
          decided_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          call_id: string;
          workspace_id: string;
          feature: string;
          target_table: string;
          target_id?: string | null;
          proposed: Json;
          outcome?: string | null;
          edit_distance?: number | null;
          decided_by?: string | null;
          decided_at?: string | null;
        };
        Update: Partial<Database['public']['Tables']['ai_proposals']['Insert']>;
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: {
      /**
       * Redeems membership, creation rights, or both. workspace_id is null
       * when the invite only granted the right to create.
       *
       * Raises with a custom SQLSTATE the caller can branch on:
       * GRK01 invalid/expired/used, GRK02 addressed to someone else.
       */
      accept_invite: {
        Args: { invite_token: string };
        Returns: {
          workspace_id: string | null;
          role: Database['public']['Enums']['member_role'] | null;
          granted_apps: Database['public']['Enums']['app_slug'][];
        };
      };
      /**
       * Who a pending invitation is for, resolved from its token.
       *
       * Callable by `anon` on purpose: the caller has no session yet, and the
       * token — unguessable, and only ever sent to the invited address — is
       * the authorisation. Null for a token that is unknown, expired or spent;
       * the three are not distinguished.
       */
      invite_email_for_token: {
        Args: { p_token: string };
        Returns: {
          email: string;
          role: Database['public']['Enums']['member_role'] | null;
          workspace_name: string | null;
          app: Database['public']['Enums']['app_slug'] | null;
          granted_apps: Database['public']['Enums']['app_slug'][];
        } | null;
      };
      /**
       * The unexpired, unredeemed invitations addressed to the caller.
       *
       * Matched against auth.users.email, the same rule accept_invite()
       * applies — so everything listed can be accepted, and an invitation you
       * merely *sent* is not one of yours. Resolves the project's name past
       * RLS, because an invitee is not a member yet and so cannot read a
       * private workspace for themselves.
       *
       * `role` and `app` are null on an invitation that only grants the right
       * to create something.
       */
      my_pending_invites: {
        Args: Record<string, never>;
        Returns: {
          token: string;
          role: Database['public']['Enums']['member_role'] | null;
          workspace_name: string | null;
          app: Database['public']['Enums']['app_slug'] | null;
          grant_apps: Database['public']['Enums']['app_slug'][];
          expires_at: string;
          invited_by_name: string | null;
        }[];
      };
      /**
       * Creates a workspace, seeds its defaults, and makes the caller owner.
       *
       * GRK03 no entitlement for this app (or quota used up), GRK04 slug taken.
       */
      create_workspace: {
        Args: {
          p_app: Database['public']['Enums']['app_slug'];
          p_slug: string;
          p_name: string;
          p_visibility?: Database['public']['Enums']['visibility'];
        };
        Returns: string;
      };
      smoke_from_humidor: {
        Args: {
          p_cigar_id: string;
          p_slug: string;
          p_date_smoked: string;
          p_smoked_at?: string;
          p_pairing?: string;
          p_note?: string;
          p_rating?: number | null;
          p_tasting_notes?: string;
        };
        /** The id of the smoked entry — the row itself, or the one split off it. */
        Returns: string;
      };
      /**
       * Admission. Every gate that costs anything to check is here, once per
       * job rather than once per call, and it raises rather than returning a
       * verdict so a caller cannot forget to look.
       *
       * GRK10 no such project (or not visible — deliberately the same),
       * GRK11 AI is off, GRK12 feature off, GRK13 not allowed,
       * GRK14 rate limited, GRK15 allowance spent, GRK16 daily limit,
       * GRK17 too deep, GRK18 job too large for what is left, GRK1B paused.
       */
      ai_begin_job: {
        Args: {
          p_feature: string;
          p_workspace: string;
          p_class?: string;
          p_max_usd?: number | null;
          p_max_calls?: number | null;
          p_parent?: string | null;
          p_fingerprint?: string | null;
          p_items_total?: number | null;
          p_environment?: string;
          p_idempotency_key?: string | null;
        };
        Returns: string;
      };
      /**
       * An answer from the cache, or null. A hit is free, is recorded as a
       * call, and still counts against the job's call ceiling — the budget
       * cannot stop a loop that costs nothing.
       */
      ai_cache_take: {
        Args: { p_job: string; p_key: string };
        /** Empty on a miss. The call id is the hit's own ledger row. */
        Returns: { content: string; call_id: string }[];
      };
      /**
       * Reaping, cache sweeping, quality floors and budget warnings, for a
       * platform admin. The cron-facing twin is service_role's, because cron
       * has no session and app.is_platform_admin() is false without one.
       */
      /**
       * Freeze a sitting as a golden case. Platform admins only — a case holds
       * a frozen copy of somebody's data and the prompt sent with it.
       */
      ai_curate_desk_case: { Args: { p_session: string; p_name: string }; Returns: string };
      /** The latest run per case, and whether the one before it passed. */
      ai_golden_status: {
        Args: Record<string, never>;
        Returns: {
          case_id: string;
          feature: string;
          name: string;
          passed: boolean | null;
          findings: Json | null;
          model: string | null;
          ran_at: string | null;
          previously: boolean | null;
        }[];
      };
      ai_housekeeping_now: {
        Args: Record<string, never>;
        Returns: {
          calls_released: number;
          jobs_reaped: number;
          cache_swept: number;
          notices: number;
        }[];
      };
      ai_cache_put: {
        Args: {
          p_job: string;
          p_key: string;
          p_content: string;
          p_prompt_version?: number | null;
          p_ttl?: string;
        };
        Returns: void;
      };
      /** One call within an admitted job. GRK19 when a ceiling is reached. */
      ai_begin_call: {
        Args: { p_job: string; p_prompt_version?: number | null };
        Returns: string;
      };
      /** Settles a call and returns what it actually cost, in USD. */
      ai_end_call: {
        Args: {
          p_call: string;
          p_prompt: number;
          p_completion: number;
          p_validator_status?: string | null;
          p_validator_findings?: Json | null;
          p_error?: string | null;
        };
        Returns: number;
      };
      ai_end_job: {
        Args: { p_job: string; p_status: string; p_error?: string | null };
        Returns: void;
      };
      ai_cancel_job: { Args: { p_job: string }; Returns: void };
      ai_enqueue_items: { Args: { p_job: string; p_refs: Json }; Returns: number };
      ai_claim_items: {
        Args: { p_job: string; p_limit?: number };
        Returns: Database['public']['Tables']['ai_job_items']['Row'][];
      };
      ai_finish_item: {
        Args: {
          p_job: string;
          p_position: number;
          p_ok: boolean;
          p_call?: string | null;
          p_error?: string | null;
        };
        Returns: void;
      };
      /** Returns the id of the version matching this body, inserting it if new. */
      ai_register_prompt: { Args: { p_feature: string; p_body: string }; Returns: number };
      /**
       * The admin console's two questions.
       *
       * Spend is already readable — ai_calls_read includes platform admins —
       * but names are not: profiles_read is "me, or somebody I share a
       * workspace with", and workspaces_read hides a private project the admin
       * is not in. Both raise 42501 for anyone who is not an admin.
       */
      ai_admin_spend: {
        Args: { p_period?: string | null };
        Returns: {
          payer_id: string;
          display_name: string | null;
          email: string;
          limit_usd: number;
          committed_usd: number;
          reserved_usd: number;
          calls: number;
          failures: number;
          budget_enabled: boolean;
        }[];
      };
      ai_admin_queue: {
        Args: Record<string, never>;
        Returns: {
          id: string;
          feature: string;
          class: string;
          status: string;
          workspace_name: string | null;
          app: Database['public']['Enums']['app_slug'] | null;
          payer_name: string | null;
          actor_name: string | null;
          spent_usd: number;
          max_usd: number;
          calls_made: number;
          items_done: number;
          items_total: number | null;
          heartbeat_at: string | null;
          created_at: string;
        }[];
      };
      ai_set_budget: {
        Args: { p_user: string; p_monthly_usd: number; p_enabled?: boolean };
        Returns: void;
      };
      /**
       * A month's spend, grouped, for the caller — as payer and as actor both.
       * `role` says which: 'mine', 'on my bill' (somebody else ran it), or
       * 'on their bill' (I ran it, they paid).
       */
      my_ai_usage: {
        Args: { p_period?: string | null };
        Returns: {
          feature: string;
          feature_name: string;
          workspace_id: string | null;
          workspace_name: string | null;
          app: Database['public']['Enums']['app_slug'] | null;
          role: string;
          calls: number;
          prompt_tokens: number;
          completion_tokens: number;
          cost_usd: number;
          failures: number;
          validator_failures: number;
        }[];
      };
    };
    Enums: {
      app_slug:
        | 'listening-party'
        | 'reading-list'
        | 'cigar-lounge'
        | 'atelier-obscura'
        | 'lanternwood'
        | 'spelltome'
        | 'scoundrel'
        | 'wbpr';
      member_role: 'owner' | 'editor' | 'viewer';
      visibility: 'private' | 'unlisted' | 'public';
    };
    CompositeTypes: { [_ in never]: never };
  };
};

type Public = Database['public'];

export type Tables<T extends keyof Public['Tables']> = Public['Tables'][T]['Row'];
export type TablesInsert<T extends keyof Public['Tables']> = Public['Tables'][T]['Insert'];
export type TablesUpdate<T extends keyof Public['Tables']> = Public['Tables'][T]['Update'];
export type Enums<T extends keyof Public['Enums']> = Public['Enums'][T];
/** What an RPC gives back, so a page can name the shape it is mapping over. */
export type Returns<T extends keyof Public['Functions']> = Public['Functions'][T]['Returns'];

export type AppSlug = Enums<'app_slug'>;
export type MemberRole = Enums<'member_role'>;
export type Visibility = Enums<'visibility'>;
