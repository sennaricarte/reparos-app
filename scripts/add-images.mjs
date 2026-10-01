#!/usr/bin/env node
/**
 * scripts/add-images.mjs
 *
 * Node ESM script to assist with selecting and applying cover images from Pexels.
 * - Default mode (curation): interactive selection from search results, writes scripts/image-choices.json
 * - --apply mode: downloads chosen images, processes with sharp, updates post frontmatter and appends credit
 *
 * Restrictions and guarantees:
 * - Uses only built-in Node APIs + sharp (assumed installed)
 * - Never logs the PEXELS_API_KEY
 * - Never overwrites an already-valid image file
 * - Idempotent: running multiple times won't duplicate work
 */

import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import path from 'path';
import readline from 'readline';
import sharp from 'sharp';

const ROOT = new URL('../', import.meta.url); // scripts/
const PROJECT_ROOT = path.resolve(new URL('../', import.meta.url).pathname, '..');
const PENDING_PATH = path.resolve(process.cwd(), 'scripts', 'pending-images.json');
const CHOICES_PATH = path.resolve(process.cwd(), 'scripts', 'image-choices.json');
const ASSETS_DIR = path.resolve(process.cwd(), 'src', 'assets', 'blog');
const CONTENT_DIR = path.resolve(process.cwd(), 'src', 'content', 'blog');
const PEXELS_KEY = process.env.PEXELS_API_KEY;

if (!PEXELS_KEY) {
  // Do not reveal the key; just warn user.
  console.warn('Aviso: variável de ambiente PEXELS_API_KEY não encontrada. Modo de curadoria mostrará URLs (mas buscas falharão sem chave).');
}

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');

async function safeReadJSON(p) {
  try {
    const txt = await fs.readFile(p, 'utf8');
    return JSON.parse(txt);
  } catch (err) {
    return null;
  }
}

async function safeWriteJSON(p, obj) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj, null, 2), 'utf8');
}

async function fetchPexels(url) {
  const headers = PEXELS_KEY ? { Authorization: PEXELS_KEY } : {};
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`Pexels API retornou ${res.status} ${res.statusText}`);
  }
  return await res.json();
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

