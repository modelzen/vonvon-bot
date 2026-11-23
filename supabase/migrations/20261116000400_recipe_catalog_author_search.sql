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
  perform set_config('vonvon.recipe_m202611160004_actor',actor,true);
  perform set_config('vonvon.recipe_m202611160004_memberships',memberships::text,true);
  perform set_config('vonvon.recipe_m202611160004_can_set',can_set::text,true);
  perform set_config('vonvon.recipe_m202611160004_self_grant',self_grant::text,true);
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


-- Match the same current nickname exposed by public_creator, including no-profile defaults.
create or replace function recipe_api.rich_catalog_page(q text,token text,access_ text) returns jsonb
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
        or strpos(lower(v.public_info->>'summary'),term)>0 or strpos(lower(coalesce(cp.display_name,recipe_private.account_default_nickname(v.owner_id))),term)>0)
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

reset role;
do $migration_role$
declare actor text := current_setting('vonvon.recipe_m202611160004_actor'); memberships jsonb;
  can_set boolean := current_setting('vonvon.recipe_m202611160004_can_set')::boolean;
  self_grant boolean := current_setting('vonvon.recipe_m202611160004_self_grant')::boolean;
begin
  if actor is distinct from session_user then raise exception 'migration_role_session_changed'; end if;
  if not can_set and not self_grant then
    execute format('revoke recipe_owner from %I',actor);
  end if;
  select coalesce(jsonb_agg(to_jsonb(m) order by m.roleid,m.member,m.grantor),'[]'::jsonb)
    into memberships from pg_catalog.pg_auth_members m;
  if memberships is distinct from current_setting('vonvon.recipe_m202611160004_memberships')::jsonb then
    raise exception 'migration_role_memberships_changed';
  end if;
end $migration_role$;
