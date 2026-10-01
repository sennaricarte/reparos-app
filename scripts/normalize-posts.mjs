#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
const POSTS_DIR = path.join(process.cwd(), 'src', 'content', 'blog');
const ASSETS_DIR = path.join(process.cwd(), 'src', 'assets', 'blog');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');

function lf(str) {
  return str.replace(/\r\n/g, '\n');
}

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

function escapeRegex(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function extractFrontmatter(raw) {
  if (!raw.startsWith('---')) return { front: null, body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return { front: null, body: raw };
  const front = raw.slice(3, end + 1); // include trailing newline
  const body = raw.slice(end + 5); // skip '---\n'
  return { front, body };
}

function parseFrontLines(front) {
  const lines = lf(front).split('\n').filter(Boolean);
  return lines;
}

function joinFrontLines(lines) {
  return '---\n' + lines.join('\n') + '\n---\n';
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function findFirstP(html) {
  const m = html.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
  return m ? m[1].replace(/<[^>]+>/g, '').trim() : null;
}

function sentenceContaining(text, rx) {
  const idx = text.search(rx);
  if (idx === -1) return null;
  // find sentence boundaries
  const start = Math.max(text.lastIndexOf('.', idx), text.lastIndexOf('!', idx), text.lastIndexOf('?', idx), 0);
  const endCandidates = [text.indexOf('.', idx), text.indexOf('!', idx), text.indexOf('?', idx)].filter(i=>i>-1);
  const end = endCandidates.length ? Math.min(...endCandidates) : Math.min(text.length, idx + 200);
  return text.slice(start===-1?0:start+1, end===-1?text.length:end).trim();
}

async function main() {
  console.log(`Normalize posts — DRY-RUN mode${APPLY ? ' (writing changes)' : ''}`);
  const files = await listMdFiles(POSTS_DIR);
  files.sort();

  const coverMap = new Map(); // filename -> [posts]
  const internalMap = new Map(); // filename -> [posts]
  const categories = {};

  const perPostReports = [];

  for (const file of files) {
    const raw = lf(await fs.readFile(file, 'utf8'));
    const { front, body } = extractFrontmatter(raw);
    if (!front) {
      console.warn(`Skipping ${file}: no frontmatter`);
      continue;
    }
    const frontLines = parseFrontLines(front);
    const origFrontLines = [...frontLines];
    // find title
    const titleLine = frontLines.find(l => /^title:\s*/i.test(l));
    const title = titleLine ? titleLine.replace(/^title:\s*/i, '').trim().replace(/^['"]|['"]$/g,'') : path.basename(file, '.md');

    // process image in frontmatter: image: "/images/blog/X.jpg" -> ../../assets/blog/X.jpg
    let coverFilename = null;
    for (let i = 0; i < frontLines.length; i++) {
      const line = frontLines[i];
      if (/^\s*layout:\s*/i.test(line)) {
        // remove layout line
        frontLines.splice(i,1);
        i--;
        continue;
      }
      const m = line.match(/^\s*image:\s*(["']?)(\/images\/blog\/([^"'\s]+))\1\s*$/i);
      if (m) {
        const origPath = m[2];
        const filename = m[3];
        coverFilename = filename;
        const newPath = `../../assets/blog/${filename}`;
        frontLines[i] = `image: "${newPath}"`;
        const assetPath = path.join(ASSETS_DIR, filename);
        const exists = await fileExists(assetPath);
        if (!coverMap.has(filename)) coverMap.set(filename, []);
        coverMap.get(filename).push(file);
        if (!exists) {
          // mark missing; we'll report later
        }
      }
    }

    // process body: single-line HTML
    let newBody = body;

    // find all img tags with /images/blog/Y.jpg
    const imgRegex = /<img\b[^>]*\bsrc=(?:["']?)(\/images\/blog\/([^"'\s>]+))(?:["']?)[^>]*>/gi;
    const matches = [...newBody.matchAll(imgRegex)];
    const internalImagesFound = [];
    for (const m of matches) {
      const full = m[0];
      const rel = m[1];
      const filename = m[2];
      internalImagesFound.push({ full, filename, index: m.index });
      if (!internalMap.has(filename)) internalMap.set(filename, []);
      internalMap.get(filename).push(file);
    }

    const conversions = [];
    const removals = [];

    // Helper to remove parent if it only contains the img
    function removeImgOrParent(html, imgTag) {
      // pattern for parent p, figure, div containing only whitespace and the img tag
      const parentRegex = new RegExp(`<(p|figure|div)[^>]*>\\s*${escapeRegex(imgTag)}\\s*<\\/\\1>`, 'i');
      if (parentRegex.test(html)) {
        return html.replace(parentRegex, '');
      }
      // otherwise just remove imgTag
      return html.replace(imgTag, '');
    }

    // process each internal image occurrence
    for (const occ of internalImagesFound) {
      const { full, filename } = occ;
      const assetPath = path.join(ASSETS_DIR, filename);
      const assetExists = await fileExists(assetPath);
      if (!assetExists) {
        conversions.push({ filename, type: 'missing' });
        // still attempt replacement to the new relative path
      }
      if (coverFilename && filename === coverFilename) {
        // remove the img (and parent if it becomes empty)
        newBody = removeImgOrParent(newBody, full);
        removals.push({ filename, reason: 'duplicate-cover' });
      } else {
        // replace img (or img parent if it only contains img) with markdown paragraph on its own
        const md = `\n\n![${title}](../../assets/blog/${filename})\n\n`;
        // parent that contains only img
        const parentRegex = new RegExp(`<(p|figure|div)[^>]*>\\s*${escapeRegex(full)}\\s*<\\/\\1>`, 'i');
        if (parentRegex.test(newBody)) {
          newBody = newBody.replace(parentRegex, md);
        } else {
          // replace just the img tag with the markdown (but ensure surrounding tags remain valid)
          newBody = newBody.replace(full, md);
        }
        conversions.push({ filename, type: 'converted' });
      }
    }

    // normalize line endings to LF
    newBody = lf(newBody).trim();
    // ensure body starts and ends with a single newline
    newBody = '\n' + newBody + '\n';

    // reassemble frontmatter preserving other fields (we already removed layout and updated image line)
    const newFront = joinFrontLines(frontLines);
    const newRaw = newFront + newBody;

    // checks for report
    const report = {
      file,
      title,
      cover: { filename: coverFilename, status: 'ok', posts: coverMap.get(coverFilename) || [] },
      internal: { conversions, removals },
      firstPMatchesDescription: false,
      bracketedText: [],
      claims: [],
      category: null,
    };

    // cover status
    if (coverFilename) {
      const assetPath = path.join(ASSETS_DIR, coverFilename);
      if (!(await fileExists(assetPath))) {
        report.cover.status = 'arquivo ausente';
      } else if ((coverMap.get(coverFilename) || []).length > 1) {
        report.cover.status = 'capa compartilhada';
        report.cover.posts = coverMap.get(coverFilename);
      } else {
        report.cover.status = 'ok';
      }
    } else {
      report.cover.status = 'sem capa';
    }

    // first <p> equals description?
    const firstP = findFirstP(body || '');
    // find description in frontLines
    const descLine = frontLines.find(l => /^\s*description:\s*/i.test(l));
    const desc = descLine ? descLine.replace(/^\s*description:\s*/i, '').trim().replace(/^['"]|['"]$/g,'') : null;
    report.firstPMatchesDescription = desc && firstP && desc === firstP;

    // bracketed text without link
    const bracketRx = /\[[^\]]+\](?!\()/g;
    const bracketMatches = (body || '').match(bracketRx);
    if (bracketMatches) report.bracketedText = bracketMatches;

    // claims
    const claimRx = /(desde\s+\d{4})|(\d+(?:\.\d{3})*\s*clientes)|(\d+%)/i;
    const claimMatch = (body || '').match(claimRx);
    if (claimMatch) {
      const sentence = sentenceContaining(body, claimRx);
      report.claims.push(sentence || claimMatch[0]);
    }

    // extract category
    const catLine = frontLines.find(l => /^\s*category:\s*/i.test(l));
    const category = catLine ? catLine.replace(/^\s*category:\s*/i, '').trim().replace(/^['"]|['"]$/g,'') : 'Geral';
    report.category = category;
    categories[category] = (categories[category] || 0) + 1;

    perPostReports.push(report);

    if (APPLY) {
      // write the file back
      await fs.writeFile(file, newRaw, 'utf8');
    }
  }

  // after processing all files, build shared-image reports
  // convert maps to arrays for reporting
  console.log('\nReport per post:\n');
  for (const r of perPostReports) {
    console.log(`---\nPost: ${path.relative(process.cwd(), r.file)} (${r.title})`);
    console.log(`Capa: ${r.cover.status}${r.cover.status === 'capa compartilhada' ? ' — compartilhada com: ' + (r.cover.posts || []).map(p=>path.basename(p)).join(', ') : ''}`);
    if (r.internal.conversions.length) {
      const conv = r.internal.conversions.map(c=>`${c.filename} (${c.type})`).join(', ');
      console.log(`Imagens internas: ${conv}`);
    } else {
      console.log('Imagens internas: nenhuma encontrada');
    }
    if (r.internal.removals.length) {
      console.log(`Imagens removidas por duplicar capa: ${r.internal.removals.map(x=>x.filename).join(', ')}`);
    }
    console.log(`Primeiro <p> igual à description: ${r.firstPMatchesDescription ? 'sim' : 'não'}`);
    if (r.bracketedText.length) {
      console.log('Texto entre colchetes sem link encontrado:', r.bracketedText.join('; '));
    }
    if (r.claims.length) {
      console.log('Trechos com números/alegações para revisão:', r.claims.join(' | '));
    }
  }

  console.log('\nImagens usadas em múltiplos posts (capas):');
  for (const [img, posts] of coverMap.entries()) {
    if (posts.length > 1) {
      console.log(`${img}: ${posts.map(p=>path.basename(p)).join(', ')}`);
    }
  }
  console.log('\nImagens usadas em múltiplos posts (internas):');
  for (const [img, posts] of internalMap.entries()) {
    if (posts.length > 1) {
      console.log(`${img}: ${posts.map(p=>path.basename(p)).join(', ')}`);
    }
  }

  console.log('\nCategorias encontradas:');
  for (const [cat, cnt] of Object.entries(categories)) {
    console.log(`${cat}: ${cnt}`);
  }

  console.log(`\nDone. ${APPLY ? 'Changes were written.' : 'Dry-run only; no files modified.'}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

