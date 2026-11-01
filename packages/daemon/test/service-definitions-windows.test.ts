import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { decodeGeneratedDefinition, InvalidDefinitionInput, renderDefinition, WINDOWS_TASK_HOST, WINDOWS_TASK_MARKER, windowsTaskEnabled } from '../src/service/definitions';
import { resolveServiceRoot, serviceTarget, type CanonicalRoot } from '../src/service/identity';
import { readRegistration } from '../src/service/registration';
import { decodeConsoleText } from '../src/service/windows-command';
import { fail, foreignTaskXml, INSTALL_ROOT, LAUNCHER, NO_TASK, ok, recorder, reserialized, SID, standalone, utf16 } from './service-windows-fixture';

const target = { platform: 'win32' as const, taskName: '\\VonvonBot-000000000000-111111111111', sid: SID };
const ROOT = 'C:\\Users\\U\\.vonvon-bot' as CanonicalRoot;
const input = (root: string = ROOT) => ({ target, root: root as CanonicalRoot, port: 7788, distribution: standalone, capturedPath: 'C:\\Windows\\system32;C:\\Tools' });
const text = (root?: string): string => decodeConsoleText(renderDefinition(input(root)).xml);
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

it('renders the task XML of §4.2: UTF-16LE with a BOM, CRLF, least privilege, hidden, no time limit, one instance, normal priority, no console window', () => {
  const bytes = renderDefinition(input()).xml;
  expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
  const xml = text();
  expect(xml.startsWith('<?xml version="1.0" encoding="UTF-16"?>\r\n')).toBe(true);
  expect(xml.split('\r\n').every(line => !line.includes('\n'))).toBe(true);
  for (const part of [
    '<RunLevel>LeastPrivilege</RunLevel>', '<LogonType>InteractiveToken</LogonType>', '<Hidden>true</Hidden>', '<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>', '<StartWhenAvailable>true</StartWhenAvailable>', '<AllowHardTerminate>true</AllowHardTerminate>',
    '<RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>', `<LogonTrigger><Enabled>true</Enabled><UserId>${SID}</UserId></LogonTrigger>`,
    '<Priority>4</Priority>', '<Command>%SystemRoot%\\System32\\conhost.exe</Command>',
    `<Arguments>--headless &quot;${LAUNCHER}&quot; __win-supervise --port 7788 --home &quot;C:\\Users\\U\\.vonvon-bot&quot;</Arguments>`,
    `<WorkingDirectory>${INSTALL_ROOT}</WorkingDirectory>`,
  ]) expect(xml).toContain(part);
  expect(xml).not.toMatch(/releases\\/);
  const description = /<Description>([^<]*)<\/Description>/.exec(xml)?.[1] ?? '';
  expect(description.startsWith(WINDOWS_TASK_MARKER)).toBe(true);
  expect(JSON.parse(description.slice(WINDOWS_TASK_MARKER.length).replace(/&quot;/g, '"'))).toEqual({
    root: ROOT, port: 7788, distribution: standalone, capturedPath: 'C:\\Windows\\system32;C:\\Tools',
  });
});

it('escapes XML in the paths and keeps the Description ASCII, and decode gives the same definition back', () => {
  const root = 'C:\\Users\\A&B <1>\\数据 (x)';
  const xml = text(root);
  expect(xml).toContain('A&amp;B &lt;1&gt;');
  expect(/<Description>([^<]*)<\/Description>/.exec(xml)?.[1]).toMatch(/^[\x20-\x7e]*$/);
  expect(decodeGeneratedDefinition(target, renderDefinition(input(root)))).toEqual({ root, port: 7788, distribution: standalone, capturedPath: 'C:\\Windows\\system32;C:\\Tools' });
});

it('installs only the standalone server, through its launcher, with paths cmd.exe reads safely', () => {
  for (const distribution of [
    { kind: 'desktop' as const, executable: 'C:\\Program Files\\Vonvon Bot\\Vonvon Bot.exe', entry: 'C:\\x\\vonvon.mjs' },
    { kind: 'npm' as const, executable: 'C:\\node\\node.exe', entry: 'C:\\npm\\vonvon.mjs' },
  ]) expect(() => renderDefinition({ ...input(), distribution })).toThrow(new InvalidDefinitionInput('Windows 只支持 standalone 的服务'));
  expect(() => renderDefinition({ ...input(), distribution: { ...standalone, executable: `${INSTALL_ROOT}\\releases\\1.0.0\\node\\node.exe` } })).toThrow(InvalidDefinitionInput);
  expect(() => renderDefinition({ ...input(), distribution: { ...standalone, entry: 'C:\\elsewhere\\current.txt' } })).toThrow(InvalidDefinitionInput);
  for (const root of ['C:\\Users\\U\\a"b', 'C:\\Users\\%USERNAME%', 'C:\\Users\\U\\', 'relative\\root']) expect(() => renderDefinition(input(root))).toThrow(InvalidDefinitionInput);
  expect(() => renderDefinition({ ...input(), target: { ...target, sid: 'nobody' } })).toThrow(InvalidDefinitionInput);
});

