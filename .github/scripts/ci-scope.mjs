import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const shaPattern = /^[0-9a-f]{40}$/i;
const maxPaths = 4096;
const maxDiffBytes = 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
const allPackages = ['protocol', 'client', 'daemon', 'ui', 'desktop'];
const allPlatforms = ['linux', 'macos', 'windows'];

export function isDocsPath(path) {
  return path === 'README.md' || /^docs\/(?:[^/]+\/)*[^/]+\.md$/.test(path);
}

export function parseChangedPaths(bytes) {
  if (!bytes.length || bytes.at(-1) !== 0 || bytes.length > maxDiffBytes) return null;
  const paths = decoder.decode(bytes).slice(0, -1).split('\0');
  if (paths.length > maxPaths || paths.some(path => !path || path.startsWith('/') || path.includes('..'))) return null;
  return paths;
}

function validSha(value) {
  return typeof value === 'string' && shaPattern.test(value) && !/^0+$/.test(value);
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, maxBuffer: maxDiffBytes + 1024 });
}

function pathPlatforms(path, name) {
  const segments = path.toLowerCase().split('/');
  const file = segments.at(-1);
  // Exact platform directories and filename tokens avoid arbitrary substring matches.
  const mac = segments.includes('darwin') || segments.includes('macos') ||
    /(?:^|[._-])(?:darwin|macos)(?:[._-]|$)/.test(file) || file.endsWith('.swift');
  const windows = segments.includes('win32') || segments.includes('windows') ||
    /(?:^|[._-])(?:win32|windows)(?:[._-]|$)/.test(file) || file.endsWith('.ps1');
  if (mac || windows) return ['linux', ...(mac ? ['macos'] : []), ...(windows ? ['windows'] : [])];
  if (name === 'daemon' || name === 'desktop') return allPlatforms;
  return ['linux'];
}

/** Pure decision logic. Paths must be the complete cumulative Git diff. */
export function planScope({ eventName, event, paths, base = '', head = '', sourceSha = '', targetSha = '', collectionError = '' }) {
  const labels = new Set(Array.isArray(event?.pull_request?.labels)
    ? event.pull_request.labels.map(label => label?.name) : []);
  const frozen = labels.has('frozen');
  const dispatch = eventName === 'workflow_dispatch';
  const full = (reason, platforms = allPlatforms) => ({ scope: 'full', packages: allPackages, platforms,
    ready: dispatch || (eventName === 'pull_request' && frozen && event?.pull_request?.draft === false),
    source_sha: sourceSha, target_sha: targetSha, base, head, reason, paths: paths ?? [] });
  if (collectionError) return { ...full(collectionError), ready: false };
  if (dispatch) return full('manual dispatch');
  if (!Array.isArray(paths) || paths.length === 0) return { ...full('empty diff'), ready: false };
  if (labels.has('ci:all')) return full('ci:all label');
  if (paths.every(isDocsPath)) {
    if (labels.has('ci:macos') || labels.has('ci:windows')) {
      return { scope: 'affected', packages: allPackages,
        platforms: allPlatforms.filter(platform => platform === 'linux' ||
          (platform === 'macos' && labels.has('ci:macos')) ||
          (platform === 'windows' && labels.has('ci:windows'))),
        ready: frozen && event?.pull_request?.draft === false,
        source_sha: sourceSha, target_sha: targetSha, base, head, reason: 'platform label on docs', paths };
    }
    return { scope: 'docs', packages: [], platforms: [], ready: true,
      source_sha: sourceSha, target_sha: targetSha, base, head, reason: '', paths };
  }
  const packages = new Set();
  const platforms = new Set(['linux']);
  let fullReason = '';
  for (const path of paths) {
    if (isDocsPath(path)) continue;
    const match = /^packages\/([^/]+)\//.exec(path);
    if (!match || !allPackages.includes(match[1])) {
      fullReason ||= `shared or unknown path: ${path}`;
      const governance = path === 'AGENTS.md' || path === 'CLAUDE.md' ||
        /^(?:\.claude|\.agents)\/skills\/(?:[^/]+\/)*[^/]+\.md$/.test(path);
      for (const platform of governance ? ['linux', 'macos'] : allPlatforms) platforms.add(platform);
      continue;
    }
    const name = match[1];
    const relative = path.slice(match[0].length);
    if (!relative.includes('/') && /^(?:package(?:-lock)?\.json|tsconfig(?:\.[^/]*)?\.json|vite\.config\.[^/]+|vitest\.config\.[^/]+|build\.[^/]+)$/.test(relative)) {
      fullReason ||= `shared package config: ${path}`;
      for (const platform of allPlatforms) platforms.add(platform);
      continue;
    }
    if (name === 'protocol' || name === 'client') {
      fullReason ||= `shared package: ${name}`;
      for (const platform of allPlatforms) platforms.add(platform);
      continue;
    }
    packages.add(name);
    if (name === 'ui') packages.add('desktop');
    if (name === 'daemon') packages.add('desktop');
    for (const platform of pathPlatforms(path, name)) platforms.add(platform);
  }
  if (labels.has('ci:macos')) platforms.add('macos');
  if (labels.has('ci:windows')) platforms.add('windows');
  const mainIntegration = eventName === 'pull_request' && event?.pull_request?.base?.ref === 'main';
  if (mainIntegration) platforms.add('macos');
  const selectedPlatforms = allPlatforms.filter(name => platforms.has(name));
  if (fullReason || mainIntegration) return full(fullReason || 'main integration', selectedPlatforms);
  return { scope: 'affected', packages: allPackages.filter(name => packages.has(name)),
    platforms: selectedPlatforms,
    ready: eventName === 'pull_request' && frozen && event?.pull_request?.draft === false,
    source_sha: sourceSha, target_sha: targetSha, base, head, reason: '', paths };
}

