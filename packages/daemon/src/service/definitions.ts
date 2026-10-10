import { posix, win32 } from 'node:path';
import { LAUNCHD_LABEL, WINDOWS_CMD_NAME, WINDOWS_RUN_KEY, WINDOWS_RUN_VALUE, WINDOWS_VBS_NAME, type CanonicalRoot, type Target } from './identity';

export type DistributionInput =
  | { kind: 'npm'; executable: string; entry: string }
  | { kind: 'desktop'; executable: string; entry: string }
  | { kind: 'development' }
  | { kind: 'unknown' };
export type Definition = Readonly<{
  root: CanonicalRoot;
  port: number;
  distribution: Exclude<DistributionInput, { kind: 'development' | 'unknown' }>;
  capturedPath: string;
}>;
type DecodedDefinition = Omit<Definition, 'root'> & { root: string };
export type SerializedDefinition =
  | { platform: 'darwin'; plist: Uint8Array }
  | { platform: 'linux'; unit: Uint8Array }
  | { platform: 'win32'; cmd: Uint8Array; vbs: Uint8Array; runValue: string };

export class InvalidDefinitionInput extends Error {
  constructor(reason: string) { super(reason); this.name = 'InvalidDefinitionInput'; }
}

function literal(value: string): void {
  if (/[\u0000-\u001f\u007f-\u009f\ud800-\udfff\ufffe\uffff]/u.test(value)) {
    throw new InvalidDefinitionInput('Unsupported control character or malformed Unicode');
  }
}
function xml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] ?? c);
}
function unxml(value: string): string {
  if (/&(?!(?:amp|lt|gt|quot|apos);)|[<>]/u.test(value)) throw new Error('Invalid XML literal');
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[name] ?? '');
}
function unitLiteral(value: string, exec = false): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, () => exec ? '$$' : '$');
}
function ununit(value: string, exec = false): string {
  const pattern = exec ? /\\[\\"]|%%|\$\$|[^\\%$]/g : /\\[\\"]|%%|[^\\%]/g;
  const tokens = value.match(pattern) ?? [];
  if (tokens.join('') !== value) throw new Error('Invalid systemd escape');
  return tokens.map((token) => token.startsWith('\\') ? token.slice(1) : token === '%%' ? '%' : exec && token === '$$' ? '$' : token).join('');
}
function batch(value: string): string { return value.replace(/%/g, '%%'); }
function unbatch(value: string): string {
  if (value.replace(/%%/g, '').includes('%')) throw new Error('Invalid batch percent escape');
  return value.replace(/%%/g, '%');
}
function vbsLiteral(value: string): string { return value.replace(/"/g, '""'); }

export function renderDefinition(input: {
  target: Target; root: CanonicalRoot; port: number; distribution: DistributionInput; capturedPath: string;
}): SerializedDefinition {
  if (input.distribution.kind === 'development' || input.distribution.kind === 'unknown') {
    throw new InvalidDefinitionInput('Distribution cannot install a service');
  }
  return render(input.target, { ...input, distribution: input.distribution });
}

function render(target: Target, definition: DecodedDefinition): SerializedDefinition {
  const { root, port, distribution, capturedPath } = definition;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new InvalidDefinitionInput('Port must be an integer from 1 to 65535');
  const paths = target.platform === 'win32' ? win32 : posix;
  for (const value of [root, distribution.executable, distribution.entry, capturedPath]) {
    literal(value);
    if (target.platform === 'win32' && value.includes('"')) throw new InvalidDefinitionInput('Windows literals cannot contain double quotes');
  }
  for (const value of [root, distribution.executable, distribution.entry]) {
    if (!paths.isAbsolute(value) || (target.platform === 'win32' && !/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/])/i.test(value))) {
      throw new InvalidDefinitionInput('Service paths must be fully absolute');
    }
  }
  const out = paths.join(root, 'service.log');
  const err = paths.join(root, 'service.err.log');
  const desktop = distribution.kind === 'desktop';
  switch (target.platform) {
    case 'darwin': {
      const string = (value: string) => `<string>${xml(value)}</string>`;
      const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n<key>Label</key>${string(LAUNCHD_LABEL)}\n<key>ProgramArguments</key><array>${[distribution.executable, distribution.entry, 'daemon', 'run', '--port', String(port)].map(string).join('')}</array>\n<key>EnvironmentVariables</key><dict>\n<key>VONVON_HOME</key>${string(root)}\n<key>VONVON_SERVICE</key>${string('launchd')}\n<key>PATH</key>${string(capturedPath)}\n${desktop ? '<key>ELECTRON_RUN_AS_NODE</key><string>1</string>\n' : ''}</dict>\n<key>StandardOutPath</key>${string(out)}\n<key>StandardErrorPath</key>${string(err)}\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n<key>ThrottleInterval</key><integer>5</integer>\n</dict>\n</plist>\n`;
      return { platform: target.platform, plist: Buffer.from(plist) };
    }
    case 'linux': {
      const unit = `[Unit]\nDescription=Vonvon Bot daemon\n\n[Service]\nType=simple\nExecStart="${unitLiteral(distribution.executable)}" "${unitLiteral(distribution.entry, true)}" daemon run --port ${port}\nEnvironment="VONVON_HOME=${unitLiteral(root)}"\nEnvironment="VONVON_SERVICE=systemd"\nEnvironment="PATH=${unitLiteral(capturedPath)}"\n${desktop ? 'Environment="ELECTRON_RUN_AS_NODE=1"\n' : ''}StandardOutput=append:${out.replace(/%/g, '%%')}\nStandardError=append:${err.replace(/%/g, '%%')}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=infinity\n\n[Install]\nWantedBy=default.target\n`;
      return { platform: target.platform, unit: Buffer.from(unit) };
    }
    case 'win32': {
      const cmdPath = win32.join(root, 'service', WINDOWS_CMD_NAME);
      const vbsPath = win32.join(root, 'service', WINDOWS_VBS_NAME);
      if (target.cmdPath !== cmdPath || target.vbsPath !== vbsPath) throw new InvalidDefinitionInput('Windows launcher paths must belong to the root');
      const cmd = ['@echo off', 'setlocal EnableExtensions DisableDelayedExpansion', 'set "ERRORLEVEL="', '"%SystemRoot%\\System32\\chcp.com" 65001 >nul', 'if errorlevel 1 exit /b 1', `set "VONVON_HOME=${batch(root)}"`, 'set "VONVON_SERVICE=windows"', `set "PATH=${batch(capturedPath)}"`, ...(desktop ? ['set "ELECTRON_RUN_AS_NODE=1"'] : []), ':run', `"${batch(distribution.executable)}" "${batch(distribution.entry)}" daemon run --port ${port} >> "${batch(out)}" 2>> "${batch(err)}"`, 'if "%errorlevel%"=="0" exit /b 0', `"%SystemRoot%\\System32\\reg.exe" query "${WINDOWS_RUN_KEY}" /v "${WINDOWS_RUN_VALUE}" >nul 2>&1`, 'if errorlevel 1 exit /b 0', '"%SystemRoot%\\System32\\ping.exe" -n 6 127.0.0.1 >nul', 'goto run', ''].join('\r\n');
      const vbs = ['Set sh = CreateObject("WScript.Shell")', 'Set env = sh.Environment("Process")', `env("VONVON_LAUNCHER") = "${vbsLiteral(cmdPath)}"`, 'sh.Run """" & sh.ExpandEnvironmentStrings("%SystemRoot%") & "\\System32\\cmd.exe"" /d /v:on /s /c """"!VONVON_LAUNCHER!""""", 0, False', ''].join('\r\n');
      return { platform: target.platform, cmd: Buffer.from(cmd), vbs: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(vbs, 'utf16le')]), runValue: `wscript.exe //B "${vbsPath}"` };
    }
  }
}

