# Reparos (reparos.app.br)

Site informativo sobre hidráulica, elétrica e reformas em São Paulo. Astro 7, Tailwind 4, deploy na Vercel (saída estática).

## Comandos

| Comando | Ação |
| :-- | :-- |
| `pnpm install` | Instala dependências |
| `pnpm dev` | Servidor local em `localhost:4321` |
| `pnpm build` | Gera o site em `./dist/` |
| `pnpm preview` | Pré-visualiza o build |

## Estrutura

- `src/content/blog/`: posts em Markdown (schema em `src/content.config.ts`).
- `src/pages/`: páginas de serviço e blog.
- `src/components/SEO.astro`: title, description, canonical, Open Graph.
- `vercel.json`: redirects 301 e headers de cache.
- `scripts/`: utilitários de manutenção de conteúdo (uso eventual).

## Frontmatter dos posts

- `seoTitle`: até 60 caracteres, sem sufixo da marca.
- `description`: 120 a 155 caracteres.
- `updatedDate`: só alterar quando o conteúdo mudar de verdade (alimenta o `lastmod` do sitemap).

## Analytics (opcional)

Defina `PUBLIC_GA_MEASUREMENT_ID` (ex.: `G-XXXXXXXXXX`) nas variáveis de ambiente da Vercel. Sem ela, nenhum script de analytics é carregado.
