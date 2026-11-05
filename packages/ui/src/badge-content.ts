/** Calendar days, inclusive. Stopping or starting a bot does not change when it joined. */
export function badgeTenure(registeredAt:number|undefined,now:number):number|undefined {
  if(registeredAt===undefined || !Number.isFinite(registeredAt) || registeredAt<=0 || registeredAt>now)return undefined;
  const civilDay=(ts:number)=>{const d=new Date(ts);return Date.UTC(d.getFullYear(),d.getMonth(),d.getDate())/86_400_000;};
  return civilDay(now)-civilDay(registeredAt)+1;
}
