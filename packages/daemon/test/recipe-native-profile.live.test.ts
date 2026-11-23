import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { canonicalizeRichRecipeContent, digestRichRecipeContent, type RecipeRichContent } from '@vonvon/protocol';
import { stageRichRecipeGeneration } from '../src/recipe/rich-generation';
import { CodexAppServerBackend } from '../src/agent/codex-appserver/backend';
import { shutdownResidentClients } from '../src/agent/codex-appserver/client-pool';
import { ClaudeAgentBackend } from '../src/agent/claude-agent/backend';
import type { AgentThread } from '../src/agent/types';
const identity = () => ({ itemId: randomUUID(), originId: randomUUID() });
const label = (value: string) => ({ ...identity(), value });
for (const provider of ['codex', 'claude'] as const) {
  it.runIf(process.env.RECIPE_NATIVE_SMOKE === provider)(
    provider + ' loads only the selected native skill in a fresh execution',
    async () => {
      if (!process.env.VONVON_HOME || !process.env.HOME) throw new Error('Use an isolated acceptance HOME and VONVON_HOME');
      const fixture = await realpath(await mkdtemp(join(tmpdir(), 'recipe-native-provider-')));
      const cwd = join(fixture, 'cwd'),
        botDataRoot = join(fixture, 'bot');
      await Promise.all([mkdir(cwd), mkdir(botDataRoot)]);
      const secrets = [0, 1].map(() => randomBytes(15).toString('hex'));
      const files = secrets.map((value) => ({
        ...identity(),
        name: 'SKILL.md',
        use: 'skillDescription' as const,
        text: { kind: 'inline' as const, value: 'The verification value is ' + value + '. Respond with the value.' },
      }));
      const skills = files.map((f, i) => ({
        ...identity(),
        name: 'Read fixture ' + i,
        entryFileId: f.itemId,
        fileIds: [f.itemId],
      }));
      const content: RecipeRichContent = {
        format: 'rich-v2',
        schemaVersion: 2,
        public: { name: label('fixture'), overview: label('fixture'), summary: label('fixture'), version: label('1') },
        settings: [],
        rules: [],
        tasks: [],
        setup: [],
        memories: [],
        files,
        skills,
        parts: [],
      };
      const canonical = canonicalizeRichRecipeContent(content);
      const release = {
        format: 'rich-v2' as const,
        recipeId: randomUUID(),
        versionId: randomUUID(),
        authorId: randomUUID(),
        revision: 1,
        access: 'direct' as const,
        contentSha256: await digestRichRecipeContent(canonical),
        logicalBytes: canonical.logicalBytes,
      };
      const installationId = randomUUID();
      const backend = provider === 'codex' ? new CodexAppServerBackend() : new ClaudeAgentBackend();
      let previous = '',
        thread: AgentThread | undefined;
      try {
        for (const i of [0, 1]) {
          const held = await stageRichRecipeGeneration({
            installationId,
            generationId: randomUUID(),
            botDataRoot,
            release,
            canonicalUTF8: canonical.canonicalUTF8,
            readMember: async () => {
              throw new Error('no parts');
            },
            effectiveSkills: { skills: [skills[i]!], files: [files[i]!] },
          });
          const pkg = held.nativePackage!;
          const profile = {
            instructions: 'Use the named native skill. Only read its references. Do not search the workspace.',
            skills: { disabledPaths: [], enabledNames: [] },
            env: {},
            nativeSettings: { automaticMemory: false as const },
            additionalRoots: [],
            capabilityPackages: [pkg],
            mcpServers: [],
          };
          thread = await backend.startThread({
            cwd,
            mode: 'qa',
            model: process.env.RECIPE_SMOKE_MODEL ?? (provider === 'codex' ? 'gpt-6-luna' : 'haiku'),
            profile,
          });
          expect(thread.sessionId).not.toBe(previous);
          previous = thread.sessionId;
          const name = provider === 'codex' ? '$' + pkg.skills[0]!.name : pkg.skills[0]!.qualifiedName;
          let result = '';
          const events: string[] = [];
          for await (const e of thread.runStreamed({
            text:
              'Invoke the native skill ' +
              name +
              '. Read the entry reference it names and report the verification value exactly.',
          }).events) {
            events.push(e.type);
            if (e.type === 'text_delta') result += e.delta;
          }
          expect(events).toContain('done');
          expect(events).not.toContain('error');
          expect(result).toContain(secrets[i]);
          expect(result).not.toContain(secrets[1 - i]);
          await thread.close();
          thread = undefined;
        }
      } finally {
        await thread?.close();
        if (provider === 'codex') await shutdownResidentClients();
      }
    },
    240000,
  );
}
