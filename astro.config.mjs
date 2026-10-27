// @ts-check
import { defineConfig, passthroughImageService } from 'astro/config';
import vercel from '@astrojs/vercel';

// Server output, not static: pages read per-user data through RLS and the
// session lives in an httpOnly cookie, neither of which survives prerendering.
// Individual public pages can opt back in with `export const prerender = true`.
export default defineConfig({
  site: process.env.SITE_URL ?? 'https://grackles.co.uk',
  output: 'server',
  adapter: vercel(),
  // Nothing here uses astro:assets: covers and photos are links to other
  // sites. Astro deploys its /_image optimiser anyway, and that endpoint is
  // where GHSA-26w7-cxv4-gfx2 (code execution through a crafted AVIF) lives
  // until the Astro 7 upgrade. Passthrough means the route never decodes an
  // image, so the vulnerable path is never reached.
  image: { service: passthroughImageService() },
});
