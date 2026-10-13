import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest } from './package-tools.mjs';

export async function checkPackage(tarball, head) {
  const names = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim().split('\n');
  for (const name of names) {
    const normalized = posix.normalize(name);
    if (!name.startsWith('package/') || normalized !== name.replace(/\/$/, '') && normalized !== name || name.includes('..') || isAbsolute(name)) throw new Error(`unsafe tar entry: ${name}`);
  }
  const listing = execFileSync('tar', ['-tvzf', tarball], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim().split('\n');
  for (const line of listing) if (!['-', 'd'].includes(line[0])) throw new Error(`tar entry type refused: ${line}`);
  const temporary = await mkdtemp(join(tmpdir(), 'vonvon-check-'));
  try {
    execFileSync('tar', ['-xzf', tarball, '-C', temporary, '--no-same-owner']);
    const root = join(temporary, 'package');
    const manifest = JSON.parse(await readFile(join(root, 'build-manifest.json'), 'utf8'));
    return await validateManifest(root, manifest, head);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [tarball, option, head] = process.argv.slice(2);
  if (!tarball || option !== '--head' || !head) throw new Error('usage: check-vonvon-bot-package.mjs <tarball> --head <sha>');
  try { process.stdout.write(JSON.stringify({ ok: true, ...await checkPackage(tarball, head) }) + '\n'); }
  catch (error) { process.stderr.write(JSON.stringify({ ok: false, error: String(error) }) + '\n'); process.exitCode = 1; }
}
