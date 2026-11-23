import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readlink, readdir, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const helper = fileURLToPath(new URL('release-code.py', import.meta.url));
const save = (p, value) => writeFile(p, JSON.stringify(value));

test('stable source delivery, isolated file selection, verified replacement, retries and retired-reader grace', { skip: process.platform === 'win32' }, async t => {
  const work = await realpath(await mkdtemp(join(tmpdir(), 'vonvon-source-test-')));
  t.after(() => rm(work, { recursive: true, force: true }));
  const repo = join(work, 'repo'), out = join(work, 'release'), root = join(work, 'host'), bin = join(work, 'bin');
  for (const dir of [repo, out, root, bin]) await mkdir(dir);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q');
  for (const dir of ['packages/daemon/src', 'packages/daemon/test', 'packages/desktop', 'deploy']) {
    await mkdir(join(repo, dir), { recursive: true });
  }
  await writeFile(join(repo, 'packages/daemon/src/example.ts'), 'export const answer = 42;\n');
  await writeFile(join(repo, 'packages/daemon/test/example.test.ts'), 'expect(answer).toBe(42);\n');
  await writeFile(join(repo, 'packages/daemon/test/private.ts'), 'const data = "-----BEGIN PRIVATE KEY-----";\n');
  await writeFile(join(repo, 'packages/daemon/src/.env'), 'not-for-readers\n');
  await writeFile(join(repo, 'deploy/config.ts'), 'not-for-readers\n');
  await symlink('../../../deploy/config.ts', join(repo, 'packages/daemon/src/linked.ts'));
  async function release(version) {
    for (const pkg of ['daemon', 'desktop']) await save(join(repo, 'packages', pkg, 'package.json'), { version });
    git('add', '-A'); git('-c', 'user.name=Fixture', '-c', 'user.email=f@example.test', 'commit', '-qm', version);
    const sourceSha = git('rev-parse', 'HEAD');
    await save(join(out, 'release-orchestration.json'), { format: 1, out, sha: sourceSha, version, seedRepo: repo });
    await save(join(out, 'release-handoff.json'), { format: 1, version, sourceSha, readyForWebsite: true });
    return sourceSha;
  }
  // Substitute the constrained SSH connection only; bytes traverse both real command entry points.
  await writeFile(join(bin, 'ssh'), '#!/bin/sh\nexec python3 "$RECEIVER_HELPER" receive --root "$TEST_ROOT"\n');
  await chmod(join(bin, 'ssh'), 0o700);
  const env = { ...process.env, PATH: bin + ':' + process.env.PATH, RECEIVER_HELPER: helper, TEST_ROOT: root };
  const send = () => spawnSync('python3', [helper, 'send', '--out', out, '--host', 'fixture'], { encoding: 'utf8', env });
  const first = await release('1.0.0');
  await writeFile(join(repo, 'packages/daemon/src/example.ts'), 'unpublished working copy');
  let reply = send();
  assert.equal(reply.status, 0, reply.stderr);
  const one = JSON.parse(reply.stdout);
  assert.deepEqual(one, JSON.parse(await readFile(join(out, 'release-code-receipt.json'), 'utf8')));
  assert.equal(one.sourceSha, first);
  const old = await realpath(join(root, 'current'));
  assert.deepEqual(await readdir(join(old, 'tree/packages/daemon/src')), ['example.ts']);
  assert.deepEqual(await readdir(join(old, 'tree/packages/daemon/test')), ['example.test.ts']);
  assert.deepEqual(await readdir(join(old, 'tree')), ['packages']);
  assert.equal(await readFile(join(old, 'tree/packages/daemon/src/example.ts'), 'utf8'), 'export const answer = 42;\n');
  assert.deepEqual(JSON.parse(send().stdout), one);
  await save(join(out, 'release-handoff.json'), { format: 1, version: '1.0.0', sourceSha: first, readyForWebsite: false });
  assert.notEqual(send().status, 0);
  assert.equal(await realpath(join(root, 'current')), old);
  const second = await release('1.1.0');
  reply = send(); assert.equal(reply.status, 0, reply.stderr);
  assert.equal(JSON.parse(reply.stdout).sourceSha, second);
  assert.equal(await readFile(join(old, 'tree/packages/daemon/src/example.ts'), 'utf8'), 'export const answer = 42;\n');
  const promoted = await readlink(join(root, 'current'));
  const damaged = spawnSync('python3', [helper, 'receive', '--root', root], {
    encoding: 'utf8', input: JSON.stringify({ bytes: 3, sha256: '0'.repeat(64) }) + '\nabc',
  });
  assert.notEqual(damaged.status, 0);
  assert.equal(await readlink(join(root, 'current')), promoted);
  await save(join(out, 'release-handoff.json'), { format: 1, version: '1.0.0', sourceSha: first, readyForWebsite: true });
  await save(join(out, 'release-orchestration.json'), { format: 1, out, sha: first, version: '1.0.0', seedRepo: repo });
  assert.notEqual(send().status, 0, 'late older receipt cannot downgrade current');
  assert.equal(await readlink(join(root, 'current')), promoted);
  await utimes(old, new Date(0), new Date(0));
  execFileSync('python3', [helper, 'prune', '--root', root]);
  await assert.rejects(realpath(old), { code: 'ENOENT' });
  assert.equal(await readlink(join(root, 'current')), promoted);
});
