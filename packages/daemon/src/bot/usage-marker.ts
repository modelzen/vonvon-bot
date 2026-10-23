/**
 * `<vonvon-mem n="设置标记" used="id,id"/>`: the line a model adds when it answered from a memory entry (记忆设计 4.5).
 * Pure parsing; taking the marker out of the card is the stream stripping's job (bot/hidden-blocks.ts), which sees the
 * same text.
 *
 * A marker whose `n` is not this session's settings mark is ignored: a quoted message or a file cannot make one count.
 * An id the session was not handed is dropped. Several markers add up.
 */
const MARKER = /<vonvon-mem\b([^<>]*?)\/?>/gi;
const ATTRIBUTE = /([a-z]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const ID = /^[A-Za-z0-9_-]{1,60}(?::[A-Za-z0-9_-]{1,40})?$/;
/** A turn that lists more than this many is not telling which ones it used. */
const MAX_USED = 50;

export function parseUsageMarkers(text: string, nonce: string, injected: ReadonlySet<string>): string[] {
  if (!nonce || !text.includes('<vonvon-mem')) return [];
  const used: string[] = [];
  for (const marker of text.matchAll(MARKER)) {
    const attributes = new Map<string, string>();
    for (const attribute of (marker[1] ?? '').matchAll(ATTRIBUTE)) attributes.set(attribute[1]!.toLowerCase(), attribute[2] ?? attribute[3] ?? '');
    if (attributes.get('n') !== nonce) continue;
    for (const raw of (attributes.get('used') ?? '').split(/[\s,，、;；]+/)) {
      const id = raw.trim();
      if (ID.test(id) && injected.has(id) && !used.includes(id)) used.push(id);
      if (used.length >= MAX_USED) return used;
    }
  }
  return used;
}
