#!/usr/bin/env node
// Syncs docs/program-graph.json with GitHub issues and renders the program board.
//
//   node scripts/program-graph-sync.mjs sync     labels, issues, sub-issues, blocked-by, project items
//   node scripts/program-graph-sync.mjs board    rewrite the board issue body from live issue state
//   node scripts/program-graph-sync.mjs mermaid  print the Mermaid graphs only
//   node scripts/program-graph-sync.mjs html <out-dir>   write a standalone index.html for GitHub Pages
//
// Needs `gh` authenticated with repo scope; `sync` also needs project scope.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(readFileSync(join(here, '..', 'docs', 'program-graph.json'), 'utf8'));
const [owner, repoName] = spec.repo.split('/');
const MARK = (id) => `<!-- program-graph: ${id} -->`;
const BOARD_ID = 'PROGRAM';
const BOARD_START = '<!-- program-graph:board:start -->';
const BOARD_END = '<!-- program-graph:board:end -->';

function gh(args, { input, json = true, allowFail = false } = {}) {
  try {
    const out = execFileSync('gh', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
    return json ? (out.trim() ? JSON.parse(out) : null) : out;
  } catch (error) {
    if (allowFail) return { error: String(error.stderr || error.message) };
    throw error;
  }
}

function graphql(query, variables) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [k, v] of Object.entries(variables)) args.push('-f', `${k}=${v}`);
  return gh(args, { allowFail: true });
}

const nodes = new Map();
nodes.set(BOARD_ID, { id: BOARD_ID, kind: 'board', title: 'Vonvon Bot v2 程序看板' });
for (const v of spec.versions) nodes.set(v.id, { ...v, kind: 'version' });
for (const t of spec.tasks) nodes.set(t.id, { ...t, kind: 'task' });
for (const o of spec.operator) nodes.set(o.id, { ...o, kind: 'operator' });
nodes.set('TOOLING', { id: 'TOOLING', kind: 'version', title: '工具、CI 与进度板', owner: 'root', mergeAfter: [] });
for (const t of spec.tooling) nodes.set(t.id, { ...t, kind: 'task', parent: 'TOOLING' });

function labelsFor(node) {
  const labels = ['program-graph'];
  if (node.kind === 'version') labels.push('version', `version:${node.id}`);
  if (node.kind === 'task') labels.push('task', `version:${node.parent}`);
  if (node.kind === 'operator') labels.push('needs-operator');
  if (node.kind === 'board') labels.push('board');
  if (node.root) labels.push('root-handoff');
  if (node.gate) labels.push('gate');
  if (node.parked) labels.push('parked');
  if (node.status === 'in-progress') labels.push('state:in-progress');
  return labels;
}

