import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const spec = JSON.parse(readFileSync(join(root, 'docs/program-graph.json'), 'utf8'));

test('the board includes tooling and counts new version-labeled defects', () => {
  const dir = mkdtempSync(join(tmpdir(), 'program-graph-test-'));
  try {
    const gh = join(dir, 'gh');
    const fixture = join(dir, 'issues.json');
    const nodes = [
      { id: 'PROGRAM' }, { id: 'TOOLING' },
      ...spec.versions, ...spec.tasks, ...spec.tooling, ...spec.operator,
    ];
    const issues = nodes.map((node, index) => ({
      number: index + 300,
      title: node.title ?? node.id,
      body: `<!-- program-graph: ${node.id} -->`,
      state: 'OPEN',
      labels: [{ name: `version:${node.parent ?? 'TOOLING'}` }],
      url: `https://github.com/${spec.repo}/issues/${index + 300}`,
    }));
    issues.push(
      { number: 998, title: 'Closed new defect', body: '', state: 'CLOSED', labels: [{ name: 'version:V5' }] },
      { number: 999, title: 'Open new defect', body: '', state: 'OPEN', labels: [{ name: 'version:V5' }] },
    );
    writeFileSync(fixture, JSON.stringify(issues));
    writeFileSync(gh, '#!/bin/sh\ncat "$GRAPH_ISSUES_FILE"\n');
    chmodSync(gh, 0o755);
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, GRAPH_ISSUES_FILE: fixture };
    const script = join(root, 'scripts/program-graph-sync.mjs');
    const graph = execFileSync(process.execPath, [script, 'mermaid'], { cwd: root, env, encoding: 'utf8' });
    assert.match(graph, /subgraph TOOLING_g\["TOOLING"\][\s\S]*?TOOL_1\["TOOL-1/);
    assert.match(graph, /subgraph TOOLING_g\["TOOLING"\][\s\S]*?TOOL_2\["TOOL-2/);
    assert.match(graph, /D999\["#999 Open new defect"\]/);
    const site = join(dir, 'site');
    execFileSync(process.execPath, [script, 'html', site], { cwd: root, env });
    const html = readFileSync(join(site, 'index.html'), 'utf8');
    const cellsFor = (id) => html.match(new RegExp(`<tr><td>${id}<\\/td>(.*?)<\\/tr>`))?.[1].match(/<td>.*?<\/td>/g);
    assert.equal(cellsFor('V5')?.[4], '<td>1</td>');
    assert.equal(cellsFor('TOOLING')?.[3], '<td>0/2</td>');
    assert.match(html, /TOOL-1/);
    assert.match(html, /TOOL-2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
