import MarkdownIt from '/vendor/markdown-it.mjs';

const parser = new MarkdownIt({ html: false, linkify: false, typographer: false });
parser.validateLink = value => {
  try { return ['http:', 'https:'].includes(new URL(value).protocol); }
  catch { return false; }
};
parser.renderer.rules.image = (tokens, i) => parser.utils.escapeHtml(tokens[i].content);
export const markdown = source => parser.render(source);
