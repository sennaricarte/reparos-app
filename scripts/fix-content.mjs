#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';

const POSTS_DIR = path.join(process.cwd(), 'src', 'content', 'blog');

const FIXED_PAGES = new Set([
  'hidraulica',
  'eletrica',
  'reformas',
  'pintura',
  'pisos',
  'construcao',
  'sobre',
  'privacidade',
  'termos',
  'blog',
]);

const WHATSAPP_LINK = 'https://wa.me/5511961485763';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');

function lf(str) { return str.replace(/\r\n/g, '\n'); }

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

function stripHtmlTags(s) {
  return s.replace(/<[^>]+>/g, '');
}

function normalizeText(s) {
  return lf(stripHtmlTags(s)).replace(/\s+/g, ' ').trim();
}

/**
 * Fix anchors that split words in the HTML body.
 * Example: "d<a href=...>esentupidora</a>" -> "<a href=...>desentupidora</a>"
 * This targets cases where a letter/digit directly precedes the <a> and a letter/digit
 * directly follows the </a>, and moves those adjacent characters inside the anchor.
 */
function fixMidwordAnchors(html) {
  return html.replace(/([\p{L}\p{M}0-9])(<a\b[^>]*>)([^<]*?)<\/a>([\p{L}\p{M}0-9])/gu, (m, pre, openTag, inner, post) => {
    return `${openTag}${pre}${inner}${post}</a>`;
  });
}

async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

function findFirstP(html) {
  const m = html.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
  return m ? m[1] : null;
}

