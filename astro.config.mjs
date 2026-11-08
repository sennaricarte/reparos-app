// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync, readdirSync } from 'node:fs';

// lastmod real: updatedDate (ou pubDate) do frontmatter de cada post.
const blogDir = new URL('./src/content/blog/', import.meta.url);
const lastmodBySlug = new Map();
for (const file of readdirSync(blogDir)) {
  if (!file.endsWith('.md')) continue;
  const fm = readFileSync(new URL(file, blogDir), 'utf8').split('---')[1] ?? '';
  const get = (key) => fm.match(new RegExp('^' + key + ':\\s*"?([^"\\n]+?)"?\\s*$', 'm'))?.[1];
  const raw = get('updatedDate') ?? get('pubDate');
  const draft = get('draft') === 'true';
  if (raw && !draft) lastmodBySlug.set(file.replace(/\.md$/, ''), new Date(raw));
}
const newestPost = new Date(Math.max(...[...lastmodBySlug.values()].map((d) => +d)));

// https://astro.build/config
export default defineConfig({
  site: 'https://reparos.app.br',
  output: 'static',
  trailingSlash: 'always',
  build: {
    inlineStylesheets: 'always',
    format: 'directory',
  },
  integrations: [
    sitemap({
      serialize(item) {
        const post = item.url.match(/\/blog\/([^/]+)\/$/);
        if (post && lastmodBySlug.has(post[1])) {
          item.lastmod = lastmodBySlug.get(post[1]).toISOString();
        } else if (item.url === 'https://reparos.app.br/' || item.url === 'https://reparos.app.br/blog/') {
          item.lastmod = newestPost.toISOString();
        }
        return item;
      },
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});
