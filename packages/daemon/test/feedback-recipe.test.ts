import {describe, expect, it} from 'vitest';
import {canonicalizeRichRecipeContent, decodeRichRecipeContent} from '@vonvon/protocol';
import {createFeedbackRecipe} from '../src/feedback/recipe.js';

describe('portable feedback recipe', () => {
  it('round trips through the actual rich-v2 codec with ordinary setup skill and explicit references', () => {
    const content = createFeedbackRecipe();
    expect(decodeRichRecipeContent(canonicalizeRichRecipeContent(content).canonical).content).toEqual(content);
    expect(content.setup).toEqual([]);
    expect(content.tasks).toEqual([]);
    expect(content.skills).toHaveLength(2);
    expect(content.files.map(file => file.name)).toContain('feedback/references/summary.md');
    expect(JSON.stringify(content)).not.toMatch(/OxVTbr|shrcndx|\/Users\/|Bearer |appSecret\s*[:=]|user_access_token\s*[:=]/);
  });
});