async function main() {
  console.log(`Fix content — DRY-RUN mode${APPLY ? ' (writing changes)' : ''}`);
  const files = await listMdFiles(POSTS_DIR);
  files.sort();

  const slugs = new Set(files.map(f => path.basename(f, '.md')));
  const categoryCounts = {};

  const totals = {
    categoriesChanged: 0,
    paragraphsRemoved: 0,
    internalLinksFixed: 0,
    internalLinksUnresolved: 0,
    ctaFixed: 0,
  };

  for (const file of files) {
    const raw = lf(await fs.readFile(file, 'utf8'));
    const { front, body } = extractFrontmatter(raw);
    if (!front) {
      console.warn(`Skipping ${file}: no frontmatter`);
      continue;
    }
    const frontLines = parseFrontLines(front);
    const origFrontLines = [...frontLines];

    // get title and description
    const titleLine = frontLines.find(l => /^title:\s*/i.test(l));
    const title = titleLine ? titleLine.replace(/^title:\s*/i, '').trim().replace(/^['"]|['"]$/g,'') : path.basename(file, '.md');
    const descLineIdx = frontLines.findIndex(l => /^\s*description:\s*/i.test(l));
    const description = descLineIdx > -1 ? frontLines[descLineIdx].replace(/^\s*description:\s*/i, '').trim().replace(/^['"]|['"]$/g,'') : '';

    // category change
    const catIdx = frontLines.findIndex(l => /^\s*category:\s*/i.test(l));
    let oldCategory = catIdx > -1 ? frontLines[catIdx].replace(/^\s*category:\s*/i, '').trim().replace(/^['"]|['"]$/g,'') : null;
    let categoryChanged = false;
    if (oldCategory === 'Dicas') {
      frontLines[catIdx] = `category: "Hidráulica"`;
      oldCategory = 'Hidráulica';
      categoryChanged = true;
      totals.categoriesChanged++;
    }
    const finalCategory = oldCategory || (catIdx>-1 ? oldCategory : 'Geral');
    categoryCounts[finalCategory] = (categoryCounts[finalCategory] || 0) + 1;

    let newBody = body;
    const postReport = {
      file,
      title,
      categoryChanged,
      paragraphRemoved: null,
      internalLinkChanges: [],
      internalLinkUnresolved: [],
      externalRelFlags: [],
      ctaFixed: false,
      otherBracketed: [],
    };

    // b) first paragraph removal if equals description
    const firstP = findFirstP(newBody);
    if (firstP) {
      const normFirst = normalizeText(firstP);
      const normDesc = normalizeText(description || '');
      if (normFirst && normFirst === normDesc) {
        // remove the first <p>...</p>
        const removed = newBody.replace(/<p\b[^>]*>[\s\S]*?<\/p>/i, '');
        newBody = removed;
        postReport.paragraphRemoved = normFirst.slice(0,80);
        totals.paragraphsRemoved++;
      }
    }

    // c) links internal conversion
    // fix anchors that split words (e.g. a tag injected inside a word)
    const beforeFix = newBody;
    newBody = fixMidwordAnchors(newBody);
    if (newBody !== beforeFix) {
      // count as an internal fix for reporting purposes
      postReport.internalLinkChanges.push({ before: 'midword-anchor-fix', after: 'merged' });
      // do not increment totals.internalLinksFixed here to keep separate count
    }
    
    const domainRx = /href=(["'])(https?:\/\/(?:www\.)?reparos\.app\.br)(\/[^"'>\s]*)?\1/gi;
    // iterate matches
    let m;
    while ((m = domainRx.exec(newBody)) !== null) {
      const fullMatch = m[0];
      const quote = m[1];
      const host = m[2];
      const rawPath = m[3] || '/';
      // ensure path starts with /
      let pathname = rawPath;
      // strip query and hash for matching but preserve later
      let suffix = '';
      const qIdx = pathname.indexOf('?');
      const hIdx = pathname.indexOf('#');
      let cutIdx = -1;
      if (qIdx !== -1) cutIdx = qIdx;
      if (hIdx !== -1 && (hIdx < cutIdx || cutIdx === -1)) cutIdx = hIdx;
      if (cutIdx !== -1) {
        suffix = pathname.slice(cutIdx);
        pathname = pathname.slice(0, cutIdx);
      }
      // normalize trailing
      pathname = pathname.replace(/\/+$/, ''); // remove trailing slashes for matching
      const segments = pathname.split('/').filter(Boolean); // segments without empty
      let replacement = null;
      if (!segments.length) {
        replacement = '/';
      } else if (segments.length === 1) {
        const seg = segments[0].toLowerCase();
        if (slugs.has(seg)) {
          replacement = `/blog/${seg}/`;
        } else if (FIXED_PAGES.has(seg)) {
          replacement = `/${seg}/`;
        }
      } else if (segments.length >= 2 && segments[0].toLowerCase() === 'blog') {
        const seg = segments[1].toLowerCase();
        if (slugs.has(seg)) {
          replacement = `/blog/${seg}/`;
        }
      }
      if (replacement) {
        // preserve suffix (query/hash) after trailing slash
        const newHref = `href=${quote}${replacement}${suffix}${quote}`;
        newBody = newBody.replace(fullMatch, newHref);
        postReport.internalLinkChanges.push({ before: fullMatch, after: newHref });
        totals.internalLinksFixed++;
      } else {
        postReport.internalLinkUnresolved.push(fullMatch);
        totals.internalLinksUnresolved++;
      }
    }

    // d) external links: check rel attributes for nofollow/sponsored/ugc
    const relRx = /<a\b[^>]*rel=(["'])([^"']*)\1[^>]*>/gi;
    let rm;
    while ((rm = relRx.exec(newBody)) !== null) {
      const relVal = rm[2];
      const flags = relVal.split(/\s+/).map(s=>s.toLowerCase()).filter(Boolean);
      const found = flags.filter(f => ['nofollow','sponsored','ugc'].includes(f));
      if (found.length) {
        postReport.externalRelFlags.push({ tag: rm[0], flags: found });
      }
    }

    // e) CTA broken replacement
    const ctaText = '[Clique aqui e fale com a nossa equipe pelo WhatsApp!]';
    if (newBody.includes(ctaText)) {
      const anchor = `<a href="${WHATSAPP_LINK}">Clique aqui e fale com a nossa equipe pelo WhatsApp!</a>`;
      newBody = newBody.replaceAll(ctaText, anchor);
      postReport.ctaFixed = true;
      totals.ctaFixed++;
    }

    // other bracketed texts without link (markdown-style or pure text) — pattern: [text] not followed by (
    const bracketRx = /\[([^\]]+)\](?!\()/g;
    const otherBrackets = [];
    let bm;
    while ((bm = bracketRx.exec(newBody)) !== null) {
      const txt = bm[1];
      if (txt === 'Clique aqui e fale com a nossa equipe pelo WhatsApp!') continue;
      otherBrackets.push(txt);
    }
    postReport.otherBracketed = otherBrackets;

    // assemble new file
    const newFront = joinFrontLines(frontLines);
    const newRaw = newFront + '\n' + lf(newBody).trim() + '\n';

    // idempotency: only write if different
    if (APPLY && newRaw !== raw) {
      await fs.writeFile(file, newRaw, 'utf8');
    }

    // print per-post report
    console.log('---');
    console.log(`Post: ${path.relative(process.cwd(), file)} (${title})`);
    if (postReport.categoryChanged) console.log('Categoria: alterada para Hidráulica');
    if (postReport.paragraphRemoved) console.log(`Parágrafo removido (início): ${postReport.paragraphRemoved}`);
    if (postReport.internalLinkChanges.length) {
      console.log('Links internos corrigidos:');
      for (const c of postReport.internalLinkChanges) {
        console.log(`  ${c.before}  →  ${c.after}`);
      }
    }
    if (postReport.internalLinkUnresolved.length) {
      console.log('Links internos sem destino (não alterados):');
      for (const u of postReport.internalLinkUnresolved) {
        console.log(`  ${u}`);
      }
    }
    if (postReport.externalRelFlags.length) {
      console.log('Links externos com rel flags:');
      for (const e of postReport.externalRelFlags) {
        console.log(`  ${e.tag} — flags: ${e.flags.join(',')}`);
      }
    }
    if (postReport.ctaFixed) console.log('CTA corrigido para link do WhatsApp.');
    if (postReport.otherBracketed.length) {
      console.log('Outros textos entre colchetes sem link encontrados:', postReport.otherBracketed.join('; '));
    }
  }

  // final totals and category counts
  console.log('\n=== Totais ===');
  console.log(`Categorias alteradas: ${totals.categoriesChanged}`);
  console.log(`Parágrafos removidos: ${totals.paragraphsRemoved}`);
  console.log(`Links internos corrigidos: ${totals.internalLinksFixed}`);
  console.log(`Links internos sem destino: ${totals.internalLinksUnresolved}`);
  console.log(`CTAs corrigidos: ${totals.ctaFixed}`);

  console.log('\nContagem por categoria:');
  for (const [cat, cnt] of Object.entries(categoryCounts)) {
    console.log(`  ${cat}: ${cnt}`);
  }

  console.log(`\nDone. ${APPLY ? 'Changes were written.' : 'Dry-run only; no files modified.'}`);
}

main().catch(err => { console.error(err); process.exit(1); });

