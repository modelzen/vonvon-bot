import { randomUUID } from "node:crypto";
import { accountIdSchema, deviceIdSchema, machineIdSchema, type AccountId, type DeviceId } from "@vonvon/protocol";
import { Pool, type PoolClient } from "pg";
import { z } from "zod";
import { RepositoryError, type Account, type Device, type DeviceCredential, type DevicePresence, type Repository, type RepositoryOptions } from "./repository.js";

const timestamp = z.date().transform((value) => value.toISOString());
const accountRow = z.object({
  account_id: accountIdSchema, provider: z.enum(["feishu", "lark"]), subject: z.string(), name: z.string(),
});
const deviceRow = z.object({
  device_id: deviceIdSchema, account_id: accountIdSchema, machine_id: machineIdSchema,
  name: z.string(), platform: z.string(), version: z.string(), public_key: z.string(),
});
const credentialRow = z.object({
  device_id: deviceIdSchema, secret_hash: z.string().regex(/^[a-f0-9]{64}$/),
  created_at: timestamp, revoked_at: timestamp.nullable(),
});
const presenceRow = z.object({
  device_id: deviceIdSchema, link_state: z.enum(["open", "closed"]), heartbeat_at: timestamp,
});
const publicDeviceRow = deviceRow.extend({ heartbeat_at: timestamp });

function decodeAccount(value: unknown): Account {
  const row = accountRow.parse(value);
  return { accountId: row.account_id, provider: row.provider, subject: row.subject, name: row.name };
}
function projectDevice(row: z.infer<typeof deviceRow>, heartbeatAt: string): Device {
  return { deviceId: row.device_id, accountId: row.account_id, machineId: row.machine_id,
    name: row.name, platform: row.platform, version: row.version, publicKey: row.public_key,
    lastSeenAt: heartbeatAt };
}
function decodeDevice(value: unknown): Device {
  const row = publicDeviceRow.parse(value);
  return projectDevice(row, row.heartbeat_at);
}
function decodeCredential(value: unknown): DeviceCredential {
  const row = credentialRow.parse(value);
  return { deviceId: row.device_id, secretHash: row.secret_hash, createdAt: row.created_at, revokedAt: row.revoked_at };
}
function decodePresence(value: unknown): DevicePresence {
  const row = presenceRow.parse(value);
  return { deviceId: row.device_id, linkState: row.link_state, heartbeatAt: row.heartbeat_at };
}

const schema = `
CREATE TABLE IF NOT EXISTS accounts (
  account_id uuid PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('feishu', 'lark')),
  subject text NOT NULL,
  name text NOT NULL,
  UNIQUE (provider, subject)
);
CREATE TABLE IF NOT EXISTS devices (
  device_id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(account_id),
  machine_id uuid NOT NULL,
  name text NOT NULL,
  platform text NOT NULL,
  version text NOT NULL,
  public_key text NOT NULL
);
CREATE INDEX IF NOT EXISTS devices_account_machine ON devices(account_id, machine_id);
CREATE TABLE IF NOT EXISTS device_credentials (
  device_id uuid PRIMARY KEY REFERENCES devices(device_id),
  secret_hash text NOT NULL CHECK (secret_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE TABLE IF NOT EXISTS device_presence (
  device_id uuid PRIMARY KEY REFERENCES devices(device_id),
  link_state text NOT NULL CHECK (link_state IN ('open', 'closed')),
  heartbeat_at timestamptz NOT NULL
);
UPDATE device_presence SET link_state = 'closed';
`;

