import { Buffer } from "node:buffer";
import {
  createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync,
  timingSafeEqual, type KeyObject,
} from "node:crypto";

/** devices 4.4: the secure channel every remote connection runs in. Noise IK (Noise specification rev 34) on node:crypto
 * only, so the daemon, the CLI and the desktop's main process share it. Not exported from the package index: the web UI
 * bundles `@vonvon/protocol` for the browser, which has no node:crypto (`@vonvon/protocol/secure-channel`). */
export const PROTOCOL_NAME = "Noise_IK_25519_AESGCM_SHA256";
/** Bound into the handshake hash, with the version byte: a `/2` peer can never be talked down to this one. */
export const PROLOGUE = Buffer.concat([Buffer.from("vonvon-secure-channel/1", "utf8"), Buffer.from([0x01])]);
/** The first byte of message 1, equal to the last byte of the prologue: an early failure, the hash binds it anyway. */
export const CHANNEL_VERSION = 0x01;

const DHLEN = 32;
const TAGLEN = 16;
const HASHLEN = 32;
/** Noise reserves 2^64-1; the last counter a channel uses is the one below. */
const MAX_NONCE = (1n << 64n) - 2n;
/** Message 1: version, e, s encrypted, payload encrypted (at least its tag). */
export const MESSAGE1_MIN = 1 + DHLEN + DHLEN + TAGLEN + TAGLEN;
/** Message 2: e, payload encrypted. */
export const MESSAGE2_MIN = DHLEN + TAGLEN;
/** A transport frame: the 8-byte counter, then the ciphertext and its tag. */
export const FRAME_OVERHEAD = 8 + TAGLEN;

export class HandshakeError extends Error {
  readonly code = "handshake_failed" as const;
  constructor(message = "secure channel handshake failed") { super(message); this.name = "HandshakeError"; }
}
export type ChannelErrorCode = "replay" | "tamper" | "exhausted" | "frame";
export class ChannelError extends Error {
  constructor(readonly code: ChannelErrorCode, message = `secure channel frame refused: ${code}`) { super(message); this.name = "ChannelError"; }
}

/** An X25519 key pair: the raw 32-byte public key (what goes on the wire and into links) and the private key object. */
export interface StaticKey { publicKey: Buffer; privateKey: KeyObject }
const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");
const rawPublic = (key: KeyObject): Buffer => {
  const x = key.export({ format: "jwk" }).x;
  if (typeof x !== "string") throw new Error("X25519 key without a public part");
  return Buffer.from(x, "base64url");
};
const base64urlKey = (text: string, what: string): Buffer => {
  const bytes = /^[A-Za-z0-9_-]{43}$/.test(text) ? Buffer.from(text, "base64url") : Buffer.alloc(0);
  if (bytes.length !== DHLEN) throw new Error(`${what} must be 32 bytes, base64url`);
  return bytes;
};
/**
 * As `device.json` keeps it (D1 `deviceKeyPair`): JWK `x` and `d`. A pair whose halves do not belong together is refused.
 * `d` is imported alone and compared here: some Node builds refuse a mismatched JWK at import with their own message.
 */
export function staticKeyFromBase64url(publicKey: string, privateKey: string): StaticKey {
  const x = base64urlKey(publicKey, "public key");
  const key = staticKeyFromPrivateKey(base64urlKey(privateKey, "private key"));
  if (!timingSafeEqual(key.publicKey, x)) throw new Error("public key does not belong to the private key");
  return key;
}
/** From the raw 32-byte private key alone (the test vectors give only that). */
export function staticKeyFromPrivateKey(privateKey: Buffer): StaticKey {
  if (privateKey.length !== DHLEN) throw new Error("private key must be 32 bytes");
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_X25519, privateKey]), format: "der", type: "pkcs8" });
  return { publicKey: rawPublic(createPublicKey(key)), privateKey: key };
}
export function generateStaticKey(): { key: StaticKey; publicKeyBase64url: string; privateKeyBase64url: string } {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const { x, d } = privateKey.export({ format: "jwk" });
  if (typeof x !== "string" || typeof d !== "string") throw new Error("X25519 key export failed");
  return { key: { publicKey: rawPublic(publicKey), privateKey }, publicKeyBase64url: x, privateKeyBase64url: d };
}

