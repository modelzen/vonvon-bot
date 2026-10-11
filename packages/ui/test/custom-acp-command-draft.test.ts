import { expect, it } from 'vitest';
import { formatAcpCommandDraft, parseAcpCommandDraft } from '../src/settings/SettingsPanel';

it('round-trips argv by line and clears to null only when empty', () => {
  expect(formatAcpCommandDraft(['agent', '--mode', 'ACP mode'])).toBe('agent\n--mode\nACP mode');
  expect(parseAcpCommandDraft('agent\n--mode\nACP mode')).toEqual(['agent', '--mode', 'ACP mode']);
  expect(parseAcpCommandDraft('')).toBeNull();
  expect(parseAcpCommandDraft('agent\n')).toEqual(['agent', '']);
});
