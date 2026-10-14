import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { currentHandoff, handoffLine, notifyAction } from './handoff.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), 'handoff.mjs');

function fixture({ labels, sessions, comments = [], dirty = false, behind = false, paseoFails = false, wait = { stdout: '{"status":"idle"}' } }) {
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
  const commentLines = (typeof comments === 'function' ? comments(sha) : comments).map((c) => JSON.stringify(c)).join('\n');
  writeFileSync(join(dir, 'comments.ndjson'), commentLines ? `${commentLines}\n` : '');
  const stub = (name, body) => {
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> ${JSON.stringify(log)}\n${body}\n`);
    chmodSync(file, 0o755);
  };
  stub('gh', `case "$*" in
  *"-X POST"*"/comments"*) echo '{"html_url":"https://example/c1"}' ;;
  *"/comments"*) cat ${JSON.stringify(join(dir, 'comments.ndjson'))} ;;
  *"/pulls/"*) cat ${JSON.stringify(join(dir, 'pull.json'))} ;;
  *) echo '[]' ;;
esac`);
  stub('paseo', `case "$*" in
  *" ls "*) cat ${JSON.stringify(join(dir, 'sessions.json'))} ;;
  *" wait "*) printf '%s\\n' ${JSON.stringify(wait.stdout ?? '')}; exit ${wait.exit ?? 0} ;;
  *) ${paseoFails ? 'exit 1' : 'true'} ;;
