// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// GitHub Pages project site for now. When the custom domain is ready, set SITE_URL to it and
// BASE_PATH to "/" (in the Pages workflow), and add public/CNAME.
const site = process.env.SITE_URL ?? 'https://kasuken.github.io';
const base = process.env.BASE_PATH ?? '/repoboard';

export default defineConfig({
  site,
  base,
  trailingSlash: 'always',
  integrations: [sitemap()],
  build: { inlineStylesheets: 'always' },
});
