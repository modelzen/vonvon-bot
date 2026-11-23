import {randomUUID} from 'node:crypto';
import type {CardActionEvent, NormalizedMessage} from '@larksuiteoapi/node-sdk';
import {recipeAuthoringRequestSchema, type RecipeAuthoringRequest} from '@vonvon/protocol';
import {assertBotIdentity} from '../config/bots';
import {paths} from '../config/paths';
import {isAdmin} from '../config/schema';
import {AuthoringJournal, authoringBotKey, linkKey, sameRecipient} from './authoring-journal';
import {fromMessage, type AuthoringOptions, type AuthoringPeer, type AuthoringSession} from './authoring-service';
import {creatorIntent,creatorClick} from './private-creator';
import {AuthoringIm} from './authoring-im';

export class AuthoringRouter {
  private readonly sessions = new Set<AuthoringSession>();
  private readonly owners = new WeakMap<AuthoringSession,{id:string;creator:boolean}>();
  private readonly opening=new Map<string,Promise<Awaited<ReturnType<AuthoringSession['request']>>>>();
  private readonly idle:AuthoringSession;
  private readonly journal:AuthoringJournal;
  private readonly now:()=>number;
  private readonly botKey:string;
  private readonly im:AuthoringIm;
  private closed=false;
  constructor(private readonly opts:AuthoringOptions,private readonly spawn:()=>AuthoringSession){
    this.now=opts.now??Date.now;
    this.journal=new AuthoringJournal(opts.root??paths.appDir,this.now);
    this.botKey=authoringBotKey(opts.bot);
    this.im=new AuthoringIm(opts.channel);
    this.idle=spawn();
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
      if(existing&&req.type==='creatorOpen'&&existing.presence!.until>this.now()&&this.now()-existing.presence!.activeAt<30*60_000){
        const p=existing.presence!;
        if(p.scope!==req.scope)throw new Error('来源身份已改变。');
        await existing.creator.open(p,req.binding,req.wakeId);
        return {kind:'creatorSession' as const,session:p.session,scope:p.scope,binding:req.binding,leaseMs:45_000};
      }
      if(existing){existing.close();this.sessions.delete(existing);}
      for(const s of this.sessions)if(s.presence&&s.presence.until<=this.now()){s.close();this.sessions.delete(s);}
      if(this.sessions.size>=64)throw new Error('配方连接已满。');
      const former=req.type==='creatorOpen'?[...this.sessions].filter(s=>{
        const p=s.presence;
        return p?.binding&&p.peer.id===peer.id&&p.peer.device===peer.device&&p.scope===req.scope&&p.account===req.accountId&&p.binding!==req.binding;
      }):[];
      const session=this.spawn();
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
      if(msg.chatType==='p2p'&&await this.journal.run(db=>Object.values(db.links).some(l=>l.bot===this.botKey&&l.recipient.chatId===msg.chatId&&
        l.recipient.openId===msg.senderId&&(l.creator?.focusUntil??0)>this.now())))return true;
      return this.idle.onMessage(msg);
    }
    if(/^\/recipe\s+link\b/i.test(text)){
      const code=text.split(/\s+/)[2]??'';
      const session=active.find(s=>s.matchesChallenge(code))??(active.filter(s=>s.hasChallenge).length===1?active.find(s=>s.hasChallenge):undefined);
      return (session??this.idle).onMessage(msg);
    }
    const intent=creatorIntent(text)??(/^\/recipe\s+(?:name|summary|overview|version|access|logo|retry|issue)\b/i.test(text)?'works':undefined);
    const own=await this.journal.run(db=>Object.entries(db.links).filter(([,l])=>l.bot===this.botKey&&sameRecipient(l.recipient,recipient)).map(([key,l])=>({key,binding:l.binding})));
    let links=own;
    if(own.length>1){
      const quoted=msg.replyToMessageId&&await this.journal.run(db=>own.find(l=>
        Object.values(db.links[l.key]?.creator?.cards??{}).some(c=>c.messageId===msg.replyToMessageId)||
        Object.values(db.operations).some(o=>o.binding===l.binding&&o.carrier.messageId===msg.replyToMessageId)||
        Object.values(db.handoffs??{}).some(h=>h.binding===l.binding&&h.messageId===msg.replyToMessageId))?.binding);
      const selection=quoted||await this.journal.run(db=>Object.values(db.links).find(l=>sameRecipient(l.recipient,recipient)&&l.bot===this.botKey&&l.creator?.chosenUntil&&l.creator.chosenUntil>this.now())?.binding);
      links=own.filter(l=>l.binding===selection);
      if(!links.length && intent){
        if(isAdmin(this.opts.cfg,recipient.openId))await this.idle.creator.chooseAccount(own,recipient,msg.messageId,intent);
        return true;
      }
      if(!links.length)return Boolean(intent||/^\/recipe\b/i.test(text)||await this.journal.run(db=>own.some(l=>(db.links[l.key]?.creator?.focusUntil??0)>this.now())));
    }
    const match=active.filter(s=>{const p=s.presence!;return links.some(l=>l.key===linkKey(p.scope,p.account)&&(!p.binding||p.binding===l.binding));});
    const original=match.find(s=>s.creator.enabled)??match[0];
    if(original)return original.onMessage(msg);
    if(intent&&links.length===1&&isAdmin(this.opts.cfg,recipient.openId)){
      await (this.opts.currentBot?.()??assertBotIdentity(this.opts.bot));
      await this.journal.run(db=>{
        const link=db.links[links[0]!.key];
        if(!link||link.binding!==links[0]!.binding||!sameRecipient(link.recipient,recipient)||!isAdmin(this.opts.cfg,recipient.openId))return;
        if(link.wake?.messageId===msg.messageId||link.creator?.seen?.includes(msg.messageId))return;
        link.wake={id:randomUUID(),messageId:msg.messageId,intent,expiresAt:this.now()+5*60_000};
      });
      await this.im.reply(recipient.chatId,msg.messageId,'已保留本次请求。原账号的 Vonvon 连接后会在这里继续。');return true;
    }
    const paused=links.length===1&&await this.journal.run(db=>(db.links[links[0]!.key]?.creator?.focusUntil??0)>this.now());
    if(paused){await this.im.reply(recipient.chatId,msg.messageId,'本次创作已保留，原账号恢复连接后可继续。');return true;}
    return this.idle.onMessage(msg);
  }
  async onAction(evt:CardActionEvent){
    if(this.closed)return;
    const raw=evt.raw as {operator?:{open_id?:string;tenant_key?:string}};
    if(!raw?.operator?.tenant_key||raw.operator.open_id!==evt.operator.openId)return;
    const recipient={openId:evt.operator.openId,tenantKey:raw.operator.tenant_key,chatId:evt.chatId};
    const click=creatorClick.safeParse(evt.action?.value).data;
    if(click?.verb==='creatorAccount'){await this.idle.creator.accountAction(evt,recipient);return;}
    const bindings=await this.journal.run(db=>Object.entries(db.links).filter(([,l])=>l.bot===this.botKey&&sameRecipient(l.recipient,recipient)).map(([key,l])=>({key,binding:l.binding})));
    const sessions=[...this.sessions].filter(s=>{const p=s.presence;return p&&bindings.some(l=>l.key===linkKey(p.scope,p.account)&&(!p.binding||p.binding===l.binding));});
    if(click?.verb==='creator'){
      const epoch=await this.journal.run(db=>bindings.map(l=>db.links[l.key]?.creator?.cards[click.ref]).find(c=>c?.messageId===evt.messageId)?.session);
      const s=sessions.find(s=>s.creator.enabled&&s.presence?.session===epoch);
      if(s)await s.onAction(evt);
      return;
    }
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
