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
  perform set_config('vonvon.recipe_m202611170004_actor',actor,true);
  perform set_config('vonvon.recipe_m202611170004_memberships',memberships::text,true);
  perform set_config('vonvon.recipe_m202611170004_can_set',can_set::text,true);
  perform set_config('vonvon.recipe_m202611170004_self_grant',self_grant::text,true);
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

-- Publication grouping is independent of the configuration's source group and content provenance.
-- Old public previews stay byte-for-byte compatible. Only the authenticated reader can
-- select this additional projection; it does not read manifest or text objects.
alter table recipe_private.browse_previews add column task_summaries jsonb
  check (jsonb_typeof(task_summaries)='array' and jsonb_array_length(task_summaries)<=32 and octet_length(task_summaries::text)<=65536);

alter function recipe_private.cache_browse_preview(uuid,bytea,jsonb) rename to cache_public_browse_preview;
create function recipe_private.cache_browse_preview(version_ uuid,canonical_ bytea,descriptions_ jsonb default '{}'::jsonb) returns void
language plpgsql set search_path=pg_catalog,pg_temp as $$
begin
  -- The original writer verifies the hash and size against the immutable published manifest.
  perform recipe_private.cache_public_browse_preview(version_,canonical_,descriptions_);
  update recipe_private.browse_previews set task_summaries=(
    select coalesce(jsonb_agg(jsonb_build_object(
      'itemId', t->'itemId', 'name', t->'name', 'placement', t->'placement',
      'spec', jsonb_strip_nulls(jsonb_build_object('kind', t#>'{spec,kind}', 'at',t#>'{spec,at}', 'minutes',t#>'{spec,minutes}',
        'time',t#>'{spec,time}', 'days',t#>'{spec,days}', 'expr',t#>'{spec,expr}')),
      'timeZone',jsonb_strip_nulls(jsonb_build_object('kind', t#>'{timeZone,kind}', 'iana',t#>'{timeZone,iana}'))
    ) order by ord),'[]'::jsonb) from jsonb_array_elements(convert_from(canonical_,'UTF8')::jsonb->'tasks') with ordinality tasks(t,ord)
  ) where version_id=version_ and task_summaries is null;
end $$;

create function recipe_api.task_summaries(recipe_ uuid,version_ uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
declare actor_ uuid:=recipe_private.actor(); summaries_ jsonb;
begin
  select p.task_summaries into summaries_ from recipe_private.versions v
    join recipe_private.rich_versions rv on rv.id=v.id and rv.state='listed'
    left join recipe_private.browse_previews p on p.version_id=v.id
    where v.id=version_ and v.recipe_id=recipe_ and
      (v.owner_id=actor_ or exists(select from recipe_private.grants g where g.actor=actor_ and g.version_id=v.id));
  if not found then raise exception 'not_found'; end if;
  return jsonb_strip_nulls(jsonb_build_object('recipeId',recipe_,'versionId',version_,'tasks',summaries_));
end $$;
revoke all on function recipe_private.cache_browse_preview(uuid,bytea,jsonb),recipe_api.task_summaries(uuid,uuid) from public,recipe_api,recipe_object_verifier;
do $privileges$
declare role_ text;
begin
  for role_ in select rolname from pg_roles where rolname in ('anon','authenticated','service_role') loop
    execute format('revoke all on function recipe_private.cache_browse_preview(uuid,bytea,jsonb),recipe_api.task_summaries(uuid,uuid) from %I',role_);
  end loop;
end $privileges$;
grant execute on function recipe_api.task_summaries(uuid,uuid) to recipe_api;

reset role;
do $migration_role$
declare actor text := current_setting('vonvon.recipe_m202611170004_actor'); memberships jsonb;
  can_set boolean := current_setting('vonvon.recipe_m202611170004_can_set')::boolean;
  self_grant boolean := current_setting('vonvon.recipe_m202611170004_self_grant')::boolean;
begin
  if actor is distinct from session_user then raise exception 'migration_role_session_changed'; end if;
  if not can_set and not self_grant then
    execute format('revoke recipe_owner from %I',actor);
  end if;
  select coalesce(jsonb_agg(to_jsonb(m) order by m.roleid,m.member,m.grantor),'[]'::jsonb)
    into memberships from pg_catalog.pg_auth_members m;
  if memberships is distinct from current_setting('vonvon.recipe_m202611170004_memberships')::jsonb then
    raise exception 'migration_role_memberships_changed';
  end if;
end $migration_role$;
