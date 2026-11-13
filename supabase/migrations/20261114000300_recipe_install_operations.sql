grant recipe_owner to current_user;
set local role recipe_owner;

create table recipe_private.install_operations (
  id uuid primary key,
  account_id uuid not null references recipe_private.accounts,
  created_at timestamptz not null default clock_timestamp(),
  state text not null check (state in ('authorized','redeemed','applied','rejected','cancelled')),
  request_digest bytea,
  version_id uuid references recipe_private.versions,
  binding jsonb,
  ticket bytea,
  expected_proof_hash bytea,
  deadline bigint,
  check (((request_digest is null and state='cancelled' and version_id is null and binding is null
          and ticket is null and expected_proof_hash is null and deadline is null)
      or (octet_length(request_digest)=32 and version_id is not null and jsonb_typeof(binding)='object'
          and octet_length(ticket)=32 and octet_length(expected_proof_hash)=32 and deadline is not null)) is true)
);
create index install_operations_account_created on recipe_private.install_operations(account_id,created_at);
alter table recipe_private.install_operations enable row level security;

create function recipe_private.install_version(a uuid,p_version uuid) returns recipe_private.versions
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare v recipe_private.versions;
begin
  select * into v from recipe_private.versions where id=p_version for share;
  if not found then raise exception 'not_found'; end if;
  if a<>v.owner_id then
    perform 1 from recipe_private.grants where actor=a and version_id=v.id for share;
    if not found then raise exception 'forbidden'; end if;
  end if;
  return v;
end $$;

create function recipe_private.install_manifest(v recipe_private.versions) returns bytea
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select convert_to((jsonb_build_object('schema',1,'recipeId',v.recipe_id,'versionId',v.id,
    'authorId',v.owner_id,'revision',v.revision,'access',v.public_info->>'access','role',v.config->>'role')
    || case when v.config ? 'setup' then jsonb_build_object('setup',v.config->'setup') else '{}'::jsonb end)::text,'UTF8')
$$;

create function recipe_private.b64url(bytes bytea) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select rtrim(translate(replace(encode(bytes,'base64'),E'\n',''),'+/','-_'),'=')
$$;

