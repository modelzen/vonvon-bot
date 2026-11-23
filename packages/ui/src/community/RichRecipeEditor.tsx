import {BackButton} from '../BackButton';
import {GlowButton} from '../GlowButton';
import {recipeSettingNames} from './RichConfiguration';
import {useEffect, useMemo, useRef, useState} from 'react';
import type {CommunityShell, RecipeDetail, RecipeRichDraft, RecipePublic, RecipeRichDraftChange} from '@vonvon/protocol';
import {Button, InlineNotice} from '../reference/components/ui';
import {Dialog} from '../reference/components/ui/Dialog';
import {useShellCapabilities} from '../client-context';
import {useDraft} from '../settings/DraftGuard';
import {RecipeDetails} from './RecipeContent';
import {RecipeAuthoringPage} from './authoring/RecipeAuthoring';

type Props = {shell: CommunityShell; accountId: string; draft: RecipeRichDraft; onBack: () => void; onPublished: (recipe: RecipeDetail & {firstCode?: string}) => void};
const publicTextFields = [{field:'name',label:'名称'},{field:'summary',label:'简介'},{field:'overview',label:'概览'},{field:'version',label:'版本'}] as const;
export function RichRecipeEditor({shell, accountId, draft: initial, onBack, onPublished}: Props) {
  const [draft, setDraft] = useState(initial);
  const [publicInfo, setPublic] = useState(initial.public);
  const [logo, setLogo] = useState<{encoded:string;preview:string}>();
  const [removeLogo,setRemoveLogo]=useState(false);
  const [editing, setEditing] = useState(false);
  const [selectedContent,setSelectedContent]=useState<string[]>([]);
  const [chat, setChat] = useState(false);
  const [review, setReview] = useState<RecipeRichDraft>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [remoteNotice,setRemoteNotice]=useState(false);
  const remoteDraft=useRef(initial);
  const [deleting, setDeleting] = useState(false);
  const logoSequence=useRef(0);
  const live = useRef(true); const requestKeys = useRef(new Map<string,string>());
  const dirty = JSON.stringify(publicInfo) !== JSON.stringify(draft.public) || Boolean(logo) || removeLogo;
  const fingerprint=JSON.stringify({public:publicInfo,logo:logo?.encoded,removeLogo});
  const submission=useRef<string|undefined>(undefined);const fingerprintRef=useRef(fingerprint);fingerprintRef.current=fingerprint;
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const authoring = useShellCapabilities()?.recipeAuthoring;
  useEffect(() => {live.current = true; return () => {live.current = false;};}, []);
  useDraft(dirty, {title:'配方发布信息', discard: () => {setPublic(draft.public);setLogo(undefined);setRemoveLogo(false);}});
  async function reload(minimum = draft.revision, acceptedSubmission = false) {
    const next = await shell.request({type:'draft',accountId,draftId:draft.draftId});
    if (!live.current) return;
    if (next.format!=='rich-v2' || next.draftId !== draft.draftId || next.revision < minimum) throw new Error('尚未读取到此草稿的新修订，请重新读取。');
    const previous=remoteDraft.current;
    if(next.revision<previous.revision)return;
    remoteDraft.current=next;setDraft(next); setReview(undefined);
    if (!dirtyRef.current || acceptedSubmission && submission.current===fingerprintRef.current) {setPublic(next.public);setLogo(undefined);setRemoveLogo(false);setRemoteNotice(false);}else {
      setPublic(current=>({
        name:current.name!==previous.public.name?current.name:next.public.name,
        summary:current.summary!==previous.public.summary?current.summary:next.public.summary,
        overview:current.overview!==previous.public.overview?current.overview:next.public.overview,
        version:current.version!==previous.public.version?current.version:next.public.version,
        access:current.access!==previous.public.access?current.access:next.public.access,
      }));
      if(next.revision>previous.revision)setRemoteNotice(true);
    }
    if(acceptedSubmission)submission.current=undefined;
    return next;
  }
  useEffect(() => authoring?.onSaved?.(receipt => {
    if (receipt.accountId === accountId && receipt.draftId === draft.draftId) void reload(receipt.revision,true).catch(e => {if (live.current) setError(String(e));});
  }), [authoring,accountId,draft.draftId]);
  const changes: RecipeRichDraftChange[] = publicTextFields.flatMap(({field}) => publicInfo[field] !== draft.public[field] ? [{op:'setPublicText' as const,itemId:draft.rich.content.public[field].itemId,field,value:publicInfo[field]}] : []);
  const publicEditable = publicTextFields.map(({field,label})=>({...draft.rich.content.public[field],label}));
  const editable = [...(draft.rich.content.role?[{...draft.rich.content.role,label:'角色'}]:[]),...draft.rich.content.settings.map(item=>({...item,label:recipeSettingNames[item.field]})),...draft.rich.content.rules.map(item=>({...item,label:({work:'工作规则',smartRespond:'智能回复规则',smartNewTopic:'智能新话题规则'}[item.purpose])})),...draft.rich.content.skills.map(item=>({...item,label:'技能 · '+item.name})),...draft.rich.content.files.map(item=>({...item,label:'文档 · '+item.name})),...draft.rich.content.tasks.map(item=>({...item,label:'任务 · '+item.name})),...draft.rich.content.memories.map((item,index)=>({...item,label:'记忆 '+(index+1)})),...draft.rich.content.settings.flatMap(item=>item.field==='presentation.cardDisplay'&&item.value?item.value.blocks.map(block=>({...block,label:'卡片块 · '+block.name})):[])];
  const scopeKey = [...publicEditable,...editable].map(item=>item.itemId).join(',');
  const availableScope = useMemo(()=>new Set(scopeKey.split(',')),[scopeKey]);
  // Hide replaced item IDs immediately, then remove them so a later refresh cannot revive old consent.
  const selectedScope = selectedContent.filter(id=>availableScope.has(id));
  useEffect(()=>{setSelectedContent(previous=>{const next=previous.filter(id=>availableScope.has(id));return next.length===previous.length?previous:next;});},[availableScope]);
  const scopeOption = (item:{itemId:string;label:string})=><label className="community-checkbox" key={item.itemId}><input type="checkbox" aria-label={`允许聊天修改${item.label}`} checked={selectedScope.includes(item.itemId)} disabled={!selectedScope.includes(item.itemId)&&selectedScope.length>=24} onChange={e=>setSelectedContent(old=>e.target.checked?[...old.filter(id=>availableScope.has(id)),item.itemId]:old.filter(id=>id!==item.itemId&&availableScope.has(id)))}/>{item.label}</label>;
  if (removeLogo && draft.rich.content.finalLogo) changes.push({op:'removeItem',kind:'finalLogo',itemId:draft.rich.content.finalLogo.itemId});
  async function chooseLogo(file?:File) {if(!file)return;const sequence=++logoSequence.current;setError(undefined);if(file.size>2097152||!['image/png','image/jpeg','image/webp'].includes(file.type)){setError('Logo 请选择不超过 2 MiB 的 PNG、JPEG 或 WebP，已有图片仍保留。');return;}try{const bytes=new Uint8Array(await file.arrayBuffer());if(!live.current||sequence!==logoSequence.current)return;let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);const base64=btoa(binary);setLogo({encoded:base64.replaceAll('+','-').replaceAll('/','_').replace(/=+$/,''),preview:`data:${file.type};base64,${base64}`});setRemoveLogo(false);setReview(undefined);}catch{if(live.current&&sequence===logoSequence.current)setError('Logo 尚未读取，已有图片仍保留。');}}
  const meta = (patch: Partial<RecipePublic>) => {setPublic(value => ({...value,...patch})); setReview(undefined);};
  const detail: RecipeDetail = {recipeId:draft.recipeId ?? draft.draftId,versionId:draft.draftId,revision:draft.revision,public:editing ? publicInfo : draft.public,owned:true,acquired:false,format:'rich-v2',rich:draft.rich,logo:removeLogo?undefined:logo?.preview??draft.logo};
  const key = (action: string) => {const name = `${action}:${draft.revision}`; if (!requestKeys.current.has(name)) requestKeys.current.set(name,crypto.randomUUID()); return requestKeys.current.get(name)!;};
  async function run(action: () => Promise<unknown>) {if (busy) return; setBusy(true); setError(undefined); try {await action();} catch(e) {if (live.current) setError(e instanceof Error ? e.message : '操作尚未完成。');} finally {if (live.current) setBusy(false);}}
  return <div className="community-page"><div className="community-heading"><div><h1>私人草稿</h1><p>仅自己可见 · 修订 {draft.revision}</p></div><div className="community-actions"><BackButton onClick={onBack} label="返回创作中心"/><Button onClick={() => setEditing(value => !value)}>编辑发布信息</Button><Button onClick={() => setChat(value => !value)}>在飞书继续编辑</Button><GlowButton disabled={busy || dirty} variant="dark" onClick={() => void run(async () => {const current = await reload(); if (live.current && current) setReview(current);})}>预览发布</GlowButton><Button onClick={() => setDeleting(true)}>删除草稿</Button></div></div>
    {error && <InlineNotice tone="warning" title="草稿操作未完成" actions={<Button onClick={() => void run(() => reload())}>重新读取</Button>}>{error}</InlineNotice>}
    {remoteNotice&&<InlineNotice title="云端已有新修订">你的未保存输入仍保留，下面展示当前已保存配置。请核对后再继续。<Button onClick={()=>{setPublic(draft.public);setLogo(undefined);setRemoveLogo(false);setRemoteNotice(false);}}>采用已保存版本</Button></InlineNotice>}
    {editing && <section className="community-editor"><h2>发布信息</h2><div className="community-logo-editor">{detail.logo && <img alt="配方 Logo 预览" src={detail.logo} onError={()=>{if(logo){setLogo(undefined);setError('Logo 无法预览，已有图片仍保留。请选择有效的静态 PNG、JPEG 或 WebP。');}}}/>}<label>方形 Logo<input aria-label="上传配方 Logo" type="file" accept="image/png,image/jpeg,image/webp" onChange={e=>void chooseLogo(e.target.files?.[0])}/></label><p>居中裁切为方形。PNG、JPEG、WebP，原图不超过 2 MiB。保存后显示服务端归一化结果。</p>{(logo||draft.logo)&&<Button onClick={()=>{++logoSequence.current;setLogo(undefined);setRemoveLogo(Boolean(draft.rich.content.finalLogo));setReview(undefined);}}>移除 Logo</Button>}</div><label>名称<input aria-label="配方名称" value={publicInfo.name} maxLength={120} onChange={e => meta({name:e.target.value})}/></label><label>公开简介<textarea aria-label="公开简介" value={publicInfo.summary} onChange={e => meta({summary:e.target.value})}/></label><label>版本<input aria-label="版本" value={publicInfo.version} onChange={e => meta({version:e.target.value})}/></label><label>获取方式<select value={publicInfo.access} onChange={e => meta({access:e.target.value === 'coded' ? 'coded':'direct'})}><option value="direct">直接获取</option><option value="coded">凭分享码获取</option></select></label><label>公开概览 · Markdown<textarea aria-label="公开概览" value={publicInfo.overview} rows={8} onChange={e => meta({overview:e.target.value})}/><small className="community-muted">有依赖或需要先运行的技能时，请在介绍中说明。</small></label>{dirty && <InlineNotice title="发布信息尚未保存">下面会将这些修改交给所选 Bot，在本人私聊确认后保存到同一份私人草稿。<Button onClick={() => setChat(true)}>核对并保存修改</Button></InlineNotice>}</section>}
    <RecipeDetails draft recipe={detail}/>
    {chat && <section><h2>本次允许在聊天中修改的内容</h2><p>完整详情保留在上方。只将这里选中的内容交给这次聊天修改。上方已填写的修改会一起保存，勾选范围本身不会修改草稿。</p><div role="group" aria-label="发布信息的聊天修改范围"><h3>发布信息</h3><div className="authoring-source-list">{publicEditable.map(scopeOption)}</div></div>{editable.length>0&&<div role="group" aria-label="群聊配置的聊天修改范围"><h3>群聊配置</h3><div className="authoring-source-list">{editable.map(scopeOption)}</div></div>}<RecipeAuthoringPage onStarted={()=>{submission.current=fingerprint;}} draft={{draftId:draft.draftId,revision:draft.revision,format:'rich-v2',changes,access:publicInfo.access!==draft.public.access?publicInfo.access:undefined,logo:logo?.encoded,selected:[...new Set([...selectedScope,...changes.flatMap(change=>'itemId'in change&&change.itemId?[change.itemId]:[]),...((logo||removeLogo)&&draft.rich.content.finalLogo?[draft.rich.content.finalLogo.itemId]:[])])]}} onSaved={(id,revision) => {if (id === draft.draftId) {void run(() => reload(revision,true));}}}/></section>}
    <Dialog open={Boolean(review)} title="确认发布到社区" size="lg" onClose={busy ? undefined : () => setReview(undefined)} footer={<><Button disabled={busy} onClick={() => setReview(undefined)}>继续编辑</Button><GlowButton variant="dark" disabled={busy || dirty || review?.revision !== draft.revision} onClick={() => void run(async () => {if (!review) return; const result = await shell.request({type:'publishDraft',format:'rich-v2',canonical:review.rich.canonical,accountId,draftId:review.draftId,revision:review.revision,requestId:key('publish')}); if (live.current) onPublished({...result,owned:true,acquired:false,rich:review.rich});})}>发布到社区</GlowButton></>}>{review && <><p>发布后此版本内容固定。请再次核对对外介绍与全部配置。</p><RecipeDetails draft recipe={{...detail,revision:review.revision,public:review.public,rich:review.rich,logo:review.logo}}/></>}{error && <InlineNotice title="发布未完成" tone="warning">{error}</InlineNotice>}</Dialog>
    <Dialog open={deleting} title="删除私人草稿" onClose={busy ? undefined : () => setDeleting(false)} footer={<><Button disabled={busy} onClick={() => setDeleting(false)}>保留</Button><Button disabled={busy} onClick={() => void run(async () => {await shell.request({type:'deleteDraft',accountId,draftId:draft.draftId,revision:draft.revision,requestId:key('delete')}); if (live.current) onBack();})}>删除草稿</Button></>}><p>删除后无法恢复，已发布版本仍保留。</p></Dialog>
  </div>;
}
