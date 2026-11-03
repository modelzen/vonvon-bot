import { expect, it } from "vitest";
import { CLOSE_CODES, closeReasonSchema, decodePairingLink, deviceEventSchema, deviceReplySchema, deviceRequestSchema, encodePairingLink, eventSchema, PAIRING_LINK_PREFIX, type PairingLink } from "../src/index.js";

const link: PairingLink = {
  v: 1, device: { id: "00000000-0000-4000-8000-000000000000", name: "工作电脑", pk: "A".repeat(43) },
  addresses: [{ host: "192.0.2.10", port: 7767, kind: "lan" }],
  invite: { id: "inv_0123456789abcdef", secret: "s".repeat(43), expiresAt: 1 }, relay: null, account: null,
};

it("round-trips a pairing link, with or without its prefix, and refuses anything else alike", () => {
  const text = encodePairingLink(link);
  expect(text.startsWith(PAIRING_LINK_PREFIX)).toBe(true);
  expect(text.slice(PAIRING_LINK_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(decodePairingLink(text)).toEqual(link);
  expect(decodePairingLink(` ${text.slice(PAIRING_LINK_PREFIX.length)}\n`)).toEqual(link);
  for (const bad of ["", "vonvon://pair#!!", `${PAIRING_LINK_PREFIX}e30`, text.slice(0, -4)]) expect(() => decodePairingLink(bad)).toThrow("invalid_pairing_link");
  expect(() => encodePairingLink({ ...link, addresses: [] })).toThrow();
  expect(() => encodePairingLink({ ...link, addresses: [{ host: "127.0.0.1", port: 7767, kind: "loopback" as "lan" }] })).toThrow();
});
it("gives the seven remote close reasons their 4xxx codes", () => {
  expect(Object.entries(CLOSE_CODES).filter(([, code]) => code >= 4000 && code < 4400).map(([reason]) => reason)).toEqual([
    "protocol_mismatch", "unknown_client", "client_revoked", "rate_limited", "handshake_failed", "remote_disabled", "pairing_failed",
  ]);
  expect(closeReasonSchema.parse("unauthorized")).toBe("unauthorized");
});
it("carries the device event inside the event envelope", () => {
  const event = { type: "event", event: "device", payload: { change: "client-revoked", clientId: "cl_0123456789abcdef", name: "笔记本", clientKind: "desktop" } };
  expect(deviceEventSchema.parse(event)).toEqual(event);
  expect(eventSchema.parse(event)).toEqual(event);
});
// D3: an address that failed to bind for a reason other than a missing address or a busy port. main 必败: no such state.
it("reads an address that failed to bind, with what failed", () => {
  const reply = { kind: "deviceStatus", status: {
    device: { id: "00000000-0000-4000-8000-000000000000", name: "工作电脑", publicKey: "A".repeat(43) },
    remote: { port: 7767, addresses: [{ host: "192.0.2.10", kind: "lan", enabledAt: 1, state: "failed", detail: "EACCES" }] },
    clients: { total: 0, active: 0 },
  } };
  expect(deviceReplySchema.parse(reply)).toEqual(reply);
});
// A1: one address, given as an IP (no --tailscale), and an overlay network's address in a link. main 必败: enable took
// `tailscale` and no host, and there was no `overlay` kind.
it("enables one given address, and carries an overlay network's address in a link", () => {
  expect(deviceRequestSchema.parse({ type: "enable", host: "10.147.17.5" })).toEqual({ type: "enable", host: "10.147.17.5" });
  expect(() => deviceRequestSchema.parse({ type: "enable" })).toThrow();
  expect(() => deviceRequestSchema.parse({ type: "enable", tailscale: true })).toThrow();
  const overlay: PairingLink = { ...link, addresses: [{ host: "10.147.17.5", port: 7767, kind: "overlay" }] };
  expect(decodePairingLink(encodePairingLink(overlay))).toEqual(overlay);
});
// devices-ui-3 4.1: what the 允许别的设备连接 panel reads: the addresses it could open, the one the caller came in on, the
// caller's own client id, and a status read that skips the kept list. main 必败: none of them parsed.
it("carries the candidates, the caller's address and its own id, all optional", () => {
  const status = { kind: "deviceStatus", status: {
    device: { id: "00000000-0000-4000-8000-000000000000", name: "工作电脑", publicKey: "A".repeat(43) },
    remote: { port: 7767, addresses: [{ host: "100.64.0.10", kind: "tailscale", enabledAt: 1, state: "listening" }],
      candidates: [{ host: "100.64.0.10", kind: "tailscale", iface: "utun4", tool: "Tailscale" }, { host: "10.147.17.5", kind: "overlay", iface: "feth2", tool: "ZeroTier" }, { host: "192.168.1.9", kind: "lan" }] },
    clients: { total: 1, active: 1 }, via: "100.64.0.10",
  } };
  expect(deviceReplySchema.parse(status)).toEqual(status);
  expect(() => deviceReplySchema.parse({ ...status, status: { ...status.status, remote: { ...status.status.remote, candidates: [{ host: "127.0.0.1", kind: "loopback" }] } } })).toThrow();
  const clients = { kind: "clients", generation: 3, clients: [], self: "cl_0123456789abcdef" };
  expect(deviceReplySchema.parse(clients)).toEqual(clients);
  expect(deviceRequestSchema.parse({ type: "status", refresh: true })).toEqual({ type: "status", refresh: true });
  expect(deviceRequestSchema.parse({ type: "status" })).toEqual({ type: "status" });
});