create function recipe_api.install_preview(p_version uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare a uuid := recipe_private.actor(); v recipe_private.versions; manifest bytea;
begin
  v := recipe_private.install_version(a,p_version);
  manifest := recipe_private.install_manifest(v);
  return jsonb_build_object('accountId',a,'recipeId',v.recipe_id,'versionId',v.id,
    'manifest',recipe_private.b64url(manifest),'manifestSha256',encode(sha256(manifest),'hex'));
end $$;

create function recipe_api.operation_context() returns jsonb
language sql security definer set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('accountId',recipe_private.actor(),
    'deadline',floor(extract(epoch from clock_timestamp())*1000)::bigint+300000)
$$;

create function recipe_private.check_operation_birth(p_id uuid) returns void
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare born bigint; now_ms bigint := floor(extract(epoch from clock_timestamp())*1000)::bigint;
begin
  if p_id is null or p_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'invalid_input';
  end if;
  born := ('x'||substr(replace(p_id::text,'-',''),1,12))::bit(48)::bigint;
  if born < now_ms-300000 then raise exception 'operation_expired'; end if;
  if born > now_ms+120000 then raise exception 'operation_clock_skew'; end if;
end $$;

create function recipe_private.new_operation(a uuid,p_id uuid) returns void
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  perform recipe_private.check_operation_birth(p_id);
  if (select count(*) from recipe_private.install_operations where account_id=a
      and created_at>=date_trunc('day',statement_timestamp(),'UTC')) >=60 then raise exception 'rate_limited'; end if;
end $$;

create function recipe_api.authorize_operation(p_id uuid,p_request jsonb,p_server_key bytea,
    p_ticket bytea,p_proof_hash bytea,p_deadline bigint) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare a uuid := recipe_private.actor(); op recipe_private.install_operations; v recipe_private.versions;
  digest bytea; now_ms bigint;
  manifest bytea; result jsonb;
begin
  if jsonb_typeof(p_request) is distinct from 'object' then raise exception 'invalid_input'; end if;
  if (p_request - array['purpose','versionId','manifestSha256','targetPublicKey','nonceCommitment','generation']='{}'::jsonb
     and p_request ?& array['purpose','versionId','manifestSha256','targetPublicKey','nonceCommitment','generation']
     and not exists(select from jsonb_each(p_request) where key<>'generation' and jsonb_typeof(value)<>'string')
     and p_request->>'purpose'='installBoundRole' and p_request->'generation'='1'::jsonb
     and p_request->>'versionId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     and p_request->>'manifestSha256' ~ '^[0-9a-f]{64}$'
     and p_request->>'targetPublicKey' ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'
     and p_request->>'nonceCommitment' ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$') is not true
     or octet_length(p_server_key) is distinct from 32 or octet_length(p_ticket) is distinct from 32
     or octet_length(p_proof_hash) is distinct from 32 or p_deadline is null then raise exception 'invalid_input'; end if;
  digest := sha256(convert_to(p_request::text,'UTF8'));
  perform pg_advisory_xact_lock(hashtextextended(a::text,187511));
  delete from recipe_private.install_operations where account_id=a and created_at < clock_timestamp()-interval '7 days';
  select * into op from recipe_private.install_operations where id=p_id for update;
  now_ms := floor(extract(epoch from clock_timestamp())*1000)::bigint;
  if found then
    if op.account_id<>a then raise exception 'not_found'; end if;
    if op.state='cancelled' then raise exception 'operation_cancelled'; end if;
    if op.request_digest is distinct from digest then raise exception 'conflict'; end if;
    if op.state='authorized' and op.deadline<now_ms then raise exception 'operation_expired'; end if;
    perform recipe_private.install_version(a,op.version_id);
    return op.binding || jsonb_build_object('ticket',recipe_private.b64url(op.ticket),'status',op.state);
  end if;
  perform recipe_private.new_operation(a,p_id);
  if p_deadline<now_ms or p_deadline>now_ms+300000 then raise exception 'invalid_input'; end if;
  if (select count(*) from recipe_private.install_operations where account_id=a
      and (state='redeemed' or (state='authorized' and deadline>=now_ms)))>=3 then raise exception 'operation_pending_limit'; end if;
  v := recipe_private.install_version(a,(p_request->>'versionId')::uuid);
  manifest := recipe_private.install_manifest(v);
  if encode(sha256(manifest),'hex')<>p_request->>'manifestSha256' then raise exception 'conflict'; end if;
  result := p_request || jsonb_build_object('operationId',p_id,'accountId',a,
    'deadline',p_deadline,'serverPublicKey',recipe_private.b64url(p_server_key));
  insert into recipe_private.install_operations(id,account_id,state,request_digest,version_id,binding,ticket,expected_proof_hash,deadline)
    values(p_id,a,'authorized',digest,v.id,result,p_ticket,p_proof_hash,p_deadline) on conflict do nothing;
  if not found then raise exception 'conflict'; end if;
  return result || jsonb_build_object('ticket',recipe_private.b64url(p_ticket),'status','authorized');
end $$;

create function recipe_api.cancel_operation(p_id uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare a uuid := recipe_private.actor(); op recipe_private.install_operations;
begin
  perform pg_advisory_xact_lock(hashtextextended(a::text,187511));
  delete from recipe_private.install_operations where account_id=a and created_at < clock_timestamp()-interval '7 days';
  select * into op from recipe_private.install_operations where id=p_id for update;
  if found then
    if op.account_id<>a then raise exception 'not_found'; end if;
    if op.state='authorized' then update recipe_private.install_operations set state='cancelled' where id=p_id; op.state := 'cancelled'; end if;
  else
    perform recipe_private.new_operation(a,p_id);
    insert into recipe_private.install_operations(id,account_id,state) values(p_id,a,'cancelled') on conflict do nothing;
    if not found then raise exception 'conflict'; end if;
    op.state := 'cancelled';
  end if;
  return jsonb_build_object('operationId',p_id,'status',case when op.state='redeemed' then 'in_progress' else op.state end);
end $$;

create function recipe_api.possess_operation(p_id uuid,p_ticket bytea,p_nonce bytea,p_proof bytea,p_outcome text default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare a uuid; account_status text; op recipe_private.install_operations; v recipe_private.versions; manifest bytea;
begin
  if octet_length(p_ticket) is distinct from 32 or octet_length(p_nonce) is distinct from 32
     or octet_length(p_proof) is distinct from 32 then raise exception 'invalid_operation_proof'; end if;
  select account_id into a from recipe_private.install_operations where id=p_id;
  if not found then
    perform recipe_private.check_operation_birth(p_id);
    raise exception 'not_found';
  end if;
  select status into account_status from recipe_private.accounts where id=a for share;
  perform pg_advisory_xact_lock(hashtextextended(a::text,187511));
  select * into op from recipe_private.install_operations where id=p_id for update;
  if not found then raise exception 'operation_expired'; end if;
  if op.created_at < clock_timestamp()-interval '7 days' then raise exception 'operation_expired'; end if;
  if op.ticket is null or sha256(op.ticket) is distinct from sha256(p_ticket)
     or op.expected_proof_hash is distinct from sha256(p_proof)
     or recipe_private.b64url(sha256(p_nonce)) is distinct from op.binding->>'nonceCommitment' then raise exception 'invalid_operation_proof'; end if;
  if account_status is distinct from 'active' then raise exception 'account_disabled'; end if;
  if op.state='cancelled' then raise exception 'operation_cancelled'; end if;
  v := recipe_private.install_version(a,op.version_id);
  if p_outcome is not null then
    if p_outcome not in ('applied','rejected') then raise exception 'invalid_input'; end if;
    if op.state='authorized' then raise exception 'conflict'; end if;
    if op.state in ('applied','rejected') and op.state<>p_outcome then raise exception 'conflict'; end if;
    update recipe_private.install_operations set state=p_outcome where id=p_id;
    return jsonb_build_object('operationId',p_id,'status',p_outcome);
  end if;
  if op.state='authorized' then
    if op.deadline < floor(extract(epoch from clock_timestamp())*1000)::bigint then raise exception 'operation_expired'; end if;
    update recipe_private.install_operations set state='redeemed' where id=p_id;
    op.state := 'redeemed';
  end if;
  manifest := recipe_private.install_manifest(v);
  if encode(sha256(manifest),'hex')<>op.binding->>'manifestSha256' then raise exception 'conflict'; end if;
  return op.binding || jsonb_build_object('manifest',recipe_private.b64url(manifest),'status',op.state);
end $$;

grant execute on function recipe_api.install_preview(uuid), recipe_api.operation_context(),
  recipe_api.authorize_operation(uuid,jsonb,bytea,bytea,bytea,bigint), recipe_api.cancel_operation(uuid),
  recipe_api.possess_operation(uuid,bytea,bytea,bytea,text) to recipe_api;
reset role;
revoke recipe_owner from current_user;
