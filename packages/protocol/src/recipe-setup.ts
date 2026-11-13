import { z } from 'zod';
const text = (limit: number) => z.string().refine((value) => [...value].length <= limit);
export const recipeSetupSchema = z
  .object({
    steps: z
      .array(
        z
          .object({
            kind: z.enum(['config', 'tool', 'context']),
            title: text(80),
            instructions: z.string().max(2048),
            check: z.string().max(512).optional(),
            required: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(8),
  })
  .strict();
export type RecipeSetup = z.infer<typeof recipeSetupSchema>;
