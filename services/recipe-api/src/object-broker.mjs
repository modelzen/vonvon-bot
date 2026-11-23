import { createHash } from 'node:crypto';
import { ApiError, UUID } from './errors.mjs';
import {credentialField} from './credential-shapes.mjs';
import { normalizeLogo, verifyNormalizedLogo } from './logo.mjs';
import { boundedObjectBytes } from './object-storage.mjs';
import { objectMemberScope, objectPackageScope } from './object-store.mjs';

const media = {text:'text/plain;charset=utf-8',finalLogo:'image/webp',manifest:'application/json'};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const uncertain = () => new ApiError(503,'object_write_uncertain',10);

function descriptor(m) {
  return {objectId:m.id,kind:m.kind,bytes:m.final_bytes,sha256:m.final_hash,mediaType:media[m.kind]};
}
function sameBytes(data, size, expected) {
  if (data === null || data.length !== size || hash(data) !== expected) throw new ApiError(409,'object_integrity');
}

export function createObjectBroker({store,storage,validateCanonicalManifest,authorizeRead,recordTextChecks=false}) {
  async function checkFinal(kind,bytes) {
    if (kind === 'finalLogo') return verifyNormalizedLogo(bytes);
    if (kind === 'manifest') {
      if (typeof validateCanonicalManifest !== 'function') throw new ApiError(503,'manifest_codec_unavailable');
      await validateCanonicalManifest(bytes);
      return;
    }
    if (kind !== 'text') throw new ApiError(422,'invalid_object_kind');
    try {
      const text = new TextDecoder('utf-8',{fatal:true}).decode(bytes);
      if (credentialField({config:{role:text}})) throw new ApiError(422,'credential_detected');
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new Error();
    } catch { throw new ApiError(422,'invalid_object_text'); }
  }

  async function readLane(m,lane) {
    const size = lane === 'temp' ? m.input_bytes : m.final_bytes;
    const data = await storage.read(m.id,lane,size);
    if (data === null && m[lane+'_state'] === 'writing') throw uncertain();
    sameBytes(data,size,lane === 'temp' ? m.input_hash : m.final_hash);
    return data;
  }

  async function removeLane(call,scope,m,lane) {
    await call('begin_delete',...scope,lane);
    if (!['none','gone'].includes(m[lane+'_state'])) {
      await storage.remove(m.id,lane);
      if (await storage.read(m.id,lane,lane === 'temp' ? m.input_bytes : m.final_cap) !== null) {
        throw new ApiError(503,'object_delete_pending',10);
      }
    }
    await call('saw_absence',...scope,lane);
  }

  return {
    async receive(actor, operationId, {ordinal,kind,bytes,sha256}, stream) {
      const scope = objectMemberScope(actor,operationId,ordinal);
      if (!Object.hasOwn(media,kind) || !Number.isInteger(bytes) || !/^[0-9a-f]{64}$/.test(sha256)) {
        throw new ApiError(422,'invalid_object_member');
      }
      return store.withMember(...scope,async call => {
        let m = await call('open_member',...scope,kind,bytes,sha256);
        if (m.state === 'ready') return descriptor(m);
        try {
          if (m.temp_state === 'none') {
            const input = await boundedObjectBytes(stream,bytes,AbortSignal.timeout(15000));
            sameBytes(input,bytes,sha256);
            await call('start_write',...scope,'temp',bytes,sha256);
            await storage.create(m.id,'temp',input);
            m = await call('member',...scope);
          }
          if (m.final_state === 'none') {
            const source = await readLane(m,'temp');
            await call('saw_bytes',...scope,'temp',source.length,hash(source));
            const normalized = kind === 'finalLogo' ? await normalizeLogo(source) : source;
            if (kind !== 'finalLogo') await checkFinal(kind,normalized);
            await call('start_write',...scope,'final',normalized.length,hash(normalized));
            await storage.create(m.id,'final',normalized);
            m = await call('member',...scope);
          }
          const final = await readLane(m,'final');
          await checkFinal(kind,final);
          await call('saw_bytes',...scope,'final',final.length,hash(final));
          if(recordTextChecks && kind==='text') await call('record_text_check',...scope,Boolean(final.toString('utf8').trim()));
          await removeLane(call,scope,m,'temp');
          return descriptor(await call('ready',...scope));
        } finally { await call('end_ingress',...scope); }
      });
    },
    async reconcileQuiescent(actor,operationId,ordinal,lane,evidenceSha256) {
      const scope = objectMemberScope(actor,operationId,ordinal);
      await store.withMember(...scope,call => call('confirm_quiescence',...scope,lane,evidenceSha256));
    },
    async collect(actor,operationId) {
      [actor,operationId] = objectPackageScope(actor,operationId);
      const inventory = await store.call('inventory',actor,operationId);
      if (inventory.state === 'open') {
        return {pending:inventory.members.map(m=>({ordinal:m.ordinal,reason:'object_held'})),inventory};
      }
      const pending = [];
      for (const {ordinal} of inventory.members) {
        const scope = [actor,operationId,ordinal];
        try {
          await store.withMember(...scope,async call => {
            const m = await call('member',...scope);
            if (m.state === 'gone') return;
            await call('end_ingress',...scope);
            for (const lane of ['final','temp']) {
              if (m[lane+'_state'] === 'writing') {
                const data = await readLane(m,lane);
                await call('saw_bytes',...scope,lane,data.length,hash(data));
              }
              await removeLane(call,scope,m,lane);
            }
            await call('end_ingress',...scope);
          });
        } catch (error) {
          const reason = error.code === 'P0001' ? error.message : error.code;
          if (!['object_member_busy','object_held','object_write_uncertain','object_delete_pending',
              'object_storage_unavailable','object_integrity'].includes(reason)) throw error;
          pending.push({ordinal,reason});
        }
      }
      await store.call('close_package',actor,operationId);
      return {pending,inventory:await store.call('inventory',actor,operationId)};
    },
    async readAuthorized(request) {
      if (typeof authorizeRead !== 'function') throw new ApiError(503,'object_access_unavailable');
      const d = await authorizeRead(request);
      if (!d || !UUID.test(d.objectId) || !Object.hasOwn(media,d.kind) || d.mediaType !== media[d.kind] ||
          !Number.isInteger(d.bytes) || d.bytes < 0 || d.bytes > (d.kind === 'manifest' ? 1048576 : 131072)) {
        throw new ApiError(404,'not_found');
      }
      const bytes = await storage.read(d.objectId,'final',d.bytes);
      sameBytes(bytes,d.bytes,d.sha256);
      return bytes;
    },
  };
}
