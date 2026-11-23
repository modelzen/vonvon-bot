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
  perform set_config('vonvon.recipe_m202611160002_actor',actor,true);
  perform set_config('vonvon.recipe_m202611160002_memberships',memberships::text,true);
  perform set_config('vonvon.recipe_m202611160002_can_set',can_set::text,true);
  perform set_config('vonvon.recipe_m202611160002_self_grant',self_grant::text,true);
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


-- Keep the generation guard and original entitlement/config projection intact.
-- The optional creator field also makes directly opened legacy recipes navigable.
create or replace function recipe_api.version_detail(recipe_ uuid,version_ uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
declare result jsonb; owner_ uuid;
begin
  perform recipe_private.require_role_generation(version_);
  result:=recipe_private.detail_role_generation(recipe_,version_);
  select owner_id into owner_ from recipe_private.versions where id=version_ and recipe_id=recipe_;
  return result||jsonb_build_object('creator',recipe_private.public_creator(owner_));
end $$;

-- Public authors exist only while they have a publicly listed publication.
-- Cards share the catalog projection, which contains no source/config/account data.
create function recipe_api.reader_author_recipes(p_author uuid,p_cursor uuid default null) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
declare cursor_time timestamptz; result jsonb;
begin
  if p_author is null then raise exception 'invalid_input'; end if;
  if not exists(select from recipe_private.versions v
    left join recipe_private.rich_versions rv on rv.id=v.id
    where v.owner_id=p_author and (rv.id is null or rv.state='listed')) then
    raise exception 'not_found';
  end if;
  if p_cursor is not null then
    select v.published_at into cursor_time from recipe_private.versions v
      left join recipe_private.rich_versions rv on rv.id=v.id
      where v.id=p_cursor and v.owner_id=p_author and (rv.id is null or rv.state='listed');
    if not found then raise exception 'invalid_input'; end if;
  end if;
  with latest as (
    select distinct on (v.recipe_id) v as version,v.id,v.recipe_id,v.published_at from recipe_private.versions v
      left join recipe_private.rich_versions rv on rv.id=v.id
      where v.owner_id=p_author and (rv.id is null or rv.state='listed')
      order by v.recipe_id,v.revision desc,v.id desc
  ), page as (
    select v.version,v.id,v.published_at from latest v
      where p_cursor is null or (v.published_at,v.id)<(cursor_time,p_cursor)
      order by v.published_at desc,v.id desc limit 51
  ), items as (select * from page order by published_at desc,id desc limit 50)
  select jsonb_build_object('creator',recipe_private.public_creator(p_author),
    'items',coalesce(jsonb_agg(recipe_private.catalog_card(version,true) order by published_at desc,id desc),'[]'::jsonb),
    'nextCursor',case when (select count(*) from page)>50 then (array_agg(id order by published_at,id))[1] end)
    into result from items;
  return result;
end $$;

revoke all on function recipe_api.reader_author_recipes(uuid,uuid) from public;
do $$
declare role_ text;
begin
  foreach role_ in array array['anon','authenticated'] loop
    if exists(select from pg_roles where rolname=role_) then
      execute format('revoke all on function recipe_api.reader_author_recipes(uuid,uuid) from %I',role_);
    end if;
  end loop;
end $$;
grant execute on function recipe_api.reader_author_recipes(uuid,uuid) to recipe_api;

reset role;
do $migration_role$
declare actor text := current_setting('vonvon.recipe_m202611160002_actor'); memberships jsonb;
  can_set boolean := current_setting('vonvon.recipe_m202611160002_can_set')::boolean;
  self_grant boolean := current_setting('vonvon.recipe_m202611160002_self_grant')::boolean;
begin
  if actor is distinct from session_user then raise exception 'migration_role_session_changed'; end if;
  if not can_set and not self_grant then
    execute format('revoke recipe_owner from %I',actor);
  end if;
  select coalesce(jsonb_agg(to_jsonb(m) order by m.roleid,m.member,m.grantor),'[]'::jsonb)
    into memberships from pg_catalog.pg_auth_members m;
  if memberships is distinct from current_setting('vonvon.recipe_m202611160002_memberships')::jsonb then
    raise exception 'migration_role_memberships_changed';
  end if;
end $migration_role$;
