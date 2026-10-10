import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const shaPattern = /^[0-9a-f]{40}$/i;
const maxPaths = 4096;
const maxDiffBytes = 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });

export function isDocsPath(path) {
  return path === 'README.md' || path === 'AGENTS.md' || path === 'CLAUDE.md' ||
    /^docs\/(?:[^/]+\/)*[^/]+\.md$/.test(path);
}

export function parseChangedPaths(bytes) {
  if (!bytes.length || bytes.at(-1) !== 0 || bytes.length > maxDiffBytes) return null;
  const paths = decoder.decode(bytes).slice(0, -1).split('\0');
  if (paths.length > maxPaths || paths.some(path => !path || path.startsWith('/'))) return null;
  return paths;
}

function validSha(value) {
  return typeof value === 'string' && shaPattern.test(value) && !/^0+$/.test(value);
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, maxBuffer: maxDiffBytes + 1024 });
}

export function determineScope(eventName, event, cwd) {
  const full = reason => ({ scope: 'full', paths: [], reason });
  if (eventName === 'workflow_dispatch') return full('manual dispatch');

  let base;
  let head;
  if (eventName === 'pull_request') {
    base = event?.pull_request?.base?.sha;
    head = event?.pull_request?.head?.sha;
  } else if (eventName === 'push') {
    base = event?.before;
    head = event?.after;
  } else {
    return full('unsupported event');
  }
  if (!validSha(base) || !validSha(head)) return full('missing or invalid SHA');

  try {
    git(cwd, 'cat-file', '-e', `${base}^{commit}`);
    git(cwd, 'cat-file', '-e', `${head}^{commit}`);
    if (eventName === 'pull_request') {
      const bases = git(cwd, 'merge-base', '--all', base, head).toString('ascii').trim().split('\n');
      if (bases.length !== 1 || !shaPattern.test(bases[0])) return full('ambiguous merge base');
      base = bases[0];
    }
    const paths = parseChangedPaths(git(cwd, 'diff', '--name-only', '--no-renames', '-z', base, head));
    if (!paths) return full('empty, malformed, or oversized diff');
    return { scope: paths.every(isDocsPath) ? 'docs' : 'full', paths, reason: '', base, head };
  } catch {
    return full('Git collection failed');
  }
}

function main() {
  let event;
  try {
    event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  } catch {
    event = null;
  }
  const result = determineScope(process.env.GITHUB_EVENT_NAME, event, process.cwd());
  console.log(JSON.stringify(result));
  if (process.env.GITHUB_OUTPUT) {
    const { scope, base = '', head = '' } = result;
    appendFileSync(process.env.GITHUB_OUTPUT, `scope=${scope}\nbase=${base}\nhead=${head}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const escaped = JSON.stringify(result.paths, null, 2).replaceAll('&', '&amp;').replaceAll('<', '&lt;');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `Scope: **${result.scope}**. Collected paths: ${result.paths.length}. ${result.reason}\n\n<pre>${escaped}</pre>\n\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
