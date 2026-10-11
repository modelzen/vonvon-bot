import {useEffect,useState} from 'react';
import type {MachineRequestHandler} from '@vonvon/protocol';
import {settingAnchor} from '../search';
export function LogPanel({request}:{request:MachineRequestHandler}) {
  const [text,setText] = useState(''), [error,setError] = useState(''), [follow,setFollow] = useState(false), [revision,setRevision] = useState(0);
  useEffect(()=>{
    let active = true;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const read = async () => {
      try {const reply = await request({type:'logs'});if(active && reply.type === 'logs') {setText(reply.text);setError('');}}
      catch(e) {if(active) setError(e instanceof Error?e.message:'日志读取失败');}
      if(active && follow) timer = setTimeout(()=>void read(),2000);
    };
    void read();
    return ()=>{active=false;clearTimeout(timer);};
  },[request,follow,revision]);
  return <section id={settingAnchor('daemon 日志')}><h2>daemon 日志</h2><p>最近 128 KB。跟随期间每两秒更新，离开页面即停止。</p><button onClick={()=>setRevision(n=>n+1)}>刷新日志</button><label><input type="checkbox" checked={follow} onChange={e=>setFollow(e.target.checked)}/>持续跟随</label>{error && <p role="alert">{error}</p>}<pre style={{whiteSpace:'pre-wrap',maxHeight:480,overflow:'auto'}}>{text || '暂无日志'}</pre></section>;
}