const sha256 = (...parts: Buffer[]): Buffer => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
};
/** Noise HKDF with two outputs: RFC 5869 with the chaining key as salt and an empty info is the same function. */
const hkdf2 = (chainingKey: Buffer, inputKeyMaterial: Buffer): [Buffer, Buffer] => {
  const out = Buffer.from(hkdfSync("sha256", inputKeyMaterial, chainingKey, Buffer.alloc(0), 2 * HASHLEN));
  return [out.subarray(0, HASHLEN), out.subarray(HASHLEN)];
};
/** AESGCM: 32 bits of zeros, then the counter big-endian. */
const nonceOf = (n: bigint): Buffer => {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64BE(n, 4);
  return nonce;
};
const seal = (key: Buffer, n: bigint, ad: Buffer, plaintext: Buffer): Buffer => {
  const cipher = createCipheriv("aes-256-gcm", key, nonceOf(n), { authTagLength: TAGLEN });
  cipher.setAAD(ad);
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
};
/** undefined when the tag does not verify. */
const open = (key: Buffer, n: bigint, ad: Buffer, ciphertext: Buffer): Buffer | undefined => {
  if (ciphertext.length < TAGLEN) return undefined;
  const decipher = createDecipheriv("aes-256-gcm", key, nonceOf(n), { authTagLength: TAGLEN });
  decipher.setAAD(ad);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAGLEN));
  try { return Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - TAGLEN)), decipher.final()]); }
  catch { return undefined; }
};
const publicKeyObject = (raw: Buffer): KeyObject => {
  try { return createPublicKey({ key: { kty: "OKP", crv: "X25519", x: raw.toString("base64url") }, format: "jwk" }); }
  catch { throw new HandshakeError(); }
};
/** A low-order point gives an all-zero secret: OpenSSL refuses to derive it, and an all-zero result is refused here too. */
const dh = (local: KeyObject, remote: Buffer): Buffer => {
  let secret: Buffer;
  try { secret = diffieHellman({ privateKey: local, publicKey: publicKeyObject(remote) }); }
  catch { throw new HandshakeError(); }
  if (secret.length !== DHLEN || secret.every(byte => byte === 0)) throw new HandshakeError();
  return secret;
};

/** Noise's SymmetricState: the chaining key, the handshake hash and the current cipher key with its counter. */
class SymmetricState {
  ck: Buffer;
  h: Buffer;
  private k: Buffer | undefined;
  private n = 0n;
  constructor(prologue: Buffer) {
    const name = Buffer.from(PROTOCOL_NAME, "ascii");
    this.h = name.length <= HASHLEN ? Buffer.concat([name, Buffer.alloc(HASHLEN - name.length)]) : sha256(name);
    this.ck = this.h;
    this.mixHash(prologue);
  }
  mixHash(data: Buffer): void { this.h = sha256(this.h, data); }
  mixKey(inputKeyMaterial: Buffer): void {
    [this.ck, this.k] = hkdf2(this.ck, inputKeyMaterial);
    this.n = 0n;
  }
  encryptAndHash(plaintext: Buffer): Buffer {
    const ciphertext = this.k ? seal(this.k, this.n++, this.h, plaintext) : plaintext;
    this.mixHash(ciphertext);
    return ciphertext;
  }
  decryptAndHash(ciphertext: Buffer): Buffer {
    let plaintext: Buffer | undefined = ciphertext;
    if (this.k) {
      plaintext = open(this.k, this.n, this.h, ciphertext);
      if (!plaintext) throw new HandshakeError();
      this.n++;
    }
    this.mixHash(ciphertext);
    return plaintext;
  }
  /** c1 carries the initiator's frames, c2 the responder's. */
  split(): [Buffer, Buffer] { return hkdf2(this.ck, Buffer.alloc(0)); }
}

