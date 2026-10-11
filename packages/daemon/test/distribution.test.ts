import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {it,expect} from 'vitest';
import {classifyDistribution,runtimeDistribution} from '../src/service/distribution';

function fixture(root:string,name:string,bin='bin/vonvon.mjs'):void {
  mkdirSync(join(root,'bin'),{recursive:true});
  mkdirSync(join(root,'dist'),{recursive:true});
  writeFileSync(join(root,'package.json'),JSON.stringify({name,bin:{vonvon:bin}}));
  writeFileSync(join(root,'bin','vonvon.mjs'),'');
  writeFileSync(join(root,'dist','cli.js'),'');
}

it('classifies only exact global and bundled layouts and returns canonical CLI paths',()=>{
  const dir=mkdtempSync(join(tmpdir(),'vonvon-distribution-'));
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

it('recognizes packaged artifacts built inside a source checkout',()=>{
  const dir=mkdtempSync(join(tmpdir(),'vonvon-packaged-checkout-'));
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
  const dir=mkdtempSync(join(tmpdir(),'vonvon-distribution-'));
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
  const dir=mkdtempSync(join(tmpdir(),'vonvon-distribution-'));
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
