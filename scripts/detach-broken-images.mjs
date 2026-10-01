#!/usr/bin/env node
/**
 * Detect and detach broken images in src/assets/blog and posts.
 * Dry-run by default; pass --apply to modify files and move images.
 *
 * Behavior:
 * - Scans src/assets/blog/* and tests with sharp().metadata()
 * - For each post in src/content/blog/*.md:
 *   - if frontmatter image points to a broken file, remove image: and imageAlt:
 *   - if body contains markdown images linking to ../../assets/blog/X and X is broken, remove that markdown line
 * - Moves broken images to _archive/broken-images/ when --apply
 * - Writes scripts/pending-images.json with per-post needs
 */
import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';

const ROOT = process.cwd();
const ASSETS_DIR = path.join(ROOT, 'src', 'assets', 'blog');
const POSTS_DIR = path.join(ROOT, 'src', 'content', 'blog');
const ARCHIVE_DIR = path.join(ROOT, '_archive', 'broken-images');
const OUT_PENDING = path.join(ROOT, 'scripts', 'pending-images.json');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');

function lf(s) { return s.replace(/\r\n/g, '\n'); }

async function listFiles(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter(e => e.isFile()).map(e => path.join(dir, e.name));
  } catch {
    return [];
  }
}

async function findMdFiles(dir) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await findMdFiles(p)));
    else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

async function testImage(file) {
  try {
    await sharp(file).metadata();
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(d) {
  await fs.mkdir(d, { recursive: true });
}

function extractFrontmatter(raw) {
  if (!raw.startsWith('---')) return { front: null, body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return { front: null, body: raw };
  const front = raw.slice(3, end + 1);
  const body = raw.slice(end + 5);
  return { front, body };
}

function parseFrontLines(front) {
  return lf(front).split('\n').filter(Boolean);
}

function joinFrontLines(lines) {
  return '---\n' + lines.join('\n') + '\n---\n';
}

async function main() {
  console.log(`Detect broken images — DRY-RUN mode${APPLY ? ' (applying changes)' : ''}`);
  const files = await listFiles(ASSETS_DIR);
  const broken = new Set();
  for (const f of files) {
    const ok = await testImage(f).catch(()=>false);
    if (!ok) broken.add(path.basename(f));
  }

  if (!broken.size) {
    console.log('No broken images detected in', ASSETS_DIR);
  } else {
    console.log('Broken images:', [...broken].join(', '));
  }

  const mdFiles = await findMdFiles(POSTS_DIR);
  const pending = [];
  const report = [];

  for (const md of mdFiles) {
    const raw = lf(await fs.readFile(md, 'utf8'));
    const { front, body } = extractFrontmatter(raw);
    if (!front) continue;
    const frontLines = parseFrontLines(front);
    const origFrontLines = [...frontLines];
    const changes = { removedFront: [], removedInline: [] };

    // frontmatter image: pattern image: "../../assets/blog/X.jpg" or image: "../../assets/blog/X"
    for (let i = 0; i < frontLines.length; i++) {
      const m = frontLines[i].match(/^\s*image:\s*["']?(?:\.\.\/\.\.\/assets\/blog\/)?([^"'\s]+)["']?\s*$/i);
      if (m) {
        const filename = m[1];
        if (broken.has(filename)) {
          // remove image line
          frontLines.splice(i,1);
          changes.removedFront.push(`image: ${filename}`);
          i--;
          // remove imageAlt if follows anywhere
          const altIdx = frontLines.findIndex(l => /^\s*imageAlt:\s*/i.test(l));
          if (altIdx !== -1) {
            changes.removedFront.push(frontLines[altIdx].trim());
            frontLines.splice(altIdx,1);
          }
        }
      }
    }

    // process body: remove markdown image lines referencing ../../assets/blog/X
    const lines = lf(body).split('\n');
    const newLines = [];
    let removedInlineCount = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const m = line.match(/!\[.*?\]\(\s*(?:\.\.\/\.\.\/assets\/blog\/)?([^)\s]+)\s*\)/i);
      if (m && broken.has(m[1])) {
        changes.removedInline.push(m[1]);
        removedInlineCount++;
        // skip this line; also skip extra blank lines that would create multiple blanks
        // remove following blank lines
        while (i+1 < lines.length && lines[i+1].trim() === '') i++;
        continue;
      } else {
        newLines.push(line);
      }
    }

    const newBody = newLines.join('\n').replace(/\n{3,}/g, '\n\n');

    // if any change, write file when APPLY
    const newRaw = joinFrontLines(frontLines) + newBody;
    const slug = path.basename(md, '.md');
    const titleLine = origFrontLines.find(l => /^title:\s*/i.test(l)) || '';
    const title = titleLine.replace(/^title:\s*/i,'').trim().replace(/^['"]|['"]$/g,'') || slug;
    const categoryLine = origFrontLines.find(l => /^\s*category:\s*/i.test(l)) || '';
    const category = categoryLine ? categoryLine.replace(/^\s*category:\s*/i,'').trim().replace(/^['"]|['"]$/g,'') : null;

    const needsCover = changes.removedFront.length > 0;
    const needsInline = removedInlineCount;

    if (changes.removedFront.length || changes.removedInline.length) {
      report.push({ file: md, slug, title, category, removedFront: changes.removedFront, removedInline: changes.removedInline });
      if (APPLY) {
        await fs.writeFile(md, newRaw, 'utf8');
      }
    }

    pending.push({ slug, title, category, needsCover, needsInline });
  }

  // move broken images to archive
  if (broken.size) {
    await ensureDir(ARCHIVE_DIR);
    for (const name of broken) {
      const src = path.join(ASSETS_DIR, name);
      const dest = path.join(ARCHIVE_DIR, name);
      // idempotent: if src doesn't exist, skip; if dest exists, skip move
      try {
        await fs.access(src);
        try {
          await fs.access(dest);
          // already moved
        } catch {
          if (APPLY) {
            await fs.rename(src, dest);
          }
        }
      } catch {
        // src missing - maybe already moved
      }
    }
  }

  // write pending JSON
  if (APPLY) {
    await ensureDir(path.dirname(OUT_PENDING));
    await fs.writeFile(OUT_PENDING, JSON.stringify(pending, null, 2), 'utf8');
  } else {
    // always write dry-run preview
    await ensureDir(path.dirname(OUT_PENDING));
    await fs.writeFile(OUT_PENDING + '.dryrun', JSON.stringify(pending, null, 2), 'utf8');
  }

  // report
  console.log('\nPer-post removals:');
  for (const r of report) {
    console.log(`- ${r.slug}: removed front [${r.removedFront.join(', ')}], inline [${r.removedInline.join(', ')}]`);
  }
  console.log(`\nTotals: posts modified: ${report.length}, broken images detected: ${broken.size}`);
  console.log(`Pending list written to ${APPLY ? OUT_PENDING : OUT_PENDING + '.dryrun'}`);
  if (APPLY && broken.size) {
    console.log(`Moved broken images to ${ARCHIVE_DIR}`);
  } else if (!APPLY && broken.size) {
    console.log(`Dry-run: run with --apply to move files to ${ARCHIVE_DIR}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });

