do $migration_role$
declare actor text := session_user; memberships jsonb; can_set boolean; self_grant boolean;
begin
  select coalesce(jsonb_agg(to_jsonb(m) order by m.roleid,m.member,m.grantor),'[]'::jsonb)
    into memberships from pg_catalog.pg_auth_members m;
  if current_setting('server_version_num')::integer>=160000 then
    can_set:=pg_has_role(actor,'recipe_owner','SET');
  else
    can_set:=pg_has_role(actor,'recipe_owner','MEMBER');
  end if;
  self_grant:=exists(select from pg_catalog.pg_auth_members
    where roleid='recipe_owner'::regrole and member=actor::regrole and grantor=actor::regrole);
  perform set_config('vonvon.recipe_m015_actor',actor,true);
  perform set_config('vonvon.recipe_m015_memberships',memberships::text,true);
  perform set_config('vonvon.recipe_m015_can_set',can_set::text,true);
  perform set_config('vonvon.recipe_m015_self_grant',self_grant::text,true);
  if current_user is distinct from actor then raise exception 'migration_role_session_changed'; end if;
  if not can_set then
    if self_grant then raise exception 'migration_role_set_disabled'; end if;
    execute format('grant recipe_owner to %I',actor);
    if not exists(select from pg_catalog.pg_auth_members
      where roleid='recipe_owner'::regrole and member=actor::regrole and grantor=actor::regrole) then
      raise exception 'migration_role_grant_not_owned';
    end if;
  end if;
end $migration_role$;
set local role recipe_owner;

alter table recipe_private.object_packages add column metadata_binding jsonb;
alter table recipe_private.rich_origins add column provenance text not null default 'authoring'
  check (provenance in ('authoring','metadata'));

create or replace function recipe_private.prune_intent_origins() returns trigger
language plpgsql set search_path=pg_catalog,pg_temp as $$
begin
  if old.state <> 'accepted' then
    delete from recipe_private.rich_origins where provenance='authoring' and intent=old.id;
  end if;
  return null;
end $$;

alter function recipe_api.reserve_object_package(uuid,uuid,int) set schema recipe_private;
revoke execute on function recipe_private.reserve_object_package(uuid,uuid,int) from recipe_api;

create function recipe_api.reserve_object_package(p_id uuid,p_draft uuid,p_cap int) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare reserved jsonb;
begin
  reserved:=recipe_private.reserve_object_package(p_id,p_draft,p_cap);
  if exists(select from recipe_private.object_packages where id=p_id and metadata_binding is not null) then
    raise exception 'conflict';
  end if;
  return reserved;
end $$;

create function recipe_private.check_metadata_binding(binding jsonb) returns void
language plpgsql immutable set search_path=pg_catalog,pg_temp as $$
begin
  if (jsonb_typeof(binding)='object'
    and binding ?& array['revision','baseManifestSha256','transformVersion','inputSha256']
    and binding-array['revision','baseManifestSha256','transformVersion','inputSha256']='{}'::jsonb
    and jsonb_typeof(binding->'revision')='number'
    and (binding->>'revision') ~ '^[1-9][0-9]{0,9}$'
    and (binding->>'revision')::numeric<=2147483647
    and binding->'transformVersion'='1'::jsonb
    and jsonb_typeof(binding->'baseManifestSha256')='string'
    and binding->>'baseManifestSha256' ~ '^[0-9a-f]{64}$'
    and jsonb_typeof(binding->'inputSha256')='string'
    and binding->>'inputSha256' ~ '^[0-9a-f]{64}$') is not true then
    raise exception 'invalid_input';
  end if;
end $$;

create function recipe_private.metadata_base(a uuid,d uuid,binding jsonb) returns jsonb
language plpgsql set search_path=pg_catalog,pg_temp as $$
declare revision_ int; manifest jsonb;
begin
  select draft.revision,recipe_private.object_descriptor(a,rich.manifest_id) into revision_,manifest
    from recipe_private.drafts draft join recipe_private.rich_drafts rich on rich.id=draft.id
    where draft.id=d and draft.owner_id=a for update of draft,rich;
  if not found then raise exception 'not_found'; end if;
  if revision_ is distinct from (binding->>'revision')::int
    or manifest->>'sha256' is distinct from binding->>'baseManifestSha256' then raise exception 'conflict'; end if;
  return manifest;
