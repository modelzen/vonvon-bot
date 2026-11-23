import {createHash, randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect, it} from 'vitest';
import {AppServerClient} from '../src/agent/codex-appserver/app-server-client';
import {codexSessionParams} from '../src/agent/codex-appserver/backend';
import {projectSkillKey, sessionSkillsChanged} from '../src/bot/skill-profile';

it.runIf(process.env.GROUP_SKILLS_NATIVE_LIVE === '1')('loads and excludes project/global skills in actual native context without changing global config', {timeout: 180_000}, async () => {
  const home = process.env.HOME, nativeHome = process.env.CODEX_HOME, bin = process.env.CODEX_BIN;
  if (!home?.startsWith(tmpdir()) || !nativeHome || !bin || !process.env.VONVON_HOME?.startsWith(home)) throw new Error('Explicit isolated HOME/VONVON_HOME, native login and Codex binary required');
  const root = await mkdtemp(join(home, 'native-skills-'));
  const cwd = join(root, 'project'), suffix = randomUUID().slice(0, 8);
  const names = {project: `vonvon-project-${suffix}`, global: `vonvon-global-${suffix}`};
  const paths = {project: join(cwd, '.agents/skills', names.project, 'SKILL.md'), global: join(home, '.agents/skills', names.global, 'SKILL.md')};
  for (const scope of ['project', 'global'] as const) {
    await mkdir(join(paths[scope], '..'), {recursive: true});
    await writeFile(paths[scope], `---\nname: ${names[scope]}\ndescription: Native group skill visibility verification ${scope}.\n---\nOnly reply with NATIVE_SKILL_BODY_${scope}.\n`);
  }
  const config = join(nativeHome, 'config.toml'), hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
  const before = hash(await readFile(config));
  const evidence: {phase: string; sessionId: string; projectLoaded: boolean; globalLoaded: boolean}[] = [];
  for (const phase of ['enabled', 'disabled', 'reenabled'] as const) {
    const disabledPaths = phase === 'disabled' ? Object.values(paths) : [];
    const client = new AppServerClient({bin, cwd, quietOutput: true});
    let rollout: string | null = null, sessionId = '';
    try {
      await client.connect();
      const profile = {instructions: 'Reply only SKILLS_READY without using tools.', skills: {disabledPaths}, env: {}, nativeSettings: {automaticMemory: false as const}, additionalRoots: [], capabilityPackages: [], mcpServers: []};
      const started = await client.request<{thread: {id: string; path: string | null}}>('thread/start', codexSessionParams({cwd, mode: 'full', model: process.env.GROUP_SKILLS_MODEL ?? 'gpt-6-luna', profile}, null, bin));
      sessionId = started.thread.id;
      const completion = (async () => {for await (const event of client.stream()) if (event.method === 'turn/completed') return; throw new Error('Native turn ended without completion');})();
      await client.request('turn/start', {threadId: sessionId, input: [{type: 'text', text: 'Reply only SKILLS_READY. Do not invoke tools or skills.'}]});
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {await Promise.race([completion, new Promise<never>((_, reject) => {timer = setTimeout(() => reject(new Error('Native skill verification timed out')), 45_000);})]);}
      finally {clearTimeout(timer);}
      const stored = await client.request<{thread: {path: string | null}}>('thread/read', {threadId: sessionId, includeTurns: false});
      rollout = stored.thread.path ?? started.thread.path;
    } finally {await client.close();}
    expect(rollout).not.toBeNull();
    const records = (await readFile(rollout!, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    const instructions = records.filter(row => row.type === 'response_item' && row.payload.type === 'message' && ['developer', 'user'].includes(row.payload.role))
      .flatMap(row => row.payload.content.map((item: {text?: string}) => item.text ?? '')).filter((text: string) => text.includes('Skills')).join('\n');
    const result = {phase, sessionId, projectLoaded: instructions.includes(names.project), globalLoaded: instructions.includes(names.global)};
    evidence.push(result);
    expect(result.projectLoaded).toBe(phase !== 'disabled');
    expect(result.globalLoaded).toBe(phase !== 'disabled');
    const accepted = {sessionId, skillProfile: {sessionId, key: projectSkillKey({skills: {disabledPaths}})}};
    expect(sessionSkillsChanged(accepted, {skills: {disabledPaths: phase === 'disabled' ? [] : Object.values(paths)}})).toBe(true);
  }
  expect(hash(await readFile(config))).toBe(before);
  if (process.env.GROUP_SKILLS_EVIDENCE) await writeFile(process.env.GROUP_SKILLS_EVIDENCE, JSON.stringify({configUnchanged: true, evidence}, null, 2));
});
