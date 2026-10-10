const TAIL_BYTES = 262_144;
const PIECE_BYTES = 65_536;

export class BackendOutput {
  private readonly ring = Buffer.allocUnsafe(TAIL_BYTES);
  private readonly scratch = Buffer.allocUnsafe(PIECE_BYTES);
  private head = 0;
  private size = 0;
  private totalBytes = 0;

  get retainedEntryCount(): number { return this.size === 0 ? 0 : 1; }

  append(text: string, deliver: (piece: string) => void): void {
    if (text.length === 1 && text.charCodeAt(0) < 128) {
      this.ring[(this.head + this.size) % TAIL_BYTES] = text.charCodeAt(0);
      this.totalBytes++;
      if (this.size === TAIL_BYTES) this.head = (this.head + 1) % TAIL_BYTES;
      else this.size++;
      this.alignHead();
      deliver(text);
      return;
    }
    let start = 0;
    while (start < text.length) {
      let end = start;
      let bytes = 0;
      while (end < text.length) {
        const point = text.codePointAt(end)!;
        const width = point < 128 ? 1 : point < 2048 ? 2 : point < 65536 ? 3 : 4;
        if (bytes + width > PIECE_BYTES) break;
        bytes += width;
        end += point > 65535 ? 2 : 1;
      }
      const piece = text.slice(start, end);
      this.scratch.write(piece, 0, bytes, 'utf8');
      const overflow = Math.max(0, this.size + bytes - TAIL_BYTES);
      this.head = (this.head + overflow) % TAIL_BYTES;
      this.size -= overflow;
      const writeAt = (this.head + this.size) % TAIL_BYTES;
      const first = Math.min(bytes, TAIL_BYTES - writeAt);
      this.scratch.copy(this.ring, writeAt, 0, first);
      this.scratch.copy(this.ring, 0, first, bytes);
      this.size += bytes;
      this.totalBytes += bytes;
      this.alignHead();
      deliver(piece);
      start = end;
    }
  }

  private alignHead(): void {
    while (this.size > 0 && (this.ring[this.head]! & 0xc0) === 0x80) {
      this.head = (this.head + 1) % TAIL_BYTES;
      this.size--;
    }
  }

  snapshot(): { text: string; omittedBytes: number } {
    const retained = Buffer.allocUnsafe(this.size);
    const first = Math.min(this.size, TAIL_BYTES - this.head);
    this.ring.copy(retained, 0, this.head, this.head + first);
    this.ring.copy(retained, first, 0, this.size - first);
    return { text: retained.toString('utf8'), omittedBytes: this.totalBytes - this.size };
  }
}

export function backendErrorSuffix(source: string): string {
  let start = source.length;
  let bytes = 0;
  while (start > 0) {
    const last = source.charCodeAt(start - 1);
    let units = 1;
    let width = last < 128 ? 1 : last < 2048 ? 2 : 3;
    if (last >= 0xdc00 && last <= 0xdfff) {
      const first = source.charCodeAt(start - 2);
      if (!(first >= 0xd800 && first <= 0xdbff)) break;
      units = 2;
      width = 4;
    } else if (last >= 0xd800 && last <= 0xdbff) break;
    if (bytes + width > 8192) break;
    bytes += width;
    start -= units;
  }
  return Buffer.from(source.slice(start), 'utf8').toString('utf8');
}