/** Both directions of an established channel. A frame is `[8-byte counter][ciphertext and tag]`, empty AD; the counter
 * must be exactly the next one, so a replayed, dropped or reordered frame is refused, and the socket closes (devices 4.4). */
export interface Channel {
  encrypt(plaintext: Buffer): Buffer;
  decrypt(frame: Buffer): Buffer;
  readonly handshakeHash: Buffer;
}
function createChannel(sendKey: Buffer, receiveKey: Buffer, handshakeHash: Buffer): Channel {
  let sendN = 0n;
  let receiveN = 0n;
  return {
    handshakeHash,
    encrypt(plaintext) {
      if (sendN > MAX_NONCE) throw new ChannelError("exhausted");
      const n = sendN++;
      const counter = Buffer.alloc(8);
      counter.writeBigUInt64BE(n);
      return Buffer.concat([counter, seal(sendKey, n, Buffer.alloc(0), plaintext)]);
    },
    decrypt(frame) {
      if (receiveN > MAX_NONCE) throw new ChannelError("exhausted");
      if (frame.length < FRAME_OVERHEAD) throw new ChannelError("frame");
      if (frame.readBigUInt64BE(0) !== receiveN) throw new ChannelError("replay");
      const plaintext = open(receiveKey, receiveN, Buffer.alloc(0), frame.subarray(8));
      if (!plaintext) throw new ChannelError("tamper");
      receiveN++;
      return plaintext;
    },
  };
}

export interface HandshakeOptions {
  /** Test vectors only: a fixed ephemeral key, and their own prologue instead of PROLOGUE. */
  ephemeral?: StaticKey;
  prologue?: Buffer;
}
const ephemeralKey = (options: HandshakeOptions | undefined): StaticKey => options?.ephemeral ?? generateStaticKey().key;

/** The client side: it knows the device's static key from the pairing link (IK's `<- s` pre-message). */
export function createInitiator(local: StaticKey, remoteStaticPublicKey: Buffer, options?: HandshakeOptions): {
  message1(payload?: Buffer): Buffer;
  finish(message2: Buffer): { channel: Channel; payload: Buffer };
} {
  if (remoteStaticPublicKey.length !== DHLEN) throw new HandshakeError("the device key must be 32 bytes");
  const state = new SymmetricState(options?.prologue ?? PROLOGUE);
  state.mixHash(remoteStaticPublicKey);
  const e = ephemeralKey(options);
  let step: "message1" | "finish" | "done" = "message1";
  return {
    // -> e, es, s, ss
    message1(payload = Buffer.alloc(0)) {
      if (step !== "message1") throw new Error("message 1 was already written");
      step = "finish";
      state.mixHash(e.publicKey);
      state.mixKey(dh(e.privateKey, remoteStaticPublicKey));
      const s = state.encryptAndHash(local.publicKey);
      state.mixKey(dh(local.privateKey, remoteStaticPublicKey));
      return Buffer.concat([Buffer.from([CHANNEL_VERSION]), e.publicKey, s, state.encryptAndHash(payload)]);
    },
    // <- e, ee, se
    finish(message2) {
      if (step !== "finish") throw new Error("finish comes once, after message 1");
      step = "done";
      if (message2.length < MESSAGE2_MIN) throw new HandshakeError();
      const re = Buffer.from(message2.subarray(0, DHLEN));
      state.mixHash(re);
      state.mixKey(dh(e.privateKey, re));
      state.mixKey(dh(local.privateKey, re));
      const payload = state.decryptAndHash(Buffer.from(message2.subarray(DHLEN)));
      const [c1, c2] = state.split();
      return { channel: createChannel(c1, c2, state.h), payload };
    },
  };
}

