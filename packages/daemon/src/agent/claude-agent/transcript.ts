/**
 * What a Claude session file says about who wrote it (s15b, product.md 3.5).
 *
 * A bot session is an ordinary `~/.claude/projects/<folder>/<id>.jsonl`: the owner can
 * `claude --resume` it in a terminal, chat a few turns or `/compact`, while the bot's own
 * process stays up with its history in memory. Before each turn the bot reads what was
 * appended since it last looked. Turn records carry `entrypoint`: the bot's are
 * `feishu-codex-bridge` (backend.ts sets CLAUDE_CODE_ENTRYPOINT), a terminal's `cli` or
 * `sdk-cli`. A record with another entrypoint means someone else wrote there, so the bot
 * reconnects from the file. Bookkeeping lines (`last-prompt`, `ai-title`, `cost-state`)
 * carry none and count for nobody. A `compact_boundary` is a compaction, whoever made it.
 */
import { access, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { log } from '../../core/logger';
import { claudeConfigDir } from './configured-model';

export const BRIDGE_ENTRYPOINT = 'feishu-codex-bridge';

/** How much of the file is read per step: a long session runs to tens of MB. */
const CHUNK = 1 << 20;

/**
 * The session's file, searched in every project folder: how Claude Code names the folder
 * for a cwd (case, symlinks, long paths) does not matter. Undefined when no folder has it.
 */
export async function findTranscript(sessionId: string): Promise<string | undefined> {
  if (!/^[\w-]+$/.test(sessionId)) return undefined;
  const projects = join(claudeConfigDir(), 'projects');
  let folders: string[] = [];
  try {
    folders = await readdir(projects);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const file = `${sessionId}.jsonl`;
  for (const folder of folders) {
    const path = join(projects, folder, file);
    if (await access(path).then(() => true, () => false)) return path;
  }
  return undefined;
}

const CustomTitle = z.object({ type: z.literal('custom-title'), customTitle: z.string() });

/** Read explicitly renamed titles; CLI-generated ai-title records do not count. */
export async function readCustomTitle(path: string): Promise<string | undefined> {
  const fh = await open(path, 'r');
  let title: string | undefined;
  let rest = Buffer.alloc(0);
  const readTitle = (line: string) => {
    if (!line.includes('"custom-title"')) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    const parsed = CustomTitle.safeParse(value);
    if (parsed.success && parsed.data.customTitle.trim()) title = parsed.data.customTitle.trim();
  };
  try {
    const chunk = Buffer.alloc(CHUNK);
    for (;;) {
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      const data = Buffer.concat([rest, chunk.subarray(0, bytesRead)]);
      let at = 0;
      for (let nl = data.indexOf(0x0a); nl >= 0; nl = data.indexOf(0x0a, at)) {
        readTitle(data.toString('utf8', at, nl));
        at = nl + 1;
      }
      rest = Buffer.from(data.subarray(at));
    }
    if (rest.length) readTitle(rest.toString('utf8'));
    return title;
  } finally {
    await fh.close();
  }
}

export interface TranscriptScan {
  /** Where the next scan starts: just past the last complete line read. */
  to: number;
  /** A turn or compaction record from something other than the bot (or the file shrank). */
  foreign: boolean;
  /** The last `compact_boundary` read, by its uuid. */
  compaction?: string;
}

/**
 * Read the complete lines from byte `from` on. A line still being written is left for the
 * next scan. A file shorter than `from` was rewritten: it is read from the start and counts
 * as foreign.
 */
export async function scanTranscript(path: string, from: number): Promise<TranscriptScan> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const shrunk = size < from;
    let pos = shrunk ? 0 : from; // just past the last complete line
    let readAt = pos;
    let foreign = shrunk;
    let compaction: string | undefined;
    let rest = Buffer.alloc(0);
    while (readAt < size) {
      const chunk = Buffer.alloc(Math.min(CHUNK, size - readAt));
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, readAt);
      if (bytesRead === 0) break;
      readAt += bytesRead;
      // Split on the newline byte, which never occurs inside a multi-byte UTF-8 character.
      const data = rest.length ? Buffer.concat([rest, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      let at = 0;
      for (let nl = data.indexOf(0x0a); nl >= 0; nl = data.indexOf(0x0a, at)) {
        const seen = readLine(data.toString('utf8', at, nl));
        if (seen.foreign) foreign = true;
        if (seen.compaction) compaction = seen.compaction;
        at = nl + 1;
      }
      pos += at;
      rest = Buffer.from(data.subarray(at));
    }
    return { to: pos, foreign, ...(compaction ? { compaction } : {}) };
  } finally {
    await fh.close().catch((err: unknown) => log.fail('agent', err, { backend: 'claude-agent', phase: 'transcript-close' }));
  }
}

/** One line: parsed only when it can matter, a turn record's entrypoint or a compaction. */
function readLine(line: string): { foreign?: boolean; compaction?: string } {
  const boundary = line.includes('"compact_boundary"');
  if (!boundary && !line.includes('"entrypoint"')) return {};
  let rec: { type?: unknown; subtype?: unknown; uuid?: unknown; entrypoint?: unknown };
  try {
    rec = JSON.parse(line) as typeof rec;
  } catch {
    return {};
  }
  const out: { foreign?: boolean; compaction?: string } = {};
  if (typeof rec.entrypoint === 'string' && typeof rec.uuid === 'string' && rec.entrypoint !== BRIDGE_ENTRYPOINT) out.foreign = true;
  if (boundary && rec.type === 'system' && rec.subtype === 'compact_boundary' && typeof rec.uuid === 'string') out.compaction = rec.uuid;
  return out;
}
