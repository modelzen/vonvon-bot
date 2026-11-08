import {afterAll,describe,expect,it} from 'vitest';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {defaultCardDisplay,type CardDisplayBlock} from '@vonvon/protocol';
import {checkCardDisplayScriptSyntax,runCardDisplayScripts} from '../src/card/card-display-scripts';

const cwd=await mkdtemp(join(tmpdir(),'card-display-scripts-'));
afterAll(()=>rm(cwd,{recursive:true,force:true}));
function custom(script:string,id='custom'):CardDisplayBlock {
  return {...defaultCardDisplay().blocks[0]!,id,kind:'custom',name:'Git 分支',source:'script',language:'node',script,sample:'{"branch":"dev"}',template:'{{branch}}',appearance:'text'};
}
function run(...blocks:CardDisplayBlock[]){return runCardDisplayScripts({version:1,blocks},{cwd,values:{context:{percent:42}}});}
describe('card display helper lifecycle',()=>{
  it('checks syntax without executing user code',async()=>{
    const marker=join(cwd,'must-not-exist');
    await checkCardDisplayScriptSyntax(custom(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`));
    await expect(readFile(marker)).rejects.toMatchObject({code:'ENOENT'});
    await expect(checkCardDisplayScriptSyntax(custom('const = ;'))).rejects.toThrow('脚本检查未通过');
  });
  it('supplies bounded context and cwd as JSON, isolates each widget, excludes credential env',async()=>{
    process.env.VONVON_CARD_TEST_SECRET='must-not-inherit';
    try {
      const result=await run(custom("let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{const v=JSON.parse(s);console.log(JSON.stringify({branch:'dev',percent:v.context.percent,cwd:v.cwd,secret:process.env.VONVON_CARD_TEST_SECRET??null}))})"));
      expect(result.errors).toEqual([]);
      expect(result.values.custom).toEqual({branch:'dev',percent:42,cwd,secret:null});
    } finally {delete process.env.VONVON_CARD_TEST_SECRET;}
  });
  it('rejects bad JSON and unsafe/deep output without aborting other components',async()=>{
    const result=await run(custom('console.log("not json")','bad'),custom('console.log(JSON.stringify({branch:"dev"}))','good'),custom('console.log(\'{"__proto__":{"x":1}}\')','reserved'));
    expect(result.values.good).toEqual({branch:'dev'});
    expect(result.errors.map(error=>error.id).sort()).toEqual(['bad','reserved']);
  });
  it('bounds output and runtime',async()=>{
    const result=await run(custom('console.log("x".repeat(20000))','large'),custom('setInterval(()=>{},100)','slow'));
    expect(result.errors.find(error=>error.id==='large')?.message).toContain('16 KB');
    expect(result.errors.find(error=>error.id==='slow')?.message).toContain('1.5 秒');
  });
  it('supports cancellation without exposing stderr or breaking replies',async()=>{
    const controller=new AbortController();
    const promise=runCardDisplayScripts({version:1,blocks:[custom('console.error("private diagnostic");setInterval(()=>{},100)')]},{cwd,values:{},signal:controller.signal});
    setTimeout(()=>controller.abort(),75);
    const result=await promise;
    expect(result.values).toEqual({});expect(result.errors[0]?.message).toBe('脚本已取消');
    expect(JSON.stringify(result)).not.toContain('private diagnostic');
  });
  it('reaps a descendant even when the helper exits first',async()=>{
    const marker=join(cwd,'orphan-must-not-write');
    const childCode=`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'orphan'),700);setInterval(()=>{},1000)`;
    const script=`require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'}).unref();console.log(JSON.stringify({branch:'dev'}));`;
    const result=await run(custom(script));
    expect(result.values.custom).toEqual({branch:'dev'});
    await new Promise(resolve=>setTimeout(resolve,900));
    await expect(readFile(marker)).rejects.toMatchObject({code:'ENOENT'});
  });
  it.skipIf(process.platform==='win32')('parses shell scripts without running them and executes valid JSON helpers',async()=>{
    await expect(checkCardDisplayScriptSyntax({...custom('if then'),language:'shell'})).rejects.toThrow('脚本检查未通过');
    const result=await run({...custom('printf \'{"branch":"dev"}\''),language:'shell'});
    expect(result.values.custom).toEqual({branch:'dev'});
  });
});
