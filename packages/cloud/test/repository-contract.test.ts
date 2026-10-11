import { randomUUID } from "node:crypto";
import { accountIdSchema, deviceIdSchema, machineIdSchema } from "@vonvon/protocol";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryRepository } from "../src/store/memory.js";
import { openPostgresRepository } from "../src/store/postgres.js";
import { RepositoryError, type Enrollment, type Repository, type RepositoryOptions } from "../src/store/repository.js";

const initialTime = "2026-10-11T00:00:00.000Z";
const laterTime = "2026-10-11T00:01:00.000Z";
const enrollment = (overrides: Partial<Enrollment> = {}): Enrollment => ({
  machineId: machineIdSchema.parse("10000000-0000-4000-8000-000000000001"),
  name: "Desk", platform: "darwin", version: "1", publicKey: "opaque-key-a",
  secretHash: "a".repeat(64), ...overrides,
});
const unknownAccount = accountIdSchema.parse("20000000-0000-4000-8000-000000000001");
const unknownDevice = deviceIdSchema.parse("30000000-0000-4000-8000-000000000001");
const databaseUrl = process.env.VONVON_CLOUD_TEST_DATABASE_URL;
type Fixture = { repository: Repository; close(): Promise<void> };

async function postgresFixture(options: RepositoryOptions): Promise<Fixture & {
  restart(): Promise<Repository>;
  query(sql: string): Promise<unknown[]>;
}> {
  if (!databaseUrl) throw new Error("Postgres test URL is required");
  const schema = `cloud_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 2_000 });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
  } catch (error) {
    await admin.end();
    throw error;
  }
  const url = new URL(databaseUrl);
  const existingOptions = url.searchParams.get("options") ?? "";
  url.searchParams.set("options", `${existingOptions} -c search_path=${schema}`.trim());
  let opened: Awaited<ReturnType<typeof openPostgresRepository>>;
  try {
    opened = await openPostgresRepository({ ...options, connectionString: url.toString() });
  } catch (error) {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    throw error;
  }
  return {
    repository: opened.repository,
    async close() {
      await opened.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
    async restart() {
      await opened.close();
      opened = await openPostgresRepository({ ...options, connectionString: url.toString() });
      return opened.repository;
    },
    async query(sql) {
      const client = await admin.connect();
      try {
        await client.query(`SET search_path TO ${schema}`);
        const result = await client.query(sql);
        return result.rows;
      } finally { client.release(); }
    },
  };
}

for (const backend of ["memory", "postgres"] as const) {
  describe.skipIf(backend === "postgres" && !databaseUrl)(`${backend} repository contract${backend === "postgres" && !databaseUrl ? " (SKIP: VONVON_CLOUD_TEST_DATABASE_URL absent)" : ""}`, () => {
    let fixture: Fixture | undefined;
    let repository: Repository;
    let clock: string;
    beforeEach(async () => {
      clock = initialTime;
      const options = { now: () => new Date(clock) };
      fixture = backend === "memory"
        ? { repository: createMemoryRepository(options), close: async () => {} }
        : await postgresFixture(options);
      repository = fixture.repository;
    });
    afterEach(async () => { await fixture?.close(); fixture = undefined; });

    it("concurrent account upserts converge and providers remain separate", async () => {
      const accounts = await Promise.all(Array.from({ length: 8 }, () => repository.upsertAccount("feishu", "same")));
      const account = accounts[0];
      expect(account).toMatchObject({ provider: "feishu", subject: "same", name: "same" });
      expect(new Set(accounts.map((entry) => entry.accountId)).size).toBe(1);
      const other = await repository.upsertAccount("lark", "same");
      expect(other.accountId).not.toBe(account?.accountId);
      expect(await repository.getAccount(other.accountId)).toEqual(other);
      expect(await repository.getAccount(unknownAccount)).toBeNull();
    });

    it("creates exactly public fields with closed enrollment contact and a hash-only credential", async () => {
      const account = await repository.upsertAccount("feishu", "owner");
      const input = enrollment();
      const device = await repository.createDevice(account.accountId, input);
      expect(device).toEqual({ deviceId: expect.any(String), accountId: account.accountId,
        machineId: input.machineId, name: "Desk", platform: "darwin", version: "1",
        publicKey: "opaque-key-a", lastSeenAt: initialTime });
      expect(await repository.getDeviceCredential(device.deviceId)).toEqual({ deviceId: device.deviceId,
        secretHash: "a".repeat(64), createdAt: initialTime, revokedAt: null });
      expect(await repository.getPresence(device.deviceId)).toEqual({ deviceId: device.deviceId,
        linkState: "closed", heartbeatAt: initialTime });
      await expect(repository.createDevice(unknownAccount, input)).rejects.toMatchObject({ code: "account_unknown" });
    });

    it("serializes concurrent active creation while allowing another account's machine", async () => {
      const a = await repository.upsertAccount("feishu", "a");
      const b = await repository.upsertAccount("feishu", "b");
      const results = await Promise.allSettled(Array.from({ length: 8 }, () => repository.createDevice(a.accountId, enrollment())));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const result of results) if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(RepositoryError);
        expect(result.reason).toMatchObject({ code: "active_device_exists" });
      }
      const other = await repository.createDevice(b.accountId, enrollment());
      const own = await repository.listDevices(a.accountId);
      expect(own).toHaveLength(1);
      expect(own[0]?.deviceId).not.toBe(other.deviceId);
      expect(await repository.listDevices(b.accountId)).toEqual([other]);
    });

    it("rotates all enrollment values in place, closing without advancing contact", async () => {
      const a = await repository.upsertAccount("feishu", "a");
      const device = await repository.createDevice(a.accountId, enrollment());
      await repository.setPresence(device.deviceId, "open", initialTime);
      clock = laterTime;
      const input = enrollment({ name: "New", platform: "linux", version: "2", publicKey: "key-b", secretHash: "b".repeat(64) });
      expect(await repository.rotateDevice(a.accountId, device.deviceId, input)).toEqual({
        ...device, name: "New", platform: "linux", version: "2", publicKey: "key-b",
      });
      expect(await repository.getDeviceCredential(device.deviceId)).toEqual({ deviceId: device.deviceId,
        secretHash: "b".repeat(64), createdAt: laterTime, revokedAt: null });
      expect(await repository.getPresence(device.deviceId)).toEqual({ deviceId: device.deviceId,
        linkState: "closed", heartbeatAt: initialTime });
    });

    it("refuses wrong owners and mismatched machines without changing records", async () => {
      const a = await repository.upsertAccount("feishu", "a");
      const b = await repository.upsertAccount("feishu", "b");
      const device = await repository.createDevice(a.accountId, enrollment());
      await expect(repository.rotateDevice(b.accountId, device.deviceId, enrollment())).rejects.toMatchObject({ code: "device_unknown" });
      await expect(repository.rotateDevice(a.accountId, device.deviceId, enrollment({ machineId: machineIdSchema.parse(randomUUID()) }))).rejects.toMatchObject({ code: "device_unknown" });
      await expect(repository.renameDevice(b.accountId, device.deviceId, "stolen")).rejects.toMatchObject({ code: "device_unknown" });
      await expect(repository.revokeDevice(b.accountId, device.deviceId)).rejects.toMatchObject({ code: "device_unknown" });
      expect(await repository.findActiveDevice(b.accountId, device.machineId)).toBeNull();
      expect(await repository.listDevices(a.accountId)).toEqual([device]);
      expect(await repository.listDevices(b.accountId)).toEqual([]);
    });

    it("renames only the owned active device and orders public lists by ID", async () => {
      const a = await repository.upsertAccount("feishu", "a");
      const one = await repository.createDevice(a.accountId, enrollment());
      const two = await repository.createDevice(a.accountId, enrollment({ machineId: machineIdSchema.parse(randomUUID()) }));
      const renamed = await repository.renameDevice(a.accountId, one.deviceId, "Office");
      expect(renamed).toEqual({ ...one, name: "Office" });
      expect(await repository.listDevices(a.accountId)).toEqual([renamed, two].sort((x, y) => x.deviceId.localeCompare(y.deviceId)));
    });

    it("retains the first revoke time and permits only a new device ID afterwards", async () => {
      const a = await repository.upsertAccount("feishu", "a");
      const device = await repository.createDevice(a.accountId, enrollment());
      await repository.setPresence(device.deviceId, "open", initialTime);
      clock = laterTime;
      await repository.revokeDevice(a.accountId, device.deviceId);
      clock = "2026-10-11T00:02:00.000Z";
      await repository.revokeDevice(a.accountId, device.deviceId);
      expect(await repository.getDeviceCredential(device.deviceId)).toMatchObject({ revokedAt: laterTime });
      expect(await repository.getPresence(device.deviceId)).toMatchObject({ linkState: "closed", heartbeatAt: initialTime });
      expect(await repository.findActiveDevice(a.accountId, device.machineId)).toBeNull();
      expect(await repository.listDevices(a.accountId)).toEqual([]);
      await expect(repository.renameDevice(a.accountId, device.deviceId, "no")).rejects.toMatchObject({ code: "device_revoked" });
      await expect(repository.rotateDevice(a.accountId, device.deviceId, enrollment())).rejects.toMatchObject({ code: "device_revoked" });
      await expect(repository.setPresence(device.deviceId, "open", clock)).rejects.toMatchObject({ code: "device_revoked" });
      const next = await repository.createDevice(a.accountId, enrollment());
      expect(next.deviceId).not.toBe(device.deviceId);
    });

    it("keeps open heartbeats monotonic and close preserves the previous contact", async () => {
      const a = await repository.upsertAccount("feishu", "a");
      const device = await repository.createDevice(a.accountId, enrollment());
      await repository.setPresence(device.deviceId, "open", laterTime);
      await repository.setPresence(device.deviceId, "open", initialTime);
      expect(await repository.getPresence(device.deviceId)).toMatchObject({ linkState: "open", heartbeatAt: laterTime });
      await repository.setPresence(device.deviceId, "closed", "2026-10-11T00:03:00.000Z");
      expect(await repository.getPresence(device.deviceId)).toMatchObject({ linkState: "closed", heartbeatAt: laterTime });
      expect(await repository.listDevices(a.accountId)).toEqual([{ ...device, lastSeenAt: laterTime }]);
      await repository.setPresence(device.deviceId, "open", initialTime);
      expect(await repository.getPresence(device.deviceId)).toMatchObject({ linkState: "open", heartbeatAt: laterTime });
    });

    it("does not resurrect a device when rotation and heartbeats race with revoke", async () => {
      const a = await repository.upsertAccount("feishu", "a");
      const device = await repository.createDevice(a.accountId, enrollment());
      const results = await Promise.allSettled([
        repository.rotateDevice(a.accountId, device.deviceId, enrollment({ secretHash: "b".repeat(64) })),
        repository.revokeDevice(a.accountId, device.deviceId),
        repository.setPresence(device.deviceId, "open", laterTime),
      ]);
      expect(results[1]?.status).toBe("fulfilled");
      for (const result of results) if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "device_revoked" });
      expect(await repository.getDeviceCredential(device.deviceId)).toMatchObject({ revokedAt: initialTime });
      expect(await repository.getPresence(device.deviceId)).toMatchObject({ linkState: "closed" });
      expect(await repository.listDevices(a.accountId)).toEqual([]);
    });

    it("a concurrent create and revoke leave at most one active device", async () => {
      const a = await repository.upsertAccount("feishu", "a");
      const old = await repository.createDevice(a.accountId, enrollment());
      const [created] = await Promise.allSettled([
        repository.createDevice(a.accountId, enrollment()), repository.revokeDevice(a.accountId, old.deviceId),
      ]);
      if (created?.status === "rejected") expect(created.reason).toMatchObject({ code: "active_device_exists" });
      const active = await repository.listDevices(a.accountId);
      expect(active).toHaveLength(created?.status === "fulfilled" ? 1 : 0);
      expect(active.some((device) => device.deviceId === old.deviceId)).toBe(false);
    });

    it("distinguishes absent reads and unknown mutation errors", async () => {
      expect(await repository.getDeviceCredential(unknownDevice)).toBeNull();
      expect(await repository.getPresence(unknownDevice)).toBeNull();
      expect(await repository.listDevices(unknownAccount)).toEqual([]);
      expect(await repository.findActiveDevice(unknownAccount, enrollment().machineId)).toBeNull();
      await expect(repository.revokeDevice(unknownAccount, unknownDevice)).rejects.toMatchObject({ code: "device_unknown" });
      await expect(repository.renameDevice(unknownAccount, unknownDevice, "none")).rejects.toMatchObject({ code: "device_unknown" });
      await expect(repository.setPresence(unknownDevice, "open", initialTime)).rejects.toMatchObject({ code: "device_unknown" });
    });

    it("returns detached records and arrays", async () => {
      const a = await repository.upsertAccount("feishu", "a");
      const device = await repository.createDevice(a.accountId, enrollment());
      Object.assign(a, { name: "mutated" });
      Object.assign(device, { name: "mutated" });
      const credential = await repository.getDeviceCredential(device.deviceId);
      const presence = await repository.getPresence(device.deviceId);
      Object.assign(credential ?? {}, { secretHash: "f".repeat(64) });
      Object.assign(presence ?? {}, { linkState: "open" });
      const devices = await repository.listDevices(a.accountId);
      Object.assign(devices[0] ?? {}, { name: "mutated" });
      expect(await repository.getAccount(a.accountId)).toMatchObject({ name: "a" });
      expect(await repository.listDevices(a.accountId)).toMatchObject([{ name: "Desk" }]);
      expect(await repository.getDeviceCredential(device.deviceId)).toMatchObject({ secretHash: "a".repeat(64) });
      expect(await repository.getPresence(device.deviceId)).toMatchObject({ linkState: "closed" });
    });
  });
}

describe("memory failure atomicity", () => {
  it("a failing clock cannot leave a device or block the next creation", async () => {
    let fail = true;
    const repository = createMemoryRepository({ now: () => { if (fail) throw new Error("clock failure"); return new Date(initialTime); } });
    const account = await repository.upsertAccount("feishu", "a");
    await expect(repository.createDevice(account.accountId, enrollment())).rejects.toThrow("clock failure");
    expect(await repository.listDevices(account.accountId)).toEqual([]);
    fail = false;
    expect(await repository.createDevice(account.accountId, enrollment())).toMatchObject({ lastSeenAt: initialTime });
  });
  it("a failing rotation or revoke clock leaves all earlier state intact", async () => {
    let fail = false;
    const repository = createMemoryRepository({ now: () => { if (fail) throw new Error("clock failure"); return new Date(initialTime); } });
    const a = await repository.upsertAccount("feishu", "a");
    const device = await repository.createDevice(a.accountId, enrollment());
    await repository.setPresence(device.deviceId, "open", laterTime);
    fail = true;
    await expect(repository.rotateDevice(a.accountId, device.deviceId, enrollment({ secretHash: "b".repeat(64), name: "replacement" }))).rejects.toThrow("clock failure");
    await expect(repository.revokeDevice(a.accountId, device.deviceId)).rejects.toThrow("clock failure");
    expect(await repository.listDevices(a.accountId)).toEqual([{ ...device, lastSeenAt: laterTime }]);
    expect(await repository.getDeviceCredential(device.deviceId)).toMatchObject({ secretHash: "a".repeat(64), revokedAt: null });
    expect(await repository.getPresence(device.deviceId)).toMatchObject({ linkState: "open", heartbeatAt: laterTime });
  });
  it("a failing ID factory cannot insert an account", async () => {
    let fail = true;
    const repository = createMemoryRepository({ newAccountId: () => { if (fail) throw new Error("ID failure"); return unknownAccount; } });
    await expect(repository.upsertAccount("feishu", "a")).rejects.toThrow("ID failure");
    expect(await repository.getAccount(unknownAccount)).toBeNull();
    fail = false;
    expect(await repository.upsertAccount("feishu", "a")).toMatchObject({ accountId: unknownAccount });
  });
});

describe.skipIf(!databaseUrl)("Postgres rollback and restart", () => {
  let fixture: Awaited<ReturnType<typeof postgresFixture>>;
  beforeEach(async () => { fixture = await postgresFixture({ now: () => new Date(initialTime) }); });
  afterEach(async () => { await fixture?.close(); });
  it("rolls back all device writes when credential insertion fails", async () => {
    const repository = fixture.repository;
    const a = await repository.upsertAccount("feishu", "a");
    await fixture.query("ALTER TABLE device_credentials ADD CONSTRAINT test_reject_hash CHECK (secret_hash <> repeat('a', 64))");
    await expect(repository.createDevice(a.accountId, enrollment())).rejects.not.toBeInstanceOf(RepositoryError);
    expect(await repository.listDevices(a.accountId)).toEqual([]);
    expect(await fixture.query("SELECT (SELECT count(*) FROM devices) AS devices, (SELECT count(*) FROM device_credentials) AS credentials, (SELECT count(*) FROM device_presence) AS presence")).toEqual([{ devices: "0", credentials: "0", presence: "0" }]);
    await fixture.query("ALTER TABLE device_credentials DROP CONSTRAINT test_reject_hash");
    const device = await repository.createDevice(a.accountId, enrollment());
    expect(await repository.getDeviceCredential(device.deviceId)).toMatchObject({ secretHash: "a".repeat(64) });
    await repository.setPresence(device.deviceId, "open", laterTime);
    await fixture.query("ALTER TABLE device_credentials ADD CONSTRAINT test_reject_rotation CHECK (secret_hash <> repeat('b', 64))");
    await expect(repository.rotateDevice(a.accountId, device.deviceId, enrollment({ name: "replacement", publicKey: "replacement-key", secretHash: "b".repeat(64) }))).rejects.not.toBeInstanceOf(RepositoryError);
    expect(await repository.listDevices(a.accountId)).toEqual([{ ...device, lastSeenAt: laterTime }]);
    expect(await repository.getDeviceCredential(device.deviceId)).toMatchObject({ secretHash: "a".repeat(64) });
    expect(await repository.getPresence(device.deviceId)).toMatchObject({ linkState: "open", heartbeatAt: laterTime });
  });
  it("preserves an existing account name during upsert", async () => {
    const repository = fixture.repository;
    const a = await repository.upsertAccount("feishu", "a");
    await fixture.query("UPDATE accounts SET name = 'Display name'");
    expect(await repository.upsertAccount("feishu", "a")).toEqual({ ...a, name: "Display name" });
  });
  it("stores only the four documented record shapes", async () => {
    const rows = await fixture.query("SELECT table_name, array_agg(column_name::text ORDER BY ordinal_position) AS columns FROM information_schema.columns WHERE table_schema = current_schema() GROUP BY table_name ORDER BY table_name");
    expect(rows).toEqual([
      { table_name: "accounts", columns: ["account_id", "provider", "subject", "name"] },
      { table_name: "device_credentials", columns: ["device_id", "secret_hash", "created_at", "revoked_at"] },
      { table_name: "device_presence", columns: ["device_id", "link_state", "heartbeat_at"] },
      { table_name: "devices", columns: ["device_id", "account_id", "machine_id", "name", "platform", "version", "public_key"] },
    ]);
  });
  it("retains credentials and contact but closes presence on boot", async () => {
    const repository = fixture.repository;
    const a = await repository.upsertAccount("feishu", "a");
    const device = await repository.createDevice(a.accountId, enrollment());
    await repository.setPresence(device.deviceId, "open", laterTime);
    const restarted = await fixture.restart();
    expect(await restarted.getDeviceCredential(device.deviceId)).toEqual({ deviceId: device.deviceId,
      secretHash: "a".repeat(64), createdAt: initialTime, revokedAt: null });
    expect(await restarted.getPresence(device.deviceId)).toEqual({ deviceId: device.deviceId,
      linkState: "closed", heartbeatAt: laterTime });
    expect(await restarted.listDevices(a.accountId)).toEqual([{ ...device, lastSeenAt: laterTime }]);
  });
});
