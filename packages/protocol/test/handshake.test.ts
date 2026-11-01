import { expect, it } from "vitest";
import { DRAIN_KINDS, MAINTENANCE_KINDS, PROTOCOL_VERSION, rpcKinds, serverInfoSchema, serverInfoV1Schema, serverInfoV2Schema } from "../src/index.js";

const v1 = { type: "serverInfo", machineId: "00000000-0000-4000-8000-000000000000", version: "0.9.0", protocolVersion: 1 };
const v2 = { ...v1, protocolVersion: 2, deviceName: "工作电脑", platform: "linux", capabilities: ["device"], principal: "owner:local" };

// devices 4.5. main 必败: there was one strict server info, and protocol 1.
it("keeps the v1 shape to its four fields and makes the v2 shape name the principal", () => {
  expect(PROTOCOL_VERSION).toBe(2);
  expect(serverInfoV1Schema.parse(v1)).toEqual(v1);
  expect(serverInfoV1Schema.safeParse({ ...v1, deviceName: "x" }).success).toBe(false);
  expect(serverInfoV2Schema.parse(v2)).toEqual(v2);
  const { principal: _principal, ...unnamed } = v2;
  expect(serverInfoV2Schema.safeParse(unnamed).success).toBe(false);
  expect(serverInfoV2Schema.safeParse({ ...v2, later: true }).success).toBe(false);
});

it("lets a client read either shape and fields a later daemon adds, without comparing the version", () => {
  expect(serverInfoSchema.parse(v1)).toEqual(v1);
  expect(serverInfoSchema.parse(v2)).toEqual(v2);
  expect(serverInfoSchema.parse({ ...v2, protocolVersion: 3, later: { x: 1 } })).toMatchObject({ protocolVersion: 3, later: { x: 1 } });
  expect(serverInfoSchema.safeParse({ ...v1, type: "hello" }).success).toBe(false);
});

it("names only kinds that exist in the maintenance and drain lists", () => {
  const kinds = new Set(rpcKinds().map(entry => entry.kind));
  for (const kind of [...MAINTENANCE_KINDS, ...DRAIN_KINDS]) expect(kinds).toContain(kind);
});
