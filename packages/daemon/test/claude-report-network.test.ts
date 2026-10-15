import { expect, it } from 'vitest';
import '../src/agent/claude-agent/backend';

it('leaves the network part out of process reports, which the Claude SDK builds on Linux for each session', () => {
  expect((process.report as { excludeNetwork?: boolean }).excludeNetwork).toBe(true);
  // What the SDK reads from the report is still there.
  expect(process.report.getReport()).toHaveProperty('header');
});
