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
  perform set_config('vonvon.recipe_m202611150003_actor',actor,true);
  perform set_config('vonvon.recipe_m202611150003_memberships',memberships::text,true);
  perform set_config('vonvon.recipe_m202611150003_can_set',can_set::text,true);
  perform set_config('vonvon.recipe_m202611150003_self_grant',self_grant::text,true);
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


create function recipe_api.publication_receipt(p_format text,p_request uuid,p_draft uuid,p_expected int,p_content_sha256 text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid:=recipe_private.actor(); action_ text; args jsonb; prior jsonb; v recipe_private.versions;
begin
  if p_request is null or p_draft is null or (p_expected between 1 and 2147483647) is not true then raise exception 'invalid_input'; end if;
  if p_format='role-v1' and p_content_sha256 is null then
    action_:='publish';args:=jsonb_build_array(p_draft,p_expected);
  elsif p_format='rich-v2' and (p_content_sha256~'^[a-f0-9]{64}$') is true then
    action_:='richPublish';args:=jsonb_build_array(p_draft,p_expected,p_content_sha256);
  else
    raise exception 'invalid_input';
  end if;
  select result into prior from recipe_private.receipts
    where actor=a and action=action_ and request_id=p_request and digest=sha256(convert_to(args::text,'UTF8'));
  if not found then return jsonb_build_object('status','unknown'); end if;
  select * into v from recipe_private.versions where id=(prior->>'versionId')::uuid and owner_id=a;
  if not found then return jsonb_build_object('status','unknown'); end if;
  return jsonb_build_object('status','committed','receipt',recipe_private.summary(v)||jsonb_build_object(
    'requestId',p_request,'format',p_format,'draftId',p_draft,'draftRevision',p_expected,'firstCodeId',prior->'firstCodeId'));
end $$;

create function recipe_api.code_issuance_receipt(p_request uuid,p_version uuid,p_count int) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid:=recipe_private.actor(); args jsonb:=jsonb_build_array(p_version,p_count); ids jsonb;
begin
  if p_request is null or p_version is null or (p_count between 1 and 100) is not true then raise exception 'invalid_input'; end if;
  select result into ids from recipe_private.receipts
    where actor=a and action='issue' and request_id=p_request and digest=sha256(convert_to(args::text,'UTF8'));
  if not found then return jsonb_build_object('status','unknown'); end if;
  return jsonb_build_object('status','committed','receipt',jsonb_build_object(
    'requestId',p_request,'versionId',p_version,'count',p_count,'codeIds',ids));
end $$;

revoke all on function recipe_api.publication_receipt(text,uuid,uuid,int,text),recipe_api.code_issuance_receipt(uuid,uuid,int) from public;
do $$
declare role_ text;
begin
  foreach role_ in array array['anon','authenticated'] loop
    if exists(select from pg_roles where rolname=role_) then
      execute format('revoke all on function recipe_api.publication_receipt(text,uuid,uuid,int,text),recipe_api.code_issuance_receipt(uuid,uuid,int) from %I',role_);
    end if;
  end loop;
end $$;
grant execute on function recipe_api.publication_receipt(text,uuid,uuid,int,text),recipe_api.code_issuance_receipt(uuid,uuid,int) to recipe_api;

reset role;
do $migration_role$
declare actor text := current_setting('vonvon.recipe_m202611150003_actor'); memberships jsonb;
  can_set boolean := current_setting('vonvon.recipe_m202611150003_can_set')::boolean;
  self_grant boolean := current_setting('vonvon.recipe_m202611150003_self_grant')::boolean;
begin
  if actor is distinct from session_user then raise exception 'migration_role_session_changed'; end if;
  if not can_set and not self_grant then
    execute format('revoke recipe_owner from %I',actor);
  end if;
  select coalesce(jsonb_agg(to_jsonb(m) order by m.roleid,m.member,m.grantor),'[]'::jsonb)
    into memberships from pg_catalog.pg_auth_members m;
  if memberships is distinct from current_setting('vonvon.recipe_m202611150003_memberships')::jsonb then
    raise exception 'migration_role_memberships_changed';
  end if;
end $migration_role$;
