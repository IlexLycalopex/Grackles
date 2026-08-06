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
