#!/usr/bin/env node
/**
 * scripts/apply-by-url.mjs
 *
 * Apply images for a hardcoded list of posts using Pexels photo IDs.
 * Node ESM, uses only sharp (assumed installed) and built-in Node APIs.
 *
 * Behavior:
 * - For each entry: fetch photo details, download src.large2x, convert with sharp to JPEG 1200px@82, save to src/assets/blog/{slug}-featured.jpg
 * - If target file exists and sharp can read it, skip (idempotent)
 * - Update post frontmatter: add image and imageAlt (if absent)
 * - Insert credit paragraph before last CTA <p> containing "WhatsApp" or "orçamento" (case-insensitive); otherwise append
 * - Report downloaded, skipped, failed with real error messages (do not print PEXELS_API_KEY)
 */

import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';

const PEXELS_KEY = process.env.PEXELS_API_KEY;
if (!PEXELS_KEY) {
  console.warn('Aviso: variável de ambiente PEXELS_API_KEY não encontrada. As requisições à API Pexels irão falhar sem a chave.');
}

const ASSETS_DIR = path.resolve(process.cwd(), 'src', 'assets', 'blog');
const CONTENT_DIR = path.resolve(process.cwd(), 'src', 'content', 'blog');

const LIST = [
  { slug: 'desentupidora-em-osasco-sp', coverId: 36842620, category: 'Hidráulica' },
  { slug: 'desentupidora-na-freguesia-do-o', coverId: 27821436, category: 'Hidráulica' },
  { slug: 'desentupidora-vinhedo-sp', coverId: 13602150, category: 'Hidráulica' },
  { slug: 'manutencao-preventiva-de-canos', coverId: 33546826, category: 'Hidráulica' },
  { slug: 'o-que-faz-um-bombeiro-hidraulico', coverId: 675987, category: 'Hidráulica' },
  { slug: 'problemas-comuns-em-encanamentos', coverId: 30478420, category: 'Hidráulica' },
];

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function findPostFileBySlug(slug) {
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        const found = await walk(full);
        if (found) return found;
      } else if (ent.isFile()) {
        const base = path.parse(ent.name).name;
        if (base === slug) return full;
      }
    }
    return null;
  }
  return await walk(CONTENT_DIR);
}

async function fetchJson(url) {
  const headers = PEXELS_KEY ? { Authorization: PEXELS_KEY } : {};
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return await res.json();
}

async function downloadToBuffer(url) {
  const headers = PEXELS_KEY ? { Authorization: PEXELS_KEY } : {};
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
}

async function processEntry(entry, report) {
  const { slug, coverId, category } = entry;
  const outName = `${slug}-featured.jpg`;
  const outPath = path.join(ASSETS_DIR, outName);

  try {
    // skip if exists and is valid
    if (await fileExists(outPath)) {
      try {
        await sharp(outPath).metadata();
        report.skipped.push({ slug, reason: 'já existe e válida', path: outPath });
        return;
      } catch {
        // corrupted -> continue to re-download
      }
    }

    // fetch photo details
    const photoUrl = `https://api.pexels.com/v1/photos/${coverId}`;
    let photoData;
    try {
      photoData = await fetchJson(photoUrl);
    } catch (err) {
      report.failed.push({ slug, reason: 'fetch photo details failed', error: String(err) });
      return;
    }

    const srcUrl = photoData?.src?.large2x ?? photoData?.src?.large ?? photoData?.src?.original;
    const photographer = photoData?.photographer ?? 'Fotógrafo';
    const photographerUrl = photoData?.photographer_url ?? photoData?.url ?? '';
    if (!srcUrl) {
      report.failed.push({ slug, reason: 'no src.large2x in photo data' });
      return;
    }

    // download image buffer
    let buf;
    try {
      buf = await downloadToBuffer(srcUrl);
    } catch (err) {
      report.failed.push({ slug, reason: 'download failed', error: String(err) });
      return;
    }

    // process with sharp
    try {
      await fs.mkdir(ASSETS_DIR, { recursive: true });
      await sharp(buf).resize({ width: 1200, withoutEnlargement: true }).jpeg({ quality: 82 }).toFile(outPath);
    } catch (err) {
      report.failed.push({ slug, reason: 'sharp processing failed', error: String(err) });
      return;
    }

    // update frontmatter
    try {
      const postFile = await findPostFileBySlug(slug);
      if (!postFile) {
        report.failed.push({ slug, reason: 'post file not found' });
        return;
      }
      let txt = await fs.readFile(postFile, 'utf8');
      const fmMatch = txt.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      if (!fmMatch) {
        report.failed.push({ slug, reason: 'frontmatter not found' });
        return;
      }
      const fm = fmMatch[1];
      let body = fmMatch[2];

      const relPath = `../../assets/blog/${outName}`;
      // add image and imageAlt if absent
      let newFm = fm;
      if (!/^\s*image\s*:/m.test(fm)) {
        newFm = fm + `\nimage: "${relPath}"\nimageAlt: "Foto de serviço de ${category} — ${photographer} via Pexels"`;
      } else if (!/^\s*imageAlt\s*:/m.test(fm)) {
        newFm = fm.replace(/\n$/, '') + `\nimageAlt: "Foto de serviço de ${category} — ${photographer} via Pexels"`;
      }

      // credit paragraph
      const creditHtml = `<p class="text-xs text-gray-500">Foto: <a href="${escapeHtml(photographerUrl || '#')}">${escapeHtml(photographer)}</a> via <a href="https://www.pexels.com">Pexels</a></p>`;
      if (!body.includes(creditHtml)) {
        const ctaRegex = /(<p[^>]*>[\s\S]*?(?:WhatsApp|orçamento|Orçamento)[\s\S]*?<\/p>)(?![\s\S]*<p[^>]*>[\s\S]*(?:WhatsApp|orçamento|Orçamento)[\s\S]*<\/p>)/i;
        if (ctaRegex.test(body)) {
          // insert before the matched last CTA
          body = body.replace(ctaRegex, (m) => `${creditHtml}\n\n${m}`);
        } else {
          body = `${body}\n\n${creditHtml}\n`;
        }
      }

      const newTxt = `---\n${newFm}\n---\n${body}`;
      await fs.writeFile(postFile, newTxt, 'utf8');
    } catch (err) {
      report.failed.push({ slug, reason: 'updating post failed', error: String(err) });
      return;
    }

    report.downloaded.push({ slug, path: outPath });
  } catch (err) {
    report.failed.push({ slug, reason: 'unexpected', error: String(err) });
  }
}

async function main() {
  const report = { downloaded: [], skipped: [], failed: [] };
  for (const entry of LIST) {
    // eslint-disable-next-line no-await-in-loop
    await processEntry(entry, report);
  }

  console.log('\nRelatório final:');
  console.log('Baixadas com sucesso:', report.downloaded.length);
  console.log('Puladas (já existiam):', report.skipped.length);
  console.log('Falhas:', report.failed.length);
  if (report.failed.length) {
    console.log('Detalhes das falhas:');
    for (const f of report.failed) {
      console.log('-', f.slug, '→', f.reason, f.error ? `: ${f.error}` : '');
    }
  }
}

main().catch((err) => {
  console.error('Erro inesperado:', err);
  process.exitCode = 1;
});

