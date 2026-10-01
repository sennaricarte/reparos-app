import { readFileSync, writeFileSync } from 'fs';

const posts = [
  { slug: 'desentupidora-em-osasco-sp', photographer: 'JESUS ADRIÁN SAAVEDRA', photographerUrl: 'https://www.pexels.com/@jesusadrian' },
  { slug: 'desentupidora-na-freguesia-do-o', photographer: 'Julien Goettelmann', photographerUrl: 'https://www.pexels.com/@julien-goettelmann' },
  { slug: 'desentupidora-vinhedo-sp', photographer: 'Philipp Fahlbusch', photographerUrl: 'https://www.pexels.com/@philipp-fahlbusch' },
  { slug: 'manutencao-preventiva-de-canos', photographer: 'Bombeiros MT', photographerUrl: 'https://www.pexels.com/@bombeiros-mt' },
  { slug: 'o-que-faz-um-bombeiro-hidraulico', photographer: 'ClickerHappy', photographerUrl: 'https://www.pexels.com/@clickerhappy' },
  { slug: 'problemas-comuns-em-encanamentos', photographer: 'Willian Justen de Vasconcellos', photographerUrl: 'https://www.pexels.com/@willian-justen-de-vasconcellos' },
];

for (const p of posts) {
  const path = `src/content/blog/${p.slug}.md`;
  let c = readFileSync(path, 'utf8');
  if (c.includes('\nimage:')) { console.log('JÁ TEM', p.slug); continue; }
  const imgLine = `image: "../../assets/blog/${p.slug}-featured.jpg"`;
  const altLine = `imageAlt: "Foto de serviço hidráulico — ${p.photographer} via Pexels"`;
  c = c.replace('category:', imgLine + '\n' + altLine + '\ncategory:');
  writeFileSync(path, c, 'utf8');
  console.log('OK', p.slug);
}

