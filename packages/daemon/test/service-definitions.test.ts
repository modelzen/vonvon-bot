import { describe, expect, it, vi } from 'vitest';
import { renderDefinition } from '../src/service/definitions';
import { resolveServiceRoot, LAUNCHD_LABEL, SYSTEMD_UNIT_NAME } from '../src/service/identity';

// These tests cover serialization and configuration semantics. Native execution
// and executable-selection evidence live in service-smoke.test.ts.

vi.mock('../src/service/identity', async importOriginal => ({
  ...await importOriginal<typeof import('../src/service/identity')>(),
  resolveServiceRoot: vi.fn(async () => '/fixture/root'),
}));
describe('systemd definition', () => {
  it('fixes the identity, root, port, restart policy, logs and PATH', async () => {
    const root = await resolveServiceRoot('/fixture/root');
    const rendered = renderDefinition({ target: { platform: 'linux', unitPath: '/unused.service' }, root, port: 32123,
      distribution: { kind: 'desktop', executable: '/fixture/bin/node', entry: '/package/tools %n/$entry.mjs' }, capturedPath: '/captured/"tools":/bin' });
    if (rendered.platform !== 'linux') throw new Error('Expected unit');
    const unit = Buffer.from(rendered.unit).toString();
    expect(SYSTEMD_UNIT_NAME).toBe('vonvon-bot.service');
    expect(unit).toContain('Type=simple');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('RestartSec=5');
    expect(unit).toContain('TimeoutStopSec=infinity');
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).toContain('"/package/tools %%n/$$entry.mjs" daemon run --port 32123');
    expect(unit).toContain(`Environment="VONVON_HOME=${root}"`);
    expect(unit).toContain('Environment="VONVON_SERVICE=systemd"');
    expect(unit).toContain('Environment="ELECTRON_RUN_AS_NODE=1"');
    expect(unit).toContain('Environment="PATH=/captured/\\"tools\\":/bin"');
    expect(unit).toContain(`StandardOutput=append:${root}/service.log`);
    expect(unit).toContain(`StandardError=append:${root}/service.err.log`);
    expect(unit).not.toContain('CODEX_BIN');
  });
});

describe('launchd definition', () => {
  it('fixes the identity, root, port and PATH without CODEX_BIN passthrough', async () => {
    const root = await resolveServiceRoot('/fixture/root');
    const rendered = renderDefinition({ target: { platform: 'darwin', plistPath: '/unused.plist' }, root, port: 32123,
      distribution: { kind: 'npm', executable: '/fixture/bin/node', entry: '/package/bin/vonvon.mjs' }, capturedPath: '/captured/bin' });
    if (rendered.platform !== 'darwin') throw new Error('Expected plist');
    const plist = Buffer.from(rendered.plist).toString();
    expect(plist).toContain(`<key>Label</key><string>${LAUNCHD_LABEL}</string>`);
    expect(plist).toContain('<string>--port</string><string>32123</string>');
    expect(plist).toContain('<key>PATH</key><string>/captured/bin</string>');
    expect(plist).toContain(`<string>${root}/service.log</string>`);
    expect(plist).toContain('<key>SuccessfulExit</key><false/>');
    expect(plist).not.toContain('CODEX_BIN');
  });
});
