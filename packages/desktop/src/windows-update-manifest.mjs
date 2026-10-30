import {createPrivateKey, createPublicKey, sign, verify} from 'node:crypto';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, required, optional = []) => object(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const base64 = (value, bytes) => typeof value === 'string' && value.length > 0 && value.length <= 32768 && Buffer.from(value, 'base64').toString('base64') === value && (!bytes || Buffer.from(value, 'base64').length === bytes);
export function normalizeWindowsPublicKey(value) {
  if (typeof value !== 'string' || value.length > 4096 || !value.startsWith('-----BEGIN PUBLIC KEY-----')) throw Error('Invalid Windows update public key');
  const key = createPublicKey(value);
  if (key.asymmetricKeyType !== 'ed25519') throw Error('Windows updates require an Ed25519 key');
  return key.export({type:'spki', format:'pem'}).toString();
}
export function publicKeyFromPrivate(value) {
  const key = createPrivateKey(value);
  if (key.asymmetricKeyType !== 'ed25519') throw Error('Windows updates require an Ed25519 key');
  return normalizeWindowsPublicKey(createPublicKey(key).export({type:'spki', format:'pem'}).toString());
}
export function validateWindowsUpdatePayload(value, architecture) {
  if (!keys(value, ['schemaVersion','product','version','architecture','url','size','sha512'], ['notes']) || value.schemaVersion !== 1 || value.product !== 'vonvon-bot' ||
      typeof value.version !== 'string' || !/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(value.version) ||
      !['x64','arm64'].includes(value.architecture) || (architecture && value.architecture !== architecture) ||
      !Number.isSafeInteger(value.size) || value.size <= 0 || !base64(value.sha512, 64) ||
      value.url !== `https://dl.vonvon.cc/bot/windows/${value.version}/Vonvon-Bot-Setup-${value.version}-${value.architecture}.exe` ||
      (value.notes !== undefined && (typeof value.notes !== 'string' || value.notes.length > 4096))) throw Error('Invalid Windows update payload');
  return value;
}
/** Sign exact UTF-8 bytes; no parser-dependent canonicalization at installation time. */
export function signWindowsUpdate(payload, privateKey) {
  validateWindowsUpdatePayload(payload);
  publicKeyFromPrivate(privateKey);
  const bytes = Buffer.from(JSON.stringify(payload));
  return {payload:bytes.toString('base64'), signature:sign(null, bytes, privateKey).toString('base64')};
}
export function verifyWindowsUpdate(envelope, publicKey, architecture) {
  if (!keys(envelope, ['payload','signature']) || !base64(envelope.payload) || !base64(envelope.signature, 64)) throw Error('Invalid Windows update signature');
  const bytes = Buffer.from(envelope.payload, 'base64');
  if (!verify(null, bytes, normalizeWindowsPublicKey(publicKey), Buffer.from(envelope.signature, 'base64'))) throw Error('Invalid Windows update signature');
  return validateWindowsUpdatePayload(JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes)), architecture);
}
