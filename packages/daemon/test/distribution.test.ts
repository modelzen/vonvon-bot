import {existsSync,mkdtempSync,mkdirSync,writeFileSync,realpathSync,rmSync,symlinkSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {it,expect} from 'vitest';
import {classifyDistribution,runtimeDistribution,serviceProgram} from '../src/service/distribution';

function fixture(root:string,name:string,bin='bin/vonvon.mjs'):void {
  mkdirSync(join(root,'bin'),{recursive:true});
  mkdirSync(join(root,'dist'),{recursive:true});
  writeFileSync(join(root,'package.json'),JSON.stringify({name,bin:{vonvon:bin}}));
  writeFileSync(join(root,'bin','vonvon.mjs'),'');
  writeFileSync(join(root,'dist','cli.js'),'');
}

it('classifies only exact global and bundled layouts and returns canonical CLI paths',()=>{
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'vonvon-distribution-')));
  try {
    const globalRoot=join(dir,'node_modules');
    const globalPackage=join(globalRoot,'vonvon-bot');
    fixture(globalPackage,'vonvon-bot');
    expect(classifyDistribution(globalPackage,globalRoot)).toEqual({kind:'global-npm',cliPath:join(globalPackage,'bin','vonvon.mjs')});
    const copied=join(dir,'copy','vonvon-bot');
    fixture(copied,'vonvon-bot');
    expect(classifyDistribution(copied,globalRoot).kind).toBe('unknown');
    const scoped=join(globalRoot,'@vonvon','daemon');
    fixture(scoped,'@vonvon/daemon');
    expect(classifyDistribution(scoped,globalRoot).kind).toBe('unknown');
    const resources=join(dir,'App','resources');
    const bundled=join(resources,'daemon');
    fixture(bundled,'@vonvon/daemon');
    mkdirSync(join(resources,'app.asar','desktop'),{recursive:true});
    writeFileSync(join(resources,'app.asar','package.json'),JSON.stringify({name:'vonvon-bot-desktop',main:'desktop/main.cjs'}));
    writeFileSync(join(resources,'app.asar','desktop','main.cjs'),'');
    expect(classifyDistribution(bundled)).toEqual({kind:'bundled',cliPath:join(bundled,'bin','vonvon.mjs')});
    writeFileSync(join(resources,'app.asar','package.json'),JSON.stringify({name:'foreign-desktop',main:'desktop/main.cjs'}));
    expect(classifyDistribution(bundled).kind).toBe('unknown');
    writeFileSync(join(resources,'app.asar','package.json'),JSON.stringify({name:'vonvon-bot-desktop',main:'other.cjs'}));
    expect(classifyDistribution(bundled).kind).toBe('unknown');
    writeFileSync(join(resources,'app.asar','package.json'),JSON.stringify({name:'vonvon-bot-desktop',main:'desktop/main.cjs'}));
    unlinkSync(join(resources,'app.asar','desktop','main.cjs'));
    expect(classifyDistribution(bundled).kind).toBe('unknown');
  } finally {rmSync(dir,{recursive:true,force:true});}
});

it('keeps a global package layout below a checkout in development',()=>{
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'vonvon-global-checkout-')));
  try {
    writeFileSync(join(dir,'.git'),'gitdir: elsewhere');
    const globalRoot=join(dir,'node_modules');
    const root=join(globalRoot,'vonvon-bot');
    fixture(root,'vonvon-bot');
    expect(classifyDistribution(root,globalRoot)).toEqual({kind:'development',cliPath:join(root,'bin','vonvon.mjs')});
  } finally {rmSync(dir,{recursive:true,force:true});}
});

it('recognizes packaged artifacts built inside a source checkout',()=>{
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'vonvon-packaged-checkout-')));
  try {
    writeFileSync(join(dir,'.git'),'gitdir: elsewhere');
    const resources=join(dir,'dist','App','resources');
    const bundled=join(resources,'daemon');
    fixture(bundled,'@vonvon/daemon');
    mkdirSync(join(resources,'app.asar','desktop'),{recursive:true});
    writeFileSync(join(resources,'app.asar','package.json'),JSON.stringify({name:'vonvon-bot-desktop',main:'desktop/main.cjs'}));
    writeFileSync(join(resources,'app.asar','desktop','main.cjs'),'');
    expect(classifyDistribution(bundled)).toEqual({kind:'bundled',cliPath:join(bundled,'bin','vonvon.mjs')});
  } finally {rmSync(dir,{recursive:true,force:true});}
});