it('recognizes the XML Task Scheduler gives back without comparing bytes', () => {
  const back = reserialized(text());
  expect([...back.subarray(0, 2)]).not.toEqual([0xff, 0xfe]);
  expect(decodeGeneratedDefinition(target, { platform: 'win32', xml: back })).toEqual({ root: ROOT, port: 7788, distribution: standalone, capturedPath: 'C:\\Windows\\system32;C:\\Tools' });
  // UTF-8 with the same content is read as well.
  expect(decodeGeneratedDefinition(target, { platform: 'win32', xml: Buffer.from(decodeConsoleText(back)) }).port).toBe(7788);
});

it.each([
  ['the marker', (xml: string) => xml.replace(WINDOWS_TASK_MARKER, 'my own task '), /marker/],
  ['the JSON', (xml: string) => xml.replace('&quot;port&quot;:7788', '&quot;port&quot;:&quot;x&quot;'), /JSON/],
  ['the Command', (xml: string) => xml.replace(`<Command>${WINDOWS_TASK_HOST}</Command>`, '<Command>C:\\Windows\\notepad.exe</Command>'), /Command/],
  ['the launcher', (xml: string) => xml.replace(`--headless &quot;${LAUNCHER}&quot;`, '--headless &quot;C:\\Windows\\evil.cmd&quot;'), /Arguments/],
  ['the Arguments', (xml: string) => xml.replace('--port 7788', '--port 7789'), /Arguments/],
  ['the RunLevel', (xml: string) => xml.replace('<RunLevel>LeastPrivilege</RunLevel>', '<RunLevel>HighestAvailable</RunLevel>'), /RunLevel/],
  ['the user', (xml: string) => xml.replace(`<Principal id="Author"><UserId>${SID}`, '<Principal id="Author"><UserId>S-1-5-21-9-9-9-500'), /runs as/],
  ['a second Command', (xml: string) => xml.replace('</Exec>', '<Command>x</Command></Exec>'), /Command is repeated/],
])('a changed %s is not ours', (_, change, reason) => {
  expect(() => decodeGeneratedDefinition(target, { platform: 'win32', xml: utf16(change(text())) })).toThrow(reason);
});

/**
 * What a piped `schtasks /Query /XML` writes in a console code page (I4a review F1): the header still says UTF-16, ASCII
 * stays, each other character becomes its bytes in `page`, or `?` where the page has none.
 */
function oem(xml: string, page: Readonly<Record<string, readonly number[] | string>>): Buffer {
  return Buffer.from([...xml].flatMap(c => {
    const bytes = page[c];
    return c.charCodeAt(0) < 0x80 ? [c.charCodeAt(0)] : typeof bytes === 'string' ? [...Buffer.from(bytes, 'latin1')] : [...(bytes ?? [0x3f])];
  }));
}
/** A user whose name is outside ASCII: the data root and the install root both under that profile. */
function profile(user: string) {
  const installRoot = `C:\\Users\\${user}\\AppData\\Local\\VonvonBot\\server`;
  const distribution = { kind: 'standalone' as const, executable: `${installRoot}\\bin\\vonvon-server.cmd`, entry: `${installRoot}\\current.txt` };
  const definition = { root: `C:\\Users\\${user}\\.vonvon-bot`, port: 7788, distribution, capturedPath: 'C:\\Windows\\system32' };
  const xml = decodeConsoleText(renderDefinition({ target, ...definition, root: definition.root as CanonicalRoot }).xml);
  return { definition, xml };
}

it.each([
  ['Western cp850, é', 'José', { é: [0x82] }],
  ['Japanese cp932, a second byte that is a backslash', '日本表', { 日: [0x93, 0xfa], 本: [0x96, 0x7b], 表: [0x95, 0x5c] }],
  ['US cp437, Chinese replaced by ?', '张三', {}],
  ['US cp437, a best-fit letter', 'Łukasz', { Ł: 'L' }],
  ['Chinese cp936', '张三', { 张: [0xd5, 0xc5], 三: [0xc8, 0xfd] }],
] as const)('recognizes its own task read back through a console code page (%s)', (_, user, page) => {
  const { definition, xml } = profile(user);
  expect(decodeGeneratedDefinition(target, { platform: 'win32', xml: oem(xml, page) })).toEqual(definition);
});

