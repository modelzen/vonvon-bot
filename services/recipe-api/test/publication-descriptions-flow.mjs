import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {canonicalizeRichRecipeContent,recipeBrowseDetailSchema} from '../../../packages/protocol/dist/index.js';
import {openDatabase} from '../src/database.mjs';
import {createRecipeServer} from '../src/http.mjs';
import {createPublicationReader,publicationDescriptions} from '../src/publication-preview.mjs';

export async function checkPublicationDescriptions({sql,sock,owner,issuer,content}){
  const source=structuredClone(content);delete source.role;delete source.finalLogo;
  for(const field of ['settings','rules','skills','files','tasks','memories','setup','parts'])source[field]=[];
  source.public.name.value='Part skill publication';source.public.version.value='external-entry-1';
  const draft=randomUUID(),recipe=randomUUID(),pkg=randomUUID(),manifest=randomUUID(),entryId=randomUUID(),referenceId=randomUUID(),requestId=randomUUID();
  const entry=Buffer.from('---\nname: skill-sample\ndescription: 新发布即可查看的技能说明。\n---\nENTRY_PRIVATE_BODY_SENTINEL');
  const reference=Buffer.from('REFERENCE_PRIVATE_BODY_SENTINEL');
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  const descriptor=(id,bytes)=>({objectId:id,kind:'text',bytes:bytes.length,sha256:hash(bytes),mediaType:'text/plain;charset=utf-8'});
  const identity=()=>({itemId:randomUUID(),originId:randomUUID()});
  const entryFile={...identity(),name:'SKILL.md',use:'skillDescription',text:{kind:'part',objectId:entryId}};
  const referenceFile={...identity(),name:'reference.md',use:'reference',text:{kind:'part',objectId:referenceId}};
  source.parts=[descriptor(entryId,entry),descriptor(referenceId,reference)];source.files=[entryFile,referenceFile];
  source.skills=[{...identity(),name:'新技能',entryFileId:entryFile.itemId,fileIds:[entryFile.itemId,referenceFile.itemId]}];
  const doc=canonicalizeRichRecipeContent(source),canonical=Buffer.from(doc.canonicalUTF8);
  const publicInfo=Object.fromEntries(Object.entries(source.public).map(([key,value])=>[key,value.value]));publicInfo.access='direct';
  sql(`create role publication_test login noinherit;grant recipe_api to publication_test;
    insert into recipe_private.drafts(id,owner_id,recipe_id,base_revision,revision,public_info,config,bytes,source_operation_id)
      values('${draft}','${owner}','${recipe}',0,1,'${JSON.stringify(publicInfo)}','{}',${doc.logicalBytes},gen_random_uuid());
    insert into recipe_private.object_packages(id,actor,draft_id,cap,state) values('${pkg}','${owner}','${draft}',1048576,'attached');
    insert into recipe_private.object_attempts(id,package_id,ordinal,kind,input_bytes,input_hash,final_cap,final_bytes,final_hash,ingress,state,temp_state,final_state) values
      ('${manifest}','${pkg}',65,'manifest',${canonical.length},'${hash(canonical)}',${canonical.length},${canonical.length},'${hash(canonical)}',false,'ready','gone','present'),
      ('${entryId}','${pkg}',0,'text',${entry.length},'${hash(entry)}',${entry.length},${entry.length},'${hash(entry)}',false,'ready','gone','present'),
      ('${referenceId}','${pkg}',1,'text',${reference.length},'${hash(reference)}',${reference.length},${reference.length},'${hash(reference)}',false,'ready','gone','present');
    insert into recipe_private.rich_drafts(id,manifest_id,items) values('${draft}','${manifest}','[]');
    insert into recipe_private.object_draft_refs(draft_id,object_id) values('${draft}','${manifest}'),('${draft}','${entryId}'),('${draft}','${referenceId}');`);
  const reads=[],allowedDrafts=new Set([draft]);let brokerMode='entry';
  const broker=createServer((req,res)=>{
    reads.push(req.url);
    const selected=/^\/v2\/drafts\/([^/]+)\/objects\/([^/]+)$/.exec(req.url);
    if(req.headers.authorization!=='Bearer verified-publisher'||!selected||!allowedDrafts.has(selected[1])||selected[2]!==entryId){res.writeHead(403);res.end();return;}
    if(brokerMode==='removed')sql(`delete from recipe_private.object_draft_refs where draft_id='${selected[1]}';delete from recipe_private.rich_drafts where id='${selected[1]}';delete from recipe_private.drafts where id='${selected[1]}';`);
    if(brokerMode==='revised')sql(`begin;set local app.rich_mutation='v2';update recipe_private.drafts set revision=revision+1 where id='${selected[1]}';commit;`);
    if(['missing','removed','revised'].includes(brokerMode)){res.writeHead(404);res.end();return;}
    if(brokerMode==='hash'){const corrupted=Buffer.from(entry);corrupted[0]^=1;res.end(corrupted);return;}
    res.end(brokerMode==='short'?entry.subarray(0,-1):entry);
  });
  broker.listen(0,'127.0.0.1');await once(broker,'listening');
  let api,db,brokerClosed=false;
  const close=server=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});
  try{
    db=await openDatabase('postgresql://publication_test@localhost/postgres?host='+encodeURIComponent(sock)+'&port=5432',randomBytes(32).toString('hex'),issuer);
    let dropPublicationResponse=true,race;
    api=createRecipeServer({verify:async token=>{assert.equal(token,'verified-publisher');return {issuer,subject:owner};},admitRich:true,
      publicationRead:createPublicationReader('http://127.0.0.1:'+broker.address().port),
      execute:async(identity,operation,args)=>{
        if(operation==='richDraft'&&race?.draftId===args[0]&&++race.lookups===race.at){
          const committed=race;race=undefined;
          await db.execute(identity,'richPublish',[committed.draftId,1,committed.key,canonical,{[source.skills[0].itemId]:'新发布即可查看的技能说明。'}]);
        }
        const result=await db.execute(identity,operation,args);
        if(operation==='richPublish'&&dropPublicationResponse){dropPublicationResponse=false;throw Error('simulated post-commit response loss');}
        return result;
      }});
    api.listen(0,'127.0.0.1');await once(api,'listening');
    const origin='http://127.0.0.1:'+api.address().port;
    const publish=({draftId=draft,key=requestId,bytes=canonical}={})=>fetch(origin+`/v2/drafts/${draftId}/publish`,{method:'POST',headers:{authorization:'Bearer verified-publisher','content-type':'application/json','idempotency-key':key,'if-match':'"1"'},body:JSON.stringify({canonical:bytes.toString('base64url')})});
    const lost=await publish();assert.equal(lost.status,500);await lost.arrayBuffer();
    assert.deepEqual(reads,[`/v2/drafts/${draft}/objects/${entryId}`]);
    assert.equal(sql(`select count(*) from recipe_private.drafts where id='${draft}'`),'0');
    const version=sql(`select id from recipe_private.versions where recipe_id='${recipe}'`);
    const response=await fetch(origin+`/v2/recipes/${recipe}/versions/${version}/preview`);assert.equal(response.status,200);
    const preview=recipeBrowseDetailSchema.parse(await response.json());
    assert.equal(preview.preview.skills[0].description,'新发布即可查看的技能说明。');
    assert.ok(!JSON.stringify(preview).includes('ENTRY_PRIVATE_BODY_SENTINEL'));assert.ok(!JSON.stringify(preview).includes('REFERENCE_PRIVATE_BODY_SENTINEL'));
    const seed=(revision=1)=>{
      const id=randomUUID(),target=randomUUID();allowedDrafts.add(id);
      sql(`insert into recipe_private.drafts(id,owner_id,recipe_id,base_revision,revision,public_info,config,bytes,source_operation_id)
        values('${id}','${owner}','${target}',0,${revision},'${JSON.stringify(publicInfo)}','{}',${doc.logicalBytes},gen_random_uuid());
        insert into recipe_private.rich_drafts(id,manifest_id,items) values('${id}','${manifest}','[]');
        insert into recipe_private.object_draft_refs(draft_id,object_id) values('${id}','${manifest}'),('${id}','${entryId}'),('${id}','${referenceId}');`);
      return id;
    };
    let count=reads.length;
    const deleted=await publish({key:randomUUID()});assert.equal(deleted.status,404);await deleted.arrayBuffer();assert.equal(reads.length,count);
    const revised=await publish({draftId:seed(2),key:randomUUID()});assert.equal(revised.status,409);await revised.arrayBuffer();assert.equal(reads.length,count);
    const changed=structuredClone(source);changed.public.name.value='Different reviewed content';
    const mismatch=await publish({draftId:seed(),key:randomUUID(),bytes:Buffer.from(canonicalizeRichRecipeContent(changed).canonicalUTF8)});
    assert.equal(mismatch.status,409);await mismatch.arrayBuffer();assert.equal(reads.length,count);
    for(const mode of ['missing','hash','short','removed','revised']){
      brokerMode=mode;const id=seed(),failed=await publish({draftId:id,key:randomUUID()});
      assert.equal(failed.status,mode==='removed'?404:mode==='revised'?409:503);
      const failure=await failed.json();assert.equal(failure.error.code,mode==='removed'?'not_found':mode==='revised'?'conflict':'publication_preview_unavailable');
      if(failed.status===503)assert.equal(failed.headers.get('retry-after'),'1');
      assert.equal(sql(`select count(*) from recipe_private.browse_previews p join recipe_private.versions v on v.id=p.version_id where v.recipe_id=(select recipe_id from recipe_private.drafts where id='${id}')`),'0');
    }
    brokerMode='missing';
    for(const at of [1,2]){
      const draftId=seed(),key=randomUUID(),before=reads.length;race={draftId,key,at,lookups:0};
      const concurrent=await publish({draftId,key});assert.equal(concurrent.status,200);await concurrent.arrayBuffer();
      assert.equal(reads.length-before,at===1?0:1);
      assert.equal(sql(`select count(*) from recipe_private.drafts where id='${draftId}'`),'0');
    }
    count=reads.length;
    await close(broker);brokerClosed=true;
    const replay=await publish();assert.equal(replay.status,200);const replayed=await replay.json();assert.equal(replayed.versionId,version);
    const again=await publish();assert.equal(again.status,200);assert.deepEqual(await again.json(),replayed);
    const after=await fetch(origin+`/v2/recipes/${recipe}/versions/${version}/preview`).then(r=>r.json());
    assert.equal(after.preview.skills[0].description,'新发布即可查看的技能说明。');assert.equal(reads.length,count);
    const derive=async(value,read)=>{
      const bytes=Buffer.from(canonicalizeRichRecipeContent(value).canonicalUTF8);
      return publicationDescriptions([draft,1,requestId,bytes],{authorization:'Bearer verified-publisher',read,committed:async()=>({status:'unknown'}),
        currentDraft:async()=>({format:'rich-v2',draftId:draft,revision:1,manifest:{sha256:hash(bytes),bytes:bytes.length}})});
    };
    const duplicate=structuredClone(source),copy={...entryFile,...identity(),name:'nested/SKILL.md'};duplicate.files.push(copy);
    duplicate.skills.push({...identity(),name:'相同内容的另一个技能',entryFileId:copy.itemId,fileIds:[copy.itemId]});
    let fetched=0;const derived=await derive(duplicate,async()=>{fetched++;return entry;});assert.equal(fetched,1);assert.equal(Object.keys(derived).length,2);
    const invalidUtf8=structuredClone(source),invalidBytes=Buffer.from([255]);
    invalidUtf8.parts[0]=descriptor(entryId,invalidBytes);
    await assert.rejects(derive(invalidUtf8,async()=>invalidBytes),{status:503,code:'publication_preview_unavailable'});
    const noFrontmatter=structuredClone(source),plain=Buffer.from('A legitimate skill without description frontmatter.');noFrontmatter.parts[0]=descriptor(entryId,plain);
    assert.deepEqual(Object.values(await derive(noFrontmatter,async()=>plain)),['']);
    console.log('PASS: fresh part-backed SKILL publication stores verified description immediately, reads no references, and post-commit response loss replays retired draft without broker reads.');
  }finally{if(api)await close(api);if(db)await db.close();if(!brokerClosed)await close(broker);}
}
