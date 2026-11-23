import {randomUUID} from 'node:crypto';
import type {CardActionEvent, NormalizedMessage} from '@larksuiteoapi/node-sdk';
import {recipeAuthoringRequestSchema, type RecipeAuthoringRequest} from '@vonvon/protocol';
import {assertBotIdentity} from '../config/bots';
import {paths} from '../config/paths';
import {isAdmin} from '../config/schema';
import {AuthoringJournal, authoringBotKey, linkKey, matchesAuthoringRoute, sameRecipient, type AuthoringRoute} from './authoring-journal';
import {fromMessage, type AuthoringOptions, type AuthoringPeer, type AuthoringSession, type Presence} from './authoring-service';
import {creatorIntent,creatorClick} from './private-creator';
import {ResourceContext} from './resource-context';
import {AuthoringIm} from './authoring-im';
import {draftIntent} from './draft-instruction';

export class AuthoringRouter {
  private readonly sessions = new Set<AuthoringSession>();
  private readonly owners = new WeakMap<AuthoringSession,{id:string;creator:boolean}>();
  private readonly opening=new Map<string,Promise<Awaited<ReturnType<AuthoringSession['request']>>>>();
  private readonly idle:AuthoringSession;
  private readonly journal:AuthoringJournal;
  private readonly now:()=>number;
  private readonly botKey:string;
  private readonly im:AuthoringIm;
  readonly resources:ResourceContext;
  private closed=false;
  constructor(private readonly opts:AuthoringOptions,private readonly spawn:(canRefreshPreview:(p:Presence,delivery:string)=>boolean)=>AuthoringSession){
    this.now=opts.now??Date.now;
    this.journal=new AuthoringJournal(opts.root??paths.appDir,this.now);
    this.botKey=authoringBotKey(opts.bot);
    this.im=new AuthoringIm(opts.channel);
    this.resources=new ResourceContext(opts,this.journal,this.now,()=>[...this.sessions].flatMap(s=>s.presence?[s.presence]:[]),()=>opts.currentBot?.()??assertBotIdentity(opts.bot));
    this.idle=spawn(this.canRefreshPreview);
  }
  async request(peer:AuthoringPeer,input:RecipeAuthoringRequest):Promise<Awaited<ReturnType<AuthoringSession['request']>>>{
    const req=recipeAuthoringRequestSchema.parse(input);
    if(req.botId!==this.opts.bot.appId||this.closed)throw new Error('来源连接已结束。');
    if(req.type==='creatorDiscover')return this.idle.request(peer,req);
    if(req.type==='open'||req.type==='creatorOpen'){
      const key=JSON.stringify([peer.id,peer.device,req.type,req.accountId,req.type==='creatorOpen'?req.binding:null]);
      const pending=this.opening.get(key);
      if(pending){await pending;return this.request(peer,input);}
      const existing=[...this.sessions].find(s=>s.presence?.peer.id===peer.id && s.presence.peer.device===peer.device &&
        (req.type==='open'||s.presence.account===req.accountId&&s.presence.binding===req.binding) && this.owners.get(s)?.creator===(req.type==='creatorOpen'));
      if(existing&&req.type==='creatorOpen'&&existing.presence!.nativePreview===req.nativePreview&&existing.presence!.resourceContext===req.resourceContext&&existing.presence!.until>this.now()&&this.now()-existing.presence!.activeAt<30*60_000){
        const p=existing.presence!;
        if(p.scope!==req.scope)throw new Error('来源身份已改变。');
        await existing.creator.open(p,req.binding,req.wakeId);
        return {kind:'creatorSession' as const,session:p.session,scope:p.scope,binding:req.binding,leaseMs:45_000,...(p.resourceContext&&{resourceContext:true as const})};
      }
      if(existing){existing.close();this.sessions.delete(existing);}
      for(const s of this.sessions)if(s.presence&&s.presence.until<=this.now()){s.close();this.sessions.delete(s);}
      if(this.sessions.size>=64)throw new Error('配方连接已满。');
      const former=req.type==='creatorOpen'?[...this.sessions].filter(s=>{
        const p=s.presence;
        return p?.binding&&p.peer.id===peer.id&&p.peer.device===peer.device&&p.scope===req.scope&&p.account===req.accountId&&p.binding!==req.binding;
      }):[];
      const session=this.spawn(this.canRefreshPreview);
      this.sessions.add(session);this.owners.set(session,{id:peer.id,creator:req.type==='creatorOpen'});
      const opening=session.request(peer,req);
      this.opening.set(key,opening);
      try{
        const reply=await opening;
        for(const old of former){old.close();this.sessions.delete(old);}
        return reply;
      }
      catch(error){this.sessions.delete(session);session.close();throw error;}
      finally{if(this.opening.get(key)===opening)this.opening.delete(key);}
    }
    const session=[...this.sessions].find(s=>s.presence?.peer.id===peer.id&&s.presence.peer.device===peer.device&&s.presence.session===req.session);
    if(!session){
      if(req.type==='close')return {kind:'closed' as const};
      throw new Error('身份、来源或草稿上下文已改变，请重新连接。');
    }
    const p=session.presence!;
    if(req.type==='resourceHandoff'){
      if(!p.resourceContext)throw new Error('此设备尚不支持配方资源交付。');
      return this.resources.handoff(p,req.requestId,req.target);
    }
    if(p.resourceContext){
      if(req.type==='creatorCheck'){
        const checked=await this.resources.check(p,req.id);if(checked)return checked;
      }
      if(req.type==='creatorAnswer'&&await this.resources.answer(p,req.id,req.answer))return {kind:'creatorAck'};
      if(req.type==='creatorPoll'){
        const author=await session.request(peer,req);
        if(author.kind!=='creatorJobs')throw new Error('配方请求无效。');
        const jobs=await this.resources.poll(p);
        return {kind:'creatorJobs',jobs:[...jobs,...author.jobs].slice(0,16)};
      }
    }
    if(req.type==='close')this.sessions.delete(session);
    return session.request(peer,req);
  }
  disconnect(id:string){
    for(const session of this.sessions)if(this.owners.get(session)?.id===id){session.disconnect(id);session.close();this.sessions.delete(session);}
  }
  close(){this.closed=true;for(const session of this.sessions)session.close();this.sessions.clear();this.idle.close();}
  async adminRemoved(id:string){
    const links=await this.journal.run(db=>Object.entries(db.links).filter(([,l])=>l.bot===this.botKey&&l.recipient.openId===id).map(([k])=>k));
    for(const s of this.sessions){
      const p=s.presence;
      s.clearAdminContext(id,Boolean(p&&links.includes(linkKey(p.scope,p.account))));
    }
    await this.idle.revokeAdminLinks(id);
  }
  async onMessage(msg:NormalizedMessage):Promise<boolean>{
    if(this.closed)return true;
    const recipient=fromMessage(msg), text=msg.content.trim();
    const active=[...this.sessions].filter(s=>s.presence&&s.presence.until>this.now()&&this.now()-s.presence.activeAt<30*60_000);
    if(!recipient){
      if(this.resources.hasTrigger(msg.messageId))return true;
      if(msg.chatType==='p2p'&&await this.journal.run(db=>Object.values(db.links).some(l=>l.bot===this.botKey&&l.recipient.chatId===msg.chatId&&
        l.recipient.openId===msg.senderId&&((l.creator?.focusUntil??0)>this.now()||Object.values(db.operations).some(o=>o.bot===l.bot&&sameRecipient(o.recipient,l.recipient)&&o.contextOpen)||
        Object.values(db.handoffs??{}).some(h=>h.binding===l.binding&&sameRecipient(h.recipient,l.recipient)&&['selecting','awaitingAttestations'].includes(h.phase.state))))))return true;
      return this.idle.onMessage(msg);
    }
    if(/^\/recipe\s+link\b/i.test(text)){
      const code=text.split(/\s+/)[2]??'';
      const session=active.find(s=>s.matchesChallenge(code))??(active.filter(s=>s.hasChallenge).length===1?active.find(s=>s.hasChallenge):undefined);
      return (session??this.idle).onMessage(msg);
    }
    const intent=creatorIntent(text)??(/^\/recipe\s+(?:name|summary|overview|version|access|logo|retry|issue)\b/i.test(text)?'works':undefined);
    const resource=await this.resources.route(msg,recipient,Boolean(intent||text.startsWith('/recipe ')));
    if(resource==='resource')return false;
    if(resource==='duplicate')return true;
    if(resource==='refuse'){
      await this.im.reply(recipient.chatId,msg.messageId,'本次配方资料尚未就绪，请在 App 核对原请求。');return true;
    }
    const snapshot=await this.journal.run(db=>{
      const now=this.now(),rows=Object.entries(db.links).filter(([,l])=>l.bot===this.botKey&&sameRecipient(l.recipient,recipient));
      const own=rows.map(([key,l])=>({key,binding:l.binding}));
      const operations=Object.values(db.operations).filter(o=>o.bot===this.botKey&&sameRecipient(o.recipient,recipient));
      if(operations.some(o=>o.instructionId===msg.messageId||o.seenInstructions?.includes(msg.messageId))||
        rows.some(([,l])=>l.wake?.messageId===msg.messageId||l.creator?.seen?.includes(msg.messageId)))return;
      const history=Object.values(db.handoffs??{}).filter(h=>sameRecipient(h.recipient,recipient)&&db.links[linkKey(h.scope,h.account)]?.bot===this.botKey);
      const handoffs=history.filter(h=>db.links[linkKey(h.scope,h.account)]?.binding===h.binding);
      const quoted=msg.replyToMessageId?rows.filter(([key,l])=>
        Object.values(l.creator?.cards??{}).some(c=>c.messageId===msg.replyToMessageId)||
        operations.some(o=>linkKey(o.scope,o.accountId)===key&&o.binding===l.binding&&o.carrier.messageId===msg.replyToMessageId)||
        handoffs.some(h=>linkKey(h.scope,h.account)===key&&h.binding===l.binding&&h.messageId===msg.replyToMessageId)):[];
      const chosen=rows.filter(([,l])=>(l.creator?.chosenUntil??0)>now);
      const context=operations.some(o=>o.contextOpen&&!o.revoked&&(o.terminalAt===undefined||o.view.state==='completed'&&(o.contextUntil??0)>now))||
        handoffs.some(h=>['selecting','awaitingAttestations'].includes(h.phase.state))||rows.some(([,l])=>(l.creator?.focusUntil??0)>now);
      const knownQuote=Boolean(msg.replyToMessageId&&(quoted.length||operations.some(o=>o.carrier.messageId===msg.replyToMessageId)||history.some(h=>h.messageId===msg.replyToMessageId)));
      const incomplete=Object.values(db.links).some(l=>l.bot===this.botKey&&l.recipient.openId===recipient.openId&&l.recipient.chatId===recipient.chatId&&!sameRecipient(l.recipient,recipient));
      const foreignQuote=Boolean(msg.replyToMessageId&&(Object.values(db.operations).some(o=>o.bot===this.botKey&&o.carrier.messageId===msg.replyToMessageId&&!sameRecipient(o.recipient,recipient))||
        Object.values(db.links).some(l=>l.bot===this.botKey&&!sameRecipient(l.recipient,recipient)&&Object.values(l.creator?.cards??{}).some(c=>c.messageId===msg.replyToMessageId))||
        Object.values(db.handoffs??{}).some(h=>db.links[linkKey(h.scope,h.account)]?.bot===this.botKey&&h.messageId===msg.replyToMessageId&&!sameRecipient(h.recipient,recipient))));
      const target=msg.replyToMessageId?quoted.length===1?quoted[0]:undefined:chosen.length===1?chosen[0]:!context&&(intent||draftIntent(text))&&rows.length===1?rows[0]:undefined;
      let route:AuthoringRoute|undefined;
      if(target){
        const address={key:target[0],binding:target[1].binding},until=target[1].creator?.chosenUntil;
        route=msg.replyToMessageId?{...address,kind:'quoted'}:chosen.length===1&&until!==undefined?{...address,kind:'chosen',chosenUntil:until}:{...address,kind:'intent'};
      }
      const handoffSession=msg.replyToMessageId&&handoffs.find(h=>h.messageId===msg.replyToMessageId&&['selecting','awaitingAttestations'].includes(h.phase.state))?.session;
      return {own,context,knownQuote,handoffSession,incomplete:incomplete||foreignQuote,route,ambiguous:chosen.length>1};
    });
    if(!snapshot)return true;
    const {own,route}=snapshot;
    const recover=async()=>{await this.im.reply(recipient.chatId,msg.messageId,'请引用原配方卡，或发送“我的配方”重新选择账号后重发本条修改。');return true;};
    if(snapshot.incomplete)return true;
    if(!route){
      if(!msg.replyToMessageId&&intent&&own.length&&isAdmin(this.opts.cfg,recipient.openId)){
        await this.idle.creator.chooseAccount(own,recipient,msg.messageId,intent);return true;
      }
      if(snapshot.context||snapshot.knownQuote||snapshot.ambiguous)return recover();
      return this.idle.onMessage(msg);
    }
    const links=own.filter(l=>l.key===route.key&&l.binding===route.binding);
    const match=active.filter(s=>{const p=s.presence!;return links.some(l=>l.key===linkKey(p.scope,p.account)&&(!p.binding||p.binding===l.binding));});
    const original=snapshot.handoffSession?match.find(s=>s.presence?.session===snapshot.handoffSession):match.find(s=>s.creator.enabled)??match[0];
    if(original){
      if(await original.onMessage(msg,route))return true;
      if(snapshot.context||snapshot.knownQuote||route.kind==='chosen')return recover();
      return false;
    }
    if(intent&&route.kind!=='quoted'&&links.length===1&&isAdmin(this.opts.cfg,recipient.openId)){
      await (this.opts.currentBot?.()??assertBotIdentity(this.opts.bot));
      const retained=await this.journal.run(db=>{
        const link=db.links[route.key];
        if(!link||link.bot!==this.botKey||!sameRecipient(link.recipient,recipient)||!isAdmin(this.opts.cfg,recipient.openId)||!matchesAuthoringRoute(db,link,route,this.now()))return false;
        if(link.wake?.messageId===msg.messageId||link.creator?.seen?.includes(msg.messageId))return true;
        link.wake={id:randomUUID(),messageId:msg.messageId,intent,expiresAt:this.now()+5*60_000};
        return true;
      });
      if(!retained)return recover();
      await this.im.reply(recipient.chatId,msg.messageId,'已保留本次请求。原账号的 Vonvon 连接后会在这里继续。');return true;
    }
    if(snapshot.context||snapshot.knownQuote||route.kind==='chosen')return recover();
    return this.idle.onMessage(msg);
  }
  private linkedCreators(key:string,binding:string){
    return [...this.sessions].filter(s=>{
      const p=s.presence;
      return s.creator.enabled&&p?.binding===binding&&p.until>this.now()&&this.now()-p.activeAt<30*60_000&&linkKey(p.scope,p.account)===key;
    });
  }
  private readonly canRefreshPreview=(p:Presence,delivery:string)=>{
    if(!p.nativePreview||!p.binding||delivery===p.session)return false;
    const linked=this.linkedCreators(linkKey(p.scope,p.account),p.binding);
    const supported=linked.filter(s=>s.presence?.nativePreview);
    return !linked.some(s=>s.presence?.session===delivery)&&supported.length===1&&supported[0]?.presence===p;
  };
  async onAction(evt:CardActionEvent){
    if(this.closed)return;
    const raw=evt.raw as {operator?:{open_id?:string;tenant_key?:string}};
    if(!raw?.operator?.tenant_key||raw.operator.open_id!==evt.operator.openId)return;
    const recipient={openId:evt.operator.openId,tenantKey:raw.operator.tenant_key,chatId:evt.chatId};
    const click=creatorClick.safeParse(evt.action?.value).data;
    if(click?.verb==='creatorAccount'){await this.idle.creator.accountAction(evt,recipient);return;}
    const bindings=await this.journal.run(db=>Object.entries(db.links).filter(([,l])=>l.bot===this.botKey&&sameRecipient(l.recipient,recipient)).map(([key,l])=>({key,binding:l.binding})));
    if(click?.verb==='creator'){
      const route=await this.journal.run(db=>bindings.flatMap(l=>{
        const card=db.links[l.key]?.creator?.cards[click.ref],choice=card?.options[click.index]?.choice;
        return card?.messageId===evt.messageId?[{...l,session:card.session,preview:choice?.kind==='read'&&choice.read.kind==='openPreview'}]:[];
      })[0]);
      if(!route)return;
      const linked=this.linkedCreators(route.key,route.binding);
      const original=linked.find(s=>s.presence?.session===route.session);
      if(original&&(!route.preview||original.presence?.nativePreview)){await original.onAction(evt);return;}
      if(!route.preview)return;
      const restored=linked.filter(s=>s.presence?.nativePreview);
      if(restored.length===1)await restored[0]!.onAction(evt,route.session);
      else await this.idle.creator.offlinePreview(evt,linked.length>0);
      return;
    }
    const sessions=[...this.sessions].filter(s=>{const p=s.presence;return p&&bindings.some(l=>l.key===linkKey(p.scope,p.account)&&(!p.binding||p.binding===l.binding));});
    if(sessions.length>1){
      const route=await this.journal.run(db=>{
        const v=evt.action?.value;
        const ref=v&&typeof v==='object'&&'ref'in v?v.ref:undefined;
        const op=Object.values(db.operations).find(r=>r.bot===this.botKey&&sameRecipient(r.recipient,recipient)&&r.carrier.ref===ref);
        if(op)return {key:linkKey(op.scope,op.accountId),session:undefined};
        const h=Object.values(db.handoffs??{}).find(r=>sameRecipient(r.recipient,recipient)&&r.ref===ref);
        return h&&{key:linkKey(h.scope,h.account),session:h.session};
      });
      const candidates=sessions.filter(s=>s.presence&&linkKey(s.presence.scope,s.presence.account)===route?.key&&(!route?.session||s.presence.session===route.session));
      const v=evt.action?.value;
      const menu=v&&typeof v==='object'&&'ref'in v?sessions.find(s=>s.ownsLegacyMenu(v.ref)):undefined;
      await (menu??candidates.find(s=>s.creator.enabled)??candidates[0])?.onAction(evt);return;
    }
    await (sessions[0]??this.idle).onAction(evt);
  }
}
