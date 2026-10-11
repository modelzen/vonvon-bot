import type { AccountId, DeviceId, MachineId } from "@vonvon/protocol";

export type Provider = "feishu" | "lark";
export type Account = Readonly<{
  accountId: AccountId;
  provider: Provider;
  subject: string;
  name: string;
}>;
export type Device = Readonly<{
  deviceId: DeviceId;
  accountId: AccountId;
  machineId: MachineId;
  name: string;
  platform: string;
  version: string;
  publicKey: string;
  lastSeenAt: string;
}>;
export type DeviceCredential = Readonly<{
  deviceId: DeviceId;
  secretHash: string;
  createdAt: string;
  revokedAt: string | null;
}>;
export type DevicePresence = Readonly<{
  deviceId: DeviceId;
  linkState: "open" | "closed";
  heartbeatAt: string;
}>;
export type Enrollment = Readonly<{
  machineId: MachineId;
  name: string;
  platform: string;
  version: string;
  publicKey: string;
  secretHash: string;
}>;
export type RepositoryOptions = Readonly<{
  now?: () => Date;
  newAccountId?: () => AccountId;
  newDeviceId?: () => DeviceId;
}>;
export type RepositoryErrorCode =
  | "account_unknown"
  | "device_unknown"
  | "device_revoked"
  | "active_device_exists"
  | "enrollment_conflict";
export class RepositoryError extends Error {
  constructor(readonly code: RepositoryErrorCode) {
    super(code);
    this.name = "RepositoryError";
  }
}
export interface Repository {
  upsertAccount(provider: Provider, subject: string): Promise<Account>;
  getAccount(accountId: AccountId): Promise<Account | null>;
  createDevice(accountId: AccountId, input: Enrollment): Promise<Device>;
  rotateDevice(accountId: AccountId, deviceId: DeviceId, input: Enrollment): Promise<Device>;
  findActiveDevice(accountId: AccountId, machineId: MachineId): Promise<Device | null>;
  getDeviceCredential(deviceId: DeviceId): Promise<DeviceCredential | null>;
  renameDevice(accountId: AccountId, deviceId: DeviceId, name: string): Promise<Device>;
  revokeDevice(accountId: AccountId, deviceId: DeviceId): Promise<void>;
  listDevices(accountId: AccountId): Promise<readonly Device[]>;
  setPresence(deviceId: DeviceId, linkState: DevicePresence["linkState"], heartbeatAt: string): Promise<void>;
  getPresence(deviceId: DeviceId): Promise<DevicePresence | null>;
}
