import { fakeService, startFixture } from './server-fixture';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { connectLocal } from '@vonvon/client';
import { agentIdSchema } from '@vonvon/protocol';
import type { AdminBot } from '../src/admin/service';
import { withDaemon, type Daemon } from '../src/cli/daemon-client';
import { runBotList } from '../src/cli/commands/bot';
import { runGroupPending } from '../src/cli/commands/group';
import { runSettingsGet } from '../src/cli/commands/settings';

const bot: AdminBot = { appId: 'cli_a', name: 'Bot', tenant: 'feishu', active: true, current: true, running: false, completionReminder: { mode: 'failures', longTaskMinutes: 3 } };

it('maps the real daemon\'s replies and refusals without printing the local credential', async () => {
  const fixture = await startFixture(fakeService({ listBots: async () => [bot] }));
  try {
    // The fake discovery script stands in for `vonvon daemon status --json`, as in the client's own tests.
    const cliEntry = join(fixture.home, 'fake-cli.mjs');
    await writeFile(cliEntry, `process.stdout.write(JSON.stringify({running:true,listen:"127.0.0.1:${fixture.api.port}"}));`);
    const daemon: Daemon = fn => withDaemon(fn, () => connectLocal({ home: fixture.home, cliEntry }));
    let out = '';
    await runBotList({ json: true, write: text => { out += text; } }, daemon);
    expect(JSON.parse(out).bots).toMatchObject([{ id: 'cli_a', enabled: true, running: false }]);
    const errors = await Promise.all([
      runGroupPending({}, { json: false, write: text => { out += text; } }, daemon).then(() => '', (error: Error) => error.message),
      runSettingsGet(undefined, {}, { json: false, write: text => { out += text; } }, daemon).then(() => '', (error: Error) => error.message),
    ]);
    expect(errors[0]).toBe('查待绑定的群失败：Bot 没启用或没在运行');
    expect(errors[1]).toBe('读取设置失败：当前 daemon 不支持此操作。\ndaemon 可能比命令行旧。');
    // The real client would throw its request-side ZodError here; the CLI's own check names the field instead.
    const scope = { kind: 'session' as const, botId: agentIdSchema.parse('cli_a'), threadId: '' };
    await expect(daemon(call => call('读取设置', c => c.settings({ type: 'read', scope })))).rejects.toThrow(/^读取设置没有发出：命令行给的参数不对（scope\.threadId：/);
    expect(`${out}${errors.join('')}`).not.toContain(fixture.credential);
  } finally { await fixture.close(); }
});
