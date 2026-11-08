import {createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode} from 'react';
import {badgeNumberSchema, MAX_BADGE_NUMBER_LENGTH, type Agent} from '@vonvon/protocol';
import {AgentAvatar} from './AgentAvatar';
import {BadgeName} from './BadgeName';
import {BadgeCode,BadgeLink,badgeUrl} from './BadgeContact';
import './now-badges.css';
import './badge-editions.css';

type BadgeProps = {
  agent: Agent; index: number; groupSummary: string; status: string; tone: 'online' | 'offline';
  ownerName?:string; tenure?:number; showMotion:boolean; children:ReactNode;
  jobNumber?: string; editable: boolean; onJobChange: (value: string) => Promise<string | undefined>;
};

/** Lanyard drafts for the owner to pick from (see now-badges.css); the others go once one is chosen. */
const LANYARD: 'a' | 'b' | 'c' | 'd' = 'a';

type PointerSample = {x:number; t:number; speed:number};
const RackPointer = createContext<{current:PointerSample | undefined} | null>(null);
const clamp = (x:number, max:number) => Math.max(-max,Math.min(max,x));

/** A short pass gives the card angular velocity. The lanyard keeps swinging even
 * when the cursor has crossed the whole card between two animation frames. */
function useHanger(enabled: boolean) {
  const slot = useRef<HTMLDivElement>(null);
  const sample = useContext(RackPointer);
  useEffect(() => {
    const node = slot.current;
    if (!node || !enabled || !matchMedia('(any-hover: hover)').matches) return;
    let frame = 0, last = 0, pos = 0, velocity = 0, target = 0, lastKick = -Infinity, lastDirection = 0;
    function draw(t: number) {
      const dt = Math.min((t-last)/1000,.032); last=t;
      velocity += ((target-pos)*145 - 8.4*velocity)*dt;
      pos = clamp(pos+velocity*dt,18);
      const settled = Math.abs(target - pos) < .012 && Math.abs(velocity) < .05;
      node!.style.setProperty('--swing',(settled ? target : pos).toFixed(3)+'deg');
      frame = settled ? 0 : requestAnimationFrame(draw);
    }
    function start(){if (!frame) {last=performance.now();frame=requestAnimationFrame(draw);}}
    function kick(e:PointerEvent) {
      if (e.pointerType!=='mouse') return;
      const prev=sample?.current;
      const elapsed=prev?e.timeStamp-prev.t:Infinity;
      const speed=prev && elapsed<110 ? elapsed>0 ? (e.clientX-prev.x)/Math.max(4,elapsed) : prev.speed : 0;
      const dir=Math.sign(speed);
      if (Math.abs(speed)>.32 && (e.timeStamp-lastKick>100 || dir!==lastDirection)) {
        velocity=clamp(velocity-clamp(speed,3.2)*56,200);lastKick=e.timeStamp;lastDirection=dir;start();
      }
    }
    function move(e:PointerEvent) {
      if(e.pointerType!=='mouse')return;
      kick(e);
      const r=node!.getBoundingClientRect();
      const x=clamp((e.clientX-r.left)/r.width*2-1,1),y=clamp((e.clientY-r.top)/r.height*2-1,1);
      target=-x*3;node!.style.setProperty('--yaw',(x*5).toFixed(2)+'deg');
      node!.style.setProperty('--pitch',(-y*3).toFixed(2)+'deg');
      node!.style.setProperty('--shine-x',(50+x*42).toFixed(2)+'%');start();
    }
    function leave(e:PointerEvent){kick(e);target=0;node!.style.setProperty('--yaw','0deg');node!.style.setProperty('--pitch','0deg');start();}
    node.addEventListener('pointerenter',kick);node.addEventListener('pointermove',move);node.addEventListener('pointerleave',leave);
    return () => {cancelAnimationFrame(frame);node.removeEventListener('pointerenter',kick);node.removeEventListener('pointermove',move);node.removeEventListener('pointerleave',leave);
      for (const prop of ['--swing','--yaw','--pitch','--shine-x'])node.style.removeProperty(prop);};
  },[enabled,sample]);
  return slot;
}