async function modeCuration() {
  const pending = await safeReadJSON(PENDING_PATH);
  if (!pending) {
    console.error(`Arquivo de pending não encontrado em ${PENDING_PATH}`);
    process.exitCode = 1;
    return;
  }

  const choices = (await safeReadJSON(CHOICES_PATH)) || {};

  const pendentesInline = [];

  for (const item of pending) {
    const { slug, title, category, needsCover = false, needsInline = 0 } = item;
    if (!needsCover) {
      if (needsInline && needsInline > 0) pendentesInline.push(item);
      continue;
    }

    console.log(`\n=== ${slug} (${category}) ===`);
    console.log(`Título: ${title}`);

    const query = encodeURIComponent(`${category} ${title}`);
    const url = `https://api.pexels.com/v1/search?query=${query}&per_page=5&orientation=landscape`;
    let data;
    try {
      data = await fetchPexels(url);
    } catch (err) {
      console.error('Erro buscando Pexels:', err.message);
      continue;
    }

    const photos = data.photos || [];
    if (!photos.length) {
      console.log('Nenhuma foto encontrada para essa query.');
      continue;
    }

    for (let i = 0; i < photos.length; i++) {
      const p = photos[i];
      const w = p.width || '?';
      const h = p.height || '?';
      const src = p.src?.original ?? p.src?.large ?? p.src?.large2x ?? 'sem-url';
      const photographer = p.photographer ?? 'Desconhecido';
      console.log(`${i + 1}) ${src} (${w}x${h}) — ${photographer}`);
    }

    let ans = await prompt('Escolha (1-5, s para pular): ');
    if (!ans) ans = 's';
    if (ans.toLowerCase() === 's') {
      console.log('Pulando...');
      continue;
    }
    const idx = parseInt(ans, 10) - 1;
    if (Number.isNaN(idx) || idx < 0 || idx >= photos.length) {
      console.log('Escolha inválida — pulando.');
      continue;
    }

    const chosen = photos[idx];
    choices[slug] = {
      coverId: chosen.id,
      coverUrl: chosen.src?.original ?? chosen.src?.large2x ?? chosen.src?.large ?? '',
      photographer: chosen.photographer ?? '',
      photographerUrl: chosen.photographer_url ?? chosen.url ?? '',
    };

    console.log(`Escolhido: ${choices[slug].coverUrl} — ${choices[slug].photographer}`);
    await safeWriteJSON(CHOICES_PATH, choices);
  }

  if (pendentesInline.length) {
    console.log('\nPosts pendentes de imagem interna (não pesquisados automaticamente):');
    for (const p of pendentesInline) {
      console.log(`- ${p.slug} (${p.title}) precisa de ${p.needsInline} imagens internas.`);
    }
  }

  console.log(`\nEscolhas salvas em ${CHOICES_PATH}`);
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function findPostFileBySlug(slug) {
  // search recursively in CONTENT_DIR for a file whose basename without extension matches slug
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

async function downloadToStream(url, destPath) {
  const res = await fetch(url, { headers: PEXELS_KEY ? { Authorization: PEXELS_KEY } : {} });
  if (!res.ok) throw new Error(`Download failed ${res.status} ${res.statusText}`);
  // read as arrayBuffer then write atomically to file (avoid streaming issues on some platforms)
  const ab = await res.arrayBuffer();
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await fs.writeFile(destPath, Buffer.from(ab));
}

async function modeApply() {
  const choices = await safeReadJSON(CHOICES_PATH);
  if (!choices) {
    console.error(`Nenhum arquivo de escolhas encontrado em ${CHOICES_PATH}`);
    process.exitCode = 1;
    return;
  }

  const report = { downloaded: [], skipped: [], failed: [] };

  for (const [slug, info] of Object.entries(choices)) {
    try {
      const postFile = await findPostFileBySlug(slug);
      if (!postFile) {
        report.failed.push({ slug, reason: 'post file not found' });
        continue;
      }

      // query photo details to find src.large2x
      const photoUrl = `https://api.pexels.com/v1/photos/${info.coverId}`;
      let photoData;
      try {
        photoData = await fetchPexels(photoUrl);
      } catch (err) {
        report.failed.push({ slug, reason: 'failed to fetch photo details', error: String(err) });
        continue;
      }
      const srcUrl = photoData.src?.large2x ?? photoData.src?.large ?? photoData.src?.original;
      if (!srcUrl) {
        report.failed.push({ slug, reason: 'no suitable src in photo data' });
        continue;
      }

      const outName = `${slug}-featured.jpg`;
      const outPath = path.join(ASSETS_DIR, outName);

      // if image exists and is valid, skip
      if (await fileExists(outPath)) {
        try {
          await sharp(outPath).metadata();
          report.skipped.push({ slug, reason: 'already exists and valid', path: outPath });
          continue;
        } catch (err) {
          // fallthrough to re-download if corrupted
          console.warn(`Arquivo existente corrompido, rebaixando: ${outPath}`);
        }
      }

      // download to a temporary path
      const tmpPath = outPath + '.tmp';
      try {
        await downloadToStream(srcUrl, tmpPath);
      } catch (err) {
        // Temporarily log the real error to help debugging (do not print the PEXELS_API_KEY)
        console.error('Download error for', slug, ':', err);
        report.failed.push({ slug, reason: 'download failed', error: String(err) });
        // cleanup tmp if exists
        try { await fs.unlink(tmpPath); } catch {}
        continue;
      }

      // validate with sharp
      try {
        await sharp(tmpPath).metadata();
      } catch (err) {
        report.failed.push({ slug, reason: 'sharp failed to read downloaded image', error: String(err) });
        try { await fs.unlink(tmpPath); } catch {}
        continue;
      }

      // resize and convert to jpeg quality 82, max width 1200
      try {
        await fs.mkdir(ASSETS_DIR, { recursive: true });
        await sharp(tmpPath)
          .resize({ width: 1200, withoutEnlargement: true })
          .jpeg({ quality: 82 })
          .toFile(outPath);
        await fs.unlink(tmpPath).catch(() => {});
      } catch (err) {
        report.failed.push({ slug, reason: 'sharp processing failed', error: String(err) });
        try { await fs.unlink(tmpPath); } catch {}
        continue;
      }

      // update frontmatter of post
      try {
        let txt = await fs.readFile(postFile, 'utf8');
        const fmMatch = txt.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
        if (!fmMatch) {
          report.failed.push({ slug, reason: 'frontmatter not found' });
          continue;
        }
        const fm = fmMatch[1];
        let body = fmMatch[2];

        // if image already present in frontmatter, skip frontmatter update
        if (!/^\s*image\s*:/m.test(fm)) {
          const relPath = `../../assets/blog/${outName}`;
          const imageLine = `image: "${relPath}"\nimageAlt: "Foto de ${categoryOrGuess(fm, info.photographer)} — ${info.photographer} via Pexels"`;
          const newFm = fm + '\n' + imageLine;
          txt = `---\n${newFm}\n---\n${body}`;
          await fs.writeFile(postFile, txt, 'utf8');
        } else {
          // ensure imageAlt exists
          if (!/^\s*imageAlt\s*:/m.test(fm)) {
            const relPath = `../../assets/blog/${outName}`;
            const newFm = fm.replace(/\n$/, '') + `\nimageAlt: "Foto de ${categoryOrGuess(fm, info.photographer)} — ${info.photographer} via Pexels"`;
            txt = `---\n${newFm}\n---\n${body}`;
            await fs.writeFile(postFile, txt, 'utf8');
          }
        }

        // add credit paragraph if not present
        const creditHtml = `<p class="text-xs text-gray-500">Foto: <a href="${escapeHtml(info.photographerUrl || '#')}">${escapeHtml(info.photographer || 'Fotógrafo')}</a> via <a href="https://www.pexels.com">Pexels</a></p>`;
        if (!txt.includes(creditHtml)) {
          // try to insert before last occurrence of a CTA paragraph (heuristic)
          const ctaRegex = /(<p[^>]*>[^<]{0,200}(?:Precisa de ajuda|Fale com|Fale conosco|Fale com nossa equipe|Fale com o WhatsApp)[\s\S]*?<\/p>)/i;
          if (ctaRegex.test(body)) {
            body = body.replace(ctaRegex, (m) => `${creditHtml}\n\n${m}`);
          } else {
            // append at end
            body = `${body}\n\n${creditHtml}\n`;
          }
          // reconstruct file with original frontmatter (we read fm earlier)
          const fmBlock = txt.match(/^---\n([\s\S]*?)\n---\n/);
          const fmContent = fmBlock ? fmBlock[1] : fm;
          const newTxt = `---\n${fmContent}\n---\n${body}`;
          await fs.writeFile(postFile, newTxt, 'utf8');
        }
      } catch (err) {
        report.failed.push({ slug, reason: 'failed updating post', error: String(err) });
        continue;
      }

      report.downloaded.push({ slug, path: outPath });
    } catch (err) {
      report.failed.push({ slug, reason: 'unexpected', error: String(err) });
    }
  }

  console.log('\nRelatório final:');
  console.log('Baixadas com sucesso:', report.downloaded.length);
  console.log('Puladas (já existiam):', report.skipped.length);
  console.log('Falhas:', report.failed.length);
  if (report.failed.length) {
    console.log('Detalhes das falhas (sem expor a chave de API):');
    for (const f of report.failed.slice(0, 20)) {
      console.log('-', f.slug, '→', f.reason);
    }
  }
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
}

function categoryOrGuess(frontmatter, fallback) {
  // try to extract category from frontmatter
  const m = frontmatter.match(/^\s*category\s*:\s*["']?(.+?)["']?\s*$/m);
  if (m) return m[1];
  return fallback || 'serviço';
}

async function main() {
  if (APPLY) {
    await modeApply();
  } else {
    await modeCuration();
  }
}

main().catch((err) => {
  console.error('Erro inesperado:', err);
  process.exitCode = 1;
});

