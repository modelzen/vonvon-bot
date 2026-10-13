#!/usr/bin/env node
// Hands a PR from Claude to Codex or back, per AGENTS.md.
//
//   node scripts/handoff.mjs <pr> --to codex|claude --comment-file <path> [--dry-run]
//   node scripts/handoff.mjs <pr> --to codex|claude --notify-only     resend the notice after a failed one
//
// State lives only on GitHub: the comment and the owner: label. Paseo only carries a notice
// that names the PR and the comment, so a lost or repeated notice changes nothing.
// Needs `gh` authenticated and `paseo` on PATH.

import { execFileSync, spawn } from 'node:child_process';
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
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--to') args.to = argv[++i];
    else if (arg === '--comment-file') args.commentFile = argv[++i];
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--notify-only') args.notifyOnly = true;
    else if (/^\d+$/.test(arg)) args.pr = Number(arg);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.pr || !SIDES[args.to] || (!args.commentFile && !args.notifyOnly)) {
    throw new Error('usage: node scripts/handoff.mjs <pr> --to codex|claude (--comment-file <path> [--dry-run] | --notify-only)');
  }
  return args;
}

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts }).trim();
const gh = (args) => run('gh', ['api', ...args]);

function checkLocal(head) {
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== head.ref) throw new Error(`current branch ${branch} is not the PR head ${head.ref}`);
  if (run('git', ['status', '--porcelain'])) throw new Error('the worktree has uncommitted changes');
  const local = run('git', ['rev-parse', 'HEAD']);
  if (local !== head.sha) throw new Error(`local HEAD ${local.slice(0, 7)} is not the PR head ${head.sha.slice(0, 7)}; push first`);
}

function notify(pr, to, url) {
  const target = SIDES[to];
  const paseo = ['--host', target.host];
  const action = notifyAction(JSON.parse(run('paseo', [...paseo, 'ls', '--json'])), pr);
  if (action.kind === 'ambiguous') throw new Error(`more than one session titled "${sessionTitle(pr)}": ${action.ids.join(', ')}`);
  const notice = `PR #${pr} 已交给你（owner:${to}），见 ${url}。按仓库 AGENTS.md 处理，交接内容以 PR 评论为准。`;
  if (action.kind === 'create') {
    run('paseo', [...paseo, 'run', '-d', ...target.run, '--title', sessionTitle(pr), '--cwd', target.cwd,
      '--new-workspace', 'worktree', '--worktree-mode', 'checkout-pr', '--pr-number', String(pr),
      `先进入 pstack:poteto-mode。${notice}`]);
  } else if (action.kind === 'send') {
    run('paseo', [...paseo, 'send', action.id, '--no-wait', notice]);
  } else {
    const waiter = spawn('sh', ['-c', 'paseo "$@" wait "$ID" && paseo "$@" send "$ID" --no-wait "$NOTICE"', 'handoff', ...paseo], {
      detached: true, stdio: 'ignore', env: { ...process.env, ID: action.id, NOTICE: notice },
    });
    waiter.unref();
  }
  return action;
}

function main(argv) {
  const { pr, to, commentFile, dryRun, notifyOnly } = parseArgs(argv);
  const from = to === 'codex' ? 'claude' : 'codex';

  const pull = JSON.parse(gh([`repos/${REPO}/pulls/${pr}`]));
  if (pull.state !== 'open') throw new Error(`PR #${pr} is ${pull.state}`);
  const labels = pull.labels.map((l) => l.name);

  if (notifyOnly) {
    if (!labels.includes(`owner:${to}`)) throw new Error(`PR #${pr} is not owned by ${to}; hand it over first`);
    const action = notify(pr, to, pull.html_url);
    console.log(`PR #${pr} → ${to}: notice ${action.kind}${action.id ? ` ${action.id}` : ''}`);
    return;
  }

  if (!labels.includes(`owner:${from}`)) {
    throw new Error(`PR #${pr} is not owned by ${from} (labels: ${labels.join(', ') || 'none'})`);
  }
  checkLocal(pull.head);

  const body = `${readFileSync(commentFile, 'utf8').trimEnd()}\n\n交接：${from} → ${to}，head \`${pull.head.sha.slice(0, 7)}\`。`;
  if (dryRun) {
    const sessions = JSON.parse(run('paseo', ['--host', SIDES[to].host, 'ls', '--json']));
    console.log(JSON.stringify({ pr, from, to, head: pull.head.sha, notify: notifyAction(sessions, pr), comment: body }, null, 2));
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'handoff-'));
  const bodyFile = join(dir, 'body.md');
  writeFileSync(bodyFile, body);
  const comment = JSON.parse(gh(['-X', 'POST', `repos/${REPO}/issues/${pr}/comments`, '-F', `body=@${bodyFile}`]));
  // Add before remove: an interrupted run leaves both labels, which a rerun passes and finishes.
  gh(['-X', 'POST', `repos/${REPO}/issues/${pr}/labels`, '-f', `labels[]=owner:${to}`]);
  gh(['-X', 'DELETE', `repos/${REPO}/issues/${pr}/labels/owner:${from}`]);

  try {
    const action = notify(pr, to, comment.html_url);
    console.log(`PR #${pr} → ${to}: ${comment.html_url} (notice: ${action.kind}${action.id ? ` ${action.id}` : ''})`);
  } catch (error) {
    throw new Error(`handed over (${comment.html_url}) but the notice failed: ${error.message}\nrerun with --notify-only`);
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
