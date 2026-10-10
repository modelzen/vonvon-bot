import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pin = '446b2a40ca75b5f725d7b0baab777b3a8f18b2e0';
const originalProvenanceSha256 = '70d912999a79c68a556c3ae40c516a3c3f2e51d821a5144b6af384792d9ec862';
const source = 'https://github.com/modelzen/feishu-codex-bridge';
const destination = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../packages/daemon');
const checkout = process.argv[2];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const git = (...args) => execFileSync('git', ['-C', checkout, ...args], { maxBuffer: 32 * 1024 * 1024 });

async function exists(file) {
  try { await fs.lstat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function lock(root) {
  const port = 20000 + Number.parseInt(hash(root).slice(0, 8), 16) % 40000;
  for (let attempt = 0; attempt < 200; attempt++) {
    const server = net.createServer(socket => socket.destroy());
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
      return server;
    } catch (error) {
      server.close();
      if (error.code !== 'EADDRINUSE') throw error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  throw new Error('Another import owns this destination; retry later');
}

async function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function atomicWrite(file, bytes) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } finally { await fs.rm(temporary, { force: true }); }
}

async function cleanStaging() {
  for (const entry of await fs.readdir(destination)) {
    if (/^\.import-[a-zA-Z0-9]{6}$/.test(entry)) await fs.rm(path.join(destination, entry), { recursive: true, force: true });
  }
}

async function main() {
  if (!checkout || process.argv.length !== 3) throw new Error('Usage: node scripts/import-core.mjs <bridge-checkout>');
  if (git('rev-parse', 'HEAD').toString().trim() !== pin) throw new Error(`Source HEAD must be ${pin}`);
  const tree = git('ls-tree', '-rz', pin, '--', 'src', 'test', 'LICENSE').toString().split('\0').filter(Boolean);
  const files = tree.map(row => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(row);
    if (!match) throw new Error(`Only regular source files are allowed: ${row}`);
    const [, mode, blob, name] = match;
    if (name.split('/').some(part => part === '..' || part === '.' || !part) || name.includes('\\')) throw new Error('Unsafe source path');
    const bytes = git('cat-file', 'blob', blob);
    return { path: name === 'LICENSE' ? 'LICENSE.bridge' : name, mode, sha256: hash(bytes), bytes };
  }).sort((a, b) => a.path.localeCompare(b.path, 'en'));
  if (!files.some(file => file.path === 'LICENSE.bridge') || !files.some(file => file.path.startsWith('src/')) || !files.some(file => file.path.startsWith('test/'))) throw new Error('Source snapshot is incomplete');
  const inventory = files.map(({ bytes, ...entry }) => entry);
  const identity = { source, commit: pin, files: inventory };
  const provenance = `# Daemon source provenance\n\nImported from [modelzen/feishu-codex-bridge](${source}/tree/${pin}) at commit \`${pin}\`.\nThe complete src and test trees are preserved at import time, including the temporary V2 web console.\nThe upstream MIT license is preserved in LICENSE.bridge. import-core.json records the original file hashes and modes.\n\nThis is a one-time source seed. A completed import never rewrites, repairs, or restores fork files.\nV2 adaptations are ordinary commits after the seed. V3 removes the temporary web console after RPC parity.\n`;
  await fs.mkdir(destination, { recursive: true });
  if (!(await fs.lstat(destination)).isDirectory()) throw new Error('Destination must be a physical directory');
  const owner = await lock(await fs.realpath(destination));
  try {
    const temporaryMetadata = /^(import-core\.json|PROVENANCE\.md)\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
    for (const name of await fs.readdir(destination)) {
      if (temporaryMetadata.test(name)) await fs.unlink(path.join(destination, name));
    }
    const manifestPath = path.join(destination, 'import-core.json');
    if (await exists(manifestPath)) {
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      if (json({ source: manifest.source, commit: manifest.commit, files: manifest.files }) !== json(identity)) throw new Error('Import manifest identity does not match the pinned source');
      if (manifest.phase === 'complete') { await cleanStaging(); console.log(`Import already complete at ${pin}; no files written`); return; }
      if (manifest.phase !== 'seeding') throw new Error('Unknown import phase');
    } else {
      for (const name of ['src', 'test', 'LICENSE.bridge']) {
        if (await exists(path.join(destination, name))) throw new Error(`Refusing unowned destination ${name}`);
      }
      if (await exists(path.join(destination, 'PROVENANCE.md'))) {
        const previous = await fs.readFile(path.join(destination, 'PROVENANCE.md'), 'utf8');
        if (hash(previous) !== originalProvenanceSha256) throw new Error('Refusing unowned provenance');
      }
      await atomicWrite(manifestPath, json({ ...identity, phase: 'seeding' }));
    }
    const provenancePath = path.join(destination, 'PROVENANCE.md');
    if (await exists(provenancePath)) {
      const previous = await fs.readFile(provenancePath, 'utf8');
      if (previous !== provenance && hash(previous) !== originalProvenanceSha256) throw new Error('Conflicting partial import: PROVENANCE.md');
    }
    await cleanStaging();
    const staging = await fs.mkdtemp(path.join(destination, '.import-'));
    try {
      for (const file of files) {
        const target = path.join(destination, file.path);
        let parent = destination;
        for (const segment of file.path.split('/').slice(0, -1)) {
          parent = path.join(parent, segment);
          if (await exists(parent)) {
            if (!(await fs.lstat(parent)).isDirectory()) throw new Error(`Unsafe destination parent: ${parent}`);
          } else {
            await fs.mkdir(parent);
            await syncDirectory(path.dirname(parent));
          }
        }
        if (await exists(target)) {
          const stat = await fs.lstat(target);
          if (!stat.isFile() || hash(await fs.readFile(target)) !== file.sha256 || (stat.mode & 0o777) !== (file.mode === '100755' ? 0o755 : 0o644)) throw new Error(`Conflicting partial import: ${file.path}`);
          continue;
        }
        await fs.mkdir(path.dirname(target), { recursive: true });
        const staged = path.join(staging, randomUUID());
        const handle = await fs.open(staged, 'wx', file.mode === '100755' ? 0o755 : 0o644);
        try {
          await handle.writeFile(file.bytes);
          await handle.chmod(file.mode === '100755' ? 0o755 : 0o644);
          await handle.sync();
        }
        finally { await handle.close(); }
        await fs.link(staged, target);
        await syncDirectory(path.dirname(target));
      }
      await atomicWrite(path.join(destination, 'PROVENANCE.md'), provenance);
      await atomicWrite(manifestPath, json({ ...identity, phase: 'complete' }));
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
    console.log(`Imported ${files.length} pinned files from ${pin}`);
  } finally { await new Promise(resolve => owner.close(resolve)); }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