it('rejects malformed, missing, bridge and marker-only installations',()=>{
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'vonvon-distribution-')));
  try {
    const globalRoot=join(dir,'node_modules');
    const root=join(globalRoot,'vonvon-bot');
    fixture(root,'vonvon-bot');
    const manifest=join(root,'package.json');
    writeFileSync(manifest,'{');
    expect(classifyDistribution(root,globalRoot).kind).toBe('unknown');
    writeFileSync(manifest,JSON.stringify({name:'@modelzen/feishu-codex-bridge',bin:{'feishu-codex-bridge':'bin/feishu-codex-bridge.mjs'}}));
    expect(classifyDistribution(root,globalRoot).kind).toBe('unknown');
    writeFileSync(manifest,JSON.stringify({name:'vonvon-bot',bin:{'feishu-codex-bridge':'bin/vonvon.mjs'}}));
    expect(classifyDistribution(root,globalRoot).kind).toBe('unknown');
    writeFileSync(manifest,JSON.stringify({name:'foreign',bin:{vonvon:'bin/vonvon.mjs'}}));
    expect(classifyDistribution(root,globalRoot).kind).toBe('unknown');
    writeFileSync(manifest,JSON.stringify({name:'vonvon-bot',bin:{vonvon:'bin/vonvon.mjs'}}));
    unlinkSync(join(root,'dist','cli.js'));
    expect(classifyDistribution(root,globalRoot).kind).toBe('unknown');
    writeFileSync(join(root,'dist','cli.js'),'');
    unlinkSync(join(root,'bin','vonvon.mjs'));
    expect(classifyDistribution(root,globalRoot).kind).toBe('unknown');
    unlinkSync(manifest);
    expect(classifyDistribution(root,globalRoot).kind).toBe('unknown');
    const legacy=join(dir,'App','runtime','core');
    mkdirSync(legacy,{recursive:true});
    writeFileSync(join(dir,'App','runtime','provenance.json'),'{}');
    expect(classifyDistribution(legacy).kind).toBe('unknown');
  } finally {rmSync(dir,{recursive:true,force:true});}
});

it('keeps source checkouts and symlinked installs in development',()=>{
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'vonvon-distribution-')));
  try {
    for (const marker of ['file','directory']) {
      const repo=join(dir,marker);
      const root=join(repo,'packages','daemon');
      fixture(root,'@vonvon/daemon');
      if (marker==='file') writeFileSync(join(repo,'.git'),'gitdir: elsewhere');
      else mkdirSync(join(repo,'.git'));
      expect(classifyDistribution(root)).toEqual({kind:'development',cliPath:join(root,'bin','vonvon.mjs')});
    }
    const repo=join(dir,'file','packages','daemon');
    writeFileSync(join(repo,'package.json'),JSON.stringify({name:'vonvon-bot',bin:{vonvon:'bin/vonvon.mjs'}}));
    const globalRoot=join(dir,'node_modules');
    mkdirSync(globalRoot);
    const link=join(globalRoot,'vonvon-bot');
    symlinkSync(repo,link,'dir');
    expect(classifyDistribution(link,globalRoot)).toEqual({kind:'development',cliPath:join(repo,'bin','vonvon.mjs')});
    writeFileSync(join(repo,'package.json'),JSON.stringify({name:'@modelzen/feishu-codex-bridge',bin:{vonvon:'bin/vonvon.mjs'}}));
    expect(classifyDistribution(repo).kind).toBe('unknown');
  } finally {rmSync(dir,{recursive:true,force:true});}
});

it('resolves this source module to its nearest daemon package',async()=>{
  const distribution=await runtimeDistribution();
  expect(distribution.kind).toBe('development');
  expect(distribution.cliPath).toBe(join(import.meta.dirname,'..','bin','vonvon.mjs'));
});

/** `<dir>/server/releases/<version>/{app,node,standalone.json}`, as scripts/build-server.mjs packs it and I2 unpacks it. */
function standalone(dir:string, version='0.9.0', marker:unknown={v:1,version,target:'linux-x64',node:'24.22.2'}, release=version):{installRoot:string;app:string} {
  const installRoot=join(dir,'server');
  const app=join(installRoot,'releases',release,'app');
  fixture(app,'@vonvon/daemon');
  writeFileSync(join(app,'package.json'),JSON.stringify({name:'@vonvon/daemon',version,bin:{vonvon:'bin/vonvon.mjs'}}));
  if (marker!==null) writeFileSync(join(installRoot,'releases',release,'standalone.json'),typeof marker==='string' ? marker : JSON.stringify(marker));
  mkdirSync(join(installRoot,'releases',release,'node','bin'),{recursive:true});
  writeFileSync(join(installRoot,'releases',release,'node','bin','node'),'');
  return {installRoot,app};
}

