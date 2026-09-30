import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,symlink,writeFile,lstat,rm,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {registerCli,removeCli} from '../desktop/main/cli-registration';

async function fixture() {
  const root=await mkdtemp(join(tmpdir(),"vonvon cli %&()' "));
  const home=join(root,'home');
  await mkdir(home);
  const runtime=join(root,'Vonvon Bot.app','Contents','Resources','runtime');
  await mkdir(join(runtime,'node','bin'),{recursive:true});
  await mkdir(join(runtime,'node','lib','node_modules','npm','bin'),{recursive:true});
  await mkdir(join(runtime,'core','bin'),{recursive:true});
  await symlink(process.execPath,join(runtime,'node','bin','node'));
  await writeFile(join(runtime,'node','lib','node_modules','npm','bin','npm-cli.js'),'');
  await writeFile(join(runtime,'core','bin','feishu-codex-bridge.mjs'),"process.stdout.write(JSON.stringify({args:process.argv.slice(2),npm:process.env.VONVON_NPM_CLI,path:process.env.PATH?.split(':')[0]}))");
  return {root,home,runtime};
}

test('macOS registration runs the new command and legacy aliases through bundled Node',{skip:process.platform!=='darwin'},async t=>{
  const {root,home,runtime}=await fixture();
  t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(join(home,'.zshrc'),'export ORIGINAL=yes');
  const options={platform:'darwin' as const,scope:'user' as const,home,runtime,zdotdir:home};
  const first=await registerCli(options);
  assert.equal(first.kind,'ready');
  const second=await registerCli(options);
  assert.equal(second.kind,'ready');
  const rc=await readFile(join(home,'.zshrc'),'utf8');
  assert.equal(rc.match(/>>> Vonvon Bridge CLI/g)?.length,1);
  assert.match(rc,/export ORIGINAL=yes\n#/);
  const bin=join(home,'.local','share','vonvon-bridge','bin');
  const zsh=execFileSync('/bin/zsh',['-c','source "$ZDOTDIR/.zshrc"; source "$ZDOTDIR/.zshrc"; command -v vonvon-bot; echo "$PATH"'],{encoding:'utf8',env:{...process.env,HOME:home,ZDOTDIR:home,PATH:`/usr/bin:/bin`}}).trim().split('\n');
  assert.equal(zsh[0],join(bin,'vonvon-bot'));
  assert.equal(zsh[1]?.split(':').filter(path=>path===bin).length,1);
  const login=execFileSync('/bin/zsh',['-lc','command -v vonvon-bot'],{encoding:'utf8',env:{...process.env,HOME:home,ZDOTDIR:home,PATH:'/usr/bin:/bin'}}).trim();
  assert.equal(login,join(bin,'vonvon-bot'));
  for(const name of ['vonvon-bot','vonvon-bridge','feishu-codex-bridge']) {
    const output=execFileSync(join(bin,name),['alpha beta',"'&()%"],{encoding:'utf8'});
    const parsed=JSON.parse(output);
    assert.deepEqual(parsed.args,['alpha beta',"'&()%"]);
    assert.equal(parsed.npm,join(runtime,'node','lib','node_modules','npm','bin','npm-cli.js'));
    assert.equal(parsed.path,join(runtime,'node','bin'));
  }
  const removed=await removeCli(options);
  assert.equal(removed.kind,'ready');
  assert.equal(await readFile(join(home,'.zshrc'),'utf8'),'export ORIGINAL=yes\n');
});

test('registration refuses a foreign file and a foreign symlink',{skip:process.platform!=='darwin'},async t=>{
  const {home,runtime,root}=await fixture();
  t.after(()=>rm(root,{recursive:true,force:true}));
  const bin=join(home,'.local','share','vonvon-bridge','bin');
  await mkdir(bin,{recursive:true});
  const foreign=join(root,'foreign');
  await writeFile(foreign,'keep');
  await symlink(foreign,join(bin,'vonvon-bridge'));
  const result=await registerCli({platform:'darwin',scope:'user',home,runtime,zdotdir:home});
  assert.equal(result.kind,'error');
  assert.equal((await lstat(join(bin,'vonvon-bridge'))).isSymbolicLink(),true);
  assert.equal(await readFile(foreign,'utf8'),'keep');
});

test('system registration creates one path entry and converges',{skip:process.platform!=='darwin'},async t=>{
  const {runtime,root}=await fixture();
  t.after(()=>rm(root,{recursive:true,force:true}));
  const systemRoot=join(root,'system');
  const options={platform:'darwin' as const,scope:'system' as const,runtime,systemRoot};
  assert.equal((await registerCli(options)).kind,'ready');
  assert.equal((await registerCli(options)).kind,'ready');
  assert.equal(await readFile(join(systemRoot,'etc','paths.d','vonvon-bridge'),'utf8'),`${join(systemRoot,'usr','local','lib','vonvon-bridge','bin')}\n`);
  assert.equal((await removeCli(options)).kind,'ready');
});

test('older app uninstall preserves registration repaired by a moved app',{skip:process.platform!=='darwin'},async t=>{
  const a=await fixture();
  t.after(()=>rm(a.root,{recursive:true,force:true}));
  const b=join(a.root,'moved','runtime');
  await mkdir(join(b,'node','bin'),{recursive:true});
  await mkdir(join(b,'node','lib','node_modules','npm','bin'),{recursive:true});
  await mkdir(join(b,'core','bin'),{recursive:true});
  await symlink(process.execPath,join(b,'node','bin','node'));
  await writeFile(join(b,'node','lib','node_modules','npm','bin','npm-cli.js'),'');
  await writeFile(join(b,'core','bin','feishu-codex-bridge.mjs'),'process.stdout.write("moved")');
  const old={platform:'darwin' as const,scope:'user' as const,home:a.home,runtime:a.runtime,zdotdir:a.home};
  assert.equal((await registerCli(old)).kind,'ready');
  assert.equal((await registerCli({...old,runtime:b})).kind,'ready');
  assert.equal((await removeCli(old)).kind,'ready');
  assert.equal(execFileSync(join(a.home,'.local','share','vonvon-bridge','bin','vonvon-bot'),{encoding:'utf8'}),'moved');
});

test('Windows registration preserves raw user PATH type and foreign entries',async t=>{
  const root=await mkdtemp(join(tmpdir(),'vonvon-win-%&()'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const runtime=join(root,'Vonvon Bot','resources','runtime');
  const localAppData=join(root,'Local AppData');
  await mkdir(join(runtime,'node','node_modules','npm','bin'),{recursive:true});
  await mkdir(join(runtime,'core','bin'),{recursive:true});
  await writeFile(join(runtime,'node','node.exe'),'');
  await writeFile(join(runtime,'node','node_modules','npm','bin','npm-cli.js'),'');
  await writeFile(join(runtime,'core','bin','feishu-codex-bridge.mjs'),'');
  const bin=join(localAppData,'Vonvon Bridge','bin');
  let value=`C:\\Legacy\\bin;${bin};C:\\Other`;
  const types:string[]=[];
  const windowsPath={read:async()=>({value,type:'REG_EXPAND_SZ' as const}),write:async(next:string,type:string)=>{value=next;types.push(type);}};
  const options={platform:'win32' as const,scope:'user' as const,runtime,localAppData,windowsPath};
  assert.equal((await registerCli(options)).kind,'ready');
  assert.equal(value,`${bin};C:\\Legacy\\bin;C:\\Other`);
  assert.equal((await registerCli(options)).kind,'ready');
  assert.deepEqual(types,['REG_EXPAND_SZ']);
  const wrapper=await readFile(join(bin,'vonvon-bot.cmd'),'utf8');
  assert.match(wrapper,/setlocal EnableExtensions DisableDelayedExpansion/);
  assert.match(wrapper,/%%&\(\)/);
  assert.match(wrapper,/%\*/);
  assert.equal((await removeCli(options)).kind,'ready');
  assert.equal(value,'C:\\Legacy\\bin;C:\\Other');
});

test('Windows command uses bundled Node and preserves arguments and exit status',{skip:process.platform!=='win32'},async t=>{
  const root=await mkdtemp(join(tmpdir(),'vonvon-native-中文-%&()'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const runtime=join(root,'Vonvon Bot','resources','runtime');
  const localAppData=join(root,'Local AppData');
  await mkdir(join(runtime,'node','node_modules','npm','bin'),{recursive:true});
  await mkdir(join(runtime,'core','bin'),{recursive:true});
  await copyFile(process.execPath,join(runtime,'node','node.exe'));
  await writeFile(join(runtime,'node','node_modules','npm','bin','npm-cli.js'),'');
  await writeFile(join(runtime,'core','bin','feishu-codex-bridge.mjs'),'console.log(JSON.stringify({args:process.argv.slice(2),npm:process.env.VONVON_NPM_CLI}));process.exitCode=37;');
  const windowsPath={read:async()=>({value:'',type:'REG_EXPAND_SZ' as const}),write:async()=>{}};
  assert.equal((await registerCli({platform:'win32',scope:'user',runtime,localAppData,windowsPath})).kind,'ready');
  for(const name of ['vonvon-bot','vonvon-bridge','feishu-codex-bridge']) {
    const command=join(localAppData,'Vonvon Bridge','bin',`${name}.cmd`);
    try {
      execFileSync('cmd.exe',['/d','/s','/c',`""${command}" "alpha beta" "&()!" "中文""`],{encoding:'utf8'});
      assert.fail('CLI exit status must reach the caller');
    } catch(error) {
      assert.ok(error instanceof Error && 'status' in error && 'stdout' in error);
      assert.equal(error.status,37);
      assert.equal(typeof error.stdout,'string');
      const result=JSON.parse(String(error.stdout));
      assert.deepEqual(result.args,['alpha beta','&()!','中文']);
      assert.equal(result.npm,join(runtime,'node','node_modules','npm','bin','npm-cli.js'));
    }
  }
});