export function NowBotBadge({agent, index, groupSummary, status, tone, ownerName, tenure, showMotion, jobNumber, editable, onJobChange, children}: BadgeProps) {
  const [back, setBack] = useState(false);
  const [detail,setDetail]=useState<'qr'|'job'>();
  const [draft,setDraft]=useState(''),[issue,setIssue]=useState('');
  const [savingNumber, setSavingNumber] = useState(false);
  const jobInput = useRef<HTMLInputElement>(null);
  const qrClose = useRef<HTMLButtonElement>(null);
  const qrTrigger = useRef<HTMLButtonElement>(null);
  const numberTrigger = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef<'qr' | 'job' | undefined>(undefined);
  const url=badgeUrl(agent.id,agent.tenant);
  const slot = useHanger(showMotion && !detail);
  const frontControl = useRef<HTMLButtonElement>(null), backControl = useRef<HTMLDivElement>(null);
  const moveFocus = useRef(false);
  const touch = useRef(false);
  const listId = 'badge-back-' + agent.id;
  const edition = index % 4;
  function turn(to: boolean) {if (to !== back) {moveFocus.current = true; setBack(to);}}
  useLayoutEffect(() => {if (moveFocus.current) {
    (back ? backControl : frontControl).current?.focus({preventScroll:true}); moveFocus.current = false;
  }}, [back]);
  useLayoutEffect(() => {
    if (detail === 'qr') qrClose.current?.focus({preventScroll: true});
    if (detail === 'job') jobInput.current?.focus({preventScroll: true});
    if (!detail && restoreFocus.current) {
      const trigger = restoreFocus.current === 'qr' ? qrTrigger : numberTrigger;
      trigger.current?.focus({preventScroll: true});
      restoreFocus.current = undefined;
    }
  }, [detail]);

  function closeDetail() {
    if (savingNumber) return;
    restoreFocus.current = detail;
    setDetail(undefined);
  }

  async function saveNumber() {
    if (savingNumber || !editable) return;
    if (!badgeNumberSchema.safeParse(draft).success) {
      setIssue(`请输入 1 至 ${MAX_BADGE_NUMBER_LENGTH} 位数字。`);
      return;
    }
    setSavingNumber(true);
    try {
      const error = await onJobChange(draft);
      if (error) setIssue(error);
      else closeDetail();
    } catch {
      setIssue('工号未能保存，请检查连接后重试。');
    } finally {
      setSavingNumber(false);
    }
  }

  function hoverTurn(to:boolean) {
    if (detail) return;
    // Pointer transfer must never steal focus from another card or page control.
    if (slot.current?.contains(document.activeElement)) moveFocus.current=true;
    setBack(to);
  }
  function keys(e: KeyboardEvent<HTMLDivElement>) {
    if (!e.currentTarget.contains(e.target as Node)) return;
    if (detail) {
      if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
        e.preventDefault();
        closeDetail();
      }
      return;
    }
    if (e.defaultPrevented || (e.target !== frontControl.current && e.target !== backControl.current && e.key !== 'Escape')) return;
    if (e.key === 'ArrowRight' && !back) {e.preventDefault(); turn(true);}
    if ((e.key === 'ArrowLeft' || e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') && back) {e.preventDefault(); turn(false);}
  }
  const identity = (
    <div className="badge-back-id">
      <div className="badge-back-person">
        <AgentAvatar agent={agent}/>
        <strong><BadgeName text={agent.name} active={back && !detail} motion={showMotion}/></strong>
      </div>
      <button type="button" disabled={!editable} ref={numberTrigger} className="badge-job" title={editable ? '修改工号' : undefined} aria-label={agent.name+' 的工号，'+(jobNumber??'未设置')+(editable ? '，可修改' : '')}
        onClick={()=>{setDraft(jobNumber??'');setIssue('');setDetail('job');}}>No. <b>{jobNumber??'—'}</b></button>
      {ownerName && <span className="badge-reports"><span>直属上级</span><BadgeName text={ownerName} active={back && !detail} motion={showMotion}/></span>}
    </div>
  );
  const groupList = (
    <div className="badge-groups-scroll" role="region" tabIndex={0} aria-label={agent.name+' 所在群，可上下滚动'}>
      <ul className="badge-groups">{children}</ul>
    </div>
  );
  return <div ref={slot} className="badge-slot" data-hanger={edition} data-detail={detail} data-back={back || undefined} onKeyDown={keys}
    onPointerDownCapture={e=>{touch.current=e.pointerType!=='mouse';}}
    onPointerEnter={e=>{if(e.pointerType==='mouse' && matchMedia('(any-hover: hover)').matches) hoverTurn(true);}}
    onPointerLeave={e=>{if(e.pointerType==='mouse') hoverTurn(false);}}>
    <div className="badge-hanger">
      <span className="badge-lanyard" aria-hidden="true"><span className="badge-strands">
        <span className="badge-strand"><i/><i><b>more than a bot · Vonvon</b></i></span>
        <span className="badge-strand"><i/><i><b>Vonvon · more than a bot</b></i></span>
      </span></span>
      <span className="badge-clasp" aria-hidden="true"/>
      <div className="badge-perspective"><div className="badge-tilt"><div className="badge-flipper">
        <button ref={frontControl} type="button" className="badge-face badge-front" inert={back} aria-expanded={back} aria-controls={listId}
          aria-label={[agent.name,jobNumber && 'No. '+jobNumber,status,groupSummary,tenure&&'在职第 '+tenure+' 天','翻面查看详情'].filter(Boolean).join('，')} onClick={() => turn(true)}>
          <span className="badge-name"><BadgeName text={agent.name} active={!back} motion={showMotion}/></span>
          <span className="badge-front-job">No. <b>{jobNumber??'—'}</b></span>
          <span className="badge-status" data-tone={tone}><i/><span>{status}</span></span>
          <span className="badge-photo"><AgentAvatar agent={agent}/></span>
          <span className="badge-foot">
            <span>在职 {tenure ?? '—'} 天</span>
            <span>{groupSummary}</span>
          </span>
        </button>
        <div className="badge-face badge-back" id={listId} ref={backControl} role="group" aria-label={agent.name+'的工牌背面'} tabIndex={-1} inert={!back}
          onClick={e=>{if(!detail && touch.current && !(e.target as Element).closest('button,a,summary,.badge-groups-scroll'))turn(false);}}>
          <div className="badge-directory" hidden={Boolean(detail)}>
            {identity}
            {groupList}
            {url && <div className="badge-contact"><BadgeLink url={url} name={agent.name}/><button type="button" ref={qrTrigger} className="badge-qr-thumb" aria-label={'放大 '+agent.name+' 的飞书二维码'} onClick={()=>setDetail('qr')}><BadgeCode url={url} name={agent.name}/></button></div>}
          </div>
          {detail === 'qr' && url && (
            <div className="badge-panel badge-scan" role="group" aria-label={agent.name + ' 的扫码卡'}>
              <header><strong><BadgeName text={agent.name} active={back} motion={showMotion}/></strong></header>
              <button className="badge-scan-code" type="button" ref={qrClose} onClick={closeDetail} aria-label={'收起 '+agent.name+' 的飞书二维码'}>
                <BadgeCode url={url} name={agent.name}/>
              </button>
              <footer><BadgeLink url={url} name={agent.name}/></footer>
            </div>
          )}
          {detail === 'job' && (
            <form className="badge-panel badge-number-editor" aria-label={'修改 ' + agent.name + ' 的工号'}
              onSubmit={event => {event.preventDefault(); void saveNumber();}}>
              <header><strong><BadgeName text={agent.name} active={back} motion={showMotion}/></strong></header>
              <div className="badge-number-field">
                <label htmlFor={listId + '-number'}>No.</label>
                <input id={listId + '-number'} ref={jobInput} aria-label="No." inputMode="numeric" maxLength={MAX_BADGE_NUMBER_LENGTH} disabled={savingNumber}
                  value={draft} autoComplete="off" spellCheck={false} aria-invalid={Boolean(issue)}
                  aria-describedby={issue ? listId + '-error' : undefined}
                  onFocus={event => event.currentTarget.select()}
                  onChange={event => {
                    setDraft(event.target.value.slice(0, MAX_BADGE_NUMBER_LENGTH));
                    setIssue('');
                  }}/>
                {issue && <small id={listId + '-error'} role="alert">{issue}</small>}
              </div>
              <footer><button type="button" disabled={savingNumber} onClick={closeDetail}>取消</button><button type="submit" disabled={!editable || savingNumber}>{savingNumber ? '保存中…' : '保存'}</button></footer>
            </form>
          )}
        </div>
      </div></div></div>
    </div>
  </div>;
}

/** Four across at the usual desktop width; on a phone the next badge peeks in.
 * Native scrolling (and focus scrolling) also handles arbitrarily long rosters. */
export function BadgeRack({children}: {children: ReactNode}) {
  const rail = useRef<HTMLDivElement>(null);
  const sample = useRef<PointerSample | undefined>(undefined);
  useEffect(()=>{
    function track(e:PointerEvent){if(e.pointerType!=='mouse')return;
      const prev=sample.current,dt=prev?e.timeStamp-prev.t:Infinity;
      sample.current={x:e.clientX,t:e.timeStamp,speed:prev && dt<110?(e.clientX-prev.x)/Math.max(4,dt):0};}
    document.addEventListener('pointermove',track,{passive:true,capture:true});
    return ()=>document.removeEventListener('pointermove',track,true);
  },[]);
  function step(direction: number){const n=rail.current;if (!n) return;
    const cards=n.querySelectorAll<HTMLElement>('.badge-slot');
    const spacing=cards.length>1?cards[1]!.offsetLeft-cards[0]!.offsetLeft:n.clientWidth;
    n.scrollBy({left:direction*spacing,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});}
  return <div className="badge-board" data-lanyard={LANYARD}>
    <div className="badge-rail" ref={rail} role="region" tabIndex={0} aria-label="Bot 工牌，可横向滚动"
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
          event.preventDefault();
          step(event.key === 'ArrowRight' ? 1 : -1);
        }
      }}>
      <div className="badge-track">
        <RackPointer.Provider value={sample}>{children}</RackPointer.Provider>
      </div>
    </div>
  </div>;
}
