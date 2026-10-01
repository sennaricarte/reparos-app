#!/usr/bin/env node
/**
 * scripts/fix-domain.mjs
 * Replace reparos.com.br -> reparos.app.br and convert absolute reparos.com.br links to relative.
 * Dry-run by default; pass --apply to write files. Idempotent.
 *
 * Rules:
 * - Operates on src/content/blog/*.md and src/pages/**/*.astro
 * - href="http(s)://(www.)reparos.com.br/CAMINHO" => relative mapping:
 *    root -> "/"
 *    /blog/SLUG or /SLUG where SLUG exists -> "/blog/SLUG/"
 *    fixed pages -> "/PAGINA/"
 *    unknown paths: leave unchanged and report
 * - Text replacements: "Reparos.com.br"/"reparos.com.br"/"www.reparos.com.br" -> "Reparos.app.br"/"reparos.app.br"
 * - Use String.replace with global regex and callback (no exec loops)
 */
import fs from 'fs/promises';
import path from 'path';

const ROOT = process.cwd();
const POSTS_DIR = path.join(ROOT, 'src', 'content', 'blog');
const PAGES_DIR = path.join(ROOT, 'src', 'pages');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');

const FIXED_PAGES = new Set(['hidraulica','eletrica','reformas','pintura','pisos','construcao','sobre','privacidade','termos','blog']);

function lf(s){ return s.replace(/\r\n/g,'\n'); }

async function listPostSlugs() {
  try {
    const files = await fs.readdir(POSTS_DIR);
    return files.filter(f=>f.endsWith('.md')).map(f=>f.replace(/\.md$/,''));
  } catch {
    return [];
  }
}

async function listFilesRecursive(dir, extFilter) {
  const out = [];
  async function walk(d){
    const entries = await fs.readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (!extFilter || extFilter.includes(path.extname(e.name))) out.push(p);
    }
  }
  await walk(dir);
  return out;
}

function contextSnippet(full, idx, len=40){
  const start = Math.max(0, idx - len);
  const end = Math.min(full.length, idx + len);
  return full.slice(start, end).replace(/\n/g,'␤');
}

async function processFile(file, slugs, report) {
  let raw = lf(await fs.readFile(file, 'utf8'));
  const original = raw;
  const changes = [];

  // href replacement
  const hrefRx = /href=(["'])(https?:\/\/(?:www\.)?reparos\.com\.br)(\/[^"'\s>]*)?\1/gi;
  raw = raw.replace(hrefRx, (match, quote, host, pth='')=>{
    const pathOnly = pth || '/';
    // normalize: remove query/hash for matching but preserve them
    const [pathname, ...rest] = pathOnly.split(/(?=[?#])/);
    const suffix = rest.join('') || '';
    const norm = pathname.replace(/\/+$/,'') || '/';
    // split segments
    const segs = norm.split('/').filter(Boolean);
    let replacement = null;
    if (segs.length === 0) {
      replacement = '/';
    } else if (segs.length === 1) {
      const seg = segs[0].toLowerCase();
      if (slugs.includes(seg)) replacement = `/blog/${seg}/`;
      else if (FIXED_PAGES.has(seg)) replacement = `/${seg}/`;
    } else if (segs.length >=2 && segs[0].toLowerCase()==='blog') {
      const seg = segs[1].toLowerCase();
      if (slugs.includes(seg)) replacement = `/blog/${seg}/`;
    }
    if (replacement) {
      const after = `href=${quote}${replacement}${suffix}${quote}`;
      changes.push({ before: match, after, idx: null });
      return after;
    } else {
      // report unresolved
      changes.push({ before: match, after: null, unresolved: true });
      return match;
    }
  });

  // text domain replacements (preserve first-letter case)
  const domainRx = /\b(?:www\.)?reparos\.com\.br\b/gi;
  raw = raw.replace(domainRx, (m)=>{
    // if starts with uppercase letter, use 'Reparos.app.br' else 'reparos.app.br'
    const first = m[0];
    const repl = (first === first.toUpperCase()) ? 'Reparos.app.br' : 'reparos.app.br';
    changes.push({ before: m, after: repl, idx: null });
    return repl;
  });

  if (raw !== original) {
    if (APPLY) {
      await fs.writeFile(file, raw, 'utf8');
    }
    // build detailed per-change snippets
    for (const c of changes) {
      if (c.unresolved) {
        report.unresolved.push({ file, text: c.before });
      } else {
        const idx = raw.indexOf(c.after || c.before);
        report.entries.push({ file, before: c.before, after: c.after || c.before, context: contextSnippet(raw, idx>=0?idx:0,40) });
      }
    }
  }
}

async function main(){
  console.log(`Fix domain — DRY-RUN mode${APPLY ? ' (applying changes)' : ''}`);
  const slugs = await listPostSlugs();
  const files = [];
  const mdFiles = (await listFilesRecursive(POSTS_DIR,['.md'])).concat(await listFilesRecursive(PAGES_DIR,['.astro']));
  files.push(...mdFiles);
  const report = { entries: [], unresolved: [] };
  for (const f of files) {
    await processFile(f, slugs, report);
  }

  // write report
  const out = path.join('scripts','fix-domain-report.json');
  await fs.mkdir('scripts',{ recursive: true });
  await fs.writeFile(out, JSON.stringify(report, null, 2), 'utf8');

  // final verification: search for reparos.com.br remaining
  const remaining = [];
  for (const f of files) {
    const txt = lf(await fs.readFile(f,'utf8'));
    if (/\breparos\.com\.br\b/i.test(txt)) remaining.push(f);
  }

  console.log(`Processed ${files.length} files.`);
  console.log(`Changes recorded: ${report.entries.length}`);
  console.log(`Unresolved absolute links: ${report.unresolved.length}`);
  if (remaining.length===0) console.log('Verification: no remaining reparos.com.br occurrences.');
  else {
    console.log('Remaining occurrences found in:', remaining);
  }
  console.log(`Detailed report written to ${out}`);
}

main().catch(e=>{ console.error(e); process.exit(1); });

