import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { decodeGeneratedDefinition, InvalidDefinitionInput, renderDefinition, WINDOWS_TASK_MARKER, windowsTaskEnabled } from '../src/service/definitions';
import { resolveServiceRoot, serviceTarget, type CanonicalRoot } from '../src/service/identity';
import { readRegistration } from '../src/service/registration';
import { decodeConsoleText } from '../src/service/windows-command';
import { fail, foreignTaskXml, INSTALL_ROOT, LAUNCHER, NO_TASK, ok, recorder, reserialized, SID, standalone, utf16 } from './service-windows-fixture';

const target = { platform: 'win32' as const, taskName: '\\VonvonBot\\000000000000-111111111111', sid: SID };
const ROOT = 'C:\\Users\\U\\.vonvon-bot' as CanonicalRoot;
const input = (root: string = ROOT) => ({ target, root: root as CanonicalRoot, port: 7788, distribution: standalone, capturedPath: 'C:\\Windows\\system32;C:\\Tools' });
const text = (root?: string): string => decodeConsoleText(renderDefinition(input(root)).xml);
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

it('renders the task XML of §4.2: UTF-16LE with a BOM, CRLF, least privilege, hidden, no time limit, one instance', () => {
  const bytes = renderDefinition(input()).xml;
  expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
  const xml = text();
  expect(xml.startsWith('<?xml version="1.0" encoding="UTF-16"?>\r\n')).toBe(true);
  expect(xml.split('\r\n').every(line => !line.includes('\n'))).toBe(true);
  for (const part of [
    '<RunLevel>LeastPrivilege</RunLevel>', '<LogonType>InteractiveToken</LogonType>', '<Hidden>true</Hidden>', '<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>', '<StartWhenAvailable>true</StartWhenAvailable>', '<AllowHardTerminate>true</AllowHardTerminate>',
    '<RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>', `<LogonTrigger><Enabled>true</Enabled><UserId>${SID}</UserId></LogonTrigger>`,
    `<Command>${LAUNCHER}</Command>`, '<Arguments>__win-supervise --port 7788 --home &quot;C:\\Users\\U\\.vonvon-bot&quot;</Arguments>',
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
  ['the Command', (xml: string) => xml.replace(`<Command>${LAUNCHER}</Command>`, '<Command>C:\\Windows\\notepad.exe</Command>'), /Command/],
  ['the Arguments', (xml: string) => xml.replace('--port 7788', '--port 7789'), /Arguments/],
  ['the RunLevel', (xml: string) => xml.replace('<RunLevel>LeastPrivilege</RunLevel>', '<RunLevel>HighestAvailable</RunLevel>'), /RunLevel/],
  ['the user', (xml: string) => xml.replace(`<Principal id="Author"><UserId>${SID}`, '<Principal id="Author"><UserId>S-1-5-21-9-9-9-500'), /runs as/],
  ['a second Command', (xml: string) => xml.replace('</Exec>', '<Command>x</Command></Exec>'), /Command is repeated/],
])('a changed %s is not ours', (_, change, reason) => {
  expect(() => decodeGeneratedDefinition(target, { platform: 'win32', xml: utf16(change(text())) })).toThrow(reason);
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
});

it('a task for another data root is other-root', async () => {
  const root = await resolveServiceRoot(await mkdtemp(join(tmpdir(), 'vonvon-win-def-'))); dirs.push(root);
  const other = await resolveServiceRoot(await mkdtemp(join(tmpdir(), 'vonvon-win-def-'))); dirs.push(other);
  const t = serviceTarget({ platform: 'win32', sid: SID, root });
  const xml = renderDefinition({ ...input(other), target: t }).xml;
  const r = recorder((_, args) => args.includes('/XML') ? ok(xml) : ok('"x","N/A","Ready"'));
  await expect(readRegistration({ target: t, requestedRoot: root, run: r.run })).resolves.toMatchObject({ kind: 'other-root', recordedRoot: other });
});
