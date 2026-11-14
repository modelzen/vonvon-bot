grant recipe_owner to current_user;
set local role recipe_owner;
create table recipe_private.rich_install_cap (
  id uuid primary key references recipe_private.install_operations on delete cascade,
  applied_hash bytea check(octet_length(applied_hash)=32),
  rejected_hash bytea check(octet_length(rejected_hash)=32),
  check((applied_hash is null)=(rejected_hash is null))
);
alter table recipe_private.rich_install_cap enable row level security;

create function recipe_api.rich_install_preview(v_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid:=recipe_private.actor(); v recipe_private.versions; rv recipe_private.rich_versions; d jsonb;
begin
  select * into v from recipe_private.versions where id=v_id;
  select * into rv from recipe_private.rich_versions where id=v_id;
  if not found then raise exception 'not_found'; end if;
  if rv.state='banned' or (a<>v.owner_id and not exists(select from recipe_private.grants where actor=a and version_id=v.id)) then raise exception 'forbidden'; end if;
  d:=recipe_api.rich_detail(v.recipe_id,v.id);
  return jsonb_build_object('accountId',a,'release',d->'release','manifest',d->'manifest');
end $$;

create function recipe_api.rich_install_authorize(op_id uuid,req jsonb,server_key bytea,ticket_ bytea,
  proof_hash bytea,applied_hash_ bytea,rejected_hash_ bytea,until_ms bigint) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid:=recipe_private.actor(); op recipe_private.install_operations; v recipe_private.versions; rv recipe_private.rich_versions;
  from_ recipe_private.versions; update_ boolean:=req->>'purpose'='updateDirectRichRecipe'; now_ms bigint; body jsonb;
  h bytea:=sha256(convert_to(req::text,'UTF8')); obj jsonb;
begin
  if (req->>'format'='rich-v2' and req->'generation'='2'::jsonb and req->>'purpose' in ('installRichRecipe','updateDirectRichRecipe')
    and req->>'manifestSha256'~'^[0-9a-f]{64}$' and req->>'targetPublicKey'~'^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'
    and req->>'nonceCommitment'~'^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$' and req ? 'versionId'
    and (not update_ or (req ? 'fromVersionId' and req->>'localPlanSha256'~'^[0-9a-f]{64}$'))
    and req-array['format','purpose','versionId','generation','manifestSha256','targetPublicKey','nonceCommitment']
        -case when update_ then array['fromVersionId','localPlanSha256'] else '{}'::text[] end='{}'::jsonb
    and octet_length(server_key)=32 and octet_length(ticket_)=32 and octet_length(proof_hash)=32
    and octet_length(applied_hash_)=32 and octet_length(rejected_hash_)=32) is not true then raise exception 'invalid_input'; end if;
  perform pg_advisory_xact_lock(hashtextextended(a::text,187511));
  delete from recipe_private.install_operations where account_id=a and created_at<clock_timestamp()-interval '7 days';
  select * into op from recipe_private.install_operations where id=op_id for update;
  select * into v from recipe_private.versions where id=(req->>'versionId')::uuid;
  select * into rv from recipe_private.rich_versions where id=v.id for share;
  if not found then raise exception 'not_found'; end if;
  if rv.state='banned' then raise exception 'forbidden'; end if;
  now_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
  if op.id is not null then
    if op.account_id<>a or not exists(select from recipe_private.rich_install_cap where id=op_id) then raise exception 'not_found'; end if;
    if op.state='cancelled' then raise exception 'operation_cancelled'; end if;
    if op.request_digest<>h then raise exception 'conflict'; end if;
    if op.state='authorized' and op.deadline<=now_ms then raise exception 'operation_expired'; end if;
  end if;
  if update_ then
    select * into from_ from recipe_private.versions where id=(req->>'fromVersionId')::uuid;
    if from_.recipe_id is distinct from v.recipe_id or from_.revision>=v.revision or v.public_info->>'access'<>'direct'
      or (rv.state<>'listed' and op.id is null) or (from_.owner_id<>a and not exists(select from recipe_private.grants where actor=a and version_id=from_.id))
      or exists(select from recipe_private.rich_versions where id=from_.id and state='banned') then raise exception 'forbidden'; end if;
  else perform recipe_api.rich_install_preview(v.id); end if;
  if op.id is not null then return op.binding||jsonb_build_object('ticket',recipe_private.b64url(op.ticket),'status',op.state); end if;
  perform recipe_private.new_operation(a,op_id);
  if until_ms is null or until_ms<=now_ms or until_ms>now_ms+300000 then raise exception 'invalid_input'; end if;
  if (select count(*) from recipe_private.install_operations where account_id=a and (state='redeemed' or state='authorized' and deadline>=now_ms))>=3
    then raise exception 'operation_pending_limit'; end if;
  obj:=recipe_private.object_descriptor(v.owner_id,rv.manifest_id);
  if obj->>'sha256' is distinct from req->>'manifestSha256' then raise exception 'conflict'; end if;
  body:=req||jsonb_build_object('operationId',op_id,'accountId',a,'deadline',until_ms,'serverPublicKey',recipe_private.b64url(server_key));
  insert into recipe_private.install_operations(id,account_id,state,request_digest,version_id,binding,ticket,expected_proof_hash,deadline)
    values(op_id,a,'authorized',h,v.id,body,ticket_,proof_hash,until_ms) on conflict do nothing;
  if not found then raise exception 'conflict'; end if;
  insert into recipe_private.rich_install_cap values(op_id,applied_hash_,rejected_hash_);
  return body||jsonb_build_object('ticket',recipe_private.b64url(ticket_),'status','authorized');
end $$;

create function recipe_private.rich_install_possession(op_id uuid,ticket_ bytea,nonce_ bytea,proof_ bytea,stage text) returns recipe_private.install_operations
language plpgsql set search_path=pg_catalog,pg_temp as $$
declare op recipe_private.install_operations; cap recipe_private.rich_install_cap; a uuid;
begin
  if stage not in ('redeem','applied','rejected') or stage is null then raise exception 'invalid_input'; end if;
  select account_id into a from recipe_private.install_operations where id=op_id;
  if not found then raise exception 'not_found'; end if;
  perform 1 from recipe_private.accounts where id=a and status='active' for share;
  if not found then raise exception 'account_disabled'; end if;
  perform pg_advisory_xact_lock(hashtextextended(a::text,187511));
  select * into op from recipe_private.install_operations where id=op_id for update;
  select * into cap from recipe_private.rich_install_cap where id=op.id;
  if not found then raise exception 'not_found'; end if;
  if op.created_at<clock_timestamp()-interval '7 days' then raise exception 'operation_expired'; end if;
  if op.state='cancelled' then raise exception 'operation_cancelled'; end if;
  if sha256(ticket_) is distinct from sha256(op.ticket) or recipe_private.b64url(sha256(nonce_)) is distinct from op.binding->>'nonceCommitment'
    or sha256(proof_) is distinct from (case stage when 'redeem' then op.expected_proof_hash when 'applied' then cap.applied_hash else cap.rejected_hash end)
    then raise exception 'invalid_operation_proof'; end if;
  return op;
end $$;

create function recipe_private.rich_install_resources(op recipe_private.install_operations) returns jsonb
language plpgsql set search_path=pg_catalog,pg_temp as $$
declare v recipe_private.versions; rv recipe_private.rich_versions; obj jsonb;
begin
  select * into v from recipe_private.versions where id=op.version_id;
  select * into rv from recipe_private.rich_versions where id=v.id for share;
  if not found or rv.state='banned' then raise exception 'forbidden'; end if;
  if op.binding->>'purpose'='updateDirectRichRecipe' then
    if exists(select from recipe_private.rich_versions where id=(op.binding->>'fromVersionId')::uuid and state='banned') then raise exception 'forbidden'; end if;
    if rv.state='withdrawn' and op.state='authorized' then raise exception 'forbidden'; end if;
  elsif op.account_id<>v.owner_id and not exists(select from recipe_private.grants where actor=op.account_id and version_id=v.id) then raise exception 'forbidden'; end if;
  obj:=recipe_private.object_descriptor(v.owner_id,rv.manifest_id);
  if obj->>'sha256' is distinct from op.binding->>'manifestSha256' then raise exception 'integrity_error'; end if;
  return jsonb_build_object('manifest',obj,'release',jsonb_build_object('format','rich-v2','recipeId',v.recipe_id,'versionId',v.id,
    'authorId',v.owner_id,'revision',v.revision,'access',v.public_info->>'access','logicalBytes',v.bytes,'contentSha256',obj->>'sha256'));
end $$;

create function recipe_api.rich_possess_install(op_id uuid,ticket_ bytea,nonce_ bytea,proof_ bytea,outcome text default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare op recipe_private.install_operations:=recipe_private.rich_install_possession(op_id,ticket_,nonce_,proof_,coalesce(outcome,'redeem'));
  resources jsonb; v recipe_private.versions; st text; disposition text;
begin
  if outcome is null then
    resources:=recipe_private.rich_install_resources(op);
    if op.state='authorized' then
      if op.deadline<=extract(epoch from clock_timestamp())*1000 then raise exception 'operation_expired'; end if;
      update recipe_private.install_operations set state='redeemed' where id=op.id;op.state:='redeemed';
    end if;
    return op.binding||resources||jsonb_build_object('status',op.state);
  end if;
  if op.state not in ('redeemed',outcome) then raise exception 'conflict'; end if;
  select * into strict v from recipe_private.versions where id=op.version_id;
  select state into strict st from recipe_private.rich_versions where id=v.id for share;
  if st='banned' then disposition:='blocked';
  elsif outcome='applied' and op.binding->>'purpose'='updateDirectRichRecipe' then
    perform recipe_private.rich_install_resources(op);
    if v.owner_id<>op.account_id and not exists(select from recipe_private.grants where actor=op.account_id and version_id=v.id) then
      insert into recipe_private.grants(actor,version_id,original_request,original_digest,acquisition_proof)
        values(op.account_id,v.id,op.id,op.request_digest,'direct-update-receipt') on conflict(actor,version_id) do nothing;
    end if;
    disposition:='settled';
  else disposition:='recorded'; end if;
  update recipe_private.install_operations set state=outcome where id=op_id;
  return jsonb_build_object('operationId',op_id,'status',outcome,'disposition',disposition);
end $$;

alter table recipe_private.grants drop constraint grants_acquisition_proof_check;
alter table recipe_private.grants add check(acquisition_proof in ('legacy-grant-only','legacy-with-raw','v2-with-raw','direct-update-receipt'));

create function recipe_objects.install_descriptor(op_id uuid,ticket_ bytea,nonce_ bytea,proof_ bytea,obj uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare op recipe_private.install_operations:=recipe_private.rich_install_possession(op_id,ticket_,nonce_,proof_,'redeem'); owner_ uuid;
begin
  if op.state<>'redeemed' then raise exception 'forbidden'; end if;
  perform recipe_private.rich_install_resources(op);
  select v.owner_id into owner_ from recipe_private.object_version_refs r join recipe_private.versions v on v.id=r.version_id
    where r.version_id=op.version_id and r.object_id=obj;
  if not found then raise exception 'not_found'; end if;return recipe_private.object_descriptor(owner_,obj);
end $$;
grant execute on function recipe_objects.install_descriptor(uuid,bytea,bytea,bytea,uuid) to recipe_object_verifier;

alter function recipe_api.cancel_operation(uuid) rename to cancel_operation_core;
alter function recipe_api.cancel_operation_core(uuid) set schema recipe_private;
revoke execute on function recipe_private.cancel_operation_core(uuid) from recipe_api;
create function recipe_api.cancel_operation(p_id uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(recipe_private.actor()::text,187511));
  if exists(select from recipe_private.rich_install_cap where id=p_id) then raise exception 'not_found'; end if;
  return recipe_private.cancel_operation_core(p_id);
end $$;
create function recipe_api.rich_install_control(op_id uuid,action_ text) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid:=recipe_private.actor(); result jsonb; op recipe_private.install_operations;
begin
  perform pg_advisory_xact_lock(hashtextextended(a::text,187511));
  select * into op from recipe_private.install_operations where id=op_id;
  if found and (op.account_id<>a or not exists(select from recipe_private.rich_install_cap where id=op.id)) then raise exception 'not_found'; end if;
  if action_='recover' then
    if op.id is null or op.created_at<clock_timestamp()-interval '7 days' then
      begin perform recipe_private.check_operation_birth(op_id);
      exception when raise_exception then if sqlerrm<>'operation_expired' then raise; end if;
        return jsonb_build_object('operationId',op_id,'unredeemable',true); end;
      raise exception 'not_found';
    end if;
    return jsonb_build_object('operationId',op_id,'status',op.state,'unredeemable',op.state='cancelled' or
      (op.state='authorized' and op.deadline<=extract(epoch from clock_timestamp())*1000));
  elsif action_='cancel' then
    result:=recipe_private.cancel_operation_core(op_id);
    if op.id is null then insert into recipe_private.rich_install_cap(id) values(op_id); end if;
    return result;
  end if;
  raise exception 'invalid_input';
end $$;

create function recipe_api.rich_install_unredeemable(op_id uuid, account_ uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare op recipe_private.install_operations; negative boolean:=false;
begin
  perform pg_advisory_xact_lock(hashtextextended(account_::text,187511));
  select * into op from recipe_private.install_operations where id=op_id;
  if not found then
    begin perform recipe_private.check_operation_birth(op_id);
    exception when raise_exception then
      if sqlerrm<>'operation_expired' then raise; end if;
      negative:=true;
    end;
  elsif op.account_id=account_ and exists(select from recipe_private.rich_install_cap where id=op_id) then
    negative:=op.state='cancelled' or (op.state='authorized' and op.deadline<=floor(extract(epoch from clock_timestamp())*1000)::bigint);
  end if;
  return jsonb_build_object('operationId',op_id,'unredeemable',negative);
end $$;
grant execute on function recipe_api.rich_install_unredeemable(uuid,uuid) to recipe_api;
grant execute on function recipe_api.cancel_operation(uuid),recipe_api.rich_install_preview(uuid),recipe_api.rich_install_authorize(uuid,jsonb,bytea,bytea,bytea,bytea,bytea,bigint),
  recipe_api.rich_install_control(uuid,text),recipe_api.rich_possess_install(uuid,bytea,bytea,bytea,text) to recipe_api;
reset role;
revoke recipe_owner from current_user;
