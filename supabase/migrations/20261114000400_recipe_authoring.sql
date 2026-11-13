grant recipe_owner to current_user;
set local role recipe_owner;

create table recipe_private.authoring_operations (
  id uuid primary key,
  account_id uuid not null references recipe_private.accounts,
  purpose text check (purpose in ('prepareDraft','editDraft')),
  target_key text,
  nonce_commitment text,
  draft_id uuid,
  base_revision integer,
  state text not null check (state in ('registered','dispatched','accepted','cancelled','expired')),
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default clock_timestamp()+interval '24 hours',
  terminal_at timestamptz,
  receipt jsonb,
  check (((purpose is null and target_key is null and nonce_commitment is null and draft_id is null and base_revision is null
       and state='cancelled') or (purpose is not null and target_key ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'
       and nonce_commitment ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'
       and ((purpose='prepareDraft' and draft_id is null and base_revision is null)
          or (purpose='editDraft' and draft_id is not null and base_revision>0)))) is true),
  check ((state in ('accepted','cancelled','expired')) = (terminal_at is not null)),
  check ((state='accepted') = (receipt is not null))
);
create index authoring_account on recipe_private.authoring_operations(account_id,created_at);
create unique index authoring_one_proposal on recipe_private.authoring_operations(draft_id)
  where purpose='editDraft' and state in ('registered','dispatched');
create table recipe_private.authoring_capabilities (
  operation_id uuid not null references recipe_private.authoring_operations on delete cascade,
  stage text not null check (stage in ('dispatch','accept')),
  binding jsonb not null check (jsonb_typeof(binding)='object'),
  ticket bytea not null check (octet_length(ticket)=32),
  proof_hash bytea not null check (octet_length(proof_hash)=32),
  payload_digest bytea not null check (octet_length(payload_digest)=32),
  deadline bigint not null,
  primary key(operation_id,stage)
);
alter table recipe_private.authoring_operations enable row level security;
alter table recipe_private.authoring_capabilities enable row level security;

create function recipe_private.maintain_authoring(a uuid) returns void
language plpgsql set search_path=pg_catalog,pg_temp as $$
begin
  update recipe_private.authoring_operations set state='expired',revision=revision+1,terminal_at=expires_at
    where account_id=a and state in ('registered','dispatched') and expires_at<=clock_timestamp();
  delete from recipe_private.authoring_operations where account_id=a and terminal_at<clock_timestamp()-interval '7 days';
end $$;

create function recipe_private.authoring_json(op recipe_private.authoring_operations) returns jsonb
language sql stable set search_path=pg_catalog,pg_temp as $$
  select coalesce(op.receipt,jsonb_strip_nulls(jsonb_build_object('operationId',op.id,'accountId',op.account_id,
    'purpose',op.purpose,'targetPublicKey',op.target_key,'nonceCommitment',op.nonce_commitment,
    'draftId',op.draft_id,'baseRevision',op.base_revision,'status',op.state,'stateRevision',op.revision,
    'operationDeadline',floor(extract(epoch from op.expires_at)*1000)::bigint)))
$$;

create function recipe_private.new_authoring(a uuid,p_id uuid) returns void
language plpgsql set search_path=pg_catalog,pg_temp as $$
begin
  perform recipe_private.check_operation_birth(p_id);
  if (select count(*) from recipe_private.authoring_operations where account_id=a
      and created_at>=date_trunc('day',statement_timestamp(),'UTC'))>=60 then raise exception 'rate_limited'; end if;
end $$;

