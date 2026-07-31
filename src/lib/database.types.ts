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
          created_at: string;
        };
        Insert: {
          id: string;
          email: string;
          display_name?: string;
          avatar_url?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          email?: string;
          display_name?: string;
          avatar_url?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      workspaces: {
        Row: {
          id: string;
          app: Database['public']['Enums']['app_slug'];
          slug: string;
          name: string;
          description: string;
          visibility: Database['public']['Enums']['visibility'];
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
        Row: {
          id: string;
          workspace_id: string;
          email: string;
          role: Database['public']['Enums']['member_role'];
          token: string;
          invited_by: string;
          created_at: string;
          expires_at: string;
          accepted_at: string | null;
          accepted_by: string | null;
        };
        Insert: {
          id?: string;
          workspace_id: string;
          email: string;
          role?: Database['public']['Enums']['member_role'];
          token?: string;
          invited_by: string;
          created_at?: string;
          expires_at?: string;
          accepted_at?: string | null;
          accepted_by?: string | null;
        };
        Update: {
          id?: string;
          workspace_id?: string;
          email?: string;
          role?: Database['public']['Enums']['member_role'];
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
    };
    Views: { [_ in never]: never };
    Functions: {
      accept_invite: { Args: { invite_token: string }; Returns: string };
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
      app_slug: 'listening-party' | 'reading-list' | 'cigar-lounge';
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

export type AppSlug = Enums<'app_slug'>;
export type MemberRole = Enums<'member_role'>;
export type Visibility = Enums<'visibility'>;
