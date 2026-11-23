// @vitest-environment jsdom
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {type RecipeInstallReply, type RecipeSourceRequest} from '@vonvon/protocol';
import {ClientProvider} from '../src/client-context';
import {RichSetupPanel} from '../src/recipes/RichSetupPanel';
import {newClient} from './devices-fixture';

type Setup = Extract<RecipeInstallReply,{kind:'richSetup'}>;
let root: Root;
let read: Setup;
let calls: RecipeSourceRequest[];
const instant = Date.parse('2027-01-02T00:00:00Z');
const task = (id: string, timeZone: string, once = false) => ({id,name:id,state:'paused' as const,token:(id==='once'?'b':'c').repeat(64),instruction:'核对任务',schedule:once?'1 月 2 日 09:00 一次':'每天 09:00',timeZone,placement:'follow' as const,spec:once?{kind:'once' as const,at:instant}:{kind:'daily' as const,time:'09:00'}});
async function click(label: string, index = 0) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].filter(button=>button.textContent?.trim()===label)[index];
  expect(button).toBeDefined(); expect(button.disabled).toBe(false);
  await act(async()=>button.click());
}
async function fill(zone: string) {
  const input = document.querySelector<HTMLInputElement>('[aria-label="任务执行时区"]')!;
  await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,zone);input.dispatchEvent(new Event('input',{bubbles:true}));});
}
async function render(sourceToken='a'.repeat(64)) {
  await act(async()=>root.render(<ClientProvider client={client} device={{id:'remote',isRemote:true,name:'目标设备',mode:'full',capabilities:[]}} shell={{recipeSource:{request:async request=>{calls.push(request);return {source:null,setup:read};}}}}><RichSetupPanel botId="cli_test" groupId="oc_test" sourceToken={sourceToken}/></ClientProvider>));
}
const client = newClient();
beforeEach(()=>{
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
  vi.stubGlobal('matchMedia',vi.fn(()=>({matches:true,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}})));
  calls=[];read={kind:'richSetup',groupId:'oc_test',token:'d'.repeat(64),steps:[],tasks:[task('once','Asia/Tokyo',true),task('daily','America/New_York')]};
  document.body.innerHTML='<div id="root"></div>';root=createRoot(document.getElementById('root')!);
});
afterEach(async()=>{await act(async()=>root.unmount());vi.unstubAllGlobals();});
it('shows the immutable once instant in the chosen zone and sends exact consent tokens',async()=>{
  await render();await click('核对并启用');
  expect(document.querySelector<HTMLInputElement>('input')!.value).toBe('Asia/Tokyo');
  await fill('Asia/Shanghai');
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('2027-01-02 08:00');
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Asia/Shanghai');
  await click('启用此任务');
  expect(calls.at(-1)).toEqual({type:'setup',viewId:'remote',botId:'cli_test',groupId:'oc_test',sourceToken:'a'.repeat(64),action:{kind:'enableTask',taskId:'once',token:'d'.repeat(64),taskToken:'b'.repeat(64),timeZone:'Asia/Shanghai'}});
  expect(read.tasks[0].spec).toEqual({kind:'once',at:instant});
});
it('resets each selected task to its native zone and cancelling writes nothing',async()=>{
  await render();await click('核对并启用');await fill('Asia/Shanghai');await click('保留暂停');
  await click('核对并启用',1);
  expect(document.querySelector<HTMLInputElement>('input')!.value).toBe('America/New_York');
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('每天 09:00');
  await click('保留暂停');await click('核对并启用');
  expect(document.querySelector<HTMLInputElement>('input')!.value).toBe('Asia/Tokyo');
  expect(calls.every(call=>call.type==='setup'&&call.action.kind==='read')).toBe(true);
});
it('closes old consent on a new source read and rejects an invalid zone',async()=>{
  await render();await click('核对并启用');await fill('Mars/Olympus');
  expect([...document.querySelectorAll<HTMLButtonElement>('button')].find(button=>button.textContent==='启用此任务')!.disabled).toBe(true);
  read={...read,token:'e'.repeat(64),tasks:[task('once','UTC',true)]};await render('f'.repeat(64));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await click('核对并启用');expect(document.querySelector<HTMLInputElement>('input')!.value).toBe('UTC');
});
it('defaults recurring Tokyo tasks to Tokyo on a remote device and keeps the chosen clock',async()=>{
  read={...read,tasks:[task('daily','Asia/Tokyo')]};
  await render();await click('核对并启用');
  expect(document.querySelector<HTMLInputElement>('input')!.value).toBe('Asia/Tokyo');
  await fill('America/New_York');
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('启用后：每天 09:00（America/New_York）');
});
it('keeps the previous calendar date when converting a fixed once instant',async()=>{
  read={...read,tasks:[{...task('once','Asia/Tokyo',true),spec:{kind:'once',at:Date.parse('2027-01-01T15:30:00Z')}}]};
  await render();await click('核对并启用');await fill('Asia/Shanghai');
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('2027-01-01 23:30');
});
it('keeps old daemon replies in their native zone without offering an unpreviewable override',async()=>{
  const {spec:_,...legacy}=task('once','Asia/Tokyo',true);
  read={...read,tasks:[legacy]};await render();await click('核对并启用');
  const input=document.querySelector<HTMLInputElement>('input')!;
  expect(input.value).toBe('Asia/Tokyo');expect(input.disabled).toBe(true);
  await click('启用此任务');
  expect(calls.at(-1)).toMatchObject({action:{timeZone:'Asia/Tokyo'}});
});

it('does not expose legacy preparation checks or an empty task panel',async()=>{
  read={...read,tasks:[],steps:[{itemId:'11111111-1111-4111-8111-111111111111',originId:'22222222-2222-4222-8222-222222222222',kind:'tool',title:'Legacy step',instructions:'LEGACY_SETUP_SENTINEL',required:true,action:{kind:'manual'},readiness:'pending'}]};
  await render();expect(document.querySelector('.recipe-source-setup')).toBeNull();
  expect(document.body.textContent).not.toContain('LEGACY_SETUP_SENTINEL');
  expect(calls.every(call=>call.type==='setup'&&call.action.kind==='read')).toBe(true);
});
