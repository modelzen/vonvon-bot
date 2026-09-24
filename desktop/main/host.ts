export type HostRefusal = {kind:'blocked';reason:string;message:string};
export interface HostHandle {
  kind:'connected'; ownership:'owned'|'attached'; readonly pid:number;
  request(path:string, init?:RequestInit):Promise<Response>;
  restart():Promise<void>; close():Promise<void>;
}
export interface HostRuntime {home:string;nodePath:string;cliPath:string}
export interface HostModule {
  inspectHost(home:string):Promise<{kind:'absent'}|{kind:'attached';pid:number}|HostRefusal>;
  connectHost(options:HostRuntime):Promise<HostHandle|HostRefusal>;
  migrateHostDataOffline(home:string,runtime:Pick<HostRuntime,'nodePath'|'cliPath'>):Promise<{kind:'unchanged';path:string}|{kind:'linked';canonicalPath:string;legacyPath:string}|{kind:'deferred'|'recovery-required';message:string}>;
}
export async function acquireHost(module:HostModule, runtime:HostRuntime):Promise<HostHandle|HostRefusal> {
  const inspection = await module.inspectHost(runtime.home);
  if (inspection.kind === 'blocked') return inspection;
  if (inspection.kind === 'absent') {
    const migration = await module.migrateHostDataOffline(runtime.home, runtime);
    if (migration.kind === 'recovery-required') return {kind:'blocked',reason:'migration-pending',message:migration.message};
  }
  return module.connectHost(runtime);
}
