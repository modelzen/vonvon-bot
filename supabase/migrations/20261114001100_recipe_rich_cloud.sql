grant recipe_owner to current_user;
set local role recipe_owner;
alter table recipe_private.drafts add column retained_candidate_bytes integer not null default 0 check(retained_candidate_bytes between 0 and 1048576);
alter table recipe_private.drafts drop constraint drafts_bytes_check;
alter table recipe_private.drafts add check (bytes-retained_candidate_bytes between 0 and 1048576);


create table recipe_private.rich_intents (
  id uuid primary key references recipe_private.authoring_operations on delete cascade,
  account_id uuid not null references recipe_private.accounts, draft_id uuid not null,
  seed uuid not null default gen_random_uuid(), input_hash text, manifest_hash text, payload_hash text,
  access text check(access in ('direct','coded')), parent_version uuid references recipe_private.versions,
  reviewed_items jsonb
);
create table recipe_private.rich_drafts (
  id uuid primary key references recipe_private.drafts on delete cascade,
  manifest_id uuid not null references recipe_private.object_attempts, items jsonb not null, retained_bytes int not null default 0, parent_version uuid references recipe_private.versions
);
create table recipe_private.rich_candidates(
  source_intent uuid primary key, owner_id uuid not null references recipe_private.accounts,
  draft_id uuid not null unique references recipe_private.drafts on delete cascade, manifest_id uuid not null references recipe_private.object_attempts, content_hash text not null, items jsonb not null
);
alter table recipe_private.rich_candidates enable row level security;
create table recipe_private.rich_versions (
  id uuid primary key references recipe_private.versions,
  manifest_id uuid not null references recipe_private.object_attempts,
  state text not null default 'listed' check(state in ('listed','withdrawn','banned')),
  parent_version uuid references recipe_private.versions
);
create table recipe_private.rich_origins (
  id uuid primary key, account_id uuid not null references recipe_private.accounts,
  kind text not null, intent uuid not null, candidate uuid not null, baseline text not null,
  parent_version uuid references recipe_private.rich_versions, parent_item uuid, parent_digest text,
  donor uuid references recipe_private.rich_origins,
  check((parent_version is null)=(parent_item is null) and (parent_version is null)=(parent_digest is null)),
  check(parent_version is null or donor is null)
);
create table recipe_private.rich_members (
  version_id uuid not null references recipe_private.rich_versions, item_id uuid not null,
  origin_id uuid not null references recipe_private.rich_origins, kind text not null, baseline text not null, fingerprint text not null,
  primary key(version_id,item_id)
);
create index rich_member_digest on recipe_private.rich_members(kind,fingerprint);
create table recipe_private.rich_parent_edges(
 origin uuid not null references recipe_private.rich_origins on delete cascade,
 version_id uuid not null, item_id uuid not null, baseline text not null,
 foreign key(version_id,item_id) references recipe_private.rich_members,
 primary key(origin,version_id,item_id));
alter table recipe_private.rich_parent_edges enable row level security;
create table recipe_private.rich_feature (
  singleton boolean primary key check(singleton), version_id uuid not null references recipe_private.rich_versions,
  editor uuid not null references recipe_private.accounts
);
create table recipe_private.creator_profiles(account_id uuid primary key references recipe_private.accounts,display_name text not null);
alter table recipe_private.rich_intents enable row level security;
alter table recipe_private.rich_drafts enable row level security;
alter table recipe_private.rich_versions enable row level security;
alter table recipe_private.rich_origins enable row level security;
alter table recipe_private.rich_members enable row level security;
alter table recipe_private.rich_feature enable row level security;
alter table recipe_private.creator_profiles enable row level security;

create function recipe_private.rich_scope(p_id uuid,p_rich boolean) returns void
language plpgsql stable set search_path=pg_catalog,pg_temp as $$
begin
  if exists(select from recipe_private.rich_intents where id=p_id)<>p_rich then raise exception 'not_found'; end if;
end $$;

alter function recipe_api.register_authoring(uuid,jsonb) rename to register_authoring_core;
alter function recipe_api.register_authoring_core(uuid,jsonb) set schema recipe_private;
revoke execute on function recipe_private.register_authoring_core(uuid,jsonb) from recipe_api;
create function recipe_api.register_authoring(p_id uuid,p_request jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(recipe_private.actor()::text,187511));
  perform recipe_private.rich_scope(p_id,false);
  if exists(select from recipe_private.rich_drafts where id=(p_request->>'draftId')::uuid) then raise exception 'not_found'; end if;
  return recipe_private.register_authoring_core(p_id,p_request);
end $$;

create function recipe_api.rich_register(p_id uuid,p_request jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid:=recipe_private.actor(); r jsonb; dest uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(a::text,187511));
  if p_request->>'format' is distinct from 'rich-v2' then raise exception 'invalid_input'; end if;
  if exists(select from recipe_private.authoring_operations where id=p_id) then perform recipe_private.rich_scope(p_id,true); end if;
  dest:=coalesce((p_request->>'draftId')::uuid,gen_random_uuid());
  if p_request->>'purpose'='editDraft' and not exists(select from recipe_private.rich_drafts where id=dest) then raise exception 'not_found'; end if;
  r:=recipe_private.register_authoring_core(p_id,p_request-'format');
  insert into recipe_private.rich_intents(id,account_id,draft_id) values(p_id,a,dest) on conflict do nothing;
  select draft_id into strict dest from recipe_private.rich_intents where id=p_id and account_id=a;
  return r||jsonb_build_object('format','rich-v2','destinationDraftId',dest);
end $$;


