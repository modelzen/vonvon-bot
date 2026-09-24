import type {DesktopSnapshot} from './bridge';
export function watchSnapshots(options:{listen:(receive:(snapshot:DesktopSnapshot)=>void)=>()=>void;initial:()=>Promise<DesktopSnapshot>;listener:(snapshot:DesktopSnapshot)=>void}):()=>void {
  let revision=-1;
  let active=true;
  const receive=(snapshot:DesktopSnapshot)=>{if(active&&snapshot.revision>revision){revision=snapshot.revision;options.listener(snapshot);}};
  const stop=options.listen(receive);
  void options.initial().then(receive);
  return()=>{active=false;stop();};
}
