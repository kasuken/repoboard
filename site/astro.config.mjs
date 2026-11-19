// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// GitHub Pages project site for now. For a custom domain: add the DNS record, set the domain in
// Settings > Pages (and Enforce HTTPS), then set SITE_URL to it and BASE_PATH to "/" in pages.yml.
const site = process.env.SITE_URL ?? 'https://kasuken.github.io';
const base = process.env.BASE_PATH ?? '/repoboard';

export default defineConfig({
  site,
  base,
  trailingSlash: 'always',
  integrations: [sitemap()],
  build: { inlineStylesheets: 'always' },
});
