import {randomUUID} from 'node:crypto';
import {expect, vi} from 'vitest';
import {PROTOCOL_VERSION} from '@vonvon/protocol';
import {generateStaticKey, staticKeyFromBase64url} from '@vonvon/protocol/secure-channel';
import {createDeviceConnections} from '../../../desktop/src/connections';
import type {DeviceRegistry, StoredDevice} from '../../../desktop/src/device-registry';
import type {RemoteConnectCode, RemoteLink} from '../../../desktop/src/remote-transport';
import {plainSecretBox} from '../../../desktop/test/helpers/fake-secure-server';

export function recipeConnections() {
  const box = plainSecretBox();
  let entries: StoredDevice[] = [];
  const registry: DeviceRegistry = {
    status: 'ok', list: () => entries, get: id => entries.find(device => device.deviceId === id),
    async put(device) {entries = [...entries.filter(entry => entry.deviceId !== device.deviceId), device];},
    async update(id, patch) {
      const previous = registry.get(id);
      if (!previous) return;
      const next = patch(previous);
      entries = entries.map(entry => entry.deviceId === id ? next : entry);
      return next;
    },
    async remove(id) {
      const previous = registry.get(id);
      entries = entries.filter(entry => entry.deviceId !== id);
      return Boolean(previous);
    },
    sealKey: key => ({publicKey: key.publicKeyBase64url, secretKeySealed: box.seal(key.privateKeyBase64url)}),
    openKey: device => staticKeyFromBase64url(device.clientKey.publicKey, box.open(device.clientKey.secretKeySealed)),
  };
  const pending: Array<(link: RemoteLink) => void> = [];
  const devices = createDeviceConnections({
    registry, box, connector: {connect: () => new Promise(resolve => pending.push(resolve))},
    client: {version: '0.10.1', protocolVersion: PROTOCOL_VERSION}, hostname: () => 'synthetic',
  });
  devices.setLocal({status: 'online', serverInfo: {type: 'serverInfo', machineId: randomUUID(), version: '0.10.1', protocolVersion: PROTOCOL_VERSION, deviceName: '测试电脑', platform: 'macos'}});

  function add(id: string) {
    const device: StoredDevice = {
      deviceId: id, name: '机房', pk: generateStaticKey().publicKeyBase64url, clientId: 'cl_00000000000000aa',
      clientKey: registry.sealKey(generateStaticKey()), routes: [{host: '192.0.2.10', port: 7767, kind: 'lan'}], addedAt: 1,
    };
    entries = [...entries, device];
  }
  async function ready(id: string) {
    await devices.switchTo(id);
    let end!: (code: RemoteConnectCode) => void;
    const closed = new Promise<{code: RemoteConnectCode}>(resolve => {end = code => resolve({code});});
    const link: RemoteLink = {
      client: {
        admin: vi.fn(async () => ({kind: 'daemonStatus', status: {installed: true, running: true, selfHosted: true, supported: true, version: '0.10.1', pid: 4242, startedAt: 1}})),
        onError: () => () => {},
      } as unknown as RemoteLink['client'],
      serverInfo: {type: 'serverInfo', machineId: id, version: '0.10.1', protocolVersion: PROTOCOL_VERSION, deviceName: '机房', platform: 'linux'},
      closed, close: async () => {end('closed');},
    };
    pending.shift()!(link);
    await vi.waitFor(() => expect(devices.state().active.phase).toBe('ready'));
    return {end};
  }
  return {devices, add, ready};
}
