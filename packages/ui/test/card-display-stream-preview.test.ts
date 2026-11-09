import {expect,it} from 'vitest';
import {streamPreviewCard,streamPreviewLength} from '../src/settings/card-display/card-display-model';
import {streamingPreviewFrames,streamingLayoutInputs,streamingPreviewFramesRequested,streamingLayoutInputsRequested} from '../src/settings/card-display/card-preview-frames';
import type {CardJson} from '../src/settings/card-display/FeishuCardPreview';

it('reveals a prefix of the native answer without changing process nodes, callback controls, or layout parts',()=>{
  for (const [frames,layouts] of [[streamingPreviewFrames,streamingLayoutInputs],[streamingPreviewFramesRequested,streamingLayoutInputsRequested]] as const) {
    const base=frames.at(-1)!,parts=layouts.at(-1)!.parts;
    const original=JSON.stringify({base,parts});
    const answerIndex=parts.answerIndices.at(-1)!;
    const full=base.body.elements[answerIndex]!.content as string;
    expect(streamPreviewLength(base,parts)).toBe(Array.from(full).length);
    expect(streamPreviewLength(base,parts)).toBeGreaterThan(30);
    const preview=streamPreviewCard(base,parts,7);
    expect(preview.body.elements[answerIndex]!.content).toBe(Array.from(full).slice(0,7).join(''));
    expect(preview.body.elements).toHaveLength(base.body.elements.length);
    base.body.elements.forEach((node,index)=>{if(index!==answerIndex)expect(preview.body.elements[index]).toBe(node);});
    expect(preview.body.elements[parts.controlsIndex!]).toEqual(base.body.elements[parts.controlsIndex!]);
    expect(JSON.stringify({base,parts})).toBe(original);
    expect(streamPreviewCard(base,parts,streamPreviewLength(base,parts))).toBe(base);
  }
});

it('streams the last textual answer in a native div by Unicode code point, preserving earlier answers and text attributes',()=>{
  const base:CardJson={schema:'2.0',body:{elements:[
    {tag:'markdown',content:'先查看项目资料。'},
    {tag:'markdown',content:'工具与状态里的文字保持原样。'},
    {tag:'div',text:{tag:'lark_md',content:'你🚀好',text_size:'normal'},element_id:'answer'},
    {tag:'img',img_key:'native-image'},
  ]}};
  const parts={answerIndices:[0,2,3]};
  expect(streamPreviewLength(base,parts)).toBe(3);
  expect(streamPreviewCard(base,parts,2).body.elements[2]).toEqual({tag:'div',text:{tag:'lark_md',content:'你🚀',text_size:'normal'},element_id:'answer'});
  expect(streamPreviewCard(base,parts,-1).body.elements[2]!.text).toEqual({tag:'lark_md',content:'',text_size:'normal'});
  expect(streamPreviewCard(base,parts,1.8).body.elements[2]!.text).toEqual({tag:'lark_md',content:'你',text_size:'normal'});
  expect(streamPreviewCard(base,parts,Infinity)).toBe(base);
  expect(base.body.elements[2]!.text).toEqual({tag:'lark_md',content:'你🚀好',text_size:'normal'});
  expect(parts.answerIndices).toEqual([0,2,3]);
});

it('leaves native cards with no text answer unchanged',()=>{
  const base:CardJson={schema:'2.0',body:{elements:[{tag:'markdown',content:'正在处理'},{tag:'img',img_key:'native-image'}]}};
  for(const parts of [{answerIndices:[]},{answerIndices:[1]}]){
    expect(streamPreviewLength(base,parts)).toBe(0);
    expect(streamPreviewCard(base,parts,0)).toBe(base);
  }
});
