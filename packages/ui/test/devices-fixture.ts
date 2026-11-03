import {vi} from 'vitest';
import type {DeviceRow, DevicesState} from '@vonvon/protocol';
import {createClient} from '../../client/src/client';
import type {DevicesShell, ShellCapabilities} from '../src/client-context';

/** devices-ui-1b tests: made-up ids, names and documentation addresses only. */
export const A = '11111111-1111-4111-8111-111111111111';
export const B = '22222222-2222-4222-8222-222222222222';
export const newClient = () => createClient({isOpen: () => true, onMessage: () => {}, onClose: () => {}, onError: () => {}, send: () => {}, close: async () => {}});
export const info = (version = '0.9.1', protocolVersion = 2, capabilities: string[] | null = ['device']) => ({
  type: 'serverInfo' as const, machineId: A, version, protocolVersion, deviceName: '机房', platform: 'linux', ...(capabilities ? {capabilities} : {}),
});
export const localRow: DeviceRow = {id: 'local', name: '这台电脑', current: false, status: 'online', platform: 'macos', version: '0.9.1', routes: []};
export const rowA: DeviceRow = {id: A, name: '机房', current: false, status: 'online', platform: 'linux', version: '0.9.1',
  routes: [{host: '100.64.0.10', port: 7767, kind: 'tailscale'}, {host: '192.0.2.10', port: 7767, kind: 'lan'}]};
export const rowB: DeviceRow = {id: B, name: '家里', current: false, status: 'unknown', platform: 'windows', version: '0.9.0', lastConnectedAt: Date.now() - 5 * 60_000,
  routes: [{host: '198.51.100.7', port: 7767, kind: 'public'}]};

export function devicesState(active: Partial<DevicesState['active']> & {id: string}, rows: Partial<Record<string, Partial<DeviceRow>>> = {}, extra: Partial<DevicesState> = {}): DevicesState {
  return {
    v: 1, revision: 1, client: {version: '0.9.1', protocolVersion: 2}, registry: 'ok', secureStorage: true,
    devices: [localRow, rowA, rowB].map(row => ({...row, ...rows[row.id], current: row.id === active.id})),
    active: {phase: 'ready', mode: 'full', attempt: 0, ...active},
    ...extra,
  };
}

export function fakeShell(): ShellCapabilities & {devices: DevicesShell & {[K in keyof DevicesShell]: ReturnType<typeof vi.fn>}} {
  const clients = new Map<string, ReturnType<typeof newClient>>();
  const devices = {
    state: vi.fn(), onState: vi.fn(() => () => {}),
    clientFor: vi.fn((view: string) => { if (!clients.has(view)) clients.set(view, newClient()); return clients.get(view)!; }),
    inspect: vi.fn(), add: vi.fn(), cancelAdd: vi.fn(async () => {}), rename: vi.fn(async () => {}), remove: vi.fn(),
    switchTo: vi.fn(async () => {}), retry: vi.fn(async () => {}),
  };
  return {devices, quit: vi.fn(async () => {}), onQuitRequested: vi.fn(() => () => {}), openExternal: vi.fn(async () => {})} as never;
}
