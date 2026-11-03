// The standalone server's manifest signing key (docs/plans/server-5-release.md 4.2; server-3 C2). A key of its own, not
// the Windows desktop one. The private key is an external file named only by cos-server.json `updatePrivateKeyFile`;
// this tool never prints it.
//
//   create-key --out <absolute path>                       private key (0600, never overwritten); prints both public forms
//   public-key --key <private key file>                    prints both public forms
//   sign --key <file> --payload <json> --out <file> [--base-url <url>]
//   verify --public-key <base64 | PEM | file> --envelope <file> [--base-url <url>]
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { SERVER_BASE_URL } from './server-constants.mjs';
import { publicKeyForms, publicKeyFromPrivate, signServerManifest, verifyServerManifest } from './server-manifest.mjs';

const usage = `Usage: node scripts/server-update-signing.mjs <command>
  create-key --out /absolute/external/server-update.pem
  public-key --key /absolute/external/server-update.pem
  sign --key <private key> --payload <payload.json> --out <envelope.json> [--base-url ${SERVER_BASE_URL}]
  verify --public-key <base64 | PEM | PEM file> --envelope <envelope.json> [--base-url ${SERVER_BASE_URL}]
The base64 form goes into packages/daemon/server-update.json, the PEM form into install.sh's public key block.`;

const describe = forms => `publicKey (packages/daemon/server-update.json): ${forms.base64}\nPEM (install.sh, between BEGIN and END VONVON PUBKEY):\n${forms.pem}\n`;

/** Writes a new private key to `out` (refusing an existing file) and returns its public forms. */
export async function createServerKey(out) {
  if (!isAbsolute(out ?? '')) throw new Error('create-key needs an absolute --out outside the repository');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  await mkdir(dirname(out), { recursive: true, mode: 0o700 });
  await writeFile(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
  return publicKeyForms(publicKey);
}

async function publicKeyArgument(value) {
  if (!value) throw new Error('verify needs --public-key');
  const text = value.trim().startsWith('-----BEGIN') || /^[A-Za-z0-9+/]{43}=$/.test(value.trim()) ? value : await readFile(value, 'utf8');
  return text.trim();
}

export async function main(argv = process.argv.slice(2), write = text => process.stdout.write(text)) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: Object.fromEntries(['out', 'key', 'payload', 'envelope', 'public-key', 'base-url'].map(name => [name, { type: 'string' }])) });
  const [command, ...rest] = positionals;
  if (rest.length) throw new Error(usage);
  const baseURL = values['base-url'] ?? SERVER_BASE_URL;
  if (command === 'create-key') {
    const forms = await createServerKey(values.out);
    write(`Created the server update signing key; the private key stays in that file.\n${describe(forms)}`);
  } else if (command === 'public-key' && values.key) {
    write(describe(publicKeyFromPrivate(await readFile(values.key, 'utf8'))));
  } else if (command === 'sign' && values.key && values.payload && values.out) {
    const envelope = signServerManifest(JSON.parse(await readFile(values.payload, 'utf8')), await readFile(values.key, 'utf8'), baseURL);
    await writeFile(values.out, envelope, { flag: 'wx' });
    write(`Signed ${values.out}.\n`);
  } else if (command === 'verify' && values.envelope) {
    const payload = verifyServerManifest(await readFile(values.envelope), await publicKeyArgument(values['public-key']), baseURL);
    write(`${JSON.stringify(payload, null, 2)}\n`);
  } else throw new Error(usage);
}

const invoked = process.argv[1] ? await realpath(resolve(process.argv[1])).catch(() => null) : null;
if (invoked && invoked === await realpath(fileURLToPath(import.meta.url))) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