it('recognizes the standalone layout before the checkout test, through the current link too (devices 7.1)',()=>{
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'vonvon-standalone-')));
  try {
    // A home directory kept in git (dotfiles) above the install root.
    writeFileSync(join(dir,'.git'),'gitdir: elsewhere');
    const {installRoot,app}=standalone(dir);
    const expected={kind:'standalone',cliPath:join(app,'bin','vonvon.mjs'),installRoot};
    expect(classifyDistribution(app)).toEqual(expected);
    symlinkSync(join('releases','0.9.0'),join(installRoot,'current'),'dir');
    expect(classifyDistribution(join(installRoot,'current','app'))).toEqual(expected);
    writeFileSync(join(installRoot,'releases','0.9.0','standalone.json'),JSON.stringify({v:1,version:'0.9.0',installRoot,history:{highest:'0.9.0'}}));
    expect(classifyDistribution(app)).toEqual(expected);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

it.each([
  ['a half-unpacked release', (dir:string)=>standalone(dir,'0.9.0',undefined,'0.9.0.part').app],
  ['a version that is not the directory name', (dir:string)=>standalone(dir,'0.9.0',{v:1,version:'0.9.0'},'0.9.1').app],
  ['a marker for another version', (dir:string)=>standalone(dir,'0.9.0',{v:1,version:'0.8.0'}).app],
  ['a missing marker', (dir:string)=>standalone(dir,'0.9.0',null).app],
  ['a malformed marker', (dir:string)=>standalone(dir,'0.9.0','{').app],
  ['a marker of another schema', (dir:string)=>standalone(dir,'0.9.0',{v:2,version:'0.9.0'}).app],
  ['an installRoot that is elsewhere', (dir:string)=>standalone(dir,'0.9.0',{v:1,version:'0.9.0',installRoot:join(dir,'other')}).app],
  ['a release outside releases/', (dir:string)=>{
    const app=join(dir,'loose','0.9.0','app');
    fixture(app,'@vonvon/daemon');
    writeFileSync(join(app,'package.json'),JSON.stringify({name:'@vonvon/daemon',version:'0.9.0',bin:{vonvon:'bin/vonvon.mjs'}}));
    writeFileSync(join(dir,'loose','0.9.0','standalone.json'),JSON.stringify({v:1,version:'0.9.0'}));
    return app;
  }],
])('does not take %s for standalone',(_name,make)=>{
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'vonvon-standalone-')));
  try {
    const app=make(dir);
    if (!existsSync(join(app,'package.json'))) throw new Error('fixture');
    expect(classifyDistribution(app).kind).toBe('unknown');
  } finally {rmSync(dir,{recursive:true,force:true});}
});

it('runs a standalone service through current with its own Node first on PATH (devices 7.2)',()=>{
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'vonvon-standalone-')));
  try {
    const {installRoot}=standalone(dir);
    const distribution={kind:'standalone' as const,cliPath:'/versioned/app/bin/vonvon.mjs',installRoot};
    expect(()=>serviceProgram(distribution,'/usr/bin/node','/usr/bin')).toThrow(/no usable current release/);
    symlinkSync(join('releases','0.9.0'),join(installRoot,'current'),'dir');
    const bin=join(installRoot,'current','node','bin');
    expect(serviceProgram(distribution,'/usr/bin/node',['/usr/bin',bin,'/bin'].join(':'))).toEqual({
      distribution:{kind:'standalone',executable:join(bin,'node'),entry:join(installRoot,'current','app','bin','vonvon.mjs')},
      capturedPath:[bin,'/usr/bin','/bin'].join(':'),
    });
    expect(serviceProgram({kind:'bundled',cliPath:'/r/daemon/bin/vonvon.mjs'},'/r/Electron','/usr/bin')).toEqual({distribution:{kind:'desktop',executable:'/r/Electron',entry:'/r/daemon/bin/vonvon.mjs'},capturedPath:'/usr/bin'});
    expect(serviceProgram({kind:'global-npm',cliPath:'/g/bin/vonvon.mjs'},'/usr/bin/node','/usr/bin').distribution).toEqual({kind:'npm',executable:'/usr/bin/node',entry:'/g/bin/vonvon.mjs'});
    expect(()=>serviceProgram({kind:'development',cliPath:'/src/bin/vonvon.mjs'},'/usr/bin/node','/usr/bin')).toThrow('Distribution cannot install a service');
  } finally {rmSync(dir,{recursive:true,force:true});}
});