create function recipe_api.register_authoring(p_id uuid,p_request jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid:=recipe_private.actor(); op recipe_private.authoring_operations; d recipe_private.drafts;
  purpose text; target text; nonce text; draft uuid; base int;
begin
  if jsonb_typeof(p_request) is distinct from 'object' then raise exception 'invalid_input'; end if;
  purpose:=p_request->>'purpose'; target:=p_request->>'targetPublicKey'; nonce:=p_request->>'nonceCommitment';
  if (p_request ?& array['purpose','targetPublicKey','nonceCommitment']
      and p_request-array['purpose','targetPublicKey','nonceCommitment','draftId','baseRevision']='{}'::jsonb
      and jsonb_typeof(p_request->'purpose')='string' and purpose in ('prepareDraft','editDraft')
      and jsonb_typeof(p_request->'targetPublicKey')='string' and target ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'
      and jsonb_typeof(p_request->'nonceCommitment')='string' and nonce ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$') is not true then
    raise exception 'invalid_input';
  end if;
  if purpose='editDraft' then
    if (jsonb_typeof(p_request->'draftId')='string' and p_request->>'draftId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and jsonb_typeof(p_request->'baseRevision')='number' and p_request->>'baseRevision' ~ '^[1-9][0-9]{0,9}$'
        and (p_request->>'baseRevision')::numeric<=2147483647) is not true then raise exception 'invalid_input'; end if;
    draft:=(p_request->>'draftId')::uuid; base:=(p_request->>'baseRevision')::int;
  elsif p_request ?| array['draftId','baseRevision'] then raise exception 'invalid_input'; end if;
  perform pg_advisory_xact_lock(hashtextextended(a::text,187511));
  perform recipe_private.maintain_authoring(a);
  select * into op from recipe_private.authoring_operations where id=p_id for update;
  if found then
    if op.account_id<>a then raise exception 'not_found'; end if;
    if op.state='cancelled' then raise exception 'operation_cancelled'; end if;
    if op.state='expired' then raise exception 'operation_expired'; end if;
    if (op.purpose,op.target_key,op.nonce_commitment,op.draft_id,op.base_revision)
       is distinct from (purpose,target,nonce,draft,base) then raise exception 'conflict'; end if;
    return recipe_private.authoring_json(op);
  end if;
  perform recipe_private.new_authoring(a,p_id);
  if (select count(*) from recipe_private.authoring_operations where account_id=a and state in ('registered','dispatched'))>=3 then
    raise exception 'operation_pending_limit'; end if;
  if purpose='editDraft' then
    select * into d from recipe_private.drafts where id=draft and owner_id=a for update;
    if not found then raise exception 'not_found'; end if;
    if d.revision<>base then raise exception 'conflict'; end if;
    if exists(select from recipe_private.authoring_operations where draft_id=draft and state in ('registered','dispatched')) then
      raise exception 'proposal_active'; end if;
  end if;
  insert into recipe_private.authoring_operations(id,account_id,purpose,target_key,nonce_commitment,draft_id,base_revision,state)
    values(p_id,a,purpose,target,nonce,draft,base,'registered') on conflict do nothing returning * into op;
  if not found then raise exception 'conflict'; end if;
  return recipe_private.authoring_json(op);
end $$;

create function recipe_api.get_authoring(p_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid:=recipe_private.actor(); op recipe_private.authoring_operations;
begin
  perform pg_advisory_xact_lock(hashtextextended(a::text,187511));
  perform recipe_private.maintain_authoring(a);
  select * into op from recipe_private.authoring_operations where id=p_id and account_id=a;
  if not found then perform recipe_private.check_operation_birth(p_id); raise exception 'not_found'; end if;
  return recipe_private.authoring_json(op);
end $$;

create function recipe_api.cancel_authoring(p_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid:=recipe_private.actor(); op recipe_private.authoring_operations;
begin
  perform pg_advisory_xact_lock(hashtextextended(a::text,187511));
  perform recipe_private.maintain_authoring(a);
  select * into op from recipe_private.authoring_operations where id=p_id for update;
  if found then
    if op.account_id<>a then raise exception 'not_found'; end if;
    if op.state in ('registered','dispatched') then
      update recipe_private.authoring_operations set state='cancelled',revision=revision+1,terminal_at=clock_timestamp()
        where id=p_id returning * into op;
    end if;
  else
    perform recipe_private.new_authoring(a,p_id);
    insert into recipe_private.authoring_operations(id,account_id,state,terminal_at)
      values(p_id,a,'cancelled',clock_timestamp()) on conflict do nothing returning * into op;
    if not found then raise exception 'conflict'; end if;
  end if;
  return recipe_private.authoring_json(op);
end $$;

create function recipe_api.authoring_context(p_id uuid,p_request jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid:=recipe_private.actor(); op recipe_private.authoring_operations; stage text; d recipe_private.drafts;
begin
  if jsonb_typeof(p_request) is distinct from 'object' then raise exception 'invalid_input'; end if;
  stage:=p_request->>'stage';
  if (p_request-array['stage','payloadDigest','stateRevision']='{}'::jsonb
      and p_request ?& array['stage','payloadDigest','stateRevision']
      and jsonb_typeof(p_request->'stage')='string' and stage in ('dispatch','accept')
      and jsonb_typeof(p_request->'payloadDigest')='string' and p_request->>'payloadDigest' ~ '^[0-9a-f]{64}$'
      and jsonb_typeof(p_request->'stateRevision')='number' and p_request->>'stateRevision' ~ '^[1-9][0-9]{0,9}$'
      and (p_request->>'stateRevision')::numeric<=2147483647) is not true then raise exception 'invalid_input'; end if;
  if stage='dispatch' and p_request->>'payloadDigest'<>encode(sha256(''::bytea),'hex') then raise exception 'invalid_input'; end if;
  perform pg_advisory_xact_lock(hashtextextended(a::text,187511));
  perform recipe_private.maintain_authoring(a);
  select * into op from recipe_private.authoring_operations where id=p_id and account_id=a for update;
  if not found then perform recipe_private.check_operation_birth(p_id); raise exception 'not_found'; end if;
  if op.state='cancelled' then raise exception 'operation_cancelled'; end if;
  if op.state='expired' then raise exception 'operation_expired'; end if;
  if op.revision is distinct from (p_request->>'stateRevision')::int
      or op.state<>(case when stage='dispatch' then 'registered' else 'dispatched' end) then raise exception 'conflict'; end if;
  if op.purpose='editDraft' then
    select * into d from recipe_private.drafts where id=op.draft_id and owner_id=a for update;
    if not found or d.revision is distinct from op.base_revision then raise exception 'conflict'; end if;
  end if;
  return recipe_private.authoring_json(op) || p_request || jsonb_build_object('deadline',least(
    floor(extract(epoch from op.expires_at)*1000)::bigint,floor(extract(epoch from clock_timestamp())*1000)::bigint+300000));
end $$;

create function recipe_api.authorize_authoring(p_id uuid,p_request jsonb,p_server_key bytea,p_ticket bytea,p_proof_hash bytea,p_deadline bigint) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare context jsonb:=recipe_api.authoring_context(p_id,p_request); cap recipe_private.authoring_capabilities; binding jsonb;
  now_ms bigint:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
begin
  if octet_length(p_server_key) is distinct from 32 or octet_length(p_ticket) is distinct from 32
     or octet_length(p_proof_hash) is distinct from 32 or p_deadline is null
     or p_deadline<=now_ms or p_deadline>(context->>'deadline')::bigint then raise exception 'invalid_input'; end if;
  select * into cap from recipe_private.authoring_capabilities where operation_id=p_id and stage=p_request->>'stage';
  if found then
    if cap.payload_digest is distinct from decode(p_request->>'payloadDigest','hex') then raise exception 'conflict'; end if;
    if cap.deadline>now_ms then return cap.binding || jsonb_build_object('ticket',recipe_private.b64url(cap.ticket)); end if;
  end if;
  binding:=context || jsonb_build_object('serverPublicKey',recipe_private.b64url(p_server_key),'deadline',p_deadline);
  insert into recipe_private.authoring_capabilities(operation_id,stage,binding,ticket,proof_hash,payload_digest,deadline)
    values(p_id,p_request->>'stage',binding,p_ticket,p_proof_hash,decode(p_request->>'payloadDigest','hex'),p_deadline)
    on conflict(operation_id,stage) do update set binding=excluded.binding,ticket=excluded.ticket,proof_hash=excluded.proof_hash,deadline=excluded.deadline;
  return binding || jsonb_build_object('ticket',recipe_private.b64url(p_ticket));
end $$;

create function recipe_private.apply_draft_patch(d recipe_private.drafts,p_patch jsonb) returns jsonb
language plpgsql set search_path=pg_catalog,pg_temp as $$
declare pub jsonb:=d.public_info; cfg jsonb:=d.config; change jsonb; field text; touched text[]:='{}';
begin
  if jsonb_typeof(p_patch) is distinct from 'object' then raise exception 'invalid_input'; end if;
  if (p_patch-array['schemaVersion','draftId','baseRevision','changes']='{}'::jsonb
      and p_patch ?& array['schemaVersion','draftId','baseRevision','changes']
      and p_patch->'schemaVersion'='1'::jsonb and jsonb_typeof(p_patch->'draftId')='string'
      and p_patch->>'draftId'=d.id::text and p_patch->'baseRevision'=to_jsonb(d.revision)
      and jsonb_typeof(p_patch->'changes')='array') is not true then raise exception 'invalid_input'; end if;
  if jsonb_array_length(p_patch->'changes') not between 1 and 16 then raise exception 'invalid_input'; end if;
  for change in select value from jsonb_array_elements(p_patch->'changes') loop
    if jsonb_typeof(change) is distinct from 'object' then raise exception 'invalid_input'; end if;
    if (change ?& array['op','value'] and jsonb_typeof(change->'op')='string') is not true then raise exception 'invalid_input'; end if;
    if change->>'op'='setPublicText' then
      field:=change->>'field';
      if (change-array['op','field','value']='{}'::jsonb and jsonb_typeof(change->'field')='string'
          and field in ('name','summary','overview','version')) is not true then raise exception 'invalid_input'; end if;
      pub:=jsonb_set(pub,array[field],change->'value'); field:='public.'||field;
    elsif change->>'op'='setDraftRole' then
      if change-array['op','value']<>'{}'::jsonb then raise exception 'invalid_input'; end if;
      cfg:=jsonb_set(cfg,'{role}',change->'value'); field:='role';
    elsif change->>'op'='setSetup' then
      if change-array['op','value']<>'{}'::jsonb then raise exception 'invalid_input'; end if;
      cfg:=case when change->'value'='null'::jsonb then cfg-'setup' else jsonb_set(cfg,'{setup}',change->'value') end; field:='setup';
    else raise exception 'invalid_input'; end if;
    if field=any(touched) then raise exception 'invalid_input'; end if;
    touched:=array_append(touched,field);
  end loop;
  perform recipe_private.check_fields(pub,cfg,false);
  return jsonb_build_object('public',pub,'config',cfg);
end $$;

create function recipe_private.write_authoring_draft(a uuid,p_draft uuid,p_expected int,p_body jsonb) returns jsonb
language plpgsql set search_path=pg_catalog,pg_temp as $$
declare d recipe_private.drafts; bytes_new int; other_bytes bigint; other_count int;
begin
  if jsonb_typeof(p_body) is distinct from 'object' or p_body-array['public','config']<>'{}'::jsonb then raise exception 'invalid_input'; end if;
  perform recipe_private.check_fields(p_body->'public',p_body->'config',false);
  bytes_new:=octet_length(p_body::text);
  if p_expected<>0 then
    select * into d from recipe_private.drafts where id=p_draft and owner_id=a for update;
    if not found or d.revision is distinct from p_expected then raise exception 'conflict'; end if;
  end if;
  if bytes_new>1048576 and (p_expected=0 or bytes_new>d.bytes) then raise exception 'quota_exceeded'; end if;
  select count(*),coalesce(sum(bytes),0) into other_count,other_bytes from recipe_private.drafts where owner_id=a and id<>p_draft;
  if (p_expected=0 and other_count>=20) or (other_bytes+bytes_new>10485760 and (p_expected=0 or bytes_new>d.bytes)) then
    raise exception 'quota_exceeded'; end if;
  if p_expected=0 then
    if (select count(*) from recipe_private.drafts where owner_id=a and created_at>=date_trunc('day',statement_timestamp(),'UTC'))
      +(select count(*) from recipe_private.retired_drafts where owner_id=a and created_at>=date_trunc('day',statement_timestamp(),'UTC'))>=100 then
      raise exception 'rate_limited'; end if;
    if exists(select from recipe_private.retired_drafts where id=p_draft) or exists(select from recipe_private.recipes where id=p_draft) then raise exception 'conflict'; end if;
    insert into recipe_private.drafts(id,owner_id,recipe_id,base_revision,revision,public_info,config,bytes)
      values(p_draft,a,p_draft,0,1,p_body->'public',p_body->'config',bytes_new) returning * into d;
  else
    update recipe_private.drafts set revision=revision+1,public_info=p_body->'public',config=p_body->'config',bytes=bytes_new
      where id=p_draft and owner_id=a and revision=p_expected returning * into d;
    if not found then raise exception 'conflict'; end if;
  end if;
  return jsonb_build_object('draftId',d.id,'revision',d.revision);
end $$;

create function recipe_api.patch_draft(p_draft uuid,p_patch jsonb,p_request uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid:=recipe_private.actor(); replay jsonb; d recipe_private.drafts; body jsonb; result jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(a::text,187511));
  delete from recipe_private.receipts where actor=a and action='patch' and created_at<clock_timestamp()-interval '7 days';
  replay:=recipe_private.prior(a,'patch',p_request,jsonb_build_array(p_draft,p_patch));
  if replay is not null then return replay; end if;
  perform recipe_private.check_operation_birth(p_request);
  if (select count(*) from recipe_private.receipts where actor=a and action='patch'
      and created_at>=date_trunc('day',statement_timestamp(),'UTC'))>=600 then raise exception 'rate_limited'; end if;
  select * into d from recipe_private.drafts where id=p_draft and owner_id=a for update;
  if not found then raise exception 'not_found'; end if;
  if p_patch->'baseRevision' is distinct from to_jsonb(d.revision) then raise exception 'conflict'; end if;
  body:=recipe_private.apply_draft_patch(d,p_patch);
  result:=recipe_private.write_authoring_draft(a,p_draft,d.revision,body);
  return recipe_private.remember(a,'patch',p_request,jsonb_build_array(p_draft,p_patch),result,p_draft);
end $$;

create function recipe_api.possess_authoring(p_id uuid,p_ticket bytea,p_nonce bytea,p_proof bytea,p_payload bytea,p_stage text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid; account_status text; op recipe_private.authoring_operations; cap recipe_private.authoring_capabilities;
  body jsonb; d recipe_private.drafts; result jsonb; now_ms bigint;
begin
  if octet_length(p_ticket) is distinct from 32 or octet_length(p_nonce) is distinct from 32
      or octet_length(p_proof) is distinct from 32 or p_stage is null or p_stage not in ('dispatch','accept') then raise exception 'invalid_operation_proof'; end if;
  select account_id into a from recipe_private.authoring_operations where id=p_id;
  if not found then perform recipe_private.check_operation_birth(p_id); raise exception 'not_found'; end if;
  select status into account_status from recipe_private.accounts where id=a for share;
  if account_status is distinct from 'active' then raise exception 'account_disabled'; end if;
  perform pg_advisory_xact_lock(hashtextextended(a::text,187511));
  select * into op from recipe_private.authoring_operations where id=p_id for update;
  if not found then raise exception 'operation_expired'; end if;
  select * into cap from recipe_private.authoring_capabilities where operation_id=p_id and stage=p_stage;
  if not found or sha256(cap.ticket) is distinct from sha256(p_ticket) or cap.proof_hash is distinct from sha256(p_proof)
      or recipe_private.b64url(sha256(p_nonce)) is distinct from op.nonce_commitment then raise exception 'invalid_operation_proof'; end if;
  if op.terminal_at<clock_timestamp()-interval '7 days' then raise exception 'operation_expired'; end if;
  now_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
  if op.state='expired' or (op.expires_at<=clock_timestamp()
      and (op.state in ('registered','dispatched') or (op.state='accepted' and p_stage='dispatch'))) then
    raise exception 'operation_expired'; end if;
  if p_stage='accept' then
    if p_payload is null or octet_length(p_payload)>131072 then raise exception 'invalid_input'; end if;
    if sha256(p_payload) is distinct from cap.payload_digest then raise exception 'conflict'; end if;
    if op.state='accepted' then return op.receipt; end if;
  elsif p_payload is not null then raise exception 'invalid_input';
  elsif op.state in ('dispatched','accepted') then
    return jsonb_build_object('operationId',op.id,'status','dispatched','stateRevision',2);
  end if;
  if op.state='cancelled' then raise exception 'operation_cancelled'; end if;
  if cap.deadline<=now_ms then raise exception 'operation_expired'; end if;
  if (cap.binding->>'stateRevision')::int is distinct from op.revision
      or op.state<>(case when p_stage='dispatch' then 'registered' else 'dispatched' end) then raise exception 'conflict'; end if;
  if p_stage='dispatch' then
    update recipe_private.authoring_operations set state='dispatched',revision=revision+1 where id=p_id;
    return jsonb_build_object('operationId',op.id,'status','dispatched','stateRevision',2);
  end if;
  begin body:=convert_from(p_payload,'UTF8')::jsonb;
  exception when others then raise exception 'invalid_input'; end;
  if op.purpose='prepareDraft' then
    result:=recipe_private.write_authoring_draft(a,gen_random_uuid(),0,body);
  else
    select * into d from recipe_private.drafts where id=op.draft_id and owner_id=a for update;
    if not found or d.revision is distinct from op.base_revision then raise exception 'conflict'; end if;
    body:=recipe_private.apply_draft_patch(d,body);
    result:=recipe_private.write_authoring_draft(a,d.id,d.revision,body);
  end if;
  result:=result||jsonb_build_object('operationId',op.id,'status','accepted','stateRevision',op.revision+1);
  update recipe_private.authoring_operations set state='accepted',revision=revision+1,terminal_at=clock_timestamp(),receipt=result where id=p_id;
  return result;
end $$;

grant execute on function recipe_api.register_authoring(uuid,jsonb),recipe_api.get_authoring(uuid),recipe_api.cancel_authoring(uuid),
  recipe_api.authoring_context(uuid,jsonb),recipe_api.authorize_authoring(uuid,jsonb,bytea,bytea,bytea,bigint),
  recipe_api.possess_authoring(uuid,bytea,bytea,bytea,bytea,text),recipe_api.patch_draft(uuid,jsonb,uuid) to recipe_api;
reset role;
revoke recipe_owner from current_user;