end $$;

create function recipe_api.reserve_metadata_package(p_id uuid,p_draft uuid,p_cap int,binding jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid:=recipe_private.actor(); op recipe_private.object_packages; reserved jsonb;
begin
  perform recipe_private.check_metadata_binding(binding);
  perform 1 from recipe_private.accounts where id=a and status='active' for share;
  if not found then raise exception 'account_disabled'; end if;
  perform pg_advisory_xact_lock(hashtextextended(a::text,187511));
  select * into op from recipe_private.object_packages where id=p_id for update;
  if found then
    if op.actor is distinct from a then raise exception 'not_found'; end if;
    if (op.draft_id,op.metadata_binding) is distinct from (p_draft,binding) then raise exception 'conflict'; end if;
    perform recipe_private.object_check_open(op);
    if op.cap is distinct from p_cap then raise exception 'conflict'; end if;
    perform recipe_private.metadata_base(a,p_draft,binding);
    return recipe_private.reserve_object_package(p_id,p_draft,p_cap);
  end if;
  perform recipe_private.check_operation_birth(p_id);
  perform recipe_private.metadata_base(a,p_draft,binding);
  reserved:=recipe_private.reserve_object_package(p_id,p_draft,p_cap);
  update recipe_private.object_packages set metadata_binding=binding where id=p_id;
  return reserved;
end $$;

create function recipe_api.rich_metadata_context(p_id uuid,p_draft uuid,binding jsonb,wire_sha text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid:=recipe_private.actor(); prior jsonb; op recipe_private.object_packages;
begin
  perform recipe_private.check_metadata_binding(binding);
  if wire_sha is not null and wire_sha !~ '^[0-9a-f]{64}$' then raise exception 'invalid_input'; end if;
  perform 1 from recipe_private.accounts where id=a and status='active' for share;
  if not found then raise exception 'account_disabled'; end if;
  prior:=recipe_private.prior(a,'richMetadata',p_id,jsonb_build_array(p_draft,binding));
  if prior is not null then
    if wire_sha is not null and wire_sha is distinct from prior->>'wireSha256' then raise exception 'conflict'; end if;
    return prior-'wireSha256';
  end if;
  select * into op from recipe_private.object_packages where id=p_id for update;
  if not found then
    perform recipe_private.check_operation_birth(p_id);
    return jsonb_build_object('pending',true);
  end if;
  if op.actor is distinct from a then raise exception 'not_found'; end if;
  if (op.draft_id,op.metadata_binding) is distinct from (p_draft,binding) then raise exception 'conflict'; end if;
  perform recipe_private.object_check_open(op);
  return jsonb_build_object('accountId',a,'manifest',recipe_private.metadata_base(a,p_draft,binding));
end $$;

create function recipe_api.rich_close_metadata(p_id uuid,p_draft uuid,binding jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid:=recipe_private.actor(); prior jsonb; op recipe_private.object_packages;
begin
  perform recipe_private.check_metadata_binding(binding);
  perform 1 from recipe_private.accounts where id=a and status='active' for share;
  if not found then raise exception 'account_disabled'; end if;
  prior:=recipe_private.prior(a,'richMetadata',p_id,jsonb_build_array(p_draft,binding));
  if prior is not null then return prior-'wireSha256'; end if;
  select * into op from recipe_private.object_packages where id=p_id for update;
  if not found then
    perform recipe_private.check_operation_birth(p_id);
    if not exists(select from recipe_private.drafts d join recipe_private.rich_drafts r on r.id=d.id
      where d.id=p_draft and d.owner_id=a) then raise exception 'not_found'; end if;
    if (select count(*) from recipe_private.object_packages where actor=a
      and created_at>=date_trunc('day',clock_timestamp(),'UTC'))>=60 then return jsonb_build_object('pending',true); end if;
    insert into recipe_private.object_packages(id,actor,draft_id,cap,state,metadata_binding)
      values(p_id,a,p_draft,1,'closed',binding);
    return jsonb_build_object('closed',true);
  end if;
  if op.actor is distinct from a then raise exception 'not_found'; end if;
  if (op.draft_id,op.metadata_binding) is distinct from (p_draft,binding) then raise exception 'conflict'; end if;
  if op.state='open' then
    perform recipe_api.cancel_object_package(p_id);
    perform recipe_objects.close_package(a,p_id);
  end if;
  return jsonb_build_object('closed',true);
end $$;

alter function recipe_private.rich_set_refs(uuid,uuid,uuid,uuid,text,bytea,jsonb) rename to rich_write_refs;
create function recipe_private.rich_set_refs(a uuid,d uuid,pkg uuid,manifest uuid,h text,canonical bytea,parts jsonb)
returns integer language plpgsql set search_path=pg_catalog,pg_temp as $$
begin
  if exists(select from recipe_private.object_packages where id=pkg and metadata_binding is not null) then
    raise exception 'conflict';
  end if;
  return recipe_private.rich_write_refs(a,d,pkg,manifest,h,canonical,parts);
end $$;

create function recipe_api.rich_save_metadata(p_id uuid,p_draft uuid,binding jsonb,wire_sha text,
  canonical bytea,manifest uuid,access_ text,items jsonb,logo jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare ctx jsonb; a uuid; h text:=encode(sha256(canonical),'hex'); content jsonb; info jsonb;
  rd recipe_private.rich_drafts; d recipe_private.drafts; item jsonb; initial_logo jsonb; next_logo jsonb;
  logical int; retained int; receipt jsonb;
begin
  if wire_sha is null then raise exception 'invalid_input'; end if;
  ctx:=recipe_api.rich_metadata_context(p_id,p_draft,binding,wire_sha);
  if ctx ? 'receipt' then return ctx->'receipt'; end if;
  if ctx ? 'pending' then raise exception 'object_unavailable'; end if;
  a:=(ctx->>'accountId')::uuid;
  select * into strict d from recipe_private.drafts where id=p_draft;
  select * into strict rd from recipe_private.rich_drafts where id=p_draft;
  if not exists(select from recipe_private.object_attempts m where m.package_id=p_id and m.id=manifest
    and m.ordinal=65 and m.kind='manifest' and m.state='ready' and m.final_state='present'
    and m.final_hash=h and m.final_bytes=octet_length(canonical)) then raise exception 'object_unavailable'; end if;

  content:=convert_from(canonical,'UTF8')::jsonb;
  if (content->>'format'='rich-v2' and content->'schemaVersion'='2'::jsonb
    and access_ in ('direct','coded') and jsonb_array_length(items) between 4 and 320) is not true then
    raise exception 'invalid_input';
  end if;
  select jsonb_object_agg(key,value->'value') into info from jsonb_each(content->'public');
  info:=info||jsonb_build_object('access',access_);
  select value into initial_logo from jsonb_array_elements(rd.items) where value->>'kind'='finalLogo';
  select value into next_logo from jsonb_array_elements(items) where value->>'kind'='finalLogo';
  if logo is not null then
    if (logo->>'packageId')::uuid is distinct from p_id or next_logo is null or
      content#>>'{finalLogo,objectId}' is distinct from logo#>>'{descriptor,objectId}' then raise exception 'conflict'; end if;
    perform recipe_private.check_rich_upload(a,p_draft,logo);
    if initial_logo is null then
      insert into recipe_private.rich_origins(id,account_id,kind,intent,candidate,baseline,provenance)
        values((next_logo->>'originId')::uuid,a,'finalLogo',p_id,(next_logo->>'itemId')::uuid,next_logo->>'baselineSha256','metadata')
        on conflict do nothing;
      if not found then raise exception 'conflict'; end if;
      if (select count(*) from recipe_private.rich_origins where account_id=a)>250000 then raise exception 'quota_exceeded'; end if;
    elsif (initial_logo->>'originId',initial_logo->>'itemId') is distinct from (next_logo->>'originId',next_logo->>'itemId') then
      raise exception 'conflict';
    end if;
  elsif next_logo is not null and next_logo is distinct from initial_logo then
    raise exception 'conflict';
  end if;
  if exists(select from jsonb_array_elements(items) x join recipe_private.rich_members m on m.kind=x->>'kind'
    and m.fingerprint=x->>'contentFingerprint' join recipe_private.versions v on v.id=m.version_id
    join recipe_private.grants g on g.actor=a and g.version_id=v.id where v.owner_id<>a and v.public_info->>'access'='coded'
    and m.kind in ('role','rule','skill','file','task','memory','setup','finalLogo')) then raise exception 'source_unavailable'; end if;
  for item in select value from jsonb_array_elements(items) loop
    perform recipe_private.check_rich_origin(a,(item->>'originId')::uuid,item->>'kind');
  end loop;
  perform recipe_private.check_rich_logo(a,items,rd.parent_version);
  logical:=recipe_private.rich_write_refs(a,p_draft,p_id,manifest,h,canonical,content->'parts');
  select coalesce(sum(m.final_bytes),0) into retained from recipe_private.object_draft_refs refs
    join recipe_private.object_attempts m on m.id=refs.object_id where refs.draft_id=p_draft and refs.object_id<>manifest
    and not exists(select from jsonb_array_elements(content->'parts') p where (p->>'objectId')::uuid=m.id);
  if logical+retained>d.bytes and
    (select coalesce(sum(bytes),0) from recipe_private.drafts where owner_id=a and id<>p_draft)+logical+retained>10485760 then
    raise exception 'quota_exceeded';
  end if;
  perform set_config('app.rich_mutation','v2',true);
  update recipe_private.drafts set revision=revision+1,public_info=info,bytes=logical+retained,retained_candidate_bytes=retained
    where id=p_draft returning revision into d.revision;
  update recipe_private.rich_drafts set manifest_id=manifest,items=rich_save_metadata.items,retained_bytes=retained where id=p_draft;
  receipt:=jsonb_build_object('requestId',p_id,'draftId',p_draft,'revision',d.revision,'manifestSha256',h);
  delete from recipe_private.receipts where actor=a and action='richMetadata' and created_at<clock_timestamp()-interval '9 days';
  perform recipe_private.remember(a,'richMetadata',p_id,jsonb_build_array(p_draft,binding),
    jsonb_build_object('receipt',receipt,'wireSha256',wire_sha),p_draft);
  return receipt;
end $$;

grant execute on function recipe_api.reserve_object_package(uuid,uuid,int),
  recipe_api.reserve_metadata_package(uuid,uuid,int,jsonb),
  recipe_api.rich_metadata_context(uuid,uuid,jsonb,text),
  recipe_api.rich_close_metadata(uuid,uuid,jsonb),
  recipe_api.rich_save_metadata(uuid,uuid,jsonb,text,bytea,uuid,text,jsonb,jsonb) to recipe_api;

reset role;
do $migration_role$
declare actor text := current_setting('vonvon.recipe_m015_actor'); memberships jsonb;
  can_set boolean := current_setting('vonvon.recipe_m015_can_set')::boolean;
  self_grant boolean := current_setting('vonvon.recipe_m015_self_grant')::boolean;
begin
  if actor is distinct from session_user then raise exception 'migration_role_session_changed'; end if;
  if not can_set and not self_grant then
    execute format('revoke recipe_owner from %I',actor);
  end if;
  select coalesce(jsonb_agg(to_jsonb(m) order by m.roleid,m.member,m.grantor),'[]'::jsonb)
    into memberships from pg_catalog.pg_auth_members m;
  if memberships is distinct from current_setting('vonvon.recipe_m015_memberships')::jsonb then
    raise exception 'migration_role_memberships_changed';
  end if;
end $migration_role$;