it('reading through a code page still tells another launcher, port or data root apart', () => {
  const { xml } = profile('José');
  const page = { é: [0x82] };
  for (const change of [
    (x: string) => x.replace('\\VonvonBot\\server\\bin\\vonvon-server.cmd&quot;', '\\Elsewhere\\server\\bin\\vonvon-server.cmd&quot;'),
    (x: string) => x.replace('__win-supervise --port 7788', '__win-supervise --port 7789'),
    (x: string) => x.replace('.vonvon-bot&quot;</Arguments>', '.other&quot;</Arguments>'),
  ]) expect(() => decodeGeneratedDefinition(target, { platform: 'win32', xml: oem(change(xml), page) })).toThrow(/Arguments/);
});

it('reads the Settings Enabled flag, not one of a nested element', () => {
  const xml = text();
  expect(windowsTaskEnabled(utf16(xml))).toBe(true);
  expect(windowsTaskEnabled(utf16(xml.replace('<Enabled>true</Enabled>\r\n    <RestartOnFailure>', '<Enabled>false</Enabled>\r\n    <RestartOnFailure>')))).toBe(false);
  expect(windowsTaskEnabled(utf16(xml.replace('<Hidden>true</Hidden>', '<Hidden>true</Hidden><IdleSettings><Enabled>false</Enabled></IdleSettings>')))).toBe(true);
});

it('readRegistration asks /Query /FO CSV first and reads /XML only for a task that exists', async () => {
  const root = await resolveServiceRoot(await mkdtemp(join(tmpdir(), 'vonvon-win-def-'))); dirs.push(root);
  const t = serviceTarget({ platform: 'win32', sid: SID, root });
  const ours = renderDefinition({ ...input(root), target: t }).xml;
  let present: Uint8Array | null = null;
  const r = recorder((_, args) => args.includes('/XML') ? (present ? ok(present) : NO_TASK) : present ? ok(`"${t.taskName}","N/A","Ready"`) : NO_TASK);

  await expect(readRegistration({ target: t, requestedRoot: root, run: r.run })).resolves.toEqual({ kind: 'absent' });
  expect(r.calls).toEqual([`schtasks /Query /TN ${t.taskName} /FO CSV /NH`]);

  present = reserialized(decodeConsoleText(ours));
  await expect(readRegistration({ target: t, requestedRoot: root, run: r.run })).resolves.toMatchObject({ kind: 'ours', definition: { root, port: 7788, distribution: standalone } });
  expect(r.calls.slice(1)).toEqual([`schtasks /Query /TN ${t.taskName} /FO CSV /NH`, `schtasks /Query /TN ${t.taskName} /XML`]);

  present = foreignTaskXml();
  await expect(readRegistration({ target: t, requestedRoot: root, run: r.run })).resolves.toMatchObject({ kind: 'unrecognized', location: t.taskName, reason: expect.stringMatching(/marker/) });

  present = Buffer.alloc(1024 * 1024 + 1, 0x20);
  await expect(readRegistration({ target: t, requestedRoot: root, run: r.run })).resolves.toMatchObject({ kind: 'unrecognized', reason: 'Definition exceeds size limit' });

  // A query that is not "no such task" is not read as absent.
  const broken = recorder(() => fail('ERROR: The Task Scheduler service is busy.', 3));
  await expect(readRegistration({ target: t, requestedRoot: root, run: broken.run })).resolves.toMatchObject({ kind: 'unrecognized', reason: expect.stringMatching(/schtasks \/Query/) });
  // daemon start and the desktop app read no answer as no task (review F5); a task that answers but is not ours stays unrecognized.
  await expect(readRegistration({ target: t, requestedRoot: root, run: broken.run, unansweredAsAbsent: true })).resolves.toEqual({ kind: 'absent' });
  const timedOut = recorder(() => ({ ok: false, status: null, stdout: '', stderr: 'schtasks /Query 超时' }));
  await expect(readRegistration({ target: t, requestedRoot: root, run: timedOut.run, unansweredAsAbsent: true })).resolves.toEqual({ kind: 'absent' });
  present = foreignTaskXml();
  await expect(readRegistration({ target: t, requestedRoot: root, run: r.run, unansweredAsAbsent: true })).resolves.toMatchObject({ kind: 'unrecognized' });
});

it('a task for another data root is other-root', async () => {
  const root = await resolveServiceRoot(await mkdtemp(join(tmpdir(), 'vonvon-win-def-'))); dirs.push(root);
  const other = await resolveServiceRoot(await mkdtemp(join(tmpdir(), 'vonvon-win-def-'))); dirs.push(other);
  const t = serviceTarget({ platform: 'win32', sid: SID, root });
  const xml = renderDefinition({ ...input(other), target: t }).xml;
  const r = recorder((_, args) => args.includes('/XML') ? ok(xml) : ok('"x","N/A","Ready"'));
  await expect(readRegistration({ target: t, requestedRoot: root, run: r.run })).resolves.toMatchObject({ kind: 'other-root', recordedRoot: other });
});