/** The device side: it learns the client's static key from message 1 and decides (devices 4.3) before answering. */
export function createResponder(local: StaticKey, options?: HandshakeOptions): {
  readMessage1(bytes: Buffer): { remoteStaticPublicKey: Buffer; payload: Buffer };
  message2(payload?: Buffer): { bytes: Buffer; channel: Channel };
} {
  const state = new SymmetricState(options?.prologue ?? PROLOGUE);
  state.mixHash(local.publicKey);
  let step: "read" | "message2" | "done" = "read";
  let re: Buffer | undefined;
  let rs: Buffer | undefined;
  return {
    readMessage1(bytes) {
      if (step !== "read") throw new Error("message 1 was already read");
      step = "done";
      if (bytes.length < MESSAGE1_MIN || bytes[0] !== CHANNEL_VERSION) throw new HandshakeError();
      const ephemeral = Buffer.from(bytes.subarray(1, 1 + DHLEN));
      state.mixHash(ephemeral);
      state.mixKey(dh(local.privateKey, ephemeral));
      const remote = state.decryptAndHash(Buffer.from(bytes.subarray(1 + DHLEN, 1 + DHLEN + DHLEN + TAGLEN)));
      state.mixKey(dh(local.privateKey, remote));
      const payload = state.decryptAndHash(Buffer.from(bytes.subarray(1 + DHLEN + DHLEN + TAGLEN)));
      re = ephemeral;
      rs = remote;
      step = "message2";
      return { remoteStaticPublicKey: Buffer.from(remote), payload };
    },
    message2(payload = Buffer.alloc(0)) {
      if (step !== "message2" || !re || !rs) throw new Error("message 2 comes once, after a message 1 that was read");
      step = "done";
      const e = ephemeralKey(options);
      state.mixHash(e.publicKey);
      state.mixKey(dh(e.privateKey, re));
      state.mixKey(dh(e.privateKey, rs));
      const bytes = Buffer.concat([e.publicKey, state.encryptAndHash(payload)]);
      const [c1, c2] = state.split();
      return { bytes, channel: createChannel(c2, c1, state.h) };
    },
  };
}

/** What a decrypted frame carries: its first byte says what, the rest is the body. `json` is today's JSON text in UTF-8
 * (hello, serverInfo, request, response, event, error, pairRequest, pairResult); `ping` and `pong` have no body; `close`
 * is why the device is closing (`closeBody`): a WebSocket close code is not authenticated, so past message 2 only this
 * one is believed (anyone on the path can send a close frame). */
export const FRAME = { json: 0x00, ping: 0x01, pong: 0x02, close: 0x03 } as const;
export type FrameType = (typeof FRAME)[keyof typeof FRAME];
const FRAME_TYPES = new Set<number>(Object.values(FRAME));
export function encodeFrame(type: FrameType, body: Buffer = Buffer.alloc(0)): Buffer {
  return Buffer.concat([Buffer.from([type]), body]);
}
export function decodeFrame(plain: Buffer): { type: FrameType; body: Buffer } {
  const type = plain[0];
  if (type === undefined || !FRAME_TYPES.has(type)) throw new ChannelError("frame");
  return { type: type as FrameType, body: plain.subarray(1) };
}
/** A `close` frame's body: the close code (2 bytes, big-endian), then the reason in UTF-8, as on the WebSocket close. */
export function closeBody(code: number, reason: string): Buffer {
  const head = Buffer.alloc(2);
  head.writeUInt16BE(code);
  return Buffer.concat([head, Buffer.from(reason, "utf8")]);
}
export function readCloseBody(body: Buffer): { code: number; reason: string } {
  if (body.length < 2) throw new ChannelError("frame");
  return { code: body.readUInt16BE(0), reason: body.subarray(2).toString("utf8") };
}
/** The reason of a 4005 for a handshake that did not come in time, not one that failed: a slow link, which a client
 * retries, is not "another device at that address" (only 4005 `handshake_failed` before message 2 says that). */
export const HANDSHAKE_TIMEOUT_REASON = "handshake_timeout";
