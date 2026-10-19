import { readBoundedUtf8FileStrict } from './bounded-local-files.js';

const MAX_JOURNAL_BYTES = 1024 * 1024;

export class ImportJournalReadError extends Error {
  constructor() {
    super('Import journal cannot be read or parsed');
    this.name = 'ImportJournalReadError';
  }
}

export async function readJournalJson(file: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readBoundedUtf8FileStrict(file, { maxBytes: MAX_JOURNAL_BYTES, timeoutMs: 2_000 });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw new ImportJournalReadError();
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new ImportJournalReadError();
  }
}