esac`);

  const comment = join(dir, 'comment.md');
  writeFileSync(comment, 'Linux 证据与验收要点。\n');
  const handoff = (...extra) => spawnSync('node', [script, '7', '--to', 'codex', ...(extra.includes('--notify-only') || extra.includes('--no-defaults') ? [] : ['--comment-file', comment, '--quota-wait', '0']), ...extra.filter((a) => a !== '--no-defaults')], {
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

test('the comment records the handoff count and the quota wait, and a handoff without --quota-wait refuses', () => {
  const f = fixture({ labels: ['owner:claude'], sessions: [], comments: (sha) => [
    { html_url: 'https://example/c0', body: `首轮\n\n${handoffLine('claude', 'codex', '0000000000')}` },
    { html_url: 'https://example/c1', body: `退回\n\n${handoffLine('codex', 'claude', sha)}` },
    { html_url: 'https://example/c2', body: '审查意见' },
  ] });
  try {
    const result = f.handoff('--no-defaults', '--comment-file', join(f.dir, 'comment.md'), '--quota-wait', '40 分钟，Claude 周限额', '--dry-run');
    assert.equal(result.status, 0, result.stderr);
    assert.match(JSON.parse(result.stdout).comment, /\n交接：claude → codex，head `[0-9a-f]{7}`。\n本 PR 第 3 次交接，等待额度阻塞：40 分钟，Claude 周限额。$/);

    const before = f.calls().length;
    const refused = f.handoff('--no-defaults', '--comment-file', join(f.dir, 'comment.md'));
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /--quota-wait/);
    assert.deepEqual(f.calls().slice(before), [], 'the refusal reads, writes and notifies nothing');
  } finally { f.cleanup(); }
});

test('an option with a missing value refuses before any external call instead of swallowing the next option', () => {
  for (const missing of ['--to', '--comment-file', '--quota-wait']) {
    const f = fixture({ labels: ['owner:claude'], sessions: [] });
    try {
      const given = { '--to': ['--to', 'codex'], '--comment-file': ['--comment-file', join(f.dir, 'comment.md')], '--quota-wait': ['--quota-wait', '0'] };
      const argv = ['7', ...Object.entries(given).flatMap(([flag, pair]) => (flag === missing ? [] : pair)), missing, '--dry-run'];
      const result = spawnSync('node', [script, ...argv], { cwd: f.dir, encoding: 'utf8', env: { ...process.env, PATH: `${f.dir}:${process.env.PATH}` } });
      assert.equal(result.status, 1, `${missing}: ${result.stdout}${result.stderr}`);
      assert.match(result.stderr, new RegExp(`${missing} needs a value`), missing);
      assert.deepEqual(f.calls(), [], `${missing}: no read, write or notice`);
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

const handedToCodex = (sha) => [{ html_url: 'https://example/c0', body: `证据\n\n${handoffLine('claude', 'codex', sha)}` }];
const idle = [{ name: 'PR #7', status: 'idle', shortId: 'abc' }];
const busy = [{ name: 'PR #7', status: 'running', shortId: 'abc' }];

test('currentHandoff takes the latest handoff comment only when it hands this head in this direction', () => {
  const sha = 'abcdef0123';
  const to = { html_url: 'a', body: `x\n\n${handoffLine('claude', 'codex', sha)}` };
  const back = { html_url: 'b', body: `y\n\n${handoffLine('codex', 'claude', sha)}` };
  const chat = { html_url: 'c', body: 'a review note' };
  assert.equal(currentHandoff([to, chat], 'claude', 'codex', sha), to);
  assert.equal(currentHandoff([to, back], 'claude', 'codex', sha), undefined);
  assert.equal(currentHandoff([to], 'claude', 'codex', '1234567890'), undefined);
});

test('a failed notice leaves the handoff done and points to --notify-only', () => {
  const f = fixture({ labels: ['owner:claude'], sessions: idle, paseoFails: true });
  try {
    const result = f.handoff();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /handed over .*\nrerun with --notify-only/s);
    assert.ok(f.calls().some((c) => c.includes('labels[]=owner:codex')), 'the label still moved');
  } finally { f.cleanup(); }
});

test('--notify-only resends a link to the handoff comment for the current head, without writing to GitHub', () => {
  const f = fixture({ labels: ['owner:codex'], sessions: idle, comments: handedToCodex });
  try {
    const result = f.handoff('--notify-only');
    assert.equal(result.status, 0, result.stderr);
    const send = f.calls().find((c) => c.includes(' send '));
    assert.ok(send?.startsWith('paseo --host 100.127.134.58:6767 send abc --no-wait PR #7 已交给你'), f.calls().join(' | '));
    assert.match(send, /见 https:\/\/example\/c0。/);
    assert.ok(!f.calls().some((c) => c.includes('-X')), 'no GitHub write');
  } finally { f.cleanup(); }
});

test('--notify-only refuses when no handoff comment hands the current head to the receiver', () => {
  const f = fixture({ labels: ['owner:codex'], sessions: idle, comments: handedToCodex('0000000000') });
  try {
    const result = f.handoff('--notify-only');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not hand head/);
    assert.ok(!f.calls().some((c) => c.includes(' send ')), 'nothing sent');
  } finally { f.cleanup(); }
});

test('--notify-only --dry-run reports the notice and sends nothing', () => {
  const f = fixture({ labels: ['owner:codex'], sessions: idle, comments: handedToCodex });
  try {
    const result = f.handoff('--notify-only', '--dry-run');
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.comment, 'https://example/c0');
    assert.deepEqual(report.notify, { kind: 'send', id: 'abc' });
    assert.ok(!f.calls().some((c) => c.includes('-X') || c.includes(' run ') || c.includes(' send ')), f.calls().join(' | '));
  } finally { f.cleanup(); }
});

const timeout = { stdout: '{"agentId":"abc","status":"timeout","message":"Agent did not finish within 300 seconds."}' };

test('a busy session is sent the notice only after paseo wait reports it idle', () => {
  const f = fixture({ labels: ['owner:claude'], sessions: busy });
  try {
    const result = f.handoff();
    assert.equal(result.status, 0, result.stderr);
    const calls = f.calls();
    const wait = calls.findIndex((c) => c.startsWith('paseo --host 100.127.134.58:6767 wait abc --timeout 300 --json'));
    const send = calls.findIndex((c) => c.includes(' send abc '));
    assert.ok(wait >= 0 && wait < send, calls.join(' | '));
  } finally { f.cleanup(); }
});

test('a wait that does not report idle fails the run with nothing sent, even when paseo exits 0', () => {
  for (const [name, wait, status] of [
    ['timeout', timeout, /ended with timeout/],
    ['unknown agent', { stdout: '{"agentId":"abc","status":"error","message":"Agent not found: abc"}' }, /ended with error/],
    ['unparseable', { stdout: 'Agent is idle.' }, /ended with failed/],
    ['nonzero exit', { stdout: '', exit: 1 }, /ended with failed/],
  ]) {
    const f = fixture({ labels: ['owner:claude'], sessions: busy, wait });
    try {
      const result = f.handoff();
      assert.equal(result.status, 1, name);
      assert.match(result.stderr, status, name);
      assert.match(result.stderr, /nothing was sent\nrerun with --notify-only/, name);
      assert.ok(!f.calls().some((c) => c.includes(' send ')), `${name}: nothing sent`);
    } finally { f.cleanup(); }
  }
});

test('--notify-only to a busy session also refuses to send on a timed-out wait', () => {
  const f = fixture({ labels: ['owner:codex'], sessions: busy, comments: handedToCodex, wait: timeout });
  try {
    const result = f.handoff('--notify-only');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ended with timeout, so nothing was sent\nrerun with --notify-only/);
    assert.ok(!f.calls().some((c) => c.includes(' send ')), f.calls().join(' | '));
  } finally { f.cleanup(); }
});

test('a rerun after an interrupted handoff reuses the posted comment and finishes the labels', () => {
  const f = fixture({ labels: ['owner:claude', 'owner:codex'], sessions: idle, comments: handedToCodex });
  try {
    const result = f.handoff();
    assert.equal(result.status, 0, result.stderr);
    const calls = f.calls();
    assert.ok(!calls.some((c) => c.includes('-X POST') && c.includes('/comments')), 'no second comment');
    assert.ok(calls.some((c) => c.includes('DELETE') && c.includes('labels/owner:claude')), calls.join(' | '));
    assert.match(calls.find((c) => c.includes(' send ')), /见 https:\/\/example\/c0。/);
  } finally { f.cleanup(); }
});
