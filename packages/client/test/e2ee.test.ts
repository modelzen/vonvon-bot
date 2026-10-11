import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createClientChannel,
  createDaemonChannel,
  exportPublicKey,
  generateKeyPair,
  type EncryptedChannelEvents,
  type Transport,
} from "../src/e2ee/e2ee.js";

type TransportPair = {
  daemon: Transport;
  client: Transport;
  dispose(): void;
};

const pairs = new Set<TransportPair>();

afterEach(() => {
  for (const pair of pairs) pair.dispose();
  pairs.clear();
  vi.restoreAllMocks();
});

function createTransportPair(): TransportPair {
  let closed = false;
  const close = (code = 1000, reason = "Normal closure"): void => {
    if (closed) return;
    closed = true;
    daemon.onclose?.(code, reason);
    client.onclose?.(code, reason);
  };
  const daemon: Transport = {
    send(data) {
      queueMicrotask(() => {
        if (!closed) client.onmessage?.({ data, isBinary: data instanceof ArrayBuffer });
      });
    },
    close,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  const client: Transport = {
    send(data) {
      queueMicrotask(() => {
        if (!closed) daemon.onmessage?.({ data, isBinary: data instanceof ArrayBuffer });
      });
    },
    close,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  const pair = { daemon, client, dispose: close };
  pairs.add(pair);
  return pair;
}

describe("pinned encrypted channel", () => {
  it("delivers authentic application messages in both directions", async () => {
    const pair = createTransportPair();
    try {
      const keyPair = generateKeyPair();
      const clientEvents: EncryptedChannelEvents = {};
      const daemonEvents: EncryptedChannelEvents = {};
      const opened = new Promise<void>((resolve) => { clientEvents.onopen = resolve; });
      const clientMessage = new Promise<string | ArrayBuffer>((resolve) => {
        clientEvents.onmessage = resolve;
      });
      const daemonMessage = new Promise<string | ArrayBuffer>((resolve) => {
        daemonEvents.onmessage = resolve;
      });
      const daemonPending = createDaemonChannel(pair.daemon, keyPair, daemonEvents);
      void daemonPending.catch(() => {});
      const client = await createClientChannel(pair.client, exportPublicKey(keyPair.publicKey), clientEvents);
      const daemon = await daemonPending;
      await opened;
      await client.send("client to daemon");
      expect(await daemonMessage).toBe("client to daemon");
      await daemon.send("daemon to client");
      expect(await clientMessage).toBe("daemon to client");
    } finally {
      pair.dispose();
    }
  });

  it("rejects a one-bit change to actual binary ciphertext without delivering plaintext", async () => {
    const pair = createTransportPair();
    try {
      const keyPair = generateKeyPair();
      const received = vi.fn();
      const daemonClosed = vi.fn();
      const clientClosed = vi.fn();
      const events: EncryptedChannelEvents = { onmessage: received };
      const opened = new Promise<void>((resolve) => { events.onopen = resolve; });
      const closed = new Promise<void>((resolve) => {
        events.onclose = (code, reason) => { clientClosed(code, reason); resolve(); };
      });
      const daemonPending = createDaemonChannel(pair.daemon, keyPair, { onclose: daemonClosed });
      void daemonPending.catch(() => {});
      const client = await createClientChannel(pair.client, exportPublicKey(keyPair.publicKey), events);
      const daemon = await daemonPending;
      await opened;
      const closeRequest = vi.spyOn(pair.client, "close");
      const send = pair.daemon.send;
      const frames: { original: Uint8Array; delivered: Uint8Array }[] = [];
      vi.spyOn(pair.daemon, "send").mockImplementation((data) => {
        if (!(data instanceof ArrayBuffer)) throw new Error("Expected binary ciphertext");
        const original = new Uint8Array(data.slice(0));
        const delivered = original.slice();
        const last = delivered.at(-1);
        if (last === undefined) throw new Error("Expected nonempty ciphertext");
        delivered[delivered.length - 1] = last ^ 1;
        frames.push({ original, delivered });
        return send(delivered.buffer);
      });
      const plaintext = new Uint8Array([17, 0, 255, 39]).buffer;
      await daemon.send(plaintext);
      await closed;
      expect(received).not.toHaveBeenCalled();
      expect(closeRequest.mock.calls).toEqual([[1011, "Decryption failed"]]);
      expect(clientClosed.mock.calls).toEqual([[1011, "Decryption failed"]]);
      expect(daemonClosed.mock.calls).toEqual([[1011, "Decryption failed"]]);
      expect(client.isOpen()).toBe(false);
      expect(daemon.isOpen()).toBe(false);
      expect(frames).toHaveLength(1);
      for (const { original, delivered } of frames) {
        expect(original.byteLength).toBeGreaterThan(plaintext.byteLength);
        expect(delivered.byteLength).toBe(original.byteLength);
        expect(Array.from(original, (byte, index) => byte ^ (delivered[index] ?? 0))
          .filter((difference) => difference !== 0)).toEqual([1]);
      }
    } finally {
      pair.dispose();
    }
  });

  it("opens on plaintext ready with a substituted valid key then rejects the genuine daemon ciphertext", async () => {
    const pair = createTransportPair();
    try {
      const realDaemonKeyPair = generateKeyPair();
      const advertisedKeyPair = generateKeyPair();
      const trace: string[] = [];
      const wire: (string | ArrayBuffer)[] = [];
      const send = pair.daemon.send;
      vi.spyOn(pair.daemon, "send").mockImplementation((data) => {
        wire.push(data);
        trace.push(typeof data === "string" && data.startsWith("{") ? "ready-sent" : "ciphertext-sent");
        return send(data);
      });
      const clientSend = vi.spyOn(pair.client, "send");
      const closeRequest = vi.spyOn(pair.client, "close");
      const received = vi.fn();
      const daemonClosed = vi.fn();
      const clientClosed = vi.fn();
      const events: EncryptedChannelEvents = { onmessage: received };
      const opened = new Promise<void>((resolve) => {
        events.onopen = () => { trace.push("client-open"); resolve(); };
      });
      const closed = new Promise<void>((resolve) => {
        events.onclose = (code, reason) => {
          trace.push("client-close");
          clientClosed(code, reason);
          resolve();
        };
      });
      const daemonPending = createDaemonChannel(pair.daemon, realDaemonKeyPair, { onclose: daemonClosed });
      void daemonPending.catch(() => {});
      const client = await createClientChannel(pair.client, exportPublicKey(advertisedKeyPair.publicKey), events);
      const daemon = await daemonPending;
      await opened;
      expect(trace).toEqual(["ready-sent", "client-open"]);
      expect(wire).toHaveLength(1);
      const ready = wire[0];
      if (typeof ready !== "string") throw new Error("Expected plaintext ready");
      expect(JSON.parse(ready)).toEqual({ type: "e2ee_ready", capabilities: { binaryCiphertext: true } });
      expect(client.isOpen()).toBe(true);
      expect(received).not.toHaveBeenCalled();
      await daemon.send("first daemon application frame");
      await closed;
      expect(received).not.toHaveBeenCalled();
      expect(closeRequest.mock.calls).toEqual([[1011, "Decryption failed"]]);
      expect(clientClosed.mock.calls).toEqual([[1011, "Decryption failed"]]);
      expect(daemonClosed.mock.calls).toEqual([[1011, "Decryption failed"]]);
      expect(trace).toEqual(["ready-sent", "client-open", "ciphertext-sent", "client-close"]);
      expect(client.isOpen()).toBe(false);
      expect(daemon.isOpen()).toBe(false);
      expect(wire).toHaveLength(2);
      expect(wire[1]).not.toBe("first daemon application frame");
      expect(clientSend).toHaveBeenCalledTimes(1);
      const hello = clientSend.mock.calls[0]?.[0];
      if (typeof hello !== "string") throw new Error("Expected plaintext hello");
      expect(JSON.parse(hello)).toEqual({
        type: "e2ee_hello", key: expect.any(String), capabilities: { binaryCiphertext: true },
      });
    } finally {
      pair.dispose();
    }
  });

  it.each([31, 33])("rejects a canonical %i-byte public key before sending hello", async (length) => {
    const pair = createTransportPair();
    try {
      const send = vi.spyOn(pair.client, "send");
      const onopen = vi.fn();
      const key = Buffer.alloc(length).toString("base64");
      expect(Buffer.from(key, "base64").toString("base64")).toBe(key);
      await expect(createClientChannel(pair.client, key, { onopen }))
        .rejects.toThrow("Invalid public key length (expected 32)");
      expect(send).not.toHaveBeenCalled();
      expect(onopen).not.toHaveBeenCalled();
    } finally {
      pair.dispose();
    }
  });
});