export async function openPostgresRepository(options: RepositoryOptions & { connectionString: string }): Promise<{
  repository: Repository;
  close(): Promise<void>;
}> {
  const pool = new Pool({ connectionString: options.connectionString, connectionTimeoutMillis: 2_000 });
  const now = options.now ?? (() => new Date());
  const newAccountId = options.newAccountId ?? (() => accountIdSchema.parse(randomUUID()));
  const newDeviceId = options.newDeviceId ?? (() => deviceIdSchema.parse(randomUUID()));

  async function transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async function lockAccount(client: PoolClient, accountId: AccountId): Promise<boolean> {
    const result = await client.query("SELECT account_id FROM accounts WHERE account_id = $1 FOR UPDATE", [accountId]);
    return result.rows.length !== 0;
  }

  // A fresh statement after the account lock observes mutations committed by its previous owner.
  async function lockDevice(client: PoolClient, accountId: AccountId, deviceId: DeviceId) {
    const device = await client.query("SELECT * FROM devices WHERE account_id = $1 AND device_id = $2 FOR UPDATE", [accountId, deviceId]);
    if (device.rows.length === 0) throw new RepositoryError("device_unknown");
    const credential = await client.query("SELECT * FROM device_credentials WHERE device_id = $1 FOR UPDATE", [deviceId]);
    const presence = await client.query("SELECT * FROM device_presence WHERE device_id = $1 FOR UPDATE", [deviceId]);
    return { device: deviceRow.parse(device.rows[0]), credential: decodeCredential(credential.rows[0]), presence: decodePresence(presence.rows[0]) };
  }
  async function lockOwnedDevice(client: PoolClient, accountId: AccountId, deviceId: DeviceId) {
    if (!await lockAccount(client, accountId)) throw new RepositoryError("device_unknown");
    return lockDevice(client, accountId, deviceId);
  }
  function requireActive(credential: DeviceCredential): void {
    if (credential.revokedAt !== null) throw new RepositoryError("device_revoked");
  }

  try {
    await transaction(async (client) => { await client.query(schema); });
  } catch (error) {
    await pool.end();
    throw error;
  }

  const repository: Repository = {
    async upsertAccount(provider, subject) {
      const result = await pool.query(`INSERT INTO accounts (account_id, provider, subject, name)
        VALUES ($1, $2, $3, $3) ON CONFLICT (provider, subject)
        DO UPDATE SET subject = EXCLUDED.subject RETURNING *`, [newAccountId(), provider, subject]);
      return decodeAccount(result.rows[0]);
    },
    async getAccount(accountId) {
      const result = await pool.query("SELECT * FROM accounts WHERE account_id = $1", [accountId]);
      return result.rows.length === 0 ? null : decodeAccount(result.rows[0]);
    },
    async createDevice(accountId, input) {
      return transaction(async (client) => {
        if (!await lockAccount(client, accountId)) throw new RepositoryError("account_unknown");
        const existing = await client.query(`SELECT d.device_id FROM devices d
          JOIN device_credentials c USING (device_id)
          WHERE d.account_id = $1 AND d.machine_id = $2 AND c.revoked_at IS NULL`, [accountId, input.machineId]);
        if (existing.rows.length > 0) throw new RepositoryError("active_device_exists");
        const deviceId = newDeviceId();
        const createdAt = now().toISOString();
        const inserted = await client.query(`INSERT INTO devices (device_id, account_id, machine_id, name, platform, version, public_key)
          VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [deviceId, accountId, input.machineId, input.name, input.platform, input.version, input.publicKey]);
        await client.query(`INSERT INTO device_credentials (device_id, secret_hash, created_at, revoked_at)
          VALUES ($1, $2, $3, NULL)`, [deviceId, input.secretHash, createdAt]);
        await client.query(`INSERT INTO device_presence (device_id, link_state, heartbeat_at)
          VALUES ($1, 'closed', $2)`, [deviceId, createdAt]);
        return projectDevice(deviceRow.parse(inserted.rows[0]), createdAt);
      });
    },
    async rotateDevice(accountId, deviceId, input) {
      return transaction(async (client) => {
        const state = await lockOwnedDevice(client, accountId, deviceId);
        if (state.device.machine_id !== input.machineId) throw new RepositoryError("device_unknown");
        requireActive(state.credential);
        const createdAt = now().toISOString();
        const updated = await client.query(`UPDATE devices SET name = $2, platform = $3, version = $4, public_key = $5
          WHERE device_id = $1 RETURNING *`, [deviceId, input.name, input.platform, input.version, input.publicKey]);
        await client.query("UPDATE device_credentials SET secret_hash = $2, created_at = $3 WHERE device_id = $1", [deviceId, input.secretHash, createdAt]);
        await client.query("UPDATE device_presence SET link_state = 'closed' WHERE device_id = $1", [deviceId]);
        return projectDevice(deviceRow.parse(updated.rows[0]), state.presence.heartbeatAt);
      });
    },
    async findActiveDevice(accountId, machineId) {
      const result = await pool.query(`SELECT d.*, p.heartbeat_at FROM devices d
        JOIN device_credentials c USING (device_id) JOIN device_presence p USING (device_id)
        WHERE d.account_id = $1 AND d.machine_id = $2 AND c.revoked_at IS NULL`, [accountId, machineId]);
      return result.rows.length === 0 ? null : decodeDevice(result.rows[0]);
    },
    async getDeviceCredential(deviceId) {
      const result = await pool.query("SELECT * FROM device_credentials WHERE device_id = $1", [deviceId]);
      return result.rows.length === 0 ? null : decodeCredential(result.rows[0]);
    },
    async renameDevice(accountId, deviceId, name) {
      return transaction(async (client) => {
        const state = await lockOwnedDevice(client, accountId, deviceId);
        requireActive(state.credential);
        const updated = await client.query("UPDATE devices SET name = $2 WHERE device_id = $1 RETURNING *", [deviceId, name]);
        return projectDevice(deviceRow.parse(updated.rows[0]), state.presence.heartbeatAt);
      });
    },
    async revokeDevice(accountId, deviceId) {
      await transaction(async (client) => {
        const state = await lockOwnedDevice(client, accountId, deviceId);
        if (state.credential.revokedAt !== null) return;
        await client.query("UPDATE device_credentials SET revoked_at = $2 WHERE device_id = $1", [deviceId, now().toISOString()]);
        await client.query("UPDATE device_presence SET link_state = 'closed' WHERE device_id = $1", [deviceId]);
      });
    },
    async listDevices(accountId) {
      const result = await pool.query(`SELECT d.*, p.heartbeat_at FROM devices d
        JOIN device_credentials c USING (device_id) JOIN device_presence p USING (device_id)
        WHERE d.account_id = $1 AND c.revoked_at IS NULL ORDER BY d.device_id`, [accountId]);
      return result.rows.map(decodeDevice);
    },
    async setPresence(deviceId, linkState, heartbeatAt) {
      await transaction(async (client) => {
        const owner = await client.query("SELECT account_id FROM devices WHERE device_id = $1", [deviceId]);
        if (owner.rows.length === 0) throw new RepositoryError("device_unknown");
        const { account_id: accountId } = accountRow.pick({ account_id: true }).parse(owner.rows[0]);
        const state = await lockOwnedDevice(client, accountId, deviceId);
        requireActive(state.credential);
        if (linkState === "closed") {
          await client.query("UPDATE device_presence SET link_state = 'closed' WHERE device_id = $1", [deviceId]);
        } else {
          await client.query(`UPDATE device_presence SET link_state = 'open', heartbeat_at = GREATEST(heartbeat_at, $2::timestamptz)
            WHERE device_id = $1`, [deviceId, new Date(heartbeatAt).toISOString()]);
        }
      });
    },
    async getPresence(deviceId) {
      const result = await pool.query("SELECT * FROM device_presence WHERE device_id = $1", [deviceId]);
      return result.rows.length === 0 ? null : decodePresence(result.rows[0]);
    },
  };

  return { repository, close: () => pool.end() };
}