export function determineScope(eventName, event, cwd) {
  if (eventName === 'workflow_dispatch') {
    let head = '';
    try { head = git(cwd, 'rev-parse', 'HEAD').toString('ascii').trim(); } catch { /* reported below */ }
    return planScope({ eventName, event, head, sourceSha: validSha(head) ? head : '',
      collectionError: validSha(head) ? '' : 'Git collection failed' });
  }
  let base;
  let head;
  if (eventName === 'pull_request') {
    base = event?.pull_request?.base?.sha;
    head = event?.pull_request?.head?.sha;
  } else if (eventName === 'push') {
    base = event?.before;
    head = event?.after;
  } else {
    return planScope({ eventName, event, collectionError: 'unsupported event' });
  }
  if (!validSha(base) || !validSha(head)) {
    return planScope({ eventName, event, collectionError: 'missing or invalid SHA' });
  }
  const sourceSha = head;
  const targetSha = eventName === 'pull_request' ? base : '';
  try {
    git(cwd, 'cat-file', '-e', `${base}^{commit}`);
    git(cwd, 'cat-file', '-e', `${head}^{commit}`);
    if (eventName === 'pull_request') {
      const bases = git(cwd, 'merge-base', '--all', base, head).toString('ascii').trim().split('\n');
      if (bases.length !== 1 || !validSha(bases[0])) throw new Error('ambiguous merge base');
      base = bases[0];
    }
    const paths = parseChangedPaths(git(cwd, 'diff', '--name-only', '--no-renames', '-z', base, head));
    if (!paths) throw new Error('empty, malformed, or oversized diff');
    return planScope({ eventName, event, paths, base, head, sourceSha, targetSha });
  } catch (error) {
    return planScope({ eventName, event, base, head, sourceSha, targetSha,
      collectionError: error?.message === 'ambiguous merge base' ? error.message : 'Git collection failed' });
  }
}

function main() {
  let event;
  try {
    event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('invalid event');
  } catch {
    console.error('CI scope collection failed: invalid event JSON.');
    process.exitCode = 1;
    return;
  }
  const result = determineScope(process.env.GITHUB_EVENT_NAME, event, process.cwd());
  console.log(JSON.stringify(result));
  if (process.env.GITHUB_OUTPUT) {
    const outputKeys = ['scope', 'packages', 'platforms', 'ready', 'source_sha', 'target_sha', 'base', 'head'];
    appendFileSync(process.env.GITHUB_OUTPUT, outputKeys
      .map(key => `${key}=${Array.isArray(result[key]) ? JSON.stringify(result[key]) : result[key]}\n`).join(''));
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
    const explanation = result.reason || (result.scope === 'affected'
      ? 'Changed package paths select their consumers; Linux is the baseline and platform labels expand checks.'
      : 'Ordinary documentation changes use lightweight checks.');
    const escaped = escapeHtml(JSON.stringify(result.paths, null, 2));
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `Scope: **${result.scope}**. Ready: **${result.ready}**. Packages: ${escapeHtml(JSON.stringify(result.packages))}. Platforms: ${escapeHtml(JSON.stringify(result.platforms))}.\n\nReason: ${escapeHtml(explanation)}\n\nChanged paths:\n\n<pre>${escaped}</pre>\n\n`);
  }
  if (result.reason && !['manual dispatch', 'main integration', 'ci:all label'].includes(result.reason) &&
    !result.reason.startsWith('shared or unknown path:') && !result.reason.startsWith('shared package:') &&
    !result.reason.startsWith('shared package config:') && result.reason !== 'platform label on docs') {
    console.error(`CI scope collection failed: ${result.reason}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
