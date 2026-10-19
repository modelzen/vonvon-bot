/** Ctrl-C at a hidden prompt: the command exits with 130, as a shell's SIGINT would. */
export class InputCancelled extends Error {
  constructor() { super('cancelled'); this.name = 'InputCancelled'; }
}

export interface TerminalInput {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(raw: boolean): unknown;
  setEncoding(encoding: BufferEncoding): unknown;
  on(event: 'data', listener: (chunk: string) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  off(event: 'data', listener: (chunk: string) => void): unknown;
  off(event: 'end', listener: () => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

/** An escape sequence (an arrow key, bracketed paste's markers) or a lone escape: never part of a key. */
// eslint-disable-next-line no-control-regex
const ESCAPE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|O.|.)?/g;

/**
 * One line from a terminal in raw mode, echoing nothing (s23g): `vonvon secrets set` asks for a key with it. Enter or
 * Ctrl-D ends it; backspace deletes; a paste arrives as one chunk and is taken whole; Ctrl-C rejects with
 * {@link InputCancelled}. The terminal's own mode is put back however it ends.
 */
export function readHidden(prompt: string, input: TerminalInput, output: { write(text: string): unknown }): Promise<string> {
  output.write(prompt);
  const wasRaw = input.isRaw ?? false;
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error?: Error): void => {
      input.off('data', onData);
      input.off('end', onEnd);
      try { input.setRawMode?.(wasRaw); } finally { input.pause(); }
      output.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk.replace(ESCAPE, '')) {
        if (ch === '\x03') return finish(new InputCancelled());
        if (ch === '\r' || ch === '\n' || ch === '\x04') return finish();
        if (ch === '\x7f' || ch === '\b') value = Array.from(value).slice(0, -1).join('');
        else if (ch >= ' ') value += ch;
      }
    };
    const onEnd = (): void => finish();
    try {
      input.setRawMode?.(true);
      input.setEncoding('utf8');
      input.on('data', onData);
      input.on('end', onEnd);
      input.resume();
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
