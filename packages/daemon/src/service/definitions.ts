import { posix } from 'node:path';
import type { CanonicalRoot, Target } from './identity';

export type DistributionInput =
  | { kind: 'npm'; executable: string; entry: string }
  | { kind: 'desktop'; executable: string; entry: string }
  /** Rendered like `npm`; told apart by its `current` link paths (devices 7.2). */
  | { kind: 'standalone'; executable: string; entry: string }
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
  | { platform: 'linux'; unit: Uint8Array };

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
  for (const value of [root, distribution.executable, distribution.entry, capturedPath]) {
    literal(value);
  }
  for (const value of [root, distribution.executable, distribution.entry]) {
    if (!posix.isAbsolute(value)) {
      throw new InvalidDefinitionInput('Service paths must be fully absolute');
    }
  }
  const out = posix.join(root, 'service.log');
  const err = posix.join(root, 'service.err.log');
  const desktop = distribution.kind === 'desktop';
  switch (target.platform) {
    case 'darwin': {
      const string = (value: string) => `<string>${xml(value)}</string>`;
      const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n<key>Label</key>${string(target.label)}\n<key>ProgramArguments</key><array>${[distribution.executable, distribution.entry, 'daemon', 'run', '--port', String(port)].map(string).join('')}</array>\n<key>EnvironmentVariables</key><dict>\n<key>VONVON_HOME</key>${string(root)}\n<key>VONVON_SERVICE</key>${string('launchd')}\n<key>PATH</key>${string(capturedPath)}\n${desktop ? '<key>ELECTRON_RUN_AS_NODE</key><string>1</string>\n' : ''}</dict>\n<key>StandardOutPath</key>${string(out)}\n<key>StandardErrorPath</key>${string(err)}\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n<key>ThrottleInterval</key><integer>5</integer>\n</dict>\n</plist>\n`;
      return { platform: target.platform, plist: Buffer.from(plist) };
    }
    case 'linux': {
      const unit = `[Unit]\nDescription=Vonvon Bot daemon\n\n[Service]\nType=simple\nExecStart="${unitLiteral(distribution.executable)}" "${unitLiteral(distribution.entry, true)}" daemon run --port ${port}\nEnvironment="VONVON_HOME=${unitLiteral(root)}"\nEnvironment="VONVON_SERVICE=systemd"\nEnvironment="PATH=${unitLiteral(capturedPath)}"\n${desktop ? 'Environment="ELECTRON_RUN_AS_NODE=1"\n' : ''}StandardOutput=append:${out.replace(/%/g, '%%')}\nStandardError=append:${err.replace(/%/g, '%%')}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=infinity\n\n[Install]\nWantedBy=default.target\n`;
      return { platform: target.platform, unit: Buffer.from(unit) };
    }
  }
}

/** `<installRoot>/current/node/bin/node <installRoot>/current/app/bin/vonvon.mjs`, as distribution.ts serviceProgram writes it. */
function isStandaloneProgram(executable: string, entry: string): boolean {
  const suffix = '/current/app/bin/vonvon.mjs';
  return entry.endsWith(suffix) && executable === `${entry.slice(0, -suffix.length)}/current/node/bin/node`;
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
  }
  const standalone = !desktop && isStandaloneProgram(executable, entry);
  const definition: DecodedDefinition = { root, capturedPath, port, distribution: { kind: desktop ? 'desktop' : standalone ? 'standalone' : 'npm', executable, entry } };
  const expected = render(target, definition);
  if (bytes.platform === 'darwin' && expected.platform === 'darwin' && Buffer.from(bytes.plist).equals(expected.plist)) return definition;
  if (bytes.platform === 'linux' && expected.platform === 'linux' && Buffer.from(bytes.unit).equals(expected.unit)) return definition;
  throw new Error('Definition does not match the complete generated format');
}
