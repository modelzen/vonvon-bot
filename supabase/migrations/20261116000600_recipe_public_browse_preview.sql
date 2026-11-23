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
  perform set_config('vonvon.recipe_m202611160006_actor',actor,true);
  perform set_config('vonvon.recipe_m202611160006_memberships',memberships::text,true);
  perform set_config('vonvon.recipe_m202611160006_can_set',can_set::text,true);
  perform set_config('vonvon.recipe_m202611160006_self_grant',self_grant::text,true);
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


-- Both access modes expose the same cached, metadata-only display projection.
-- Source member ACLs, grants, and withdrawn/banned lifecycle checks stay separate.
create or replace function recipe_api.browse_preview(recipe_ uuid,version_ uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid:=recipe_private.actor(false); v recipe_private.versions; rv recipe_private.rich_versions; result_ jsonb; display_ jsonb; access_ text;
begin
  select * into v from recipe_private.versions where id=version_ and recipe_id=recipe_;
  if not found then raise exception 'not_found'; end if;
  select * into rv from recipe_private.rich_versions where id=version_;
  if found then
    access_:=recipe_private.rich_access(a,v,rv.state);
    if access_ in ('withdrawn','blocked') then return jsonb_build_object('state',access_,'versionId',v.id); end if;
    result_:=recipe_private.catalog_card(v,true)||jsonb_build_object('state',rv.state,'owned',coalesce(v.owner_id=a,false),
      'acquired',exists(select from recipe_private.grants where actor=a and version_id=v.id));
    select preview into display_ from recipe_private.browse_previews where version_id=version_;
    return result_||case when found then jsonb_build_object('preview',display_) else jsonb_build_object('previewUnavailable',true) end;
  end if;
  return recipe_private.summary(v)||jsonb_build_object('format','role-v1','state','listed','creator',recipe_private.public_creator(v.owner_id),
    'hasDisplayLogo',false,'owned',coalesce(v.owner_id=a,false),'acquired',exists(select from recipe_private.grants where actor=a and version_id=v.id),
    'preview',jsonb_build_object('settings','[]'::jsonb,'skills','[]'::jsonb,'ruleCount',0,'taskCount',0));
end $$;

reset role;
do $migration_role$
declare actor text := current_setting('vonvon.recipe_m202611160006_actor'); memberships jsonb;
  can_set boolean := current_setting('vonvon.recipe_m202611160006_can_set')::boolean;
  self_grant boolean := current_setting('vonvon.recipe_m202611160006_self_grant')::boolean;
begin
  if actor is distinct from session_user then raise exception 'migration_role_session_changed'; end if;
  if not can_set and not self_grant then
    execute format('revoke recipe_owner from %I',actor);
  end if;
  select coalesce(jsonb_agg(to_jsonb(m) order by m.roleid,m.member,m.grantor),'[]'::jsonb)
    into memberships from pg_catalog.pg_auth_members m;
  if memberships is distinct from current_setting('vonvon.recipe_m202611160006_memberships')::jsonb then
    raise exception 'migration_role_memberships_changed';
  end if;
end $migration_role$;
