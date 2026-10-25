import {RefreshCw} from 'lucide-react';
import {useEffect,useState} from 'react';
import type {MachineRequestHandler} from '@vonvon/protocol';
import {settingAnchor} from '../search';
import {IconButton, InlineNotice, Toggle} from '../reference/components/ui';
import {SettingsGroup} from '../reference/components/system-settings';
import './diagnostics.css';
export function LogPanel({request}:{request:MachineRequestHandler}) {
  const [text,setText] = useState(''), [error,setError] = useState(''), [follow,setFollow] = useState(false), [revision,setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(()=>{
    let active = true;
    let timer:ReturnType<typeof setTimeout>|undefined;
    setLoading(true);
    const read = async () => {
      try {const reply = await request({type:'logs'});if(active && reply.type === 'logs') {setText(reply.text);setError('');}}
      catch(e) {if(active) setError(e instanceof Error?e.message:'日志读取失败');}
      finally {if(active) setLoading(false);}
      if(active && follow) timer = setTimeout(()=>void read(),2000);
    };
    void read();
    return ()=>{active=false;clearTimeout(timer);};
  },[request,follow,revision]);
  return <SettingsGroup id={settingAnchor('daemon 日志')} label="daemon 日志" className="diagnostics-log"
    action={<IconButton size="sm" variant="ghost" label="刷新日志" title="刷新日志" loading={loading} onClick={()=>setRevision(n=>n+1)}><RefreshCw size={15} strokeWidth={1.7} aria-hidden="true"/></IconButton>}
    footer="显示最近 128 KB 日志。">
    <div className="diagnostics-log-toolbar"><span>自动刷新</span><Toggle label="持续跟随" className="settings-row-switch" checked={follow} onChange={e=>setFollow(e.target.checked)}/></div>
    {error && <InlineNotice title="日志读取失败" tone="warning">{error}</InlineNotice>}
    <pre className="diagnostics-log-content" tabIndex={0} aria-label="daemon 日志内容">{text || (loading ? '正在读取日志…' : '暂无日志')}</pre>
  </SettingsGroup>;
}
