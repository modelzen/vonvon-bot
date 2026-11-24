import { describe, expect, it } from 'vitest';
import { card, md, table } from '../src/card/cards';
import { measureCard } from '../src/card/card-budget';
import { processPanel } from '../src/card/process-panel';
import {
  findLiveMarkdownSplit,
  paginateMarkdown,
  parseMarkdownBlocks,
  splitLineIntoSentences,
} from '../src/card/content-split';

describe('card-budget measureCard', () => {
  it('counts recursive tag components including panel header icons and tables', () => {
    const panel = processPanel('测试面板', [md('hello')], false, { icon: 'computer_outlined' });
    const tbl = table(
      [{ name: 'c0', displayName: 'A' }],
      [{ c0: '1' }],
    );
    const built = card([panel, tbl]);
    const metrics = measureCard(built);
    // panel(1) + header.title(1) + header.title.icon(1) + header.icon(1) + body md(1) + table(1) = 6
    expect(metrics.components).toBe(6);
    expect(metrics.tables).toBe(1);
    expect(metrics.bytes).toBe(Buffer.byteLength(JSON.stringify(built), 'utf8'));
  });
});

describe('content-split parseMarkdownBlocks', () => {
  it('recognizes code blocks, pipe tables, headings, and paragraphs with exact offsets', () => {
    const doc = [
      '# 报告标题',
      '',
      '第一段说明。',
      '```ts',
      'const a = 1;',
      '```',
      '',
      '| 名称 | 值 |',
      '| --- | --- |',
      '| foo | bar |',
      '',
      '结尾段。',
    ].join('\n');
    const segs = parseMarkdownBlocks(doc);
    expect(segs.map(s => s.kind)).toEqual(['heading', 'paragraph', 'code_block', 'table', 'paragraph']);
    expect(segs[2]).toMatchObject({ kind: 'code_block', language: 'ts', atomic: true });
    expect(segs[3]).toMatchObject({ kind: 'table', atomic: true });
    for (const seg of segs) {
      expect(doc.slice(seg.start, seg.end)).toBe(seg.raw);
    }
  });

  it('marks unclosed streaming code fences as unclosed in live mode', () => {
    const doc = '前文说明。\n\n```bash\necho hello\nstill streaming';
    const segs = parseMarkdownBlocks(doc, { live: true });
    expect(segs).toHaveLength(2);
    expect(segs[0]).toMatchObject({ kind: 'paragraph' });
    expect(segs[1]).toMatchObject({ kind: 'code_block', language: 'bash', unclosed: true });
  });

  it('does not treat single-line inline triple-backtick code as a fenced block', () => {
    const doc = '```inline``` 后面的文字。';
    const segs = parseMarkdownBlocks(doc);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.kind).toBe('paragraph');
  });
});

describe('content-split splitLineIntoSentences', () => {
  it('splits CJK and English sentences without breaking decimals, URLs, paths, or inline code', () => {
    const line = '版本 v0.10.1 耗时 3.14 秒，详见 https://example.com/a.b/c 和 `foo.bar()`。第二句完成！Done! Next sentence.';
    const units = splitLineIntoSentences(line);
    expect(units.map(u => u.raw.trim())).toEqual([
      '版本 v0.10.1 耗时 3.14 秒，详见 https://example.com/a.b/c 和 `foo.bar()`。',
      '第二句完成！',
      'Done!',
      'Next sentence.',
    ]);
  });

  it('keeps numbered list prefixes attached to the sentence', () => {
    const line = '1. First step finishes cleanly. 2. Second step.';
    const units = splitLineIntoSentences(line);
    expect(units[0]!.raw.trim()).toBe('1. First step finishes cleanly.');
    expect(units[1]!.raw.trim()).toBe('2. Second step.');
  });
});

