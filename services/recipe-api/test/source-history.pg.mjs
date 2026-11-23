import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const unknown = operationId => ({operationId, state:'unknown', draftId:null, recipeId:null, versionId:null});
const summary = (operationId, draft, publication) => ({
  operationId, state:publication ? 'published' : 'draft', draftId:draft.draftId, recipeId:draft.recipeId,
  versionId:publication?.versionId ?? null, revision:publication?.revision ?? draft.revision,
  name:(publication ?? draft).public.name, version:(publication ?? draft).public.version,
});

export async function checkSourceHistory({request, ready, accept, operationId, author, other, secondDevice,
  completeBody, account, sql, upgrade}) {
  const publish = (d, token=author) => request('/drafts/'+d.draftId+'/publish', {
    method:'POST', token, revision:d.revision, body:{},
  });
  const history = (operationIds, token=author, status=200) => request('/authoring/source-history', {
    method:'POST', token, body:{operationIds}, status,
  });
  async function prepare(name) {
    const body = {...completeBody, public:{...completeBody.public, name}};
    const {op, cap} = await ready(body);
    const receipt = await accept(cap, body);
    return {id:op.operationId, draft:await request('/drafts/'+receipt.draftId,{token:author})};
  }

  const legacyLive = await prepare('旧草稿');
  const legacyPublished = await prepare('第一个版本');
  const firstVersion = await publish(legacyPublished.draft);
  const newerBody = {...completeBody, public:{...completeBody.public, name:'后来创建的草稿', version:'2'},
    recipeId:firstVersion.recipeId, sourceVersionId:firstVersion.versionId};
  const unrelated = await request('/drafts', {method:'POST', token:author, body:newerBody});
  await publish(unrelated);
  const incomplete = await prepare('缺少精确发布回执');
  const unproven = await publish(incomplete.draft);
  sql(`delete from recipe_private.receipts where actor='${account}' and action='publish' and result->>'versionId'='${unproven.versionId}'`);
  upgrade();
  const expected = [summary(legacyPublished.id,legacyPublished.draft,firstVersion), unknown(incomplete.id),
    summary(legacyLive.id,legacyLive.draft)];
  assert.deepEqual(await history(expected.map(row=>row.operationId)), {entries:expected});

  const body = {...completeBody, public:{...completeBody.public, name:'跨设备草稿'}};
  const {op, cap} = await ready(body);
  await accept(cap, body);
  const items = (await request('/me/drafts',{token:secondDevice})).items;
  const remoteDraft = items.find(item=>item.public.name===body.public.name);
  assert.ok(remoteDraft);
  sql(`update recipe_private.authoring_operations set terminal_at=clock_timestamp()-interval '8 days' where id='${op.operationId}';
    select recipe_private.maintain_authoring('${account}')`);
  assert.equal(sql(`select count(*) from recipe_private.authoring_operations where id='${op.operationId}'`),'0');
  const published = await publish(remoteDraft,secondDevice);
  const exact = summary(op.operationId,remoteDraft,published);
  sql(`delete from recipe_private.receipts where actor='${account}' and action='publish'
      and result->>'versionId' in ('${firstVersion.versionId}','${published.versionId}')`);
  assert.deepEqual(await history([op.operationId,legacyPublished.id]), {entries:[exact,expected[0]]});

  const arbitrary = operationId();
  assert.deepEqual(await history([arbitrary,op.operationId],other), {entries:[unknown(arbitrary),unknown(op.operationId)]});
  await history([op.operationId],null,401);
  await request('/drafts/'+legacyLive.draft.draftId,{token:other,status:404});
  await request('/drafts/'+legacyLive.draft.draftId+'/publish',{method:'POST',token:other,body:{},revision:1,status:404});
  sql(`update recipe_private.accounts set status='disabled' where id='${account}'`);
  await history([op.operationId],author,403);
  sql(`update recipe_private.accounts set status='active' where id='${account}'`);
  for (const invalid of [[], [op.operationId,op.operationId], [randomUUID()], Array.from({length:33},()=>operationId())]) {
    await history(invalid,author,422);
  }
  await request('/authoring/source-history',{method:'POST',token:author,body:{operationIds:[op.operationId],accountId:account},status:422});
  const page=Array.from({length:32},()=>operationId());
  assert.deepEqual(await history(page),{entries:page.map(unknown)});
  await request('/drafts/'+legacyLive.draft.draftId,{method:'DELETE',token:author,revision:1,body:{}});
  assert.deepEqual(await history([legacyLive.id]),{entries:[unknown(legacyLive.id)]});
  const access = sql("select has_table_privilege('recipe_api','recipe_private.drafts','SELECT') or " +
    "has_table_privilege('recipe_api','recipe_private.retired_drafts','UPDATE') or " +
    "has_function_privilege('public','recipe_api.source_history(uuid[])','EXECUTE')");
  assert.equal(access,'f');
}
