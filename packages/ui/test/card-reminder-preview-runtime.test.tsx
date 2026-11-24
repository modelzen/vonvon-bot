import {expect,it,vi} from 'vitest';
import {isValidElement,type ReactElement,type ReactNode} from 'react';
import {CARD_DISPLAY_REMINDER_EID} from '@vonvon/protocol';
import {FeishuCardPreview,FeishuContentSample} from '../src/settings/card-display/FeishuCardPreview';
import {composeCard,defaultCardDisplay} from '../src/settings/card-display/card-display-model';
import {toolPreviewFrames,toolPreviewLayoutInputs,toolPreviewFramesRequested,toolPreviewLayoutInputsRequested} from '../src/settings/card-display/card-preview-frames';
vi.mock('react',async original=>({...await original<typeof import('react')>(),useState:(initial:unknown)=>[typeof initial==='function'?initial():initial,()=>{}]}));
type Element=ReactElement<Record<string,any>>;
function nodes(node:ReactNode):Element[]{if(Array.isArray(node))return node.flatMap(nodes);if(!isValidElement<Record<string,any>>(node))return [];return typeof node.type==='function'?[node,...nodes((node.type as (props:Record<string,any>)=>ReactNode)(node.props))]:[node,...nodes(node.props.children)];}
const event=()=>({stopPropagation:vi.fn()});

it('lets the real reminder button request a reminder, while a separate small setting action edits it',()=>{
  const draft=defaultCardDisplay();draft.blocks.find(block=>block.kind==='reminder')!.template='🔔 完成后叫我';
  const card=composeCard(toolPreviewFrames.tool,draft,'tool',false,undefined,toolPreviewLayoutInputs.tool);
  const request=vi.fn(),select=vi.fn(),remove=vi.fn(),drag=vi.fn();
  const tree=nodes(FeishuCardPreview({card,editing:true,onRequestReminder:request,onSelect:select,onRemove:remove,onPointerDragStart:drag,nonRemovableComponents:['reminder']}));
  const button=tree.find(node=>node.type==='button'&&node.props['data-action']==='run.remind')!;
  const pointer={button:0};button.props.onPointerDown(pointer);expect(drag).toHaveBeenCalledExactlyOnceWith('reminder',pointer);
  button.props.onClick(event());expect(request).toHaveBeenCalledOnce();expect(select).not.toHaveBeenCalled();
  tree.find(node=>node.type==='button'&&node.props['aria-label']==='设置 🔔 完成后叫我')!.props.onClick(event());expect(select).toHaveBeenCalledExactlyOnceWith('reminder');
  const wrapper=tree.find(node=>node.props['data-card-component']==='reminder')!;
  const body=nodes(wrapper).find(node=>node.props.className==='vcr-widget-body')!;
  expect(body.props.inert).toBeUndefined();expect(body.props['aria-hidden']).toBeUndefined();
  expect(tree.some(node=>node.props['aria-label']==='隐藏 🔔 完成后叫我')).toBe(false);expect(remove).not.toHaveBeenCalled();
});