alter function recipe_api.get_authoring(uuid) rename to get_authoring_core;
alter function recipe_api.get_authoring_core(uuid) set schema recipe_private;
revoke execute on function recipe_private.get_authoring_core(uuid) from recipe_api;
create function recipe_api.get_authoring(p_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
  perform recipe_private.rich_scope(p_id,false);
  return recipe_private.get_authoring_core($1);
end $$;

alter function recipe_api.recover_authoring(uuid) rename to recover_authoring_core;
alter function recipe_api.recover_authoring_core(uuid) set schema recipe_private;
revoke execute on function recipe_private.recover_authoring_core(uuid) from recipe_api;
create function recipe_api.recover_authoring(p_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
  perform recipe_private.rich_scope(p_id,false);
  return recipe_private.recover_authoring_core($1);
end $$;

alter function recipe_api.cancel_authoring(uuid) rename to cancel_authoring_core;
alter function recipe_api.cancel_authoring_core(uuid) set schema recipe_private;
revoke execute on function recipe_private.cancel_authoring_core(uuid) from recipe_api;
create function recipe_api.cancel_authoring(p_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
  perform recipe_private.rich_scope(p_id,false);
  return recipe_private.cancel_authoring_core($1);
end $$;

alter function recipe_api.authoring_context(uuid,jsonb) rename to authoring_context_core;
alter function recipe_api.authoring_context_core(uuid,jsonb) set schema recipe_private;
revoke execute on function recipe_private.authoring_context_core(uuid,jsonb) from recipe_api;
create function recipe_api.authoring_context(p_id uuid,p_request jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
  perform recipe_private.rich_scope(p_id,false);
  return recipe_private.authoring_context_core($1,$2);
end $$;

alter function recipe_api.authorize_authoring(uuid,jsonb,bytea,bytea,bytea,bigint) rename to authorize_authoring_core;
alter function recipe_api.authorize_authoring_core(uuid,jsonb,bytea,bytea,bytea,bigint) set schema recipe_private;
revoke execute on function recipe_private.authorize_authoring_core(uuid,jsonb,bytea,bytea,bytea,bigint) from recipe_api;
create function recipe_api.authorize_authoring(p_id uuid,p_request jsonb,p_server_key bytea,p_ticket bytea,p_proof_hash bytea,p_deadline bigint) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
  perform recipe_private.rich_scope(p_id,false);
  return recipe_private.authorize_authoring_core($1,$2,$3,$4,$5,$6);
end $$;

alter function recipe_api.possess_authoring(uuid,bytea,bytea,bytea,bytea,text) rename to possess_authoring_core;
alter function recipe_api.possess_authoring_core(uuid,bytea,bytea,bytea,bytea,text) set schema recipe_private;
revoke execute on function recipe_private.possess_authoring_core(uuid,bytea,bytea,bytea,bytea,text) from recipe_api;
create function recipe_api.possess_authoring(p_id uuid,p_ticket bytea,p_nonce bytea,p_proof bytea,p_payload bytea,p_stage text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
  perform recipe_private.rich_scope(p_id,false);
  return recipe_private.possess_authoring_core($1,$2,$3,$4,$5,$6);
end $$;

do $bind$
declare src text:=pg_get_functiondef('recipe_private.authorize_authoring_core(uuid,jsonb,bytea,bytea,bytea,bigint)'::regprocedure);
begin
  if strpos(src,'context jsonb:=recipe_api.authoring_context(')=0 then raise exception 'unexpected_v1_authorize_definition'; end if;
  execute replace(src,'context jsonb:=recipe_api.authoring_context(','context jsonb:=recipe_private.authoring_context_core(');
end $bind$;

create function recipe_api.rich_op_context(p_id uuid,p_action text,p_request jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid:=recipe_private.actor(); r jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(a::text,187511));
  if p_action='recover' and not exists(select from recipe_private.authoring_operations where id=p_id) then
    return recipe_private.recover_authoring_core(p_id)||jsonb_build_object('format','rich-v2');
  end if;
  if p_action='cancel' and not exists(select from recipe_private.authoring_operations where id=p_id) then
    r:=recipe_private.cancel_authoring_core(p_id);
    insert into recipe_private.rich_intents(id,account_id,draft_id) values(p_id,a,gen_random_uuid());
    return r||jsonb_build_object('format','rich-v2');
  end if;
  perform recipe_private.rich_scope(p_id,true);
  if p_action='context' then
    r:=recipe_private.authoring_context_core(p_id,p_request);
    if p_request->>'stage'='accept' and not exists(select from recipe_private.rich_intents where id=p_id and payload_hash=p_request->>'payloadDigest')
      then raise exception 'conflict'; end if;
  elsif p_action='cancel' then r:=recipe_private.cancel_authoring_core(p_id);
  elsif p_action in ('get','recover') then r:=recipe_private.get_authoring_core(p_id);
  else raise exception 'invalid_input'; end if;
  if p_action='context' and p_request->>'stage'='accept' then
    r:=r||jsonb_build_object('sourceReviewSha256',(select input_hash from recipe_private.rich_intents where id=p_id));
  end if;
  return r||jsonb_build_object('format','rich-v2');
end $$;
create function recipe_api.rich_authorize(p_id uuid,p_request jsonb,p_server bytea,p_ticket bytea,p_proof bytea,p_deadline bigint) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
  perform recipe_api.rich_op_context(p_id,'context',p_request);

  return recipe_private.authorize_authoring_core(p_id,p_request,p_server,p_ticket,p_proof,p_deadline)||jsonb_build_object('format','rich-v2')
    ||case when p_request->>'stage'='accept' then jsonb_build_object('sourceReviewSha256',(select input_hash from recipe_private.rich_intents where id=p_id)) else '{}'::jsonb end;
end $$;

create function recipe_api.rich_dispatch(p_id uuid,p_ticket bytea,p_nonce bytea,p_proof bytea) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
  perform recipe_private.rich_scope(p_id,true);
  return recipe_private.possess_authoring_core(p_id,p_ticket,p_nonce,p_proof,null,'dispatch')||jsonb_build_object('format','rich-v2');
end $$;

create function recipe_api.rich_plan_context(p_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid:=recipe_private.actor(); i recipe_private.rich_intents; op recipe_private.authoring_operations; d recipe_private.drafts;
begin
  perform pg_advisory_xact_lock(hashtextextended(a::text,187511));
  perform recipe_private.maintain_authoring(a);
  select * into i from recipe_private.rich_intents where id=p_id and account_id=a;
  if not found then raise exception 'not_found'; end if;
  select * into strict op from recipe_private.authoring_operations where id=i.id for update;
  if op.state<>'dispatched' then raise exception 'conflict'; end if;
  select * into d from recipe_private.drafts where id=i.draft_id and owner_id=a;
  if op.purpose='editDraft' and (d.id is null or d.revision<>op.base_revision) then raise exception 'conflict'; end if;
  return jsonb_build_object('seed',i.seed,'draftId',i.draft_id,'purpose',op.purpose,'revision',op.base_revision,
    'sourceIntentId',d.source_operation_id,'access',d.public_info->>'access','manifest',(select recipe_private.object_descriptor(a,r.manifest_id)
    from recipe_private.rich_drafts r where r.id=d.id));
end $$;

create function recipe_private.check_rich_origin(a uuid,o uuid,k text) returns void
language plpgsql set search_path=pg_catalog,pg_temp as $$
declare n int:=0; seen uuid[]:='{}'; todo uuid[]:=array[o]; accounts uuid[]:=array[a];
  r recipe_private.rich_origins; v recipe_private.versions; m recipe_private.rich_members; edge record; lifecycle text; principal uuid;
begin
  while cardinality(todo)>0 loop
    o:=todo[1];principal:=accounts[1];todo:=todo[2:];accounts:=accounts[2:];
    select * into r from recipe_private.rich_origins where id=o and account_id=principal and kind=k;
    if not found then raise exception 'source_unavailable'; end if;
    if o=any(seen) then continue; end if;
    seen:=array_append(seen,o);n:=n+1;
    if n>64 then raise exception 'source_unavailable'; end if;
    if r.donor is not null then todo:=array_append(todo,r.donor);accounts:=array_append(accounts,principal); end if;
    for edge in select r.parent_version as version_id,r.parent_item as item_id,r.parent_digest as baseline where r.parent_version is not null
      union all select e.version_id,e.item_id,e.baseline from recipe_private.rich_parent_edges e where e.origin=r.id loop
      select * into v from recipe_private.versions where id=edge.version_id;
      select state into lifecycle from recipe_private.rich_versions where id=v.id for share;
      select * into m from recipe_private.rich_members where version_id=v.id and item_id=edge.item_id;
      if not found or m.kind<>k or m.baseline<>edge.baseline or lifecycle is distinct from 'listed'
        or (v.owner_id<>a and (v.public_info->>'access'='coded' or k='finalLogo')) then raise exception 'source_unavailable'; end if;
      todo:=array_append(todo,m.origin_id);accounts:=array_append(accounts,v.owner_id);
      if cardinality(todo)>64 then raise exception 'source_unavailable'; end if;
    end loop;
  end loop;
end $$;

create function recipe_private.check_rich_logo(a uuid,items jsonb,parent uuid) returns void
language plpgsql set search_path=pg_catalog,pg_temp as $$
begin
  if exists(
    with recursive ancestry(kind,id) as (
      select 'origin'::text,(x->>'originId')::uuid from jsonb_array_elements(items) x
      union select 'version',parent where parent is not null
      union
      select next.kind,next.id from ancestry n cross join lateral (
        select 'origin'::text kind,o.donor id from recipe_private.rich_origins o where n.kind='origin' and o.id=n.id and o.donor is not null
        union select 'version',o.parent_version from recipe_private.rich_origins o where n.kind='origin' and o.id=n.id and o.parent_version is not null
        union select 'version',e.version_id from recipe_private.rich_parent_edges e where n.kind='origin' and e.origin=n.id
        union select 'origin',m.origin_id from recipe_private.rich_members m where n.kind='version' and m.version_id=n.id
        union select 'version',v.parent_version from recipe_private.rich_versions v where n.kind='version' and v.id=n.id and v.parent_version is not null
      ) next
    )
    select from ancestry n join recipe_private.versions v on n.kind='version' and v.id=n.id and v.owner_id<>a
      join recipe_private.rich_members m on m.version_id=v.id and m.kind='finalLogo'
      join jsonb_array_elements(items) x on x->>'kind'='finalLogo' and x->>'contentFingerprint'=m.fingerprint
  ) then raise exception 'source_unavailable'; end if;
end $$;

create function recipe_private.prune_intent_origins() returns trigger language plpgsql set search_path=pg_catalog,pg_temp as $$
begin
  if old.state<>'accepted' then delete from recipe_private.rich_origins where intent=old.id; end if;
  return null;
end $$;
create trigger prune_intent_origins after delete on recipe_private.authoring_operations for each row execute function recipe_private.prune_intent_origins();

create function recipe_api.rich_save_plan(p_id uuid,p_inputs text,p_manifest text,p_payload text,p_access text,p_parent uuid,p_records jsonb,p_items jsonb) returns void
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid:=recipe_private.actor(); i recipe_private.rich_intents; row jsonb; src jsonb; edge jsonb;
begin
  perform recipe_api.rich_plan_context(p_id);
  select * into strict i from recipe_private.rich_intents where id=p_id;
  if i.input_hash is not null and (i.input_hash,i.manifest_hash,i.payload_hash) is distinct from (p_inputs,p_manifest,p_payload) then raise exception 'conflict'; end if;
  if p_access not in ('direct','coded') or p_inputs!~'^[a-f0-9]{64}$' or p_manifest!~'^[a-f0-9]{64}$' or p_payload!~'^[a-f0-9]{64}$'
    or jsonb_array_length(p_records)>320 or jsonb_array_length(p_items) not between 4 and 320 then raise exception 'invalid_input'; end if;
  if p_parent is not null and not exists(select from recipe_private.versions v join recipe_private.recipes r on r.id=v.recipe_id and r.revision=v.revision
    join recipe_private.rich_versions rv on rv.id=v.id and rv.state='listed' where v.id=p_parent and v.owner_id=a) then raise exception 'source_unavailable'; end if;
  for row in select value from jsonb_array_elements(p_records) loop
    src:=row->'source';
    if src->>'kind'='accountClaim' then
      if row->>'kind' in ('role','rule','skill','file','task','memory','setup','finalLogo') and exists(
        select from recipe_private.rich_members m join recipe_private.versions v on v.id=m.version_id
        join recipe_private.grants g on g.version_id=v.id and g.actor=a
        where v.owner_id<>a and v.public_info->>'access'='coded' and m.kind=row->>'kind' and m.fingerprint=row->>'contentFingerprint')
        then raise exception 'source_unavailable'; end if;
    elsif src->>'kind'='releaseItem' then
      if not exists(select from recipe_private.rich_members m where m.version_id=(src->>'versionId')::uuid
         and m.item_id=(src->>'itemId')::uuid and m.baseline=src->>'baselineSha256' and m.kind=row->>'kind') then raise exception 'source_unavailable'; end if;
    elsif src->>'kind'='releaseItems' then
      if jsonb_array_length(src->'parents') not between 1 and 64 then raise exception 'source_unavailable'; end if;
      for edge in select value from jsonb_array_elements(src->'parents') loop
        if not exists(select from recipe_private.rich_members m where m.version_id=(edge->>'versionId')::uuid and m.item_id=(edge->>'itemId')::uuid
          and m.kind=row->>'kind' and m.baseline=edge->>'baselineSha256') then raise exception 'source_unavailable'; end if;
      end loop;
    elsif row->>'donorOriginId' is null then raise exception 'source_unavailable'; end if;
    insert into recipe_private.rich_origins(id,account_id,kind,intent,candidate,baseline,parent_version,parent_item,parent_digest,donor)
    values((row->>'originId')::uuid,a,row->>'kind',p_id,coalesce((row->>'candidateId')::uuid,(row->>'itemId')::uuid),row->>'baselineSha256',
      (src->>'versionId')::uuid,(src->>'itemId')::uuid,src->>'baselineSha256',(row->>'donorOriginId')::uuid) on conflict do nothing;
    if src->>'kind'='releaseItems' then
      insert into recipe_private.rich_parent_edges select (row->>'originId')::uuid,(e->>'versionId')::uuid,(e->>'itemId')::uuid,e->>'baselineSha256'
        from jsonb_array_elements(src->'parents') e on conflict do nothing;
    end if;
  end loop;
  if (select count(*) from recipe_private.rich_origins where account_id=a)>250000 then raise exception 'quota_exceeded'; end if;
  for row in select value from jsonb_array_elements(p_items) loop
    if exists(select from recipe_private.rich_members m join recipe_private.versions v on v.id=m.version_id
        join recipe_private.grants g on g.version_id=v.id and g.actor=a where v.owner_id<>a and v.public_info->>'access'='coded'
        and m.kind in ('role','rule','skill','file','task','memory','setup','finalLogo') and m.kind=row->>'kind' and m.fingerprint=row->>'contentFingerprint')
      then raise exception 'source_unavailable'; end if;
    perform recipe_private.check_rich_origin(a,(row->>'originId')::uuid,row->>'kind');
  end loop;
  perform recipe_private.check_rich_logo(a,p_items,coalesce(p_parent,(select parent_version from recipe_private.rich_drafts where id=i.draft_id)));
  update recipe_private.rich_intents set input_hash=p_inputs,manifest_hash=p_manifest,payload_hash=p_payload,
    access=p_access,parent_version=p_parent,reviewed_items=p_items where id=p_id;
end $$;

create function recipe_private.rich_set_refs(a uuid,d uuid,pkg uuid,manifest uuid,h text,canonical bytea,parts jsonb) returns integer
language plpgsql set search_path=pg_catalog,pg_temp as $$
declare ids uuid[]:=array[manifest]; added uuid[]; desc_ jsonb; p jsonb; n int:=octet_length(canonical);
begin
  desc_:=recipe_private.object_descriptor(a,manifest);
  if desc_->>'kind' is distinct from 'manifest' or desc_->>'sha256' is distinct from h or (desc_->>'bytes')::int is distinct from n
    or h is distinct from encode(sha256(canonical),'hex') then raise exception 'object_unavailable'; end if;
  for p in select value from jsonb_array_elements(parts) loop
    if p is distinct from recipe_private.object_descriptor(a,(p->>'objectId')::uuid) or (p->>'objectId')::uuid=any(ids) then raise exception 'object_unavailable'; end if;
    ids:=array_append(ids,(p->>'objectId')::uuid);n:=n+(p->>'bytes')::int;
  end loop;
  if n>1048576 then raise exception 'quota_exceeded'; end if;
  select array_agg(id) into added from unnest(ids) u(id) where not exists(select from recipe_private.object_draft_refs r where r.draft_id=d and r.object_id=u.id);
  if added is not null then perform recipe_private.attach_object_package(pkg,d,added); end if;
  select array_agg(distinct id) into ids from (
    select unnest(ids) as id union all select m.id from recipe_private.rich_candidates c join recipe_private.object_attempts initial on initial.id=c.manifest_id
      join recipe_private.object_attempts m on m.package_id=initial.package_id where c.draft_id=d and m.state='ready'
  ) retained;
  delete from recipe_private.object_draft_refs where draft_id=d and not(object_id=any(ids));
  return n;
end $$;

create function recipe_api.rich_accept(op_id uuid,ticket bytea,nonce bytea,proof bytea,payload bytea,canonical bytea,manifest uuid,pkg uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare i recipe_private.rich_intents; op recipe_private.authoring_operations; cap recipe_private.authoring_capabilities;
  d recipe_private.drafts; base recipe_private.versions; a uuid; info jsonb; c jsonb; r jsonb; x jsonb; total int; retained int;
begin
  select account_id into a from recipe_private.rich_intents where id=op_id;
  if not found then raise exception 'not_found'; end if;
  perform set_config('app.recipe_account',a::text,true);
  perform 1 from recipe_private.accounts where id=a and status='active' for share;
  if not found then raise exception 'account_disabled'; end if;
  perform pg_advisory_xact_lock(hashtextextended(a::text,187511));
  select * into strict i from recipe_private.rich_intents where id=op_id;
  select * into strict op from recipe_private.authoring_operations where id=op_id for update;
  select * into cap from recipe_private.authoring_capabilities where operation_id=op_id and stage='accept';
  if not found or sha256(ticket) is distinct from sha256(cap.ticket) or sha256(proof) is distinct from cap.proof_hash
    or recipe_private.b64url(sha256(nonce)) is distinct from op.nonce_commitment then raise exception 'invalid_operation_proof'; end if;
  if cap.payload_digest is distinct from sha256(payload) or i.manifest_hash is distinct from encode(sha256(canonical),'hex')
    or i.payload_hash is distinct from encode(sha256(payload),'hex') then raise exception 'conflict'; end if;
  if op.state='accepted' then
    if op.terminal_at<clock_timestamp()-interval '7 days' then raise exception 'operation_expired'; end if;
    if op.receipt->>'manifestId' is distinct from manifest::text or op.receipt->>'packageId' is distinct from pkg::text then raise exception 'conflict'; end if;
    return op.receipt;
  end if;
  if op.state<>'dispatched' or op.revision<>(cap.binding->>'stateRevision')::int then raise exception 'conflict'; end if;
  if op.expires_at<=clock_timestamp() or cap.deadline<=extract(epoch from clock_timestamp())*1000 then raise exception 'operation_expired'; end if;
  if convert_from(payload,'UTF8')::jsonb->>'purpose' is distinct from op.purpose then raise exception 'conflict'; end if;
  c:=convert_from(canonical,'UTF8')::jsonb;
  if c->>'format' is distinct from 'rich-v2' or c->>'schemaVersion' is distinct from '2' then raise exception 'invalid_input'; end if;
  for x in select value from jsonb_array_elements(i.reviewed_items) loop perform recipe_private.check_rich_origin(a,(x->>'originId')::uuid,x->>'kind'); end loop;
  perform recipe_private.check_rich_logo(a,i.reviewed_items,coalesce(i.parent_version,(select parent_version from recipe_private.rich_drafts where id=i.draft_id)));
  select jsonb_object_agg(key,value->'value') into info from jsonb_each(c->'public');info:=info||jsonb_build_object('access',i.access);
  perform set_config('app.rich_mutation','v2',true);
  if op.purpose='prepareDraft' then
    if (select count(*) from recipe_private.drafts where owner_id=a)>=20 then raise exception 'quota_exceeded'; end if;
    if (select count(*) from recipe_private.drafts where owner_id=a and created_at>=date_trunc('day',statement_timestamp(),'UTC'))
      +(select count(*) from recipe_private.retired_drafts where owner_id=a and created_at>=date_trunc('day',statement_timestamp(),'UTC'))>=100 then raise exception 'rate_limited'; end if;
    if i.parent_version is not null then
      select v.* into base from recipe_private.versions v join recipe_private.recipes rp on rp.id=v.recipe_id and rp.revision=v.revision
        where v.id=i.parent_version and v.owner_id=a for share of rp;
      if not found then raise exception 'conflict'; end if;
    end if;
    insert into recipe_private.drafts(id,owner_id,recipe_id,base_revision,revision,public_info,config,bytes)
      values(i.draft_id,a,coalesce(base.recipe_id,i.draft_id),coalesce(base.revision,0),1,info,'{}',0) returning * into d;
  else
    select * into d from recipe_private.drafts where id=i.draft_id and owner_id=a for update;
    if not found or d.revision<>op.base_revision then raise exception 'conflict'; end if;
    update recipe_private.drafts set revision=revision+1,public_info=info where id=d.id returning * into d;
  end if;
  total:=recipe_private.rich_set_refs(a,d.id,pkg,manifest,i.manifest_hash,canonical,c->'parts');
  select coalesce(sum(m.final_bytes),0) into retained from recipe_private.object_draft_refs refs join recipe_private.object_attempts m on m.id=refs.object_id
    where refs.draft_id=d.id and refs.object_id<>manifest and not exists(select from jsonb_array_elements(c->'parts') p where (p->>'objectId')::uuid=m.id);
  if (select coalesce(sum(bytes),0) from recipe_private.drafts where owner_id=a and id<>d.id)+total+retained>10485760 and total+retained>d.bytes then raise exception 'quota_exceeded'; end if;
  update recipe_private.drafts set bytes=total+retained,retained_candidate_bytes=retained where id=d.id;
  insert into recipe_private.rich_drafts values(d.id,manifest,i.reviewed_items,retained,i.parent_version)
    on conflict(id) do update set manifest_id=excluded.manifest_id,items=excluded.items,retained_bytes=excluded.retained_bytes;
  if op.purpose='prepareDraft' then
    insert into recipe_private.rich_candidates(source_intent,owner_id,draft_id,manifest_id,content_hash,items)
    values(op_id,a,d.id,manifest,i.manifest_hash,i.reviewed_items);
  end if;
  r:=jsonb_build_object('format','rich-v2','operationId',op.id,'status','accepted','stateRevision',op.revision+1,
    'draftId',d.id,'recipeId',d.recipe_id,'revision',d.revision,'manifestId',manifest,'packageId',pkg);
  update recipe_private.authoring_operations set state='accepted',revision=revision+1,receipt=r,terminal_at=clock_timestamp() where id=op_id;
  return r;
end $$;

create function recipe_private.protect_rich_draft() returns trigger
language plpgsql set search_path=pg_catalog,pg_temp as $$
begin
  if exists(select from recipe_private.rich_drafts where id=old.id) and current_setting('app.rich_mutation',true) is distinct from 'v2' then raise exception 'request_upgrade_required'; end if;
  if tg_op='DELETE' then return old; end if;return new;
end $$;
create trigger protect_rich_draft before update or delete on recipe_private.drafts for each row execute function recipe_private.protect_rich_draft();

alter function recipe_private.install_version(uuid,uuid) rename to install_version_v1;
create function recipe_private.install_version(a uuid,p_version uuid) returns recipe_private.versions
language plpgsql set search_path=pg_catalog,pg_temp as $$
begin
  if exists(select from recipe_private.rich_versions where id=p_version) then raise exception 'request_upgrade_required'; end if;
  return recipe_private.install_version_v1(a,p_version);
end $$;
alter function recipe_api.version_detail(uuid,uuid) rename to version_detail_v1;
alter function recipe_api.version_detail_v1(uuid,uuid) set schema recipe_private;
revoke execute on function recipe_private.version_detail_v1(uuid,uuid) from recipe_api;
create function recipe_api.version_detail(p_recipe uuid,p_version uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
begin
  if exists(select from recipe_private.rich_versions where id=p_version) then raise exception 'request_upgrade_required'; end if;
  return recipe_private.version_detail_v1(p_recipe,p_version);
end $$;
create or replace function recipe_api.list_drafts() returns jsonb
language sql stable security definer set search_path=pg_catalog,pg_temp as $$
  select jsonb_build_object('items',coalesce(jsonb_agg(recipe_private.draft_json(d) order by id),'[]'))
  from recipe_private.drafts d where owner_id=recipe_private.actor() and not exists(select from recipe_private.rich_drafts r where r.id=d.id)
$$;
create or replace function recipe_api.get_draft(p_draft uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
declare d recipe_private.drafts;
begin
  select * into d from recipe_private.drafts where id=p_draft and owner_id=recipe_private.actor();
  if not found then raise exception 'not_found'; end if;
  if exists(select from recipe_private.rich_drafts where id=d.id) then raise exception 'request_upgrade_required'; end if;
  return recipe_private.draft_json(d);
end $$;

create table recipe_private.rich_text_checks(object_id uuid primary key references recipe_private.object_attempts on delete cascade, nonblank boolean not null);
alter table recipe_private.rich_text_checks enable row level security;
create function recipe_objects.record_text_check(a uuid,pkg uuid,ordinal_ int,nonblank_ boolean) returns void
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare m recipe_private.object_attempts;
begin
  m:=recipe_objects.member(a,pkg,ordinal_);
  if m.kind<>'text' or m.final_state<>'present' then raise exception 'object_unavailable'; end if;
  insert into recipe_private.rich_text_checks values(m.id,nonblank_) on conflict do nothing;
end $$;
grant execute on function recipe_objects.record_text_check(uuid,uuid,int,boolean) to recipe_object_verifier;
create function recipe_api.rich_draft(d_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid:=recipe_private.actor(); d recipe_private.drafts; r recipe_private.rich_drafts;
begin
  select * into d from recipe_private.drafts where id=d_id and owner_id=a;
  select * into r from recipe_private.rich_drafts where id=d.id;
  if not found then raise exception 'not_found'; end if;
  return jsonb_build_object('format','rich-v2','draftId',d.id,'recipeId',d.recipe_id,'revision',d.revision,
    'access',d.public_info->>'access','sourceIntentId',d.source_operation_id,'manifest',recipe_private.object_descriptor(a,r.manifest_id),'logicalBytes',d.bytes-r.retained_bytes,'retainedCandidateBytes',r.retained_bytes,
    'sourceManifest',(select recipe_private.object_descriptor(a,c.manifest_id) from recipe_private.rich_candidates c where c.draft_id=d.id));
end $$;
create function recipe_api.rich_draft_list() returns jsonb
language sql stable security definer set search_path=pg_catalog,pg_temp as $$
  select jsonb_build_object('items',coalesce(jsonb_agg(recipe_api.rich_draft(d.id) || jsonb_build_object('public',d.public_info) order by d.created_at desc),'[]'))
  from recipe_private.drafts d join recipe_private.rich_drafts r on r.id=d.id where d.owner_id=recipe_private.actor()
$$;
create function recipe_api.rich_candidate(src uuid,alias uuid,rev int) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid:=recipe_private.actor(); result jsonb;
begin
  if not exists(select from recipe_private.drafts d join recipe_private.rich_drafts r on r.id=d.id where d.source_operation_id=src and d.owner_id=a and d.revision=rev)
    then raise exception 'source_unavailable'; end if;
  select jsonb_build_object('itemId',i->>'itemId','candidateHash',rc.content_hash) into result
    from recipe_private.rich_candidates rc cross join lateral jsonb_array_elements(rc.items) i
    where rc.source_intent=src and rc.owner_id=a and i->>'itemId'=alias::text;
  if result is null then raise exception 'source_unavailable'; end if;return result;
end $$;

create function recipe_api.rich_delete(d_id uuid,rev int,req uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid:=recipe_private.actor(); args jsonb:=jsonb_build_array(d_id,rev); prior jsonb:=recipe_private.prior(a,'richDelete',req,args);
begin
  if prior is not null then return prior; end if;
  perform recipe_api.rich_draft(d_id);
  perform set_config('app.rich_mutation','v2',true);
  delete from recipe_private.object_draft_refs where draft_id=d_id;
  prior:=recipe_api.delete_draft(d_id,rev,req);
  return recipe_private.remember(a,'richDelete',req,args,prior,d_id);
end $$;
create function recipe_api.rich_publish(d_id uuid,rev int,req uuid,canonical bytea) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid:=recipe_private.actor(); h text:=encode(sha256(canonical),'hex'); args jsonb:=jsonb_build_array(d_id,rev,h);
  prior jsonb:=recipe_private.prior(a,'richPublish',req,args); d recipe_private.drafts; rd recipe_private.rich_drafts; v recipe_private.versions;
  obj jsonb; row jsonb; parent int; first_id uuid; first_code text; result jsonb;
begin
  if prior is null then
    select * into d from recipe_private.drafts where id=d_id and owner_id=a for update;
    select * into rd from recipe_private.rich_drafts where id=d.id;
    if not found then raise exception 'not_found'; end if;
    if d.revision<>rev then raise exception 'conflict'; end if;
    obj:=recipe_private.object_descriptor(a,rd.manifest_id);
    if obj->>'sha256' is distinct from h or (obj->>'bytes')::int is distinct from octet_length(canonical) then raise exception 'conflict'; end if;
    if exists(select from jsonb_array_elements(convert_from(canonical,'UTF8')::jsonb->'tasks') t
      where t->'instruction'->>'kind'='part' and not exists(select from recipe_private.rich_text_checks tc
      where tc.object_id=(t->'instruction'->>'objectId')::uuid and tc.nonblank)) then raise exception 'incomplete_setup'; end if;
    for row in select value from jsonb_array_elements(rd.items) loop perform recipe_private.check_rich_origin(a,(row->>'originId')::uuid,row->>'kind'); end loop;
    perform recipe_private.check_rich_logo(a,rd.items,rd.parent_version);
    if (select count(*) from recipe_private.versions where owner_id=a and published_at>=date_trunc('day',statement_timestamp(),'UTC'))>=10 then raise exception 'rate_limited'; end if;
    if (select coalesce(sum(bytes),0) from recipe_private.versions where owner_id=a)+d.bytes-rd.retained_bytes>26214400 then raise exception 'quota_exceeded'; end if;
    if d.base_revision=0 then
      if (select count(*) from recipe_private.recipes where owner_id=a)>=20 then raise exception 'quota_exceeded'; end if;
      insert into recipe_private.recipes(id,owner_id) values(d.recipe_id,a) on conflict do nothing;
      if not found then raise exception 'conflict'; end if;
    end if;
    select revision into parent from recipe_private.recipes where id=d.recipe_id and owner_id=a for update;
    if parent is distinct from d.base_revision then raise exception 'conflict'; end if;
    if parent>=30 then raise exception 'quota_exceeded'; end if;
    if exists(select from recipe_private.versions where recipe_id=d.recipe_id and public_info->>'version'=d.public_info->>'version') then raise exception 'conflict'; end if;
    insert into recipe_private.versions(recipe_id,owner_id,revision,public_info,config,bytes)
      values(d.recipe_id,a,parent+1,d.public_info,'{}',d.bytes-rd.retained_bytes) returning * into v;
    insert into recipe_private.rich_versions(id,manifest_id,parent_version) values(v.id,rd.manifest_id,rd.parent_version);
    insert into recipe_private.rich_members select v.id,(i->>'itemId')::uuid,(i->>'originId')::uuid,i->>'kind',i->>'baselineSha256',i->>'contentFingerprint' from jsonb_array_elements(rd.items) i;
    insert into recipe_private.object_version_refs select v.id,object_id from recipe_private.object_draft_refs where draft_id=d.id and
      (object_id=rd.manifest_id or exists(select from jsonb_array_elements(convert_from(canonical,'UTF8')::jsonb->'parts') pp where (pp->>'objectId')::uuid=object_id));
    update recipe_private.recipes set revision=v.revision where id=v.recipe_id;
    if v.public_info->>'access'='coded' then first_id:=(recipe_private.new_codes(a,v.id,1)->>0)::uuid; end if;
    perform set_config('app.rich_mutation','v2',true);
    delete from recipe_private.object_draft_refs where draft_id=d.id;
    insert into recipe_private.retired_drafts(id,owner_id,created_at) values(d.id,a,d.created_at);
    update recipe_private.retired_drafts set source_version_id=v.id where id=d.id;
    delete from recipe_private.drafts where id=d.id;
    prior:=recipe_private.remember(a,'richPublish',req,args,jsonb_build_object('versionId',v.id,'firstCodeId',first_id),d.id);
  else
    select * into strict v from recipe_private.versions where id=(prior->>'versionId')::uuid;
    first_id:=(prior->>'firstCodeId')::uuid;
  end if;
  select recipe_private.display_code(nonce) into first_code from recipe_private.codes where id=first_id and owner_id=a;
  return recipe_private.summary(v)||jsonb_strip_nulls(jsonb_build_object('firstCode',first_code,'format','rich-v2'));
end $$;

create function recipe_private.rich_access(a uuid,v recipe_private.versions,st text) returns text
language sql stable set search_path=pg_catalog,pg_temp as $$
  select case when st='banned' then 'blocked'
    when a=v.owner_id or exists(select from recipe_private.grants where actor=a and version_id=v.id) then 'full'
    when st='withdrawn' then 'withdrawn' when st='listed' and v.public_info->>'access'='direct' then 'full' else 'intro' end
$$;
create function recipe_private.public_creator(owner_ uuid) returns jsonb language sql stable set search_path=pg_catalog,pg_temp as $$
  select jsonb_build_object('authorId',owner_,'displayName',coalesce((select display_name from recipe_private.creator_profiles where account_id=owner_),'配方作者'))
$$;
create function recipe_api.rich_profile(name_ text) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid:=recipe_private.actor();
begin
  if name_ is null or length(btrim(name_)) not between 1 and 60 or name_ ~ '[@[:cntrl:]]' then raise exception 'invalid_input'; end if;
  insert into recipe_private.creator_profiles values(a,btrim(name_)) on conflict(account_id) do update set display_name=excluded.display_name;
  return recipe_private.public_creator(a);
end $$;
create function recipe_api.rich_detail(recipe uuid,version uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid:=recipe_private.actor(false); v recipe_private.versions; rv recipe_private.rich_versions; scope text; result jsonb; manifest jsonb;
begin
  select * into v from recipe_private.versions where id=version and recipe_id=recipe;
  select * into rv from recipe_private.rich_versions where id=v.id;
  if not found then raise exception 'not_found'; end if;
  scope:=recipe_private.rich_access(a,v,rv.state);
  if scope in ('withdrawn','blocked') then return jsonb_build_object('state',scope,'versionId',v.id); end if;
  result:=recipe_private.summary(v)||jsonb_build_object('format','rich-v2','state',rv.state,'visibility',scope,'creator',recipe_private.public_creator(v.owner_id),
    'hasDisplayLogo',rv.state='listed' and exists(select from recipe_private.object_version_refs dr join recipe_private.object_attempts m on m.id=dr.object_id
       where dr.version_id=v.id and m.kind='finalLogo'),
    'owned',coalesce(v.owner_id=a,false),'acquired',exists(select from recipe_private.grants where version_id=v.id and actor=a));
  if scope='full' then
    manifest:=recipe_private.object_descriptor(v.owner_id,rv.manifest_id);
    result:=result||jsonb_build_object('manifest',manifest,'release',jsonb_build_object('format','rich-v2','recipeId',v.recipe_id,'versionId',v.id,
      'authorId',v.owner_id,'revision',v.revision,'access',v.public_info->>'access','logicalBytes',v.bytes,'contentSha256',manifest->>'sha256'));
  end if;
  return result;
end $$;

create function recipe_objects.business_actor(iss text,sub uuid) returns uuid language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid;
begin
  select i.account_id into a from recipe_private.account_identities i join recipe_private.accounts ac on ac.id=i.account_id and ac.status='active'
    join recipe_private.identity_deployment dep on dep.issuer=i.issuer where i.issuer=iss and i.subject=sub;
  if not found then raise exception 'auth_required'; end if;return a;
end $$;
create function recipe_objects.read_descriptor(iss text,sub uuid,scope text,target uuid,obj uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid; own uuid; v recipe_private.versions; rv recipe_private.rich_versions;
begin
  if sub is not null or iss is not null then a:=recipe_objects.business_actor(iss,sub); end if;
  if scope='draft' then
    select d.owner_id into own from recipe_private.drafts d join recipe_private.object_draft_refs r on r.draft_id=d.id
      where d.id=target and r.object_id=obj and d.owner_id=a;
  elsif scope='version' then
    select * into v from recipe_private.versions where id=target;
    select * into rv from recipe_private.rich_versions where id=v.id;
    if found and recipe_private.rich_access(a,v,rv.state)='full' and exists(select from recipe_private.object_version_refs where version_id=target and object_id=obj) then own:=v.owner_id; end if;
  else raise exception 'invalid_input'; end if;
  if own is null then raise exception 'not_found'; end if;return recipe_private.object_descriptor(own,obj);
end $$;
grant execute on function recipe_objects.business_actor(text,uuid),recipe_objects.read_descriptor(text,uuid,text,uuid,uuid) to recipe_object_verifier;

create function recipe_objects.display_logo(v_id uuid) returns jsonb
language sql stable security definer set search_path=pg_catalog,pg_temp as $$
  select recipe_private.object_descriptor(v.owner_id,m.id) from recipe_private.rich_versions rv join recipe_private.versions v on v.id=rv.id
    join recipe_private.object_version_refs r on r.version_id=v.id join recipe_private.object_attempts m on m.id=r.object_id and m.kind='finalLogo'
    where rv.id=v_id and rv.state='listed'
$$;
grant execute on function recipe_objects.display_logo(uuid) to recipe_object_verifier;

create function recipe_private.close_rich_version(v_id uuid,next_state text) returns void language plpgsql set search_path=pg_catalog,pg_temp as $$
begin
  update recipe_private.rich_versions set state=next_state where id=v_id and (state<>'banned' or next_state='banned');
  if not found then raise exception 'not_found'; end if;
  delete from recipe_private.rich_feature where version_id=v_id;
  update recipe_private.codes set nonce=null,status='disabled' where version_id=v_id and status='available';
end $$;
create function recipe_api.rich_withdraw(v_id uuid) returns void language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid:=recipe_private.actor();
begin
  perform pg_advisory_xact_lock(hashtextextended(a::text,187511));
  if not exists(select from recipe_private.versions where id=v_id and owner_id=a) then raise exception 'not_found'; end if;
  perform recipe_private.close_rich_version(v_id,'withdrawn');
end $$;

alter function recipe_api.acquire(uuid,text,text) rename to acquire_core;
alter function recipe_api.acquire_core(uuid,text,text) set schema recipe_private;
revoke execute on function recipe_private.acquire_core(uuid,text,text) from recipe_api;
create function recipe_api.acquire(p_version uuid,p_code text,p_request text) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare st text;
begin
  select state into st from recipe_private.rich_versions where id=p_version for share;
  if found and st<>'listed' then raise exception 'forbidden'; end if;
  return recipe_private.acquire_core(p_version,p_code,p_request);
end $$;
create function recipe_private.guard_code_lifecycle() returns trigger language plpgsql set search_path=pg_catalog,pg_temp as $$
declare st text;
begin
  select state into st from recipe_private.rich_versions where id=new.version_id for share;
  if found and st<>'listed' then raise exception 'forbidden'; end if;return new;
end $$;
create trigger guard_code_lifecycle before insert on recipe_private.codes for each row execute function recipe_private.guard_code_lifecycle();
create function recipe_private.guard_legacy_parent() returns trigger language plpgsql set search_path=pg_catalog,pg_temp as $$
begin
  if current_setting('app.rich_mutation',true) is distinct from 'v2' and exists(select from recipe_private.rich_versions w
    join recipe_private.versions v on v.id=w.id where v.recipe_id=new.recipe_id and v.revision=new.base_revision)
    then raise exception 'request_upgrade_required'; end if;return new;
end $$;
create trigger guard_legacy_parent before insert on recipe_private.drafts for each row execute function recipe_private.guard_legacy_parent();

create function recipe_private.catalog_card(v recipe_private.versions,rich boolean) returns jsonb
language sql stable set search_path=pg_catalog,pg_temp as $$
  select recipe_private.summary(v) || case when rich then jsonb_build_object('creator',recipe_private.public_creator(v.owner_id),
    'hasDisplayLogo',exists(select from recipe_private.rich_versions rv join recipe_private.object_version_refs dr on dr.version_id=rv.id
      join recipe_private.object_attempts m on m.id=dr.object_id where rv.id=v.id and rv.state='listed' and m.kind='finalLogo'),
    'format',case when exists(select from recipe_private.rich_versions where id=v.id) then 'rich-v2' else 'role-v1' end) else '{}' end
$$;
create function recipe_private.listed_catalog(term text,after_id uuid,rich boolean) returns jsonb
language plpgsql stable set search_path=pg_catalog,pg_temp as $$
declare hero recipe_private.versions; cursor_time timestamptz; result jsonb;
begin
  term:=lower(btrim(coalesce(term,'')));
  if length(term)>120 then raise exception 'invalid_input'; end if;
  if after_id is not null then
    select published_at into cursor_time from recipe_private.versions where id=after_id;
    if not found then raise exception 'invalid_input'; end if;
  end if;
  if term='' then
    select v.* into hero from recipe_private.versions v join recipe_private.recipes p on p.id=v.recipe_id and p.revision=v.revision
      left join recipe_private.rich_versions rv on rv.id=v.id left join recipe_private.rich_feature f on f.version_id=v.id
      where rv.id is null or (rich and rv.state='listed')
      order by (f.version_id is not null) desc,v.published_at desc,v.id desc limit 1;
  end if;
  with page as (
    select v as version,v.id,v.published_at from recipe_private.versions v join recipe_private.recipes p on p.id=v.recipe_id and p.revision=v.revision
      left join recipe_private.rich_versions rv on rv.id=v.id left join recipe_private.creator_profiles cp on cp.account_id=v.owner_id
    where (rv.id is null or rich and rv.state='listed') and v.recipe_id is distinct from hero.recipe_id
      and (after_id is null or (v.published_at,v.id)<(cursor_time,after_id))
      and (term='' or strpos(lower(v.public_info->>'name'),term)>0 or strpos(lower(v.public_info->>'summary'),term)>0
        or (rich and strpos(lower(cp.display_name),term)>0))
    order by v.published_at desc,v.id desc limit 9
  ), items as (select * from page order by published_at desc,id desc limit 8)
  select jsonb_build_object('hero',case when after_id is null and hero.id is not null then recipe_private.catalog_card(hero,rich) end,
    'items',coalesce(jsonb_agg(recipe_private.catalog_card(version,rich) order by published_at desc,id desc),'[]'),
    'nextCursor',case when (select count(*) from page)>8 then (array_agg(id order by published_at,id))[1] end) into result from items;
  return result;
end $$;
create or replace function recipe_api.catalog(p_query text,p_cursor uuid) returns jsonb
language sql stable security definer set search_path=pg_catalog,pg_temp as $$ select recipe_private.listed_catalog(p_query,p_cursor,false) $$;
create function recipe_api.rich_catalog(p_query text,p_cursor uuid) returns jsonb
language sql stable security definer set search_path=pg_catalog,pg_temp as $$ select recipe_private.listed_catalog(p_query,p_cursor,true) $$;

reset role;
create role recipe_editor nologin nosuperuser nocreatedb nocreaterole nobypassrls;
grant usage on schema recipe_api to recipe_editor;
set local role recipe_owner;
create function recipe_api.rich_moderate(action_ text,version_ uuid,editor_ uuid) returns void
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare v recipe_private.versions; st text;
begin
  select * into v from recipe_private.versions where id=version_;
  select state into st from recipe_private.rich_versions where id=v.id for update;
  if not found then raise exception 'not_found'; end if;
  if action_='ban' then perform recipe_private.close_rich_version(v.id,'banned');
  elsif action_='feature' then
    if st<>'listed' or not exists(select from recipe_private.recipes where id=v.recipe_id and revision=v.revision)
      or not exists(select from recipe_private.accounts where id=editor_ and status='active')
      or (v.owner_id<>editor_ and not exists(select from recipe_private.grants where actor=editor_ and version_id=v.id)) then raise exception 'forbidden'; end if;
    insert into recipe_private.rich_feature values(true,v.id,editor_) on conflict(singleton) do update set version_id=v.id,editor=editor_;
  elsif action_='unfeature' then delete from recipe_private.rich_feature where version_id=v.id;
  else raise exception 'invalid_input'; end if;
end $$;
grant execute on function recipe_api.rich_moderate(text,uuid,uuid) to recipe_editor;

create function recipe_api.rich_catalog_page(q text,token text,access_ text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
declare term text:=lower(btrim(coalesce(q,''))); query_hash text; anchor timestamptz:=statement_timestamp(); last_time timestamptz;
  last_recipe uuid; hero_recipe uuid; hero recipe_private.versions; body bytea; sig text; cur jsonb; result jsonb; next_data jsonb;
begin
  if length(term)>120 or (access_ is not null and access_ not in ('coded','direct')) then raise exception 'invalid_input'; end if;
  query_hash:=encode(sha256(convert_to(jsonb_build_array(term,access_,'published_desc')::text,'UTF8')),'hex');
  if token is not null then
    if length(token)>1600 or token!~'^[a-f0-9]+[.][a-f0-9]{64}$' then raise exception 'invalid_input'; end if;
    begin
      body:=decode(split_part(token,'.',1),'hex');sig:=encode(recipe_private.code_mac('catalog-cursor:v2',body),'hex');
      if sig<>split_part(token,'.',2) then raise exception 'invalid_input'; end if;
      cur:=convert_from(body,'UTF8')::jsonb;
      if cur->>'query' is distinct from query_hash then raise exception 'invalid_input'; end if;
      anchor:=(cur->>'anchor')::timestamptz;last_time:=(cur->>'time')::timestamptz;last_recipe:=(cur->>'recipe')::uuid;
      hero_recipe:=(cur->>'hero')::uuid;
    exception when others then raise exception 'invalid_input'; end;
  elsif term='' and access_ is null then
    select v.* into hero from recipe_private.versions v join recipe_private.recipes r on r.id=v.recipe_id and r.revision=v.revision
      left join recipe_private.rich_versions rv on rv.id=v.id left join recipe_private.rich_feature f on f.version_id=v.id
      where (rv.id is null or rv.state='listed') and v.published_at<=anchor order by (f.version_id is not null) desc,
        v.published_at desc,v.recipe_id desc limit 1;
    hero_recipe:=hero.recipe_id;
  end if;
  with page as (
    select v as version,v.recipe_id,v.published_at from recipe_private.versions v join recipe_private.recipes r on r.id=v.recipe_id and r.revision=v.revision
      left join recipe_private.rich_versions rv on rv.id=v.id left join recipe_private.creator_profiles cp on cp.account_id=v.owner_id
    where (rv.id is null or rv.state='listed') and v.published_at<=anchor and v.recipe_id is distinct from hero_recipe
      and (last_time is null or (v.published_at,v.recipe_id)<(last_time,last_recipe))
      and (access_ is null or v.public_info->>'access'=access_) and (term='' or strpos(lower(v.public_info->>'name'),term)>0
        or strpos(lower(v.public_info->>'summary'),term)>0 or strpos(lower(cp.display_name),term)>0)
    order by v.published_at desc,v.recipe_id desc limit 9
  ), items as(select * from page order by published_at desc,recipe_id desc limit 8)
  select jsonb_build_object('hero',case when hero.id is not null then recipe_private.catalog_card(hero,true) end,
      'items',coalesce(jsonb_agg(recipe_private.catalog_card(version,true) order by published_at desc,recipe_id desc),'[]')),
    case when (select count(*) from page)>8 then jsonb_build_object('query',query_hash,'anchor',anchor,'hero',hero_recipe,
      'time',(array_agg(published_at order by published_at,recipe_id))[1],'recipe',(array_agg(recipe_id order by published_at,recipe_id))[1]) end
    into result,next_data from items;
  body:=convert_to(next_data::text,'UTF8');
  return result||jsonb_build_object('nextCursor',case when body is not null then encode(body,'hex')||'.'||encode(recipe_private.code_mac('catalog-cursor:v2',body),'hex') end);
end $$;
grant execute on function recipe_api.rich_catalog_page(text,text,text) to recipe_api;
create function recipe_api.rich_update_items(v_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid:=recipe_private.actor(); rows_ jsonb;
begin
  if not exists(select from recipe_private.versions v join recipe_private.rich_versions rv on rv.id=v.id and rv.state='listed'
    join recipe_private.recipes r on r.id=v.recipe_id and r.revision=v.revision where v.id=v_id and v.owner_id=a) then raise exception 'source_unavailable'; end if;
  select jsonb_agg(jsonb_build_object('itemId',m.item_id,'originId',m.origin_id,'kind',m.kind,'baselineSha256',m.baseline)) into rows_
  from recipe_private.rich_members m where version_id=v_id;
  return rows_;
end $$;
grant execute on function recipe_api.rich_update_items(uuid) to recipe_api;
create function recipe_api.rich_source_items(v_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid:=recipe_private.actor(); v recipe_private.versions; st text;
begin
  select * into v from recipe_private.versions where id=v_id;
  select state into st from recipe_private.rich_versions where id=v_id;
  if not found or recipe_private.rich_access(a,v,st)<>'full' then raise exception 'not_found'; end if;
  return jsonb_build_object('versionId',v.id,'authorId',v.owner_id,'access',v.public_info->>'access','items',(
    select jsonb_agg(jsonb_build_object('itemId',m.item_id,'kind',m.kind,'baselineSha256',m.baseline) order by m.item_id)
    from recipe_private.rich_members m where m.version_id=v.id));
end $$;
grant execute on function recipe_api.rich_source_items(uuid) to recipe_api;

do $grant$
declare fn regprocedure;
begin
  for fn in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='recipe_api' and p.proname in ('register_authoring','get_authoring','recover_authoring','cancel_authoring','authoring_context','authorize_authoring',
      'possess_authoring','version_detail','acquire','rich_register','rich_op_context','rich_authorize','rich_dispatch','rich_plan_context','rich_save_plan','rich_accept',
      'rich_draft','rich_draft_list','rich_candidate','rich_delete','rich_publish','rich_profile','rich_detail','rich_withdraw','rich_catalog') loop
    execute format('grant execute on function %s to recipe_api',fn);
  end loop;
end $grant$;
reset role;
revoke recipe_owner from current_user;
