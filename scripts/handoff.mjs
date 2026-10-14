#!/usr/bin/env node
// Hands a PR from Claude to Codex or back, per AGENTS.md.
//
//   node scripts/handoff.mjs <pr> --to codex|claude --comment-file <path> --quota-wait <text> [--dry-run]
//   node scripts/handoff.mjs <pr> --to codex|claude --notify-only [--dry-run]   resend the notice after a failed one
//
// State lives only on GitHub: the comment and the owner: label. Paseo only carries a notice
// that names the PR and the comment, so a lost or repeated notice changes nothing.
// A rerun after an interruption reuses the handoff comment for the same head instead of posting another.
// Needs `gh` authenticated and `paseo` on PATH.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = 'modelzen/vonvon-bot';

export const SIDES = {
  claude: {
    host: '100.121.117.46:6767',
    cwd: '/home/ops/vonvon/vonvon-bot',
    run: ['--provider', 'claude/claude-opus-5-5', '--thinking', 'medium'],
  },
  codex: {
    host: '100.127.134.58:6767',
    cwd: '/Users/clay/develop/src/github.com/ClayCheung/vonvon-bot',
    run: ['--provider', 'codex/gpt-6.1-sol', '--thinking', 'high', '--mode', 'full-access'],
  },
};

export const sessionTitle = (pr) => `PR #${pr}`;

// A busy receiver is waited on in the foreground, within one agent tool call, so a failure is reported, not lost.
const WAIT_SECONDS = 300;

export const handoffLine = (from, to, sha) => `交接：${from} → ${to}，head \`${sha.slice(0, 7)}\`。`;
const HANDOFF_LINE = /^交接：\w+ → \w+，head `[0-9a-f]{7}`。$/m;

// The per-PR record the subscription review reads after a week: how often the PR changed hands, and how long it waited on quota.
export const recordLine = (count, quotaWait) => `本 PR 第 ${count} 次交接，等待额度阻塞：${quotaWait}。`;
export const handoffCount = (comments) => comments.filter((c) => HANDOFF_LINE.test(c.body)).length + 1;

// The latest handoff comment, if it hands this head from `from` to `to`.
export function currentHandoff(comments, from, to, sha) {
  const latest = comments.filter((c) => HANDOFF_LINE.test(c.body)).at(-1);
  return latest && latest.body.match(HANDOFF_LINE)[0] === handoffLine(from, to, sha) ? latest : undefined;
}

// `paseo send` interrupts a running turn by default, so a busy session is notified only once it is idle.
export function notifyAction(sessions, pr) {
  const matches = sessions.filter((s) => s.name === sessionTitle(pr));
  if (matches.length > 1) return { kind: 'ambiguous', ids: matches.map((s) => s.shortId ?? s.id) };
  if (matches.length === 0) return { kind: 'create' };
  const [session] = matches;
  return { kind: session.status === 'running' ? 'send-when-idle' : 'send', id: session.shortId ?? session.id };
}

