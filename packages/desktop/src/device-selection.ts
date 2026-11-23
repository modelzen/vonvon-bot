import {randomUUID} from 'node:crypto';
import {readFile,rename,unlink,writeFile} from 'node:fs/promises';
import {z} from 'zod';
import {LOCAL_VIEW,type ViewId} from '@vonvon/protocol';
import type {DeviceRegistry} from './device-registry.js';

const selectionSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('local')}).strict(),
  z.object({kind:z.literal('paired'),deviceId:z.string().uuid(),pk:z.string().regex(/^[A-Za-z0-9_-]{43}$/)}).strict(),
]);
const fileSchema=z.object({v:z.literal(1),selection:selectionSchema}).strict();
export type DeviceSelection=z.infer<typeof selectionSchema>;
export interface DeviceSelectionStore {
  get():Readonly<DeviceSelection>|undefined;
  /** Writes resolve in invocation order; failed writes leave the previous preference intact. */
  set(selection:DeviceSelection):Promise<void>;
}

/** Public preference only; pairing credentials remain in devices.json and secure storage. */
export async function openDeviceSelection(path:string):Promise<DeviceSelectionStore>{
  let raw:unknown;
  try{raw=JSON.parse(await readFile(path,'utf8'));}catch{raw=undefined;}
  const parsed=fileSchema.safeParse(raw);
  let selection=parsed.success?parsed.data.selection:undefined;
  const newer=raw!==null&&typeof raw==='object'&&'v' in raw&&typeof raw.v==='number'&&raw.v>1;
  let queue:Promise<unknown>=Promise.resolve();
  return {
    get:()=>selection,
    set(value){
      const next=selectionSchema.parse(value);
      const work=queue.then(async()=>{
        if(newer)throw new Error('Device selection was saved by a newer app');
        if(JSON.stringify(next)===JSON.stringify(selection))return;
        const temporary=path+'.tmp-'+randomUUID();
        try{
          await writeFile(temporary,JSON.stringify({v:1,selection:next},null,2)+'\n',{flag:'wx',mode:0o600});
          await rename(temporary,path);
          selection=next;
        }finally{await unlink(temporary).catch(()=>{});}
      });
      queue=work.catch(()=>{});
      return work;
    },
  };
}

/** A saved choice never authorizes a device that is absent, repaired with another key, or revoked. */
export function savedDeviceView(store:DeviceSelectionStore,registry:DeviceRegistry):ViewId{
  const selected=store.get();
  if(!selected||selected.kind==='local')return LOCAL_VIEW;
  const device=registry.get(selected.deviceId);
  if(!device||device.pk!==selected.pk||device.problem)return LOCAL_VIEW;
  try{registry.openKey(device);}catch{return LOCAL_VIEW;}
  return device.deviceId;
}
