#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';

const POSTS_DIR = path.join(process.cwd(), 'src', 'content', 'blog');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');

function lf(s) { return s.replace(/\r\n/g, '\n'); }

async function listMdFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      files.push(...(await listMdFiles(full)));
    } else if (e.isFile() && e.name.endsWith('.md')) {
      files.push(full);
    }
  }
  return files;
}

function findFrontBoundary(raw) {
  if (!raw.startsWith('---')) return -1;
  const idx = raw.indexOf('\n---', 3);
  return idx;
}

// parse attributes in an HTML tag, preserving order
function parseAttrs(attrString) {
  const attrs = [];
  const rx = /([^\s=\/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = rx.exec(attrString)) !== null) {
    const name = m[1];
    const value = m[2] ?? m[3] ?? m[4] ?? null;
    attrs.push({ name, value });
  }
  return attrs;
}

function buildAttr(name, value) {
  if (value === null || value === undefined) return name;
  // escape double quotes
  const v = String(value).replace(/"/g, '&quot;');
  return `${name}="${v}"`;
}

function isInternalHref(href) {
  return href.startsWith('/') || href.startsWith('#');
}

function isExternalHref(href) {
  const low = href.toLowerCase();
  return low.startsWith('http://') || low.startsWith('https://') || low.includes('wa.me');
}

async function processFile(file) {
  const rawBuf = await fs.readFile(file);
  let raw = rawBuf.toString('utf8');
  // find frontmatter boundary and preserve front byte-for-byte
  const end = findFrontBoundary(raw);
  let frontRaw = '';
  let body = raw;
  if (end !== -1) {
    const cut = end + 5; // include '\n---\n' (4 or 5 chars? using 5 to include newline)
    // Find exact closing delimiter position including the newline after ---
    // Adjust: locate the position of '\n---' and then the following newline
    const closingIdx = raw.indexOf('\n---', 3);
    const after = raw.indexOf('\n', closingIdx + 1);
    const sliceEnd = after === -1 ? (closingIdx + 4) : (after + 1);
    frontRaw = raw.slice(0, sliceEnd);
    body = raw.slice(sliceEnd);
  } else {
    // no frontmatter, operate on whole file as body
    frontRaw = '';
    body = raw;
  }

  const originalBody = body;
  let newBody = lf(body);

  const aOpenRx = /<a\b([^>]*)>/gi;
  const changes = [];
  let internalCleaned = 0;
  let externalAdjusted = 0;

  let m;
  // collect matches first to avoid issues with modifying string while iterating with regex
  const matches = [];
  while ((m = aOpenRx.exec(newBody)) !== null) {
    matches.push({ index: m.index, full: m[0], attrs: m[1] });
  }

  for (const match of matches) {
    const fullTag = match.full;
    const attrString = match.attrs || '';
    const attrs = parseAttrs(attrString);
    const attrMap = new Map(attrs.map(a => [a.name.toLowerCase(), a]));
    if (!attrMap.has('href')) continue;
    const hrefRaw = attrMap.get('href').value ?? '';
    const href = String(hrefRaw);
    const isInternal = isInternalHref(href);
    const isExternal = isExternalHref(href);

    if (!isInternal && !isExternal) {
      // neither internal nor external per rules; skip
      continue;
    }

    // build new attrs according to spec
    const newAttrs = [];
    if (isInternal) {
      // keep href first
      newAttrs.push({ name: 'href', value: hrefRaw });
      // then title if present
      if (attrMap.has('title')) newAttrs.push({ name: 'title', value: attrMap.get('title').value });
      // then aria-* and data-* in original order
      for (const a of attrs) {
        const lname = a.name.toLowerCase();
        if (lname.startsWith('aria-') || lname.startsWith('data-')) {
          // avoid duplicating href/title already included
          if (lname === 'href' || lname === 'title') continue;
          newAttrs.push({ name: a.name, value: a.value });
        }
      }
    } else {
      // external: href, target, rel, then title, aria-*, data-*
      newAttrs.push({ name: 'href', value: hrefRaw });
      newAttrs.push({ name: 'target', value: '_blank' });
      newAttrs.push({ name: 'rel', value: 'noopener' });
      if (attrMap.has('title')) newAttrs.push({ name: 'title', value: attrMap.get('title').value });
      for (const a of attrs) {
        const lname = a.name.toLowerCase();
        if (lname.startsWith('aria-') || lname.startsWith('data-')) {
          newAttrs.push({ name: a.name, value: a.value });
        }
      }
    }

    const newTag = `<a${newAttrs.length ? ' ' + newAttrs.map(a => buildAttr(a.name, a.value)).join(' ') : ''}>`;
    if (newTag !== fullTag) {
      // replace only the first occurrence at or after match.index to avoid accidental global replacements
      const before = newBody.slice(0, match.index);
      const after = newBody.slice(match.index);
      const replaced = after.replace(fullTag, newTag);
      newBody = before + replaced;
      changes.push({ before: fullTag, after: newTag });
      if (isInternal) internalCleaned++;
      if (isExternal) externalAdjusted++;
    }
  }

  const changed = changes.length > 0;
  let outRaw = frontRaw + newBody;
  // ensure LF line endings
  outRaw = lf(outRaw);

  return {
    file,
    changed,
    changes,
    internalCleaned,
    externalAdjusted,
    outRaw,
    originalBody,
  };
}

async function main() {
  console.log(`Fix anchors — DRY-RUN mode${APPLY ? ' (writing changes)' : ''}`);
  const files = await listMdFiles(POSTS_DIR);
  files.sort();

  let totalPostsChanged = 0;
  let totalInternalCleaned = 0;
  let totalExternalAdjusted = 0;
  const perPostReports = [];

  for (const f of files) {
    const res = await processFile(f);
    if (res.changed) {
      totalPostsChanged++;
      totalInternalCleaned += res.internalCleaned;
      totalExternalAdjusted += res.externalAdjusted;
      perPostReports.push(res);
      if (APPLY) {
        // write file preserving frontmatter bytes and using LF for body
        await fs.writeFile(f, res.outRaw, 'utf8');
      }
    }
  }

  // print per-post reports
  for (const r of perPostReports) {
    console.log('---');
    console.log(`Post: ${path.relative(process.cwd(), r.file)}`);
    for (const c of r.changes) {
      console.log(`  ${c.before}  →  ${c.after}`);
    }
  }

  // final checks: ensure no resulting <a> contains disallowed attrs
  const violationRx = /<a\b[^>]*(?:\bnofollow\b|\bnoreferrer\b|\bsponsored\b|\bclass\s*=)/i;
  const violations = [];
  for (const f of files) {
    const txt = (await fs.readFile(f, 'utf8'));
    if (violationRx.test(txt)) {
      violations.push(path.relative(process.cwd(), f));
    }
  }

  console.log('\n=== Totals ===');
  console.log(`Posts altered: ${totalPostsChanged}`);
  console.log(`Links internos limpos: ${totalInternalCleaned}`);
  console.log(`Links externos ajustados: ${totalExternalAdjusted}`);
  if (violations.length === 0) {
    console.log('Verificação final: sem <a> com nofollow/noreferrer/sponsored ou class=');
  } else {
    console.log('Verificação final: problemas encontrados em:');
    for (const v of violations) console.log(`  ${v}`);
  }

  console.log(`\nDone. ${APPLY ? 'Changes were written.' : 'Dry-run only; no files modified.'}`);
}

main().catch(err => { console.error(err); process.exit(1); });

