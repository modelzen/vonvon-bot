import { describe, expect, it } from 'vitest';
import { encodeCommand, newNonce, parseReceipt, ReceiptParser, validateSignalReceipt } from '../../src/provider/process/holder-protocol';

describe('encodeCommand', () => {
  it('frames launch fields byte for byte, with spaces, newlines, = and multibyte text untouched', () => {
    const bytes = encodeCommand({
      command: 'launch', nonce: 'n-1',
      file: '/opt/my app/codex', args: ['app-server', 'a\nb', 'x=y z'],
      env: { PATH: '/usr/bin', NOTE: 'k=v\n咖' },
    });
    const expected = 'launch n-1\n'
      + '17\n/opt/my app/codex'
      + '3\n' + '10\napp-server' + '3\na\nb' + '5\nx=y z'
      + '2\n' + '13\nPATH=/usr/bin' + '12\nNOTE=k=v\n咖'
      + '0\n';
    expect(bytes.equals(Buffer.from(expected, 'utf8'))).toBe(true);
  });

  it('encodes a cwd frame and plain commands as one line', () => {
    expect(encodeCommand({ command: 'launch', nonce: 'a', file: 'c', args: [], env: {}, cwd: '/w d' }).toString())
      .toBe('launch a\n1\nc0\n0\n4\n/w d');
    expect(encodeCommand({ command: 'kill', nonce: 'abc' }).toString()).toBe('kill abc\n');
  });

  it('refuses inputs the holder could not read back', () => {
    expect(() => encodeCommand({ command: 'term', nonce: 'has space' })).toThrow(/nonce/);
    expect(() => encodeCommand({ command: 'launch', nonce: 'a', file: 'c', args: [], env: { 'A=B': 'x' } })).toThrow(/environment key/);
    expect(() => encodeCommand({ command: 'launch', nonce: 'a', file: 'c', args: ['a\0b'], env: {} })).toThrow(/NUL/);
  });

  it('makes fresh nonces in the wire alphabet', () => {
    const nonces = new Set(Array.from({ length: 50 }, newNonce));
    expect(nonces.size).toBe(50);
    for (const nonce of nonces) expect(nonce).toMatch(/^[A-Za-z0-9-]{1,32}$/);
  });
});

describe('ReceiptParser', () => {
  it('joins a receipt split across chunks and splits two receipts in one chunk', () => {
    const parser = new ReceiptParser();
    expect(parser.push(Buffer.from('sent te'))).toEqual([]);
    expect(parser.push(Buffer.from('rm n1\ncreated n2 4'))).toEqual([{ kind: 'sent', rung: 'term', nonce: 'n1' }]);
    expect(parser.push(Buffer.from('2\nready n2\nprovider-exit - SIGKILL\n'))).toEqual([
      { kind: 'created', nonce: 'n2', pid: 42 },
      { kind: 'ready', nonce: 'n2' },
      { kind: 'provider-exit', code: null, signal: 'SIGKILL' },
    ]);
  });

  it.each([
    ['hello vonvon-holder 1', { kind: 'hello', version: 1 }],
    ['ready n 812', { kind: 'ready', nonce: 'n', pid: 812 }],
    ['launch-failed n 2', { kind: 'launch-failed', nonce: 'n', errno: 2 }],
    ['launch-failed n execve 13', { kind: 'launch-failed', nonce: 'n', step: 'execve', errno: 13 }],
    ['refused kill n 1', { kind: 'refused', command: 'kill', nonce: 'n', reason: 1 }],
    ['refused term n reaped', { kind: 'refused', command: 'term', nonce: 'n', reason: 'reaped' }],
    ['refused go n already-sent', { kind: 'refused', command: 'go', nonce: 'n', reason: 'already-sent' }],
    ['probe-unknown n 1', { kind: 'probe-unknown', nonce: 'n', errno: 1 }],
    ['provider-exit 3 -', { kind: 'provider-exit', code: 3, signal: null }],
    ['empty n', { kind: 'empty', nonce: 'n' }],
  ])('parses %j', (line, receipt) => {
    expect(parseReceipt(line)).toEqual(receipt);
  });

  it.each([
    'bogus n', '', 'sent term', 'sent hup n', 'sent term n extra', 'sent  term n', 'created n -4',
    'refused term n maybe', 'refused fork n 1', 'provider-exit 1', 'provider-exit x -', 'provider-exit - kill',
    'reaped ' + 'x'.repeat(33), 'live n\r', 'empty né', 'hello other 1', 'launch-failed n a b 1', 'toString n',
  ])('reports %j as malformed', line => {
    expect(parseReceipt(line)).toEqual({ kind: 'malformed', line });
  });
});

describe('validateSignalReceipt', () => {
  const term = { command: 'term' as const, nonce: 't1' };
  const kill = { command: 'kill' as const, nonce: 'k1' };

  it('maps sent and refused only for the issued command and nonce', () => {
    for (const platform of ['posix', 'win32'] as const) {
      expect(validateSignalReceipt(kill, parseReceipt('sent kill k1'), platform)).toBe('sent');
      expect(validateSignalReceipt(kill, parseReceipt('refused kill k1 1'), platform)).toBe('refused');
      expect(validateSignalReceipt(term, parseReceipt('refused term t1 reaped'), platform)).toBe('refused');
      expect(validateSignalReceipt(kill, parseReceipt('sent kill t1'), platform)).toBeUndefined();
      expect(validateSignalReceipt(kill, parseReceipt('sent term k1'), platform)).toBeUndefined();
      expect(validateSignalReceipt(kill, parseReceipt('refused term k1 1'), platform)).toBeUndefined();
    }
  });

  it('accepts accepted only for term on Windows', () => {
    expect(validateSignalReceipt(term, parseReceipt('accepted term t1'), 'win32')).toBe('accepted');
    expect(validateSignalReceipt(term, parseReceipt('accepted term t1'), 'posix')).toBeUndefined();
    expect(validateSignalReceipt(kill, parseReceipt('accepted kill k1'), 'win32')).toBeUndefined();
    expect(validateSignalReceipt(term, parseReceipt('accepted term other'), 'win32')).toBeUndefined();
  });

  it('drops unrelated and malformed receipts', () => {
    expect(validateSignalReceipt(kill, parseReceipt('reaped k1'), 'posix')).toBeUndefined();
    expect(validateSignalReceipt(kill, parseReceipt('provider-exit - SIGKILL'), 'posix')).toBeUndefined();
    expect(validateSignalReceipt(kill, parseReceipt('sent kill'), 'posix')).toBeUndefined();
  });
});
