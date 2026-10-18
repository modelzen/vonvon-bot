import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as sdk from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAgentBackend } from '../../src/agent/claude-agent/backend';

/** The real SDK transport driving the fake CLI at `cli`, with HOME and the config dir in `root`. */
export const claudeWithFakeCli = (root: string, cli: string): ClaudeAgentBackend => new ClaudeAgentBackend(async () => ({
  ...sdk, query: args => sdk.query({
    ...args, options: { ...args.options, pathToClaudeCodeExecutable: cli, executable: 'node',
      env: { ...args.options?.env, HOME: root, VONVON_HOME: join(root, 'vonvon'), CLAUDE_CONFIG_DIR: root },
    },
  }),
}), () => undefined);

/** A fake CLI behaving as the real one (2.1.296, JP-VPS 2026-10-18) with a request in flight: it never
 * answers, ignores stdin EOF and exits 143 soon after SIGTERM. It writes its pid to `pidFile`, and
 * `${pidFile}.user` once the user message arrived. */
export async function writeWaitingClaudeCli(root: string): Promise<{ cli: string; pidFile: string }> {
  const cli = join(root, 'fake-cli.mjs');
  const pidFile = join(root, 'pid');
  await writeFile(cli, `
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.on('SIGTERM', () => setTimeout(() => process.exit(143), 30));
setInterval(() => {}, 1000);
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.type === 'control_request') process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } }) + '\\n');
  if (message.type === 'user') writeFileSync(${JSON.stringify(`${pidFile}.user`)}, '1');
});
`);
  return { cli, pidFile };
}