function parseArgs(argv) {
  const args = { dryRun: false, notifyOnly: false };
  // A missing value must not swallow the next option: `--quota-wait --dry-run` would otherwise run a real handoff.
  const value = (i) => {
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`${argv[i]} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--to') args.to = value(i++);
    else if (arg === '--comment-file') args.commentFile = value(i++);
    else if (arg === '--quota-wait') args.quotaWait = value(i++).trim();
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--notify-only') args.notifyOnly = true;
    else if (/^\d+$/.test(arg)) args.pr = Number(arg);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.pr || !SIDES[args.to] || !args.commentFile === !args.notifyOnly || !args.commentFile !== !args.quotaWait) {
    throw new Error('usage: node scripts/handoff.mjs <pr> --to codex|claude (--comment-file <path> --quota-wait <text> | --notify-only) [--dry-run]\n'
      + '--quota-wait names the time this round waited on model quota, for example 0 or "40 分钟，Claude 周限额"');
  }
  return args;
}

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts }).trim();
const gh = (args) => run('gh', ['api', ...args]);

// Compares commits, not branch names: Paseo's checkout-pr suffixes the local branch when another worktree holds it.
function checkLocal(head) {
  if (run('git', ['status', '--porcelain'])) throw new Error('the worktree has uncommitted changes');
  const local = run('git', ['rev-parse', 'HEAD']);
  if (local !== head.sha) throw new Error(`local HEAD ${local.slice(0, 7)} is not the PR head ${head.sha.slice(0, 7)}; push first`);
}

function planNotice(pr, to, url) {
  const paseo = ['--host', SIDES[to].host];
  const action = notifyAction(JSON.parse(run('paseo', [...paseo, 'ls', '--json'])), pr);
  if (action.kind === 'ambiguous') throw new Error(`more than one session titled "${sessionTitle(pr)}": ${action.ids.join(', ')}`);
  return { ...action, notice: `PR #${pr} 已交给你（owner:${to}），见 ${url}。按仓库 AGENTS.md 处理，交接内容以 PR 评论为准。` };
}

function sendNotice(pr, to, { kind, id, notice }) {
  const target = SIDES[to];
  const paseo = ['--host', target.host];
  if (kind === 'create') {
    run('paseo', [...paseo, 'run', '-d', ...target.run, '--title', sessionTitle(pr), '--cwd', target.cwd,
      '--new-workspace', 'worktree', '--worktree-mode', 'checkout-pr', '--pr-number', String(pr),
      `先进入 pstack:poteto-mode。${notice}`]);
    return;
  }
  if (kind === 'send-when-idle') {
    // `paseo wait` exits 0 on idle, timeout, and unknown agents alike; only the reported status tells them apart.
    let status;
    try {
      status = JSON.parse(run('paseo', [...paseo, 'wait', id, '--timeout', String(WAIT_SECONDS), '--json'])).status;
    } catch (error) {
      status = `failed (${error.message.split('\n')[0]})`;
    }
    if (status !== 'idle') throw new Error(`waiting ${WAIT_SECONDS}s for session ${id} to be idle ended with ${status}, so nothing was sent`);
  }
  run('paseo', [...paseo, 'send', id, '--no-wait', notice]);
}

const describe = ({ kind, id }) => `${kind}${id ? ` ${id}` : ''}`;

function main(argv) {
  const { pr, to, commentFile, quotaWait, dryRun, notifyOnly } = parseArgs(argv);
  const from = to === 'codex' ? 'claude' : 'codex';

  const pull = JSON.parse(gh([`repos/${REPO}/pulls/${pr}`]));
  if (pull.state !== 'open') throw new Error(`PR #${pr} is ${pull.state}`);
  const labels = pull.labels.map((l) => l.name);
  const comments = run('gh', ['api', '--paginate', `repos/${REPO}/issues/${pr}/comments`, '--jq', '.[] | {html_url, body}'])
    .split('\n').filter(Boolean).map((line) => JSON.parse(line));
  let handoff = currentHandoff(comments, from, to, pull.head.sha);

  if (notifyOnly) {
    if (!labels.includes(`owner:${to}`)) throw new Error(`PR #${pr} is not owned by ${to}; hand it over first`);
    if (!handoff) throw new Error(`the latest handoff comment on PR #${pr} does not hand head ${pull.head.sha.slice(0, 7)} from ${from} to ${to}`);
    const plan = planNotice(pr, to, handoff.html_url);
    if (dryRun) {
      const { notice, ...action } = plan;
      console.log(JSON.stringify({ pr, from, to, head: pull.head.sha, comment: handoff.html_url, notify: action }, null, 2));
      return;
    }
    try {
      sendNotice(pr, to, plan);
    } catch (error) {
      throw new Error(`${error.message}\nrerun with --notify-only`);
    }
    console.log(`PR #${pr} → ${to}: notice ${describe(plan)} for ${handoff.html_url}`);
    return;
  }

  if (!labels.includes(`owner:${from}`)) {
    throw new Error(`PR #${pr} is not owned by ${from} (labels: ${labels.join(', ') || 'none'})`);
  }
  checkLocal(pull.head);

  const body = `${readFileSync(commentFile, 'utf8').trimEnd()}\n\n${handoffLine(from, to, pull.head.sha)}\n${recordLine(handoffCount(comments), quotaWait)}`;
  if (dryRun) {
    const { notice, ...plan } = planNotice(pr, to, handoff?.html_url ?? '<new comment>');
    console.log(JSON.stringify({ pr, from, to, head: pull.head.sha, reuse: handoff?.html_url ?? null, notify: plan, comment: body }, null, 2));
    return;
  }

  if (!handoff) {
    const dir = mkdtempSync(join(tmpdir(), 'handoff-'));
    const bodyFile = join(dir, 'body.md');
    writeFileSync(bodyFile, body);
    handoff = JSON.parse(gh(['-X', 'POST', `repos/${REPO}/issues/${pr}/comments`, '-F', `body=@${bodyFile}`]));
  }
  // Add before remove: an interrupted run leaves both labels, which a rerun passes and finishes.
  gh(['-X', 'POST', `repos/${REPO}/issues/${pr}/labels`, '-f', `labels[]=owner:${to}`]);
  gh(['-X', 'DELETE', `repos/${REPO}/issues/${pr}/labels/owner:${from}`]);

  try {
    const plan = planNotice(pr, to, handoff.html_url);
    sendNotice(pr, to, plan);
    console.log(`PR #${pr} → ${to}: ${handoff.html_url} (notice: ${describe(plan)})`);
  } catch (error) {
    throw new Error(`handed over (${handoff.html_url}) but the notice failed: ${error.message}\nrerun with --notify-only`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`handoff: ${error.message}`);
    process.exit(1);
  }
}
