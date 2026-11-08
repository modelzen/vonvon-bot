import {useMemo, useState} from 'react';
import QRCode from 'qrcode';
import {ArrowUpRight} from 'lucide-react';
import {useShellCapabilities} from './client-context';
import {allowedExternalUrl,botChatUrl,openExternalUrl} from './url-actions';

/** Both sizes encode exactly the same allowlisted AppLink as the hyperlink. A
 * four-module quiet zone is part of the drawing, even on the holographic face. */
export function BadgeCode({url,name}: {url:string;name:string}) {
  return <QrCode className="badge-code" url={url} label={name+' 的飞书二维码'}/>;
}
/** `quiet`: the white modules around it; the share card's sits on its own white tile. */
export function QrCode({url,label,className,quiet=4}: {url:string;label:string;className?:string;quiet?:number}) {
  const matrix=useMemo(()=>{
    const {modules}=QRCode.create(url,{errorCorrectionLevel:'M'});
    let path='';
    for(let y=0;y<modules.size;y++)for(let x=0;x<modules.size;x++){
      if(!modules.get(y,x))continue;
      const start=x;while(x+1<modules.size&&modules.get(y,x+1))x++;
      const width=x-start+1;path+='M'+(start+quiet)+' '+(y+quiet)+'h'+width+'v1h-'+width+'z';
    }
    return {size:modules.size+2*quiet,path};
  },[url,quiet]);
  return <svg className={className} xmlns="http://www.w3.org/2000/svg" role="img" aria-label={label} viewBox={'0 0 '+matrix.size+' '+matrix.size} shapeRendering="crispEdges"><rect width={matrix.size} height={matrix.size} fill="white"/><path d={matrix.path} fill="#18201c"/></svg>;
}
export function badgeUrl(id:string,tenant:'feishu'|'lark'='feishu'){return allowedExternalUrl(botChatUrl(id,tenant),'bot-chat');}
export function BadgeLink({url,name}:{url:string;name:string}) {
  const shell=useShellCapabilities();
  const [error,setError]=useState('');
  return <><a className="badge-link" href={url} target="_blank" rel="noopener noreferrer" aria-label={'去飞书找我：'+name} onClick={e=>{
    if(shell?.openExternal){e.preventDefault();void openExternalUrl(url,'bot-chat',shell).catch(()=>setError('飞书未能打开，可扫码进入。'));}
  }}>去飞书找我<ArrowUpRight size={12}/></a>{error && <small role="alert">{error}</small>}</>;
}
