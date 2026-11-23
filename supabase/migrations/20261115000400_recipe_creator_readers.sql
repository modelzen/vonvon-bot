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
  perform set_config('vonvon.recipe_m202611150004_actor',actor,true);
  perform set_config('vonvon.recipe_m202611150004_memberships',memberships::text,true);
  perform set_config('vonvon.recipe_m202611150004_can_set',can_set::text,true);
  perform set_config('vonvon.recipe_m202611150004_self_grant',self_grant::text,true);
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


create function recipe_api.metadata_receipt(p_request uuid,p_draft uuid,p_expected int,p_base_sha256 text,p_transform int,p_input_sha256 text,p_wire_sha256 text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid:=recipe_private.actor(); binding jsonb; prior jsonb;
begin
  if p_request is null or p_draft is null or (p_expected between 1 and 2147483647) is not true
    or (p_base_sha256~'^[a-f0-9]{64}$') is not true or p_transform is distinct from 1
    or (p_input_sha256~'^[a-f0-9]{64}$') is not true
    or p_wire_sha256 is not null and p_wire_sha256!~'^[a-f0-9]{64}$' then raise exception 'invalid_input'; end if;
  binding:=jsonb_build_object('revision',p_expected,'baseManifestSha256',p_base_sha256,'transformVersion',p_transform,'inputSha256',p_input_sha256);
  select result into prior from recipe_private.receipts
    where actor=a and action='richMetadata' and request_id=p_request
      and digest=sha256(convert_to(jsonb_build_array(p_draft,binding)::text,'UTF8'))
      and (p_wire_sha256 is null or result->>'wireSha256'=p_wire_sha256);
  if not found then return jsonb_build_object('status','unknown'); end if;
  return jsonb_build_object('status','committed','receipt',prior->'receipt');
end $$;

create function recipe_api.creator_context(p_format text,p_draft uuid,p_expected int,p_content_sha256 text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid:=recipe_private.actor(); d recipe_private.drafts; r recipe_private.rich_drafts; v recipe_private.versions;
  parent jsonb; manifest jsonb;
begin
  if p_draft is null or (p_expected between 1 and 2147483647) is not true
    or (p_format='role-v1' and p_content_sha256 is null
      or p_format='rich-v2' and (p_content_sha256~'^[a-f0-9]{64}$') is true) is not true then raise exception 'invalid_input'; end if;
  select * into d from recipe_private.drafts where id=p_draft and owner_id=a;
  if not found then raise exception 'not_found'; end if;
  select * into r from recipe_private.rich_drafts where id=d.id;
  if p_format='rich-v2' and not found then raise exception 'not_found'; end if;
  if p_format='role-v1' and found then raise exception 'request_upgrade_required'; end if;
  if d.revision<>p_expected then raise exception 'conflict'; end if;
  if p_format='rich-v2' then
    manifest:=recipe_private.object_descriptor(a,r.manifest_id);
    if manifest->>'sha256' is distinct from p_content_sha256 then raise exception 'conflict'; end if;
    if r.parent_version is not null then
      select * into v from recipe_private.versions where id=r.parent_version and owner_id=a;
      if not found then raise exception 'integrity_error'; end if;
      parent:=jsonb_build_object('recipeId',v.recipe_id,'versionId',v.id);
    end if;
  elsif d.base_revision<>0 then
    select * into v from recipe_private.versions where recipe_id=d.recipe_id and revision=d.base_revision and owner_id=a;
    if not found then raise exception 'integrity_error'; end if;
    parent:=jsonb_build_object('recipeId',v.recipe_id,'versionId',v.id);
  end if;
  return jsonb_build_object('draftId',d.id,'format',p_format,'revision',d.revision,'sourceIntentId',d.source_operation_id,'parent',parent);
end $$;

revoke all on function recipe_api.metadata_receipt(uuid,uuid,int,text,int,text,text),recipe_api.creator_context(text,uuid,int,text) from public;
do $$
declare role_ text;
begin
  foreach role_ in array array['anon','authenticated'] loop
    if exists(select from pg_roles where rolname=role_) then
      execute format('revoke all on function recipe_api.metadata_receipt(uuid,uuid,int,text,int,text,text),recipe_api.creator_context(text,uuid,int,text) from %I',role_);
    end if;
  end loop;
end $$;
grant execute on function recipe_api.metadata_receipt(uuid,uuid,int,text,int,text,text),recipe_api.creator_context(text,uuid,int,text) to recipe_api;

reset role;
do $migration_role$
declare actor text := current_setting('vonvon.recipe_m202611150004_actor'); memberships jsonb;
  can_set boolean := current_setting('vonvon.recipe_m202611150004_can_set')::boolean;
  self_grant boolean := current_setting('vonvon.recipe_m202611150004_self_grant')::boolean;
begin
  if actor is distinct from session_user then raise exception 'migration_role_session_changed'; end if;
  if not can_set and not self_grant then
    execute format('revoke recipe_owner from %I',actor);
  end if;
  select coalesce(jsonb_agg(to_jsonb(m) order by m.roleid,m.member,m.grantor),'[]'::jsonb)
    into memberships from pg_catalog.pg_auth_members m;
  if memberships is distinct from current_setting('vonvon.recipe_m202611150004_memberships')::jsonb then
    raise exception 'migration_role_memberships_changed';
  end if;
end $migration_role$;