it('keeps the requested button editable and draggable, without a second request or remove action',()=>{
  const draft=defaultCardDisplay();const reminder=draft.blocks.find(block=>block.kind==='reminder')!;
  reminder.template='🛎️ 完成后叫我';reminder.requestedTemplate='✅ 已记住，完成后叫你';
  const card=composeCard(toolPreviewFramesRequested.tool,draft,'tool',false,undefined,toolPreviewLayoutInputsRequested.tool);
  const request=vi.fn(),select=vi.fn(),drag=vi.fn();
  const tree=nodes(FeishuCardPreview({card,editing:true,onRequestReminder:request,onSelect:select,onPointerDragStart:drag,onRemove:vi.fn(),nonRemovableComponents:['reminder']}));
  const wrapper=tree.find(node=>node.props['data-card-component']==='reminder')!;
  expect(tree.some(node=>node.type==='button'&&node.props['data-action']==='run.remind')).toBe(false);
  const local=nodes(wrapper);const button=local.find(node=>node.type==='button'&&node.props['data-element-id']===CARD_DISPLAY_REMINDER_EID)!;
  expect(button.props.disabled).toBe(true);expect(nodes(button).find(node=>node.props.className==='vcr-button-label')!.props.children).toBe('✅ 已记住，完成后叫你');
  expect(button.props.onClick).toBeUndefined();expect(button.props.onPointerDown).toBeUndefined();
  const edit=local.find(node=>node.props.className==='vcr-widget-edit')!;
  expect(edit.props.disabled).toBeUndefined();expect(edit.props['aria-label']).toBe('✅ 已记住，完成后叫你');
  expect(edit.props.title).toBe('本轮结束后会提醒发起人');
  expect(local.find(node=>node.props.className==='vcr-widget-body')!.props.inert).toBe(true);
  edit.props.onPointerDown({button:0});edit.props.onClick(event());
  expect(drag).toHaveBeenCalledOnce();expect(select).toHaveBeenCalledExactlyOnceWith('reminder');expect(request).not.toHaveBeenCalled();
  expect(local.some(node=>node.props.className==='vcr-widget-remove')).toBe(false);
});

it('preserves native pixel and fill button widths in the card and chooser sample',()=>{
  for(const [width,cssWidth] of [['172px','172px'],['fill','100%'],['default',undefined]] as const){
    const data={tag:'button',element_id:CARD_DISPLAY_REMINDER_EID,width,size:'medium',margin:'2px',text:{tag:'plain_text',content:'🔔 完成之后提醒我'}};
    const tree=nodes(FeishuCardPreview({card:{schema:'2.0',body:{elements:[data]}}}));
    const button=tree.find(node=>node.type==='button'&&node.props['data-element-id']===CARD_DISPLAY_REMINDER_EID)!;
    expect(button.props.style).toEqual({margin:'2px',width:cssWidth});
    expect(button.props['data-width']).toBe(width);
    expect(nodes(button).find(node=>node.props.className==='vcr-button-label')!.props.children).toBe('🔔 完成之后提醒我');
    const sample=nodes(FeishuContentSample({node:data})).find(node=>node.type==='span'&&node.props['data-element-id']===CARD_DISPLAY_REMINDER_EID)!;
    expect(sample.props.style.width).toBe(cssWidth);expect(sample.props['data-width']).toBe(width);
    expect(nodes(sample).find(node=>node.props.className==='vcr-button-label')!.props.children).toBe('🔔 完成之后提醒我');
  }
});

it('keeps reminder samples noninteractive and tags them for the same button-height styling',()=>{
  const draft=defaultCardDisplay();const card=composeCard(toolPreviewFrames.tool,draft,'tool',false,undefined,toolPreviewLayoutInputs.tool);
  const tree=nodes(FeishuCardPreview({card}));
  const button=tree.find(node=>node.type==='button'&&node.props['data-action']==='run.remind')!;
  const sample=nodes(FeishuContentSample({node:{tag:'button',text:{tag:'plain_text',content:'🛎️ 完成后叫我'},behaviors:[{value:{a:'run.remind'}}]}}));
  expect(button.props['data-action']).toBe('run.remind');
  expect(sample.find(node=>node.type==='span'&&node.props['data-action']==='run.remind')!.props.onClick).toBeUndefined();
  const requestedSample=nodes(FeishuContentSample({node:{tag:'button',element_id:CARD_DISPLAY_REMINDER_EID,disabled:true,text:{tag:'plain_text',content:'🛎️ 完成后叫我'}}}));
  expect(requestedSample.find(node=>node.type==='span'&&node.props['data-element-id']===CARD_DISPLAY_REMINDER_EID)!.props.onClick).toBeUndefined();
});