function capture(text: string, pattern: RegExp): string[] {
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) throw new Error('Missing or duplicate definition field');
  const match = matches[0];
  if (!match) throw new Error('Missing definition field');
  return match.slice(1);
}
function field(text: string, pattern: RegExp): string {
  const value = capture(text, pattern)[0];
  if (value === undefined) throw new Error('Missing definition value');
  return value;
}

export function decodeGeneratedDefinition(target: Target, bytes: SerializedDefinition): DecodedDefinition {
  if (target.platform !== bytes.platform) throw new Error('Platform mismatch');
  const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let root: string;
  let capturedPath: string;
  let executable: string;
  let entry: string;
  let port: number;
  let desktop: boolean;
  switch (bytes.platform) {
    case 'darwin': {
      const text = utf8.decode(bytes.plist);
      root = unxml(field(text, /<key>VONVON_HOME<\/key><string>([^<]*)<\/string>/g));
      capturedPath = unxml(field(text, /<key>PATH<\/key><string>([^<]*)<\/string>/g));
      const args = capture(text, /<key>ProgramArguments<\/key><array><string>([^<]*)<\/string><string>([^<]*)<\/string><string>daemon<\/string><string>run<\/string><string>--port<\/string><string>([0-9]+)<\/string><\/array>/g);
      executable = unxml(args[0] ?? ''); entry = unxml(args[1] ?? ''); port = Number(args[2]);
      desktop = text.includes('<key>ELECTRON_RUN_AS_NODE</key><string>1</string>\n');
      break;
    }
    case 'linux': {
      const text = utf8.decode(bytes.unit);
      root = ununit(field(text, /^Environment="VONVON_HOME=((?:\\.|[^"\\])*)"$/gm));
      capturedPath = ununit(field(text, /^Environment="PATH=((?:\\.|[^"\\])*)"$/gm));
      const args = capture(text, /^ExecStart="((?:\\.|[^"\\])*)" "((?:\\.|[^"\\])*)" daemon run --port ([0-9]+)$/gm);
      executable = ununit(args[0] ?? ''); entry = ununit(args[1] ?? '', true); port = Number(args[2]);
      desktop = text.includes('Environment="ELECTRON_RUN_AS_NODE=1"\n');
      break;
    }
    case 'win32': {
      const text = utf8.decode(bytes.cmd);
      if (target.platform !== 'win32') throw new Error('Platform mismatch');
      try {
        if (bytes.vbs[0] !== 0xff || bytes.vbs[1] !== 0xfe || bytes.vbs.length % 2 !== 0) throw new Error('VBS must be UTF-16LE with BOM');
        new TextDecoder('utf-16le', { fatal: true }).decode(bytes.vbs.subarray(2));
      } catch (error) {
        throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), { location: target.vbsPath });
      }
      root = unbatch(field(text, /^set "VONVON_HOME=([^"\r\n]*)"\r?$/gm));
      capturedPath = unbatch(field(text, /^set "PATH=([^"\r\n]*)"\r?$/gm));
      const args = capture(text, /^"([^"\r\n]*)" "([^"\r\n]*)" daemon run --port ([0-9]+) >> "[^"\r\n]*" 2>> "[^"\r\n]*"\r?$/gm);
      executable = unbatch(args[0] ?? ''); entry = unbatch(args[1] ?? ''); port = Number(args[2]);
      desktop = text.includes('set "ELECTRON_RUN_AS_NODE=1"\r\n');
      break;
    }
  }
  const definition: DecodedDefinition = { root, capturedPath, port, distribution: { kind: desktop ? 'desktop' : 'npm', executable, entry } };
  const expected = render(target, definition);
  if (bytes.platform === 'darwin' && expected.platform === 'darwin' && Buffer.from(bytes.plist).equals(expected.plist)) return definition;
  if (bytes.platform === 'linux' && expected.platform === 'linux' && Buffer.from(bytes.unit).equals(expected.unit)) return definition;
  if (bytes.platform === 'win32' && expected.platform === 'win32' && target.platform === 'win32') {
    if (bytes.runValue !== expected.runValue) throw Object.assign(new Error('Run invocation does not match the generated format'), { location: `${WINDOWS_RUN_KEY}\\${WINDOWS_RUN_VALUE}` });
    if (!Buffer.from(bytes.vbs).equals(expected.vbs)) throw Object.assign(new Error('VBS does not match the generated format'), { location: target.vbsPath });
    if (Buffer.from(bytes.cmd).equals(expected.cmd)) return definition;
  }
  throw new Error('Definition does not match the complete generated format');
}