function bodyFor(node) {
  const lines = [];
  if (node.kind === 'version') {
    lines.push(`**分支** \`${node.branch ?? '待建'}\`${node.pr ? `，PR #${node.pr}` : ''}。**负责人** ${node.owner}。`);
    lines.push(`**合并前提** ${node.mergeAfter?.length ? node.mergeAfter.map((m) => (spec.merged.includes(m) ? `${m}（已合）` : m)).join('、') : '无'}。`);
    if (node.acceptance) lines.push(`**验收输入** ${node.acceptance}。`);
    if (node.plan) lines.push(`**计划章节** docs/plan.md “${node.plan}”。`);
    if (node.note) lines.push(`**说明** ${node.note}`);
    if (node.parked) lines.push(`**停放** ${node.parked}`);
    lines.push('', '子 issue 是这个版本的任务分区和缺陷。版本状态由根代理用标签维护：`state:code-ready`、`state:frozen`、`state:verified`，合入后关闭。');
  } else if (node.kind === 'task') {
    if (node.scope) lines.push('**范围（本任务拥有的文件）**', ...node.scope.map((s) => `- \`${s}\``), '');
    lines.push(`**依赖** ${node.blockedBy?.length ? node.blockedBy.join('、') : '无，可立即开始'}。`);
    if (node.freeze) lines.push(`**发布冻结点** ${node.freeze}。`);
    if (node.acceptance) lines.push(`**验收输入** ${node.acceptance}。`);
    if (node.docs) lines.push(`**设计依据** ${node.docs}。`);
    if (node.done) lines.push(`**完成标准** ${node.done}`);
    if (node.plan) lines.push(`**计划章节** ${node.plan}。`);
    if (node.body) lines.push(node.body);
    if (node.root) lines.push('', '这是根代理在集成时写的共享文件交接，工作代理不改这些文件。');
    if (node.gate) lines.push('', '证据门只在冻结 head 上跑一次。前提都已合入的 PR 才排进正式检查，两个都能跑时先跑未合入下游更多的那个。');
    if (node.parked) lines.push('', '停放中：缺少验收输入，不挡其他任务。');
  } else if (node.kind === 'operator') {
    lines.push(node.body, '', `**挡住的任务** ${node.blocks?.length ? node.blocks.join('、') : '无'}。`);
  } else if (node.kind === 'board') {
    lines.push('这个 issue 由 `scripts/program-graph-sync.mjs board` 重写。手工编辑会被覆盖。', '', BOARD_START, BOARD_END);
  }
  lines.push('', MARK(node.id));
  return lines.join('\n');
}

function titleFor(node) {
  if (node.kind === 'board') return node.title;
  if (node.kind === 'version') return `${node.id} ${node.title.replace(new RegExp(`^${node.id}\\s*`), '')}`;
  return `${node.id} ${node.title}`;
}

function listIssues() {
  const all = gh(['issue', 'list', '--repo', spec.repo, '--state', 'all', '--limit', '500', '--json', 'number,title,body,state,labels,id,url']);
  const byMark = new Map();
  for (const issue of all) {
    const m = /<!-- program-graph: ([A-Za-z0-9_-]+) -->/.exec(issue.body ?? '');
    if (m) byMark.set(m[1], issue);
  }
  return { all, byMark };
}

function ensureLabels() {
  const have = new Set(gh(['label', 'list', '--repo', spec.repo, '--limit', '200', '--json', 'name']).map((l) => l.name));
  const want = new Map([
    ['program-graph', ['0E8A16', '由 docs/program-graph.json 生成的节点']],
    ['version', ['1D76DB', '一个版本（一个 PR）的父 issue']],
    ['task', ['5319E7', '版本内的任务分区']],
    ['gate', ['B60205', '冻结 head 上的证据门']],
    ['root-handoff', ['FBCA04', '根代理写的共享文件交接']],
    ['needs-operator', ['D93F0B', '只有用户能做的事']],
    ['parked', ['CCCCCC', '缺少验收输入，停放']],
    ['board', ['000000', '程序看板']],
    ['state:in-progress', ['FEF2C0', '有人在做']],
    ['state:code-ready', ['C2E0C6', '代码完成，等正式检查']],
    ['state:frozen', ['BFD4F2', 'head 已冻结，证据门在跑']],
    ['state:verified', ['0052CC', '独立 Shipping 判定干净，等合并顺序']],
    ['backlog', ['EEEEEE', '不属于任何版本的待办']],
  ]);
  for (const v of [...spec.versions, { id: 'TOOLING' }]) want.set(`version:${v.id}`, ['006B75', `属于 ${v.id}`]);
  for (const [name, [color, description]] of want) {
    if (have.has(name)) continue;
    gh(['label', 'create', name, '--repo', spec.repo, '--color', color, '--description', description], { json: false });
    console.log(`label ${name}`);
  }
}

function createOrUpdate(node, byMark) {
  const title = titleFor(node);
  const body = bodyFor(node);
  const labels = labelsFor(node);
  let issue = byMark.get(node.id);
  if (!issue) {
    const args = ['issue', 'create', '--repo', spec.repo, '--title', title, '--body', body];
    for (const l of labels) args.push('--label', l);
    if (node.kind === 'operator' && spec.operatorLogin) args.push('--assignee', spec.operatorLogin);
    const url = gh(args, { json: false }).trim().split('\n').pop();
    const number = Number(url.split('/').pop());
    issue = gh(['api', `repos/${spec.repo}/issues/${number}`]);
    issue = { number, id: issue.node_id, url: issue.html_url, state: issue.state.toUpperCase(), body, title, labels: labels.map((name) => ({ name })) };
    byMark.set(node.id, issue);
    console.log(`created #${number} ${title}`);
  } else {
    const haveLabels = new Set(issue.labels.map((l) => l.name));
    const missing = labels.filter((l) => !haveLabels.has(l));
    const changed = issue.title !== title || (issue.body ?? '').trim() !== body.trim();
    if (node.kind === 'board') {
      // the board body is owned by `board`; only keep labels and title current
      if (issue.title !== title || missing.length) {
        const args = ['issue', 'edit', String(issue.number), '--repo', spec.repo, '--title', title];
        for (const l of missing) args.push('--add-label', l);
        gh(args, { json: false });
      }
    } else if (changed || missing.length) {
      const args = ['issue', 'edit', String(issue.number), '--repo', spec.repo, '--title', title, '--body', body];
      for (const l of missing) args.push('--add-label', l);
      gh(args, { json: false });
      console.log(`updated #${issue.number} ${title}`);
    }
  }
  if (node.status === 'done' && issue.state !== 'CLOSED') {
    gh(['issue', 'close', String(issue.number), '--repo', spec.repo, '--comment', '计划记录为已完成。'], { json: false });
    issue.state = 'CLOSED';
    console.log(`closed #${issue.number}`);
  }
  return issue;
}

function link(parentIssue, childIssue) {
  const r = graphql('mutation($p:ID!,$c:ID!){ addSubIssue(input:{issueId:$p, subIssueId:$c}){ issue{ number } } }', { p: parentIssue.id, c: childIssue.id });
  if (r?.error && !/already|duplicate/i.test(r.error)) console.warn(`sub-issue #${parentIssue.number} <- #${childIssue.number}: ${r.error.trim()}`);
}

function block(blockedIssue, blockingIssue) {
  const r = graphql('mutation($i:ID!,$b:ID!){ addBlockedBy(input:{issueId:$i, blockingIssueId:$b}){ issue{ number } } }', { i: blockedIssue.id, b: blockingIssue.id });
  if (r?.error && !/already|duplicate|exists/i.test(r.error)) console.warn(`blocked-by #${blockedIssue.number} <- #${blockingIssue.number}: ${r.error.trim()}`);
}

function ensureProject(issues) {
  const list = gh(['project', 'list', '--owner', owner, '--format', 'json', '--limit', '50'], { allowFail: true });
  if (list?.error) {
    console.warn(`project skipped: ${list.error.trim()}`);
    return;
  }
  let project = (list.projects ?? []).find((p) => p.title === spec.project);
  if (!project) {
    project = gh(['project', 'create', '--owner', owner, '--title', spec.project, '--format', 'json']);
    console.log(`project #${project.number} ${project.title}`);
  }
  const items = gh(['project', 'item-list', String(project.number), '--owner', owner, '--format', 'json', '--limit', '500']);
  const have = new Set((items.items ?? []).map((i) => i.content?.url ?? i.content?.number).filter(Boolean));
  for (const issue of issues) {
    if (have.has(issue.url) || have.has(issue.number)) continue;
    gh(['project', 'item-add', String(project.number), '--owner', owner, '--url', issue.url], { json: false, allowFail: true });
  }
  console.log(`project items: ${issues.length} checked`);
  return project;
}

function sync() {
  ensureLabels();
  const { all, byMark } = listIssues();
  const byNumber = new Map(all.map((i) => [i.number, i]));
  const order = [BOARD_ID, 'TOOLING', ...spec.versions.map((v) => v.id), ...spec.tasks.map((t) => t.id), ...spec.tooling.map((t) => t.id), ...spec.operator.map((o) => o.id)];
  const issues = new Map();
  for (const id of order) issues.set(id, createOrUpdate(nodes.get(id), byMark));

  const board = issues.get(BOARD_ID);
  for (const v of [...spec.versions, nodes.get('TOOLING')]) link(board, issues.get(v.id));
  for (const t of [...spec.tasks, ...spec.tooling]) link(issues.get(nodes.get(t.id).parent), issues.get(t.id));
  for (const o of spec.operator) link(board, issues.get(o.id));

  for (const v of spec.versions) for (const m of v.mergeAfter ?? []) if (!spec.merged.includes(m)) block(issues.get(v.id), issues.get(m));
  for (const t of [...spec.tasks, ...spec.tooling]) for (const b of t.blockedBy ?? []) block(issues.get(t.id), issues.get(b));
  for (const o of spec.operator) for (const target of o.blocks ?? []) block(issues.get(target), issues.get(o.id));

  for (const [vid, numbers] of Object.entries(spec.existingIssues)) {
    const parent = issues.get(vid);
    for (const n of numbers) {
      let found = byNumber.get(n);
      if (!found) {
        const raw = gh(['api', `repos/${spec.repo}/issues/${n}`]);
        found = { number: n, id: raw.node_id, url: raw.html_url, labels: raw.labels, state: raw.state.toUpperCase() };
      }
      if (!found.labels.some((l) => l.name === `version:${vid}`)) {
        gh(['issue', 'edit', String(n), '--repo', spec.repo, '--add-label', `version:${vid}`], { json: false, allowFail: true });
      }
      link(parent, found);
    }
  }
  ensureProject([...issues.values()]);
  board_(issues, byNumber);
}

function mermaidId(id) {
  return id.replace(/[^A-Za-z0-9]/g, '_');
}

function short(text, n = 26) {
  const t = text.replace(/"/g, '”');
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function stateOf(raw, issues) {
  const node = nodes.get(raw.id) ?? raw;
  const issue = issues.get(node.id);
  if (!issue) return 'missing';
  if (issue.state === 'CLOSED') return 'done';
  const labels = new Set((issue.labels ?? []).map((l) => l.name));
  if (node.kind === 'version') {
    if (labels.has('state:verified')) return 'verified';
    if (labels.has('state:frozen')) return 'frozen';
    if (labels.has('state:code-ready')) return 'code-ready';
  }
  if (node.parked) return 'parked';
  const blockers = node.kind === 'version' ? (node.mergeAfter ?? []).filter((m) => !spec.merged.includes(m)) : [...(node.blockedBy ?? []), ...spec.operator.filter((o) => o.blocks?.includes(node.id)).map((o) => o.id)];
  if (labels.has('state:in-progress')) return 'in-progress';
  if (blockers.some((b) => issues.get(b)?.state !== 'CLOSED')) return 'blocked';
  return 'ready';
}

const STYLE = {
  done: 'fill:#c2e0c6,stroke:#2da44e,color:#000',
  defect: 'fill:#ffebe9,stroke:#cf222e,color:#000',
  verified: 'fill:#0052cc,stroke:#0052cc,color:#fff',
  frozen: 'fill:#bfd4f2,stroke:#0969da,color:#000',
  'code-ready': 'fill:#dbe9ff,stroke:#0969da,color:#000',
  'in-progress': 'fill:#fef2c0,stroke:#bf8700,color:#000',
  ready: 'fill:#ffffff,stroke:#0969da,color:#000',
  blocked: 'fill:#eeeeee,stroke:#8c959f,color:#57606a',
  parked: 'fill:#ffffff,stroke:#8c959f,stroke-dasharray:4 3,color:#57606a',
  missing: 'fill:#ffdce0,stroke:#cf222e,color:#000',
};

function defectsOf(versionId, byNumber) {
  const generated = new Set([...issues_marked(byNumber)]);
  return [...byNumber.values()].filter((i) => !generated.has(i.number) && (i.labels ?? []).some((l) => l.name === `version:${versionId}`));
}

function issues_marked(byNumber) {
  return [...byNumber.values()].filter((i) => /<!-- program-graph: /.test(i.body ?? '')).map((i) => i.number);
}

function mermaid(issues, byNumber = new Map(), { links = false } = {}) {
  const versionLines = ['flowchart LR'];
  const styles = [];
  const label = (node, extra = '') => {
    const issue = issues.get(node.id);
    const n = issue ? `#${issue.number} ` : '';
    return `${mermaidId(node.id)}["${node.id} ${n}${short(node.title.replace(new RegExp(`^${node.id}\\s*`), ''))}${extra}"]`;
  };
  for (const m of spec.merged) versionLines.push(`  ${mermaidId(m)}["${m} 已合入"]`), styles.push(`  style ${mermaidId(m)} ${STYLE.done}`);
  for (const v of spec.versions) {
    const tasks = spec.tasks.filter((t) => t.parent === v.id);
    const done = tasks.filter((t) => issues.get(t.id)?.state === 'CLOSED').length;
    versionLines.push(`  ${label(v, ` ${done}/${tasks.length}`)}`);
    styles.push(`  style ${mermaidId(v.id)} ${STYLE[stateOf(v, issues)]}`);
    for (const m of v.mergeAfter ?? []) versionLines.push(`  ${mermaidId(m)} --> ${mermaidId(v.id)}`);
  }
  const taskLines = ['flowchart LR'];
  const taskStyles = [];
  for (const o of spec.operator) {
    taskLines.push(`  ${label(o)}`);
    taskStyles.push(`  style ${mermaidId(o.id)} ${STYLE[stateOf(o, issues)]}`);
  }
  for (const v of [...spec.versions, nodes.get('TOOLING')]) {
    const tasks = [...spec.tasks, ...spec.tooling].filter((t) => t.parent === v.id);
    taskLines.push(`  subgraph ${mermaidId(v.id)}_g["${v.id}"]`);
    for (const t of tasks) taskLines.push(`    ${label(t)}`), taskStyles.push(`  style ${mermaidId(t.id)} ${STYLE[stateOf(t, issues)]}`);
    taskLines.push('  end');
  }
  for (const t of [...spec.tasks, ...spec.tooling]) for (const b of t.blockedBy ?? []) taskLines.push(`  ${mermaidId(b)} --> ${mermaidId(t.id)}`);
  for (const o of spec.operator) for (const target of o.blocks ?? []) taskLines.push(`  ${mermaidId(o.id)} -.-> ${mermaidId(target)}`);
  for (const v of [...spec.versions, nodes.get('TOOLING')]) {
    const gate = spec.tasks.find((t) => t.parent === v.id && t.gate);
    for (const d of defectsOf(v.id, byNumber)) {
      const id = `D${d.number}`;
      taskLines.push(`  ${id}["#${d.number} ${short(d.title, 30)}"]`);
      taskStyles.push(`  style ${id} ${d.state === 'CLOSED' ? STYLE.done : STYLE.defect}`);
      if (gate) taskLines.push(`  ${id} -.-> ${mermaidId(gate.id)}`);
      if (links) taskLines.push(`  click ${id} "${d.url}"`);
    }
  }
  if (links) {
    for (const [id, issue] of issues) if (id !== BOARD_ID) taskLines.push(`  click ${mermaidId(id)} "${issue.url}"`), versionLines.push(`  click ${mermaidId(id)} "${issue.url}"`);
  }
  const taskGraph = [...taskLines, ...taskStyles].join('\n');
  const versionGraph = [...versionLines, ...styles].join('\n');
  return { versionGraph, taskGraph };
}

function progressRows(issues, byNumber) {
  const rows = [];
  for (const v of spec.versions) {
    const tasks = spec.tasks.filter((t) => t.parent === v.id);
    const done = tasks.filter((t) => issues.get(t.id)?.state === 'CLOSED').length;
    const ready = tasks.filter((t) => stateOf(t, issues) === 'ready').map((t) => t.id);
    const active = tasks.filter((t) => stateOf(t, issues) === 'in-progress').map((t) => t.id);
    const defects = (spec.existingIssues[v.id] ?? []).filter((n) => (byNumber.get(n)?.state ?? 'OPEN') === 'OPEN').length;
    const issue = issues.get(v.id);
    rows.push(`| ${v.id} | #${issue.number} | ${v.pr ? `#${v.pr}` : '未开'} | ${stateOf(v, issues)} | ${done}/${tasks.length} | ${defects} | ${active.join('、') || '无'} | ${ready.join('、') || '无'} |`);
  }
  return rows;
}

const TABLE_HEAD = ['| 版本 | issue | PR | 状态 | 任务 | 未关缺陷 | 进行中 | 现在可开始 |', '| --- | --- | --- | --- | --- | --- | --- | --- |'];

function board_(issues, byNumber) {
  const { versionGraph, taskGraph } = mermaid(issues, byNumber);
  const rows = progressRows(issues, byNumber);
  const legend = '颜色：绿 已完成 · 黄 进行中 · 白 可开始 · 灰 被挡 · 虚线 停放 · 红 未关缺陷 · 蓝 版本已冻结或已验证。缺陷用虚线指向所属版本的证据门。';
  const body = [
    `更新时间 ${new Date().toISOString()}。`,
    '',
    '## 版本合并图',
    '',
    legend,
    '',
    '```mermaid',
    versionGraph,
    '```',
    '',
    ...TABLE_HEAD,
    ...rows,
    '',
    '## 任务依赖图',
    '',
    '```mermaid',
    taskGraph,
    '```',
  ].join('\n');
  const board = issues.get(BOARD_ID);
  const current = gh(['api', `repos/${spec.repo}/issues/${board.number}`]).body ?? '';
  const start = current.indexOf(BOARD_START);
  const end = current.indexOf(BOARD_END);
  const head = start >= 0 ? current.slice(0, start + BOARD_START.length) : `${bodyFor(nodes.get(BOARD_ID)).split(BOARD_START)[0]}${BOARD_START}`;
  const tail = end >= 0 ? current.slice(end) : `${BOARD_END}\n\n${MARK(BOARD_ID)}`;
  const next = `${head}\n${body}\n${tail}`;
  const file = join(mkdtempSync(join(tmpdir(), 'program-board-')), 'body.md');
  writeFileSync(file, next);
  gh(['issue', 'edit', String(board.number), '--repo', spec.repo, '--body-file', file], { json: false });
  console.log(`board #${board.number} updated`);
}

function loadIssues() {
  const { all, byMark } = listIssues();
  const issues = new Map();
  for (const id of nodes.keys()) if (byMark.has(id)) issues.set(id, byMark.get(id));
  return { issues, byNumber: new Map(all.map((i) => [i.number, i])) };
}

function html(issues, byNumber, outDir) {
  const { versionGraph, taskGraph } = mermaid(issues, byNumber, { links: true });
  const rows = progressRows(issues, byNumber);
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const issueLink = (cell) => cell.replace(/#(\d+)/g, (_, n) => `<a href="https://github.com/${spec.repo}/issues/${n}">#${n}</a>`);
  const tableRows = rows.map((r) => `<tr>${r.split('|').slice(1, -1).map((c) => `<td>${issueLink(esc(c.trim()))}</td>`).join('')}</tr>`).join('\n');
  const head = TABLE_HEAD[0].split('|').slice(1, -1).map((c) => `<th>${c.trim()}</th>`).join('');
  const page = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>Vonvon Bot v2 进度</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font:14px/1.5 -apple-system,system-ui,sans-serif;margin:24px;color:#1f2328}h1,h2{font-weight:600}table{border-collapse:collapse}td,th{border:1px solid #d0d7de;padding:4px 8px;text-align:left}pre.mermaid{background:transparent}.legend{color:#57606a}a{color:#0969da;text-decoration:none}</style>
<script type="module">import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';mermaid.initialize({startOnLoad:true,securityLevel:'loose',flowchart:{useMaxWidth:true}});</script>
</head><body>
<h1>Vonvon Bot v2 进度</h1>
<p class="legend">更新时间 ${new Date().toISOString()}。看板 <a href="https://github.com/${spec.repo}/issues/${issues.get(BOARD_ID)?.number ?? ''}">issue #${issues.get(BOARD_ID)?.number ?? ''}</a>。颜色：绿 已完成 · 黄 进行中 · 白 可开始 · 灰 被挡 · 虚线 停放 · 红 未关缺陷 · 蓝 版本已冻结或已验证。缺陷用虚线指向所属版本的证据门。</p>
<h2>版本合并图</h2>
<pre class="mermaid">${esc(versionGraph)}</pre>
<h2>进度</h2>
<table><thead><tr>${head}</tr></thead><tbody>
${tableRows}
</tbody></table>
<h2>任务依赖图</h2>
<pre class="mermaid">${esc(taskGraph)}</pre>
</body></html>
`;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'index.html'), page);
  console.log(`wrote ${join(outDir, 'index.html')}`);
}

const mode = process.argv[2] ?? 'board';
if (mode === 'sync') sync();
else if (mode === 'board') {
  const { issues, byNumber } = loadIssues();
  board_(issues, byNumber);
} else if (mode === 'html') {
  const { issues, byNumber } = loadIssues();
  html(issues, byNumber, process.argv[3] ?? 'board-site');
} else if (mode === 'mermaid') {
  const { issues, byNumber } = loadIssues();
  const { versionGraph, taskGraph } = mermaid(issues, byNumber);
  console.log(versionGraph, '\n\n', taskGraph);
} else {
  console.error(`unknown mode ${mode}`);
  process.exit(2);
}
