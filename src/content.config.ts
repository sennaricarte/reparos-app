import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

export default {
  collections: {
    blog: {
      loader: glob({
        pattern: '**/*.md',
        base: './src/content/blog',
      }),
      schema: ({ image }) =>
        z.object({
          title: z.string(),
          seoTitle: z.string().optional(),
          description: z.string(),
          pubDate: z.coerce.date(),
          updatedDate: z.coerce.date().optional(),
          category: z.string().default('Geral'),
          image: image().optional(),
          imageAlt: z.string().optional(),
          draft: z.boolean().default(false),
        }),
    },
  },
};