describe('content-split paginateMarkdown', () => {
  it('returns one untouched slice when the full text fits', () => {
    const text = '第一段\n\n第二段';
    const slices = paginateMarkdown(text, () => true);
    expect(slices).toHaveLength(1);
    expect(slices[0]!.text).toBe(text);
    expect(slices[0]!.oversized).toEqual([]);
  });

  it('prefers paragraph boundaries and moves whole paragraphs intact to the next card', () => {
    const p1 = `第一段。${'甲'.repeat(60)}`;
    const p2 = `第二段。${'乙'.repeat(60)}`;
    const p3 = `第三段。${'丙'.repeat(60)}`;
    const doc = [p1, p2, p3].join('\n\n');
    const slices = paginateMarkdown(doc, candidate => candidate.length <= 100);
    expect(slices.map(s => s.text)).toEqual([p1, p2, p3]);
    expect(slices.every(s => s.oversized.length === 0)).toBe(true);
  });

  it('keeps headings attached to the following paragraph instead of stranding them at card end', () => {
    const doc = ['前置段落。'.repeat(12), '## 第二节', '第二节内容。'.repeat(8)].join('\n\n');
    const slices = paginateMarkdown(doc, candidate => candidate.length <= 80);
    expect(slices).toHaveLength(2);
    expect(slices[0]!.text).not.toContain('## 第二节');
    expect(slices[1]!.text).toContain('## 第二节');
    expect(slices[1]!.text).toContain('第二节内容。');
  });

  it('keeps fenced code blocks whole on the next card instead of splitting mid-block', () => {
    const intro = '开场说明。'.repeat(12);
    const code = '```bash\nnpm run build\nnpm test\n```';
    const doc = `${intro}\n\n${code}`;
    const slices = paginateMarkdown(doc, candidate => candidate.length <= 75);
    expect(slices).toHaveLength(2);
    expect(slices[0]!.text).toBe(intro);
    expect(slices[1]!.text).toBe(code);
  });

  it('falls back to complete sentence boundaries when a single paragraph exceeds an empty card', () => {
    const sentences = Array.from({ length: 6 }, (_, i) => `第${String(i + 1)}句完整内容在这里结束。`);
    const singleParagraph = sentences.join('');
    const slices = paginateMarkdown(singleParagraph, candidate => candidate.length <= 45);
    expect(slices.length).toBeGreaterThan(1);
    for (const slice of slices) {
      expect(slice.text.endsWith('。')).toBe(true);
      expect(slice.oversized).toEqual([]);
    }
    expect(slices.map(s => s.text).join('')).toBe(singleParagraph);
  });

  it('flags an oversized single code block as an attachment item while keeping surrounding prose', () => {
    const hugeCode = `\`\`\`ts\n${'const line = 1234567890;\n'.repeat(60)}\`\`\``;
    const doc = `前置说明。\n\n${hugeCode}\n\n后续总结。`;
    const slices = paginateMarkdown(doc, candidate => candidate.length <= 500);
    const oversized = slices.flatMap(s => s.oversized);
    expect(oversized).toHaveLength(1);
    expect(oversized[0]).toMatchObject({ kind: 'code_block', language: 'ts', raw: hugeCode });
    const joined = slices.map(s => s.text).join('\n\n');
    expect(joined).toContain('前置说明。');
    expect(joined).toContain('后续总结。');
  });
});

describe('content-split findLiveMarkdownSplit', () => {
  it('splits before an unclosed streaming code fence instead of cutting inside it', () => {
    const intro = '分析已完成。\n\n接下来贴出脚本：';
    const unclosedCode = `\`\`\`python\n${'print("hello")\n'.repeat(30)}`;
    const doc = `${intro}\n\n${unclosedCode}`;
    const decision = findLiveMarkdownSplit(doc, prefix => prefix.length <= 200, { live: true });
    expect(decision.kind).toBe('split');
    if (decision.kind === 'split') {
      expect(decision.prefix).toBe(intro);
      expect(doc.slice(decision.splitOffset)).toBe(unclosedCode);
    }
  });

  it('reports streaming_oversized for a giant unclosed code block at offset 0', () => {
    const unclosedCode = `\`\`\`ts\n${'export const x = 1;\n'.repeat(50)}`;
    const decision = findLiveMarkdownSplit(unclosedCode, prefix => prefix.length <= 200, { live: true });
    expect(decision.kind).toBe('streaming_oversized');
  });

  it('reports oversized once a giant code block closes and subsequent prose arrives', () => {
    const closedCode = `\`\`\`ts\n${'export const x = 1;\n'.repeat(50)}\`\`\``;
    const doc = `${closedCode}\n\n总结完成。`;
    const decision = findLiveMarkdownSplit(doc, prefix => prefix.length <= 200, { live: true, blockId: 'text:a' });
    expect(decision.kind).toBe('oversized');
    if (decision.kind === 'oversized') {
      expect(decision.item.raw).toBe(closedCode);
      expect(decision.item.language).toBe('ts');
    }
  });
});
