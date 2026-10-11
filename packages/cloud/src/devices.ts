import { createHash, timingSafeEqual } from "node:crypto";
import { machineIdSchema, type AccountId, type DeviceId } from "@vonvon/protocol";
import { z } from "zod";
import { RepositoryError, type Device, type DevicePresence, type Enrollment, type Repository } from "./store/repository.js";

const nonempty = z.string().refine((value) => value.trim().length > 0);
const enrollmentSchema = z.object({
  machineId: machineIdSchema,
  name: nonempty,
  platform: nonempty,
  version: nonempty,
  publicKey: nonempty,
  secretHash: z.string().regex(/^[a-fA-F0-9]{64}$/).transform((value) => value.toLowerCase()),
});

export interface DeviceOperations {
  enroll(accountId: AccountId, input: Enrollment): Promise<Device>;
  rename(accountId: AccountId, deviceId: DeviceId, name: string): Promise<Device>;
  revoke(accountId: AccountId, deviceId: DeviceId): Promise<void>;
  validateCredential(deviceId: DeviceId, rawSecret: Uint8Array): Promise<void>;
  isOnline(presence: DevicePresence | null, now: Date): boolean;
}

export class DeviceCredentialError extends Error {
  readonly code = "device_unauthorized";
  constructor() {
    super("device_unauthorized");
    this.name = "DeviceCredentialError";
  }
}

export function createDeviceOperations(repository: Repository): DeviceOperations {
  return {
    async enroll(accountId, input) {
      const enrollment = enrollmentSchema.parse(input);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const existing = await repository.findActiveDevice(accountId, enrollment.machineId);
          return existing
            ? await repository.rotateDevice(accountId, existing.deviceId, enrollment)
            : await repository.createDevice(accountId, enrollment);
        } catch (error) {
          if (!(error instanceof RepositoryError)
            || (error.code !== "active_device_exists" && error.code !== "device_revoked")) throw error;
        }
      }
      throw new RepositoryError("enrollment_conflict");
    },
    async rename(accountId, deviceId, name) {
      return repository.renameDevice(accountId, deviceId, nonempty.parse(name));
    },
    async revoke(accountId, deviceId) {
      await repository.revokeDevice(accountId, deviceId);
    },
    async validateCredential(deviceId, rawSecret) {
      const credential = await repository.getDeviceCredential(deviceId);
      if (!credential) throw new RepositoryError("device_unknown");
      if (credential.revokedAt !== null) throw new RepositoryError("device_revoked");
      if (rawSecret.byteLength !== 32) throw new DeviceCredentialError();
      const received = createHash("sha256").update(rawSecret).digest();
      const expected = Buffer.from(credential.secretHash, "hex");
      if (expected.length !== received.length || !timingSafeEqual(received, expected)) throw new DeviceCredentialError();
    },
    isOnline(presence, now) {
      if (!presence || presence.linkState !== "open") return false;
      const age = now.getTime() - Date.parse(presence.heartbeatAt);
      return age >= 0 && age <= 45_000;
    },
  };
}
