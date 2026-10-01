#!/usr/bin/env node
/**
 * scripts/make-og.mjs
 * Generates src/assets/og-default.png (1200x630) from an inline SVG using sharp.
 *
 * Usage: node scripts/make-og.mjs
 *
 * Requires: sharp installed in the project.
 */
import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';

const OUT = path.resolve(process.cwd(), 'src', 'assets', 'og-default.png');
const WIDTH = 1200;
const HEIGHT = 630;
const BRAND = '#4f46e5'; // matches --color-brand

const svg = `
<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="${BRAND}" />
  <style>
    .title { font-family: Inter, Arial, sans-serif; font-size: 64px; font-weight: 700; fill: #ffffff; }
    .subtitle { font-family: Inter, Arial, sans-serif; font-size: 28px; fill: #ffffff; opacity: 0.95; }
  </style>
  <g>
    <text x="60" y="210" class="title">Reparos</text>
    <text x="60" y="270" class="subtitle">Hidráulica, Elétrica e Reformas em São Paulo</text>
  </g>
</svg>
`;

async function main() {
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  const buffer = Buffer.from(svg, 'utf8');
  await sharp(buffer).resize(WIDTH, HEIGHT).png().toFile(OUT);
  console.log('Wrote', OUT);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

