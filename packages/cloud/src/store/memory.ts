import { randomUUID } from "node:crypto";
import { accountIdSchema, deviceIdSchema, type AccountId, type DeviceId, type MachineId } from "@vonvon/protocol";
import { RepositoryError, type Account, type Device, type DeviceCredential, type DevicePresence, type Enrollment, type Repository, type RepositoryOptions } from "./repository.js";

type StoredDevice = Omit<Device, "lastSeenAt">;
type DeviceState = {
  device: StoredDevice;
  credential: DeviceCredential;
  presence: DevicePresence;
};
type AccountState = {
  account: Account;
  devices: Map<DeviceId, DeviceState>;
  activeMachines: Map<MachineId, DeviceId>;
};

export function createMemoryRepository(options: RepositoryOptions = {}): Repository {
  const now = options.now ?? (() => new Date());
  const newAccountId = options.newAccountId ?? (() => accountIdSchema.parse(randomUUID()));
  const newDeviceId = options.newDeviceId ?? (() => deviceIdSchema.parse(randomUUID()));
  const accounts = new Map<AccountId, AccountState>();
  const accountKeys = new Map<string, AccountId>();
  const devices = new Map<DeviceId, DeviceState>();
  const project = (state: DeviceState): Device => ({ ...state.device, lastSeenAt: state.presence.heartbeatAt });

  function owned(accountId: AccountId, deviceId: DeviceId): DeviceState {
    const state = accounts.get(accountId)?.devices.get(deviceId);
    if (!state) throw new RepositoryError("device_unknown");
    return state;
  }
  function active(state: DeviceState): void {
    if (state.credential.revokedAt !== null) throw new RepositoryError("device_revoked");
  }
  function deviceRecord(accountId: AccountId, deviceId: DeviceId, input: Enrollment): StoredDevice {
    return { accountId, deviceId, machineId: input.machineId, name: input.name,
      platform: input.platform, version: input.version, publicKey: input.publicKey };
  }

  return {
    async upsertAccount(provider, subject) {
      const key = JSON.stringify([provider, subject]);
      const existingId = accountKeys.get(key);
      if (existingId) {
        const existing = accounts.get(existingId);
        if (!existing) throw new Error("Account index is inconsistent");
        return { ...existing.account };
      }
      const accountId = newAccountId();
      if (accounts.has(accountId)) throw new Error("Duplicate account ID");
      const account: Account = { accountId, provider, subject, name: subject };
      const state: AccountState = { account, devices: new Map(), activeMachines: new Map() };
      const result = { ...account };
      accounts.set(accountId, state);
      accountKeys.set(key, accountId);
      return result;
    },
    async getAccount(accountId) {
      const state = accounts.get(accountId);
      return state ? { ...state.account } : null;
    },
    async createDevice(accountId, input) {
      const account = accounts.get(accountId);
      if (!account) throw new RepositoryError("account_unknown");
      if (account.activeMachines.has(input.machineId)) throw new RepositoryError("active_device_exists");
      const deviceId = newDeviceId();
      if (devices.has(deviceId)) throw new Error("Duplicate device ID");
      const createdAt = now().toISOString();
      const state: DeviceState = {
        device: deviceRecord(accountId, deviceId, input),
        credential: { deviceId, secretHash: input.secretHash, createdAt, revokedAt: null },
        presence: { deviceId, linkState: "closed", heartbeatAt: createdAt },
      };
      const result = project(state);
      devices.set(deviceId, state);
      account.devices.set(deviceId, state);
      account.activeMachines.set(state.device.machineId, deviceId);
      return result;
    },
    async rotateDevice(accountId, deviceId, input) {
      const state = owned(accountId, deviceId);
      if (state.device.machineId !== input.machineId) throw new RepositoryError("device_unknown");
      active(state);
      const device = deviceRecord(accountId, deviceId, input);
      const credential: DeviceCredential = { deviceId, secretHash: input.secretHash,
        createdAt: now().toISOString(), revokedAt: null };
      const presence: DevicePresence = { ...state.presence, linkState: "closed" };
      const result = { ...device, lastSeenAt: presence.heartbeatAt };
      state.device = device;
      state.credential = credential;
      state.presence = presence;
      return result;
    },
    async findActiveDevice(accountId, machineId) {
      const account = accounts.get(accountId);
      const id = account?.activeMachines.get(machineId);
      const state = id ? account?.devices.get(id) : undefined;
      return state ? project(state) : null;
    },
    async getDeviceCredential(deviceId) {
      const state = devices.get(deviceId);
      return state ? { ...state.credential } : null;
    },
    async renameDevice(accountId, deviceId, name) {
      const state = owned(accountId, deviceId);
      active(state);
      const device = { ...state.device, name };
      const result = { ...device, lastSeenAt: state.presence.heartbeatAt };
      state.device = device;
      return result;
    },
    async revokeDevice(accountId, deviceId) {
      const state = owned(accountId, deviceId);
      if (state.credential.revokedAt !== null) return;
      const credential = { ...state.credential, revokedAt: now().toISOString() };
      const presence: DevicePresence = { ...state.presence, linkState: "closed" };
      state.credential = credential;
      state.presence = presence;
      accounts.get(accountId)?.activeMachines.delete(state.device.machineId);
    },
    async listDevices(accountId) {
      const account = accounts.get(accountId);
      if (!account) return [];
      return [...account.devices.values()]
        .filter((state) => state.credential.revokedAt === null)
        .map(project).sort((a, b) => a.deviceId.localeCompare(b.deviceId));
    },
    async setPresence(deviceId, linkState, heartbeatAt) {
      const state = devices.get(deviceId);
      if (!state) throw new RepositoryError("device_unknown");
      active(state);
      const incoming = linkState === "open" ? new Date(heartbeatAt).toISOString() : state.presence.heartbeatAt;
      state.presence = { deviceId, linkState,
        heartbeatAt: Date.parse(incoming) > Date.parse(state.presence.heartbeatAt) ? incoming : state.presence.heartbeatAt };
    },
    async getPresence(deviceId) {
      const state = devices.get(deviceId);
      return state ? { ...state.presence } : null;
    },
  };
}
