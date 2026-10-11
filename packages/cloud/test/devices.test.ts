import { createHash, randomUUID } from "node:crypto";
import { deviceIdSchema, machineIdSchema } from "@vonvon/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { createDeviceOperations } from "../src/devices.js";
import { createMemoryRepository } from "../src/store/memory.js";
import { RepositoryError, type Enrollment } from "../src/store/repository.js";

const time = "2026-10-11T00:00:00.000Z";
const secretA = new Uint8Array(32).fill(0x41);
const secretB = new Uint8Array(32).fill(0x42);
const hash = (secret: Uint8Array) => createHash("sha256").update(secret).digest("hex");
const input = (secret = secretA): Enrollment => ({
  machineId: machineIdSchema.parse("10000000-0000-4000-8000-000000000001"),
  name: "Desk", platform: "darwin", version: "1", publicKey: "opaque-public-key",
  secretHash: hash(secret),
});

describe("device operations", () => {
  let repository: ReturnType<typeof createMemoryRepository>;
  let operations: ReturnType<typeof createDeviceOperations>;
  beforeEach(() => {
    repository = createMemoryRepository({ now: () => new Date(time) });
    operations = createDeviceOperations(repository);
  });

  it("enrolls, renames and revokes while retaining no secret in the public response", async () => {
    const a = await repository.upsertAccount("feishu", "a");
    const device = await operations.enroll(a.accountId, input());
    expect(Object.keys(device).sort()).toEqual(["accountId", "deviceId", "lastSeenAt", "machineId", "name", "platform", "publicKey", "version"]);
    await expect(operations.validateCredential(device.deviceId, secretA)).resolves.toBeUndefined();
    expect(await operations.rename(a.accountId, device.deviceId, "Office")).toMatchObject({ name: "Office" });
    await operations.revoke(a.accountId, device.deviceId);
    await expect(operations.validateCredential(device.deviceId, secretA)).rejects.toMatchObject({ code: "device_revoked" });
    expect(await repository.listDevices(a.accountId)).toEqual([]);
  });

  it("rotates in place and refuses the old secret immediately", async () => {
    const a = await repository.upsertAccount("feishu", "a");
    const first = await operations.enroll(a.accountId, input());
    const second = await operations.enroll(a.accountId, { ...input(secretB), publicKey: "replacement-key" });
    expect(second.deviceId).toBe(first.deviceId);
    expect(second.publicKey).toBe("replacement-key");
    await expect(operations.validateCredential(first.deviceId, secretA)).rejects.toMatchObject({ code: "device_unauthorized" });
    await expect(operations.validateCredential(second.deviceId, secretB)).resolves.toBeUndefined();
    await operations.revoke(a.accountId, first.deviceId);
    const third = await operations.enroll(a.accountId, input());
    expect(third.deviceId).not.toBe(first.deviceId);
  });

  it("isolates another account using the same machine", async () => {
    const a = await repository.upsertAccount("feishu", "a");
    const b = await repository.upsertAccount("feishu", "b");
    const first = await operations.enroll(a.accountId, input());
    const second = await operations.enroll(b.accountId, input(secretB));
    expect(first.deviceId).not.toBe(second.deviceId);
    await expect(operations.rename(b.accountId, first.deviceId, "stolen")).rejects.toMatchObject({ code: "device_unknown" });
    await expect(operations.revoke(b.accountId, first.deviceId)).rejects.toMatchObject({ code: "device_unknown" });
    await expect(operations.validateCredential(first.deviceId, secretA)).resolves.toBeUndefined();
  });

  it("distinguishes wrong, malformed, unknown and revoked credentials", async () => {
    const a = await repository.upsertAccount("feishu", "a");
    const device = await operations.enroll(a.accountId, input());
    for (const secret of [secretB, new Uint8Array(31), new Uint8Array(33)]) {
      await expect(operations.validateCredential(device.deviceId, secret)).rejects.toMatchObject({ code: "device_unauthorized" });
    }
    await expect(operations.validateCredential(deviceIdSchema.parse(randomUUID()), secretA)).rejects.toMatchObject({ code: "device_unknown" });
    await operations.revoke(a.accountId, device.deviceId);
    await expect(operations.validateCredential(device.deviceId, secretB)).rejects.toMatchObject({ code: "device_revoked" });
    expect(secretA).toEqual(new Uint8Array(32).fill(0x41));
  });

  it("validates boundary values and stores canonical lowercase hashes", async () => {
    const a = await repository.upsertAccount("feishu", "a");
    for (const invalid of [{ secretHash: "x".repeat(64) }, { secretHash: "a".repeat(63) }, { publicKey: "  " }, { name: "" }, { platform: "" }, { version: "" }]) {
      await expect(operations.enroll(a.accountId, { ...input(), ...invalid })).rejects.toThrow();
    }
    expect(await repository.listDevices(a.accountId)).toEqual([]);
    const device = await operations.enroll(a.accountId, { ...input(), secretHash: hash(secretA).toUpperCase() });
    expect(await repository.getDeviceCredential(device.deviceId)).toMatchObject({ secretHash: hash(secretA) });
    await expect(operations.rename(a.accountId, device.deviceId, "  ")).rejects.toThrow();
    expect(await repository.listDevices(a.accountId)).toMatchObject([{ name: "Desk" }]);
  });

  it("concurrent enrollments converge on one active ID", async () => {
    const a = await repository.upsertAccount("feishu", "a");
    const devices = await Promise.all(Array.from({ length: 8 }, () => operations.enroll(a.accountId, input())));
    expect(new Set(devices.map((device) => device.deviceId)).size).toBe(1);
    expect(await repository.listDevices(a.accountId)).toHaveLength(1);
    const first = devices[0];
    if (!first) throw new Error("Enrollment returned no devices");
    await expect(operations.validateCredential(first.deviceId, secretA)).resolves.toBeUndefined();
  });

  it("bounds enrollment churn while preserving operational failures", async () => {
    const a = await repository.upsertAccount("feishu", "a");
    let attempts = 0;
    const churning = createDeviceOperations({ ...repository, createDevice: async () => {
      attempts += 1;
      throw new RepositoryError("active_device_exists");
    } });
    await expect(churning.enroll(a.accountId, input())).rejects.toMatchObject({ code: "enrollment_conflict" });
    expect(attempts).toBe(3);
    const failure = new Error("database disconnected");
    const failing = createDeviceOperations({ ...repository, createDevice: async () => { throw failure; }, getDeviceCredential: async () => { throw failure; } });
    await expect(failing.enroll(a.accountId, input())).rejects.toBe(failure);
    await expect(failing.validateCredential(deviceIdSchema.parse(randomUUID()), secretA)).rejects.toBe(failure);
  });

  it.each([[-1, false], [0, true], [44_999, true], [45_000, true], [45_001, false]])("heartbeat age %i gives online=%s", (age, online) => {
    const presence = { deviceId: deviceIdSchema.parse(randomUUID()), linkState: "open" as const, heartbeatAt: time };
    expect(operations.isOnline(presence, new Date(Date.parse(time) + age))).toBe(online);
    expect(operations.isOnline({ ...presence, linkState: "closed" }, new Date(Date.parse(time) + age))).toBe(false);
  });

  it("goes offline immediately on close and rejects absent or invalid contact times", async () => {
    const a = await repository.upsertAccount("feishu", "a");
    const device = await operations.enroll(a.accountId, input());
    await repository.setPresence(device.deviceId, "open", time);
    expect(operations.isOnline(await repository.getPresence(device.deviceId), new Date(time))).toBe(true);
    await repository.setPresence(device.deviceId, "closed", time);
    expect(operations.isOnline(await repository.getPresence(device.deviceId), new Date(time))).toBe(false);
    expect(operations.isOnline(null, new Date(time))).toBe(false);
    expect(operations.isOnline({ deviceId: device.deviceId, linkState: "open", heartbeatAt: "invalid" }, new Date(time))).toBe(false);
  });
});
