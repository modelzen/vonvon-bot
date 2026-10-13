import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { notifyAction } from './handoff.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'handoff.mjs');

function fixture({ labels, sessions, dirty = false, behind = false, paseoFails = false }) {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-test-'));
  const repo = join(dir, 'repo');
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '-b', 'claude/x', repo]);
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'one');
  const sha = git('rev-parse', 'HEAD');
  if (behind) git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'two');
  if (dirty) writeFileSync(join(repo, 'new.txt'), 'x');

  const log = join(dir, 'calls.log');
  const pull = { state: 'open', html_url: 'https://example/pr7', labels: labels.map((name) => ({ name })), head: { ref: 'claude/x', sha } };
  writeFileSync(join(dir, 'pull.json'), JSON.stringify(pull));
  writeFileSync(join(dir, 'sessions.json'), JSON.stringify(sessions));
  const stub = (name, body) => {
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> ${JSON.stringify(log)}\n${body}\n`);
    chmodSync(file, 0o755);
  };
  stub('gh', `case "$*" in
  *"/comments"*) echo '{"html_url":"https://example/c1"}' ;;
  *"/pulls/"*) cat ${JSON.stringify(join(dir, 'pull.json'))} ;;
  *) echo '[]' ;;
esac`);
  stub('paseo', `case "$*" in *" ls "*) cat ${JSON.stringify(join(dir, 'sessions.json'))} ;; *) ${paseoFails ? 'exit 1' : 'true'} ;; esac`);

  const comment = join(dir, 'comment.md');
  writeFileSync(comment, 'Linux 证据与验收要点。\n');
  const handoff = (...extra) => spawnSync('node', [script, '7', '--to', 'codex', ...(extra.includes('--notify-only') ? [] : ['--comment-file', comment]), ...extra], {
    cwd: repo, encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
  const calls = () => { try { return readFileSync(log, 'utf8').trim().split('\n'); } catch { return []; } };
  return { dir, sha, handoff, calls, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('notifyAction creates, sends, defers, or refuses by the session titled after the PR', () => {
  assert.deepEqual(notifyAction([{ name: 'PR #70', status: 'idle', shortId: 'a' }], 7), { kind: 'create' });
  assert.deepEqual(notifyAction([{ name: 'PR #7', status: 'idle', shortId: 'a' }], 7), { kind: 'send', id: 'a' });
  assert.deepEqual(notifyAction([{ name: 'PR #7', status: 'running', shortId: 'a' }], 7), { kind: 'send-when-idle', id: 'a' });
  assert.equal(notifyAction([{ name: 'PR #7', shortId: 'a' }, { name: 'PR #7', shortId: 'b' }], 7).kind, 'ambiguous');
});

test('a handoff posts the comment, adds the new owner before removing the old, then notifies the idle session', () => {
  const f = fixture({ labels: ['owner:claude'], sessions: [{ name: 'PR #7', status: 'idle', shortId: 'abc' }] });
  try {
    const result = f.handoff();
    assert.equal(result.status, 0, result.stderr);
    const calls = f.calls();
    const comment = calls.findIndex((c) => c.includes('/issues/7/comments'));
    const add = calls.findIndex((c) => c.includes('labels[]=owner:codex'));
    const remove = calls.findIndex((c) => c.includes('DELETE') && c.includes('labels/owner:claude'));
    assert.ok(comment >= 0 && comment < add && add < remove, `order: ${calls.join(' | ')}`);
    assert.ok(calls.some((c) => c.startsWith('paseo --host 100.127.134.58:6767 send abc --no-wait PR #7 已交给你')), calls.join(' | '));
    assert.ok(!calls.some((c) => c.includes(' run ')), 'an existing session is not duplicated');
  } finally { f.cleanup(); }
});

test('with no session for the PR, a handoff creates one titled after it on the receiving host', () => {
  const f = fixture({ labels: ['owner:claude'], sessions: [] });
  try {
    const result = f.handoff();
    assert.equal(result.status, 0, result.stderr);
    const create = f.calls().find((c) => c.startsWith('paseo') && c.includes(' run '));
    assert.ok(create, 'a session is created');
    assert.match(create, /--provider codex\/gpt-6\.1-sol .*--title PR #7 .*--new-workspace worktree --worktree-mode checkout-pr --pr-number 7/);
  } finally { f.cleanup(); }
});

test('a handoff refuses without side effects when the PR is not ours, the tree is dirty, or the head is not pushed', () => {
  for (const [name, opts, message] of [
    ['not owner', { labels: ['owner:codex'] }, /not owned by claude/],
    ['dirty', { labels: ['owner:claude'], dirty: true }, /uncommitted/],
    ['unpushed', { labels: ['owner:claude'], behind: true }, /push first/],
  ]) {
    const f = fixture({ sessions: [], ...opts });
    try {
      const result = f.handoff();
      assert.equal(result.status, 1, name);
      assert.match(result.stderr, message, name);
      assert.ok(!f.calls().some((c) => c.includes('-X')), `${name}: no GitHub write`);
      assert.ok(!f.calls().some((c) => c.startsWith('paseo')), `${name}: no notice`);
    } finally { f.cleanup(); }
  }
});

test('--dry-run reads and reports but writes nothing', () => {
  const f = fixture({ labels: ['owner:claude'], sessions: [] });
  try {
    const result = f.handoff('--dry-run');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).notify.kind, 'create');
    assert.ok(!f.calls().some((c) => c.includes('-X') || c.includes(' run ') || c.includes(' send ')));
  } finally { f.cleanup(); }
});

test('a failed notice leaves the handoff done and points to --notify-only, which resends without writing', () => {
  const f = fixture({ labels: ['owner:claude'], sessions: [{ name: 'PR #7', status: 'idle', shortId: 'abc' }], paseoFails: true });
  try {
    const result = f.handoff();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /handed over .*\nrerun with --notify-only/s);
    assert.ok(f.calls().some((c) => c.includes('labels[]=owner:codex')), 'the label still moved');
  } finally { f.cleanup(); }

  const g = fixture({ labels: ['owner:codex'], sessions: [{ name: 'PR #7', status: 'idle', shortId: 'abc' }] });
  try {
    const result = g.handoff('--notify-only');
    assert.equal(result.status, 0, result.stderr);
    assert.ok(g.calls().some((c) => c.startsWith('paseo --host 100.127.134.58:6767 send abc --no-wait PR #7 已交给你')));
    assert.ok(!g.calls().some((c) => c.includes('-X')), 'no GitHub write');
  } finally { g.cleanup(); }
});
