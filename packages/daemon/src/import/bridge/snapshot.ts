import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { inspectLocalPath, LocalFileSafetyError, readLocalText } from './bounded-local-files';
import { BridgeSecretSourceSchema, BridgeSnapshotSchema, convertBridgeSnapshot, type BridgeConversion } from './conversion';

const configEnvelope = z.object({ accounts: z.object({ app: z.object({ secret: z.unknown() }).passthrough() }) }).passthrough();
const encryptedStore = z.object({ version: z.literal(1), entries: z.record(z.string(), z.unknown()) });
const base64 = (bytes?: number) => z.string().max(128 * 1024).refine(value => {
  const decoded = Buffer.from(value, 'base64');
  return decoded.length > 0 && (bytes === undefined || decoded.length === bytes) && decoded.toString('base64') === value;
});
const envelopeSchema = z.object({ iv: base64(12), data: base64(), tag: base64(16) }).strict();
type Envelope = z.infer<typeof envelopeSchema>;
export interface SnapshotIssue { readonly appId?: string; readonly file: string; readonly code: string }
export interface BridgeSnapshotIdentity {
  readonly bots: readonly { readonly appId: string; readonly tenant: 'feishu' | 'lark' }[];
  readonly registrySha256: string;
}
export type BridgeSnapshotRead =
  | { readonly kind: 'invalid'; readonly issues: readonly SnapshotIssue[] }
  | { readonly kind: 'read'; readonly identity: BridgeSnapshotIdentity; readonly conversion: BridgeConversion;
      readonly issues: readonly SnapshotIssue[]; readonly legacySecrets: Readonly<Record<string, Envelope>> };
export interface BridgeSnapshotOptions {
  readonly sourceDir: string;
  readonly destinationSecretsGetter: string;
  readonly signal?: AbortSignal;
}
class SnapshotError extends Error {
  constructor(readonly code: string) { super(code); }
}
function code(error: unknown): string {
  if (error instanceof SnapshotError) return error.code;
  if (error instanceof LocalFileSafetyError) return error.problem;
  if (error instanceof SyntaxError) return 'invalid-json';
  if (error instanceof z.ZodError) return 'invalid-schema';
  return 'unreadable';
}

/** Read-only data foundation; callers must stop/lock and read again before staging.
 * Neither provider resolution nor key derivation/decryption occurs here. */
export async function readBridgeSnapshot(options: BridgeSnapshotOptions): Promise<BridgeSnapshotRead> {
  let file = '.';
  try {
    if (!isAbsolute(options.sourceDir) || options.sourceDir.includes('\0')) throw new SnapshotError('source-path');
    const root = resolve(options.sourceDir);
    const directory = await inspectLocalPath(root, root, options.signal);
    if (!directory?.isDirectory()) throw new SnapshotError('not-directory');
    async function text(relative: string, optional = false): Promise<string | undefined> {
      const path = join(root, relative);
      const before = await inspectLocalPath(root, path, options.signal);
      if (!before) {
        if (optional) return undefined;
        throw new SnapshotError('missing-file');
      }
      if (!before.isFile() || before.nlink !== 1) throw new SnapshotError('not-regular-file');
      const contents = await readLocalText(root, path, options.signal);
      const after = await inspectLocalPath(root, path, options.signal);
      if (contents === undefined || !after?.isFile() || after.nlink !== 1
        || before.dev !== after.dev || before.ino !== after.ino
        || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new SnapshotError('source-changed');
      return contents;
    }
    async function json(relative: string): Promise<unknown> {
      const contents = await text(relative);
      if (contents === undefined) throw new SnapshotError('missing-file');
      return JSON.parse(contents) as unknown;
    }
    file = 'bots.json';
    const registry = BridgeSnapshotSchema.shape.registry.parse(await json(file));
    // The conversion's identity regex uses $, so explicitly refuse final newlines too.
    if ((registry.current !== undefined && /[^A-Za-z0-9_-]/.test(registry.current))
      || registry.bots.some(bot => /[^A-Za-z0-9_-]/.test(bot.appId))
      || new Set(registry.bots.map(bot => bot.appId)).size !== registry.bots.length) throw new SnapshotError('invalid-registry');
    const ordered = [...registry.bots].sort((a, b) => a.appId < b.appId ? -1 : a.appId > b.appId ? 1 : 0);
    const identity: BridgeSnapshotIdentity = {
      bots: ordered.map(({ appId, tenant }) => ({ appId, tenant })),
      registrySha256: createHash('sha256').update(JSON.stringify({ ...registry, bots: ordered })).digest('hex'),
    };
    const issues: SnapshotIssue[] = [];
    const bots: unknown[] = [];
    const legacySecrets: Record<string, Envelope> = Object.create(null);
    let store: Promise<z.infer<typeof encryptedStore>> | undefined;
    for (const entry of registry.bots) {
      const base = join('bots', entry.appId);
      try {
        file = join(base, 'config.json');
        const config = configEnvelope.parse(await json(file));
        const raw = config.accounts.app.secret;
        let secret: z.infer<typeof BridgeSecretSourceSchema>;
        if (typeof raw === 'string') {
          if (!raw.length) throw new SnapshotError('invalid-secret');
          secret = { kind: 'plaintext' };
        } else {
          const external = BridgeSecretSourceSchema.parse({ kind: 'external', reference: raw });
          if (external.kind !== 'external') throw new SnapshotError('invalid-secret');
          const reference = external.reference;
          secret = reference.source === 'exec' && reference.provider === 'bridge'
            ? { kind: 'legacy-keystore', id: reference.id } : external;
          if (secret.kind === 'legacy-keystore') {
            file = 'secrets.enc';
            store ??= json(file).then(value => encryptedStore.parse(value));
            const entries = (await store).entries;
            if (!Object.hasOwn(entries, secret.id)) throw new SnapshotError('missing-secret');
            legacySecrets[secret.id] = envelopeSchema.parse(entries[secret.id]);
          }
        }
        file = join(base, 'projects.json');
        const projects = await json(file);
        file = join(base, 'sessions.json');
        const sessions = await json(file);
        file = join(base, 'comment-instructions.md');
        const commentInstructions = await text(file, true) ?? null;
        file = join(base, 'outbound-files');
        const outbound = await inspectLocalPath(root, join(root, file), options.signal);
        if (outbound && !outbound.isDirectory()) throw new SnapshotError('not-directory');
        bots.push({ appId: entry.appId, config: { ...config, accounts: {
          app: { ...config.accounts.app, secret },
        } }, projects, sessions, commentInstructions, outboundFilesPresent: outbound !== undefined });
      } catch (error) {
        issues.push({ appId: entry.appId, file, code: code(error) });
        bots.push({ appId: entry.appId });
      }
    }
    return { kind: 'read', identity, issues, legacySecrets, conversion: convertBridgeSnapshot({
      destinationSecretsGetter: options.destinationSecretsGetter, registry, bots,
    }) };
  } catch (error) { return { kind: 'invalid', issues: [{ file, code: code(error) }] }; }
}
