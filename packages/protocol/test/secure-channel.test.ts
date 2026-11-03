import { describe, expect, it } from "vitest";
import {
  ChannelError, closeBody, createInitiator, createResponder, decodeFrame, encodeFrame, FRAME, generateStaticKey, HandshakeError, PROLOGUE,
  readCloseBody, staticKeyFromBase64url, type StaticKey,
} from "../src/secure-channel.js";

// devices-2 第 5 节 and 验收要点 2–3. main 必败: there was no channel.
const pair = (options: { client?: StaticKey; device?: StaticKey; devicePrologue?: Buffer; ephemeral?: StaticKey } = {}) => {
  const client = options.client ?? generateStaticKey().key;
  const device = options.device ?? generateStaticKey().key;
  const initiator = createInitiator(client, device.publicKey, options.ephemeral ? { ephemeral: options.ephemeral } : undefined);
  const responder = createResponder(device, options.devicePrologue ? { prologue: options.devicePrologue } : undefined);
  return { client, device, initiator, responder };
};
const handshake = () => {
  const { initiator, responder, client } = pair();
  const message1 = initiator.message1();
  const read = responder.readMessage1(message1);
  const message2 = responder.message2();
  const finished = initiator.finish(message2.bytes);
  return { client, message1, message2: message2.bytes, read, clientChannel: finished.channel, deviceChannel: message2.channel };
};
const failsHandshake = (run: () => unknown) => {
  let caught: unknown;
  try { run(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(HandshakeError);
  expect(caught).toMatchObject({ code: "handshake_failed" });
};
const failsFrame = (run: () => unknown, code: ChannelError["code"]) => {
  let caught: unknown;
  try { run(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(ChannelError);
  expect(caught).toMatchObject({ code });
};

describe("handshake", () => {
  it("pins the prologue bytes and the message sizes", () => {
    expect(PROLOGUE.toString("hex")).toBe(Buffer.from("vonvon-secure-channel/1").toString("hex") + "01");
    expect(PROLOGUE.subarray(0, 3).toString("hex")).toBe("766f6e");
    expect(PROLOGUE.subarray(-3).toString("hex")).toBe("2f3101");
    const { message1, message2, read, client, clientChannel, deviceChannel } = handshake();
    expect(message1[0]).toBe(0x01);
    expect(message1).toHaveLength(1 + 32 + 48 + 16);
    expect(message2).toHaveLength(48);
    expect(read.remoteStaticPublicKey.equals(client.publicKey)).toBe(true);
    expect(read.payload).toHaveLength(0);
    expect(clientChannel.handshakeHash.equals(deviceChannel.handshakeHash)).toBe(true);
  });

  it("round-trips frames both ways with counters 0, 1, 2…", () => {
    const { clientChannel, deviceChannel } = handshake();
    expect(deviceChannel.decrypt(clientChannel.encrypt(Buffer.from("a"))).toString()).toBe("a");
    expect(clientChannel.decrypt(deviceChannel.encrypt(Buffer.from("b"))).toString()).toBe("b");
    for (let index = 1; index <= 1000; index++) {
      const frame = clientChannel.encrypt(Buffer.from(`frame ${index}`));
      expect(frame.readBigUInt64BE(0)).toBe(BigInt(index));
      expect(frame).toHaveLength(8 + `frame ${index}`.length + 16);
      expect(deviceChannel.decrypt(frame).toString()).toBe(`frame ${index}`);
    }
  });

  it("binds the prologue: a /2 device refuses a /1 message, and a /2 answer fails the /1 client", () => {
    const other = Buffer.concat([Buffer.from("vonvon-secure-channel/2"), Buffer.from([0x01])]);
    const { initiator, responder } = pair({ devicePrologue: other });
    failsHandshake(() => responder.readMessage1(initiator.message1()));
    // Same keys and ephemeral on both clients, only the prologue differs: the device answers the /2 one, the /1 one refuses it.
    const client = generateStaticKey().key;
    const device = generateStaticKey().key;
    const ephemeral = generateStaticKey().key;
    const honest = createInitiator(client, device.publicKey, { ephemeral });
    const downgraded = createInitiator(client, device.publicKey, { ephemeral, prologue: other });
    honest.message1();
    const answering = createResponder(device, { prologue: other });
    answering.readMessage1(downgraded.message1());
    failsHandshake(() => honest.finish(answering.message2().bytes));
  });

  // 审查 D2-CRYPTO-4: the vectors bring their own prologue, so only this shows the default path binds PROLOGUE.
  it("uses PROLOGUE when given none, on both sides", () => {
    const client = generateStaticKey().key;
    const device = generateStaticKey().key;
    const run = (initiatorPrologue: Buffer | undefined, responderPrologue: Buffer | undefined) => {
      const initiator = createInitiator(client, device.publicKey, initiatorPrologue ? { prologue: initiatorPrologue } : undefined);
      const responder = createResponder(device, responderPrologue ? { prologue: responderPrologue } : undefined);
      responder.readMessage1(initiator.message1());
      return initiator.finish(responder.message2().bytes).channel;
    };
    expect(run(undefined, PROLOGUE).handshakeHash).toHaveLength(32);
    expect(run(PROLOGUE, undefined).handshakeHash).toHaveLength(32);
    // No prologue, or the name without its version byte: the default side refuses either.
    for (const other of [Buffer.alloc(0), Buffer.from("vonvon-secure-channel/1")]) {
      failsHandshake(() => run(undefined, other));
      failsHandshake(() => run(other, undefined));
    }
  });

  // 审查 D2-CRYPTO-3: the vectors inject the ephemeral keys, so only this shows a real handshake makes new ones.
  it("makes a new ephemeral key for every handshake, on both sides, never the static one", () => {
    const client = generateStaticKey().key;
    const device = generateStaticKey().key;
    const first = createInitiator(client, device.publicKey).message1();
    const second = createInitiator(client, device.publicKey).message1();
    expect(first.subarray(1, 33).equals(second.subarray(1, 33))).toBe(false);
    for (const message1 of [first, second]) expect(message1.subarray(1, 33).equals(client.publicKey)).toBe(false);
    const answers = [first, second].map(message1 => {
      const responder = createResponder(device);
      responder.readMessage1(message1);
      return responder.message2().bytes;
    });
    expect(answers[0]?.subarray(0, 32).equals(answers[1]?.subarray(0, 32) ?? Buffer.alloc(0))).toBe(false);
    for (const message2 of answers) expect(message2.subarray(0, 32).equals(device.publicKey)).toBe(false);
  });

  it("refuses another version byte, a changed byte anywhere, a short message, the wrong device key and a low-order point", () => {
    const changed = (index: number) => {
      const { initiator, responder } = pair();
      const message1 = initiator.message1();
      message1[index] = (message1[index] ?? 0) ^ 0x01;
      failsHandshake(() => responder.readMessage1(message1));
    };
    { const { initiator, responder } = pair(); const message1 = initiator.message1(); message1[0] = 0x02; failsHandshake(() => responder.readMessage1(message1)); }
    for (const index of [1, 20, 33, 60, 80, 81, 96]) changed(index);
    { const { initiator, responder } = pair(); failsHandshake(() => responder.readMessage1(initiator.message1().subarray(0, 96))); }
    // The client took the wrong key for the device: the device cannot read the static key it encrypted.
    { const device = generateStaticKey().key; const initiator = createInitiator(generateStaticKey().key, generateStaticKey().key.publicKey); failsHandshake(() => createResponder(device).readMessage1(initiator.message1())); }
    // An all-zero (low-order) device key: the first DH is refused before anything is sent.
    failsHandshake(() => createInitiator(generateStaticKey().key, Buffer.alloc(32)).message1());
    // An all-zero ephemeral in message 1, and in message 2.
    { const { initiator, responder } = pair(); const message1 = initiator.message1(); message1.fill(0, 1, 33); failsHandshake(() => responder.readMessage1(message1)); }
    { const { initiator, responder } = pair(); responder.readMessage1(initiator.message1()); const message2 = responder.message2().bytes; message2.fill(0, 0, 32); failsHandshake(() => initiator.finish(message2)); }
    // A changed or short message 2.
    { const { initiator, responder } = pair(); responder.readMessage1(initiator.message1()); const message2 = responder.message2().bytes; message2[40] = (message2[40] ?? 0) ^ 0x80; failsHandshake(() => initiator.finish(message2)); }
    { const { initiator, responder } = pair(); responder.readMessage1(initiator.message1()); failsHandshake(() => initiator.finish(responder.message2().bytes.subarray(0, 47))); }
  });
});

describe("frames", () => {
  it("refuses a replayed frame, two frames swapped, a changed tag and a short frame", () => {
    const { clientChannel, deviceChannel } = handshake();
    const first = clientChannel.encrypt(Buffer.from("first"));
    expect(deviceChannel.decrypt(first).toString()).toBe("first");
    failsFrame(() => deviceChannel.decrypt(first), "replay");

    const swapped = handshake();
    const one = swapped.clientChannel.encrypt(Buffer.from("one"));
    const two = swapped.clientChannel.encrypt(Buffer.from("two"));
    failsFrame(() => swapped.deviceChannel.decrypt(two), "replay");
    expect(swapped.deviceChannel.decrypt(one).toString()).toBe("one");

    const tampered = handshake();
    const frame = tampered.clientChannel.encrypt(Buffer.from("tag"));
    frame[frame.length - 1] = (frame[frame.length - 1] ?? 0) ^ 0x01;
    failsFrame(() => tampered.deviceChannel.decrypt(frame), "tamper");
    const body = handshake();
    const changedBody = body.clientChannel.encrypt(Buffer.from("body"));
    changedBody[8] = (changedBody[8] ?? 0) ^ 0x01;
    failsFrame(() => body.deviceChannel.decrypt(changedBody), "tamper");
    failsFrame(() => handshake().deviceChannel.decrypt(Buffer.alloc(23)), "frame");
  });

  it("types the plaintext: json, ping, pong, close, and nothing else", () => {
    expect(encodeFrame(FRAME.json, Buffer.from("{}")).toString("hex")).toBe("007b7d");
    expect(encodeFrame(FRAME.ping)).toEqual(Buffer.from([0x01]));
    expect(encodeFrame(FRAME.close, closeBody(4003, "client_revoked")).toString("hex")).toBe(`030fa3${Buffer.from("client_revoked").toString("hex")}`);
    expect(readCloseBody(decodeFrame(Buffer.from("030fa3", "hex")).body)).toEqual({ code: 4003, reason: "" });
    failsFrame(() => readCloseBody(Buffer.from([0x0f])), "frame");
    expect(decodeFrame(Buffer.from([0x02]))).toEqual({ type: FRAME.pong, body: Buffer.alloc(0) });
    expect(decodeFrame(Buffer.from("\u0000{\"a\":1}")).body.toString()).toBe("{\"a\":1}");
    failsFrame(() => decodeFrame(Buffer.from([0x09])), "frame");
    failsFrame(() => decodeFrame(Buffer.alloc(0)), "frame");
  });
});

describe("keys", () => {
  it("writes keys as 43 base64url characters and reads them back", () => {
    const generated = generateStaticKey();
    expect(generated.publicKeyBase64url).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generated.privateKeyBase64url).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const restored = staticKeyFromBase64url(generated.publicKeyBase64url, generated.privateKeyBase64url);
    expect(restored.publicKey.equals(generated.key.publicKey)).toBe(true);
    // The restored key talks to a device as the generated one did.
    const device = generateStaticKey().key;
    const responder = createResponder(device);
    expect(responder.readMessage1(createInitiator(restored, device.publicKey).message1()).remoteStaticPublicKey.equals(generated.key.publicKey)).toBe(true);
    expect(() => staticKeyFromBase64url(generateStaticKey().publicKeyBase64url, generated.privateKeyBase64url)).toThrow("does not belong");
    expect(() => staticKeyFromBase64url("short", generated.privateKeyBase64url)).toThrow();
  });
});
