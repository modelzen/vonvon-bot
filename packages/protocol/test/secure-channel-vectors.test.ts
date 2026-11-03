import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { createInitiator, createResponder, CHANNEL_VERSION, staticKeyFromPrivateKey } from "../src/secure-channel.js";

// devices-2 第 5 节：the official Noise vectors, from a fixture (fixtures/README.md says where from). main 必败: there was no channel.
interface Vector {
  protocol_name: string; init_prologue: string; init_static: string; init_ephemeral: string; init_remote_static: string;
  resp_prologue: string; resp_static: string; resp_ephemeral: string; handshake_hash: string;
  messages: Array<{ payload: string; ciphertext: string }>;
}
const { vectors } = JSON.parse(await readFile(new URL("./fixtures/noise-ik-25519-aesgcm-sha256.json", import.meta.url), "utf8")) as { vectors: Vector[] };
const hex = (text: string): Buffer => Buffer.from(text, "hex");

it("has the fixture, and only the suite it is named for", () => {
  expect(vectors.length).toBeGreaterThanOrEqual(1);
  for (const vector of vectors) expect(vector.protocol_name).toBe("Noise_IK_25519_AESGCM_SHA256");
});

it.each(vectors.map((vector, index) => [index, vector] as const))("vector %i: same bytes on the wire, same handshake hash, both ways", (_index, vector) => {
  const initiatorStatic = staticKeyFromPrivateKey(hex(vector.init_static));
  const responderStatic = staticKeyFromPrivateKey(hex(vector.resp_static));
  expect(responderStatic.publicKey.toString("hex")).toBe(vector.init_remote_static);
  const initiator = createInitiator(initiatorStatic, hex(vector.init_remote_static), { prologue: hex(vector.init_prologue), ephemeral: staticKeyFromPrivateKey(hex(vector.init_ephemeral)) });
  const responder = createResponder(responderStatic, { prologue: hex(vector.resp_prologue), ephemeral: staticKeyFromPrivateKey(hex(vector.resp_ephemeral)) });
  const [first, second, ...transport] = vector.messages;
  if (!first || !second) throw new Error("a vector has both handshake messages");

  const message1 = initiator.message1(hex(first.payload));
  expect(message1[0]).toBe(CHANNEL_VERSION);
  expect(message1.subarray(1).toString("hex")).toBe(first.ciphertext);
  const read = responder.readMessage1(message1);
  expect(read.payload.toString("hex")).toBe(first.payload);
  expect(read.remoteStaticPublicKey.equals(initiatorStatic.publicKey)).toBe(true);

  const message2 = responder.message2(hex(second.payload));
  expect(message2.bytes.toString("hex")).toBe(second.ciphertext);
  const finished = initiator.finish(message2.bytes);
  expect(finished.payload.toString("hex")).toBe(second.payload);
  expect(finished.channel.handshakeHash.toString("hex")).toBe(vector.handshake_hash);
  expect(message2.channel.handshakeHash.toString("hex")).toBe(vector.handshake_hash);

  // After the handshake the messages alternate, the initiator first: each is a vonvon frame without its 8-byte counter.
  for (const [index, message] of transport.entries()) {
    const [sender, receiver] = index % 2 === 0 ? [finished.channel, message2.channel] : [message2.channel, finished.channel];
    const frame = sender.encrypt(hex(message.payload));
    expect(frame.readBigUInt64BE(0)).toBe(BigInt(Math.floor(index / 2)));
    expect(frame.subarray(8).toString("hex")).toBe(message.ciphertext);
    expect(receiver.decrypt(frame).toString("hex")).toBe(message.payload);
  }
});
