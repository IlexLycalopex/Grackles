// @ts-check
import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';

// Server output, not static: pages read per-user data through RLS and the
// session lives in an httpOnly cookie, neither of which survives prerendering.
// Individual public pages can opt back in with `export const prerender = true`.
export default defineConfig({
  site: process.env.SITE_URL ?? 'https://grackles.co.uk',
  output: 'server',
  adapter: vercel(),
});
