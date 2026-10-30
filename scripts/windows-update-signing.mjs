import {generateKeyPairSync} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, isAbsolute, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {signWindowsUpdate} from '../packages/desktop/src/windows-update-manifest.mjs';
export {signWindowsUpdate, verifyWindowsUpdate, publicKeyFromPrivate, normalizeWindowsPublicKey} from '../packages/desktop/src/windows-update-manifest.mjs';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, input, output] = process.argv.slice(2);
  if (command === 'create-key' && isAbsolute(input ?? '') && isAbsolute(output ?? '')) {
    const {privateKey, publicKey} = generateKeyPairSync('ed25519');
    await mkdir(dirname(input), {recursive:true, mode:0o700});
    await writeFile(input, privateKey.export({type:'pkcs8',format:'pem'}), {flag:'wx',mode:0o600});
    await writeFile(output, JSON.stringify({publicKey:publicKey.export({type:'spki',format:'pem'}).toString()}, null, 2)+'\n', {flag:'wx'});
    console.log('Created Windows update signing key; private material stays in the external key file.');
  } else if (command === 'sign' && input && output && process.env.VONVON_WINDOWS_UPDATE_PRIVATE_KEY_FILE) {
    const key = await readFile(process.env.VONVON_WINDOWS_UPDATE_PRIVATE_KEY_FILE,'utf8');
    const envelope = signWindowsUpdate(JSON.parse(await readFile(input,'utf8')), key);
    await writeFile(output, JSON.stringify(envelope)+'\n', {flag:'wx'});
    console.log('Signed Windows update manifest.');
  } else throw Error('Usage: create-key <absolute external private-key path> <absolute public-config path>, or sign <payload.json> <envelope.json> with VONVON_WINDOWS_UPDATE_PRIVATE_KEY_FILE');
}
