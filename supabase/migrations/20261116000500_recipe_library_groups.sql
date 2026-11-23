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
  perform set_config('vonvon.recipe_m202611160005_actor',actor,true);
  perform set_config('vonvon.recipe_m202611160005_memberships',memberships::text,true);
  perform set_config('vonvon.recipe_m202611160005_can_set',can_set::text,true);
  perform set_config('vonvon.recipe_m202611160005_self_grant',self_grant::text,true);
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


-- Entitlement filtering precedes recipe grouping and both pagination layers.
create function recipe_private.library_visible_versions(a uuid,scope_ text,anchor_ timestamptz)
returns table(version_id uuid,recipe_id uuid,revision integer,state text,owned boolean,acquired boolean)
language sql stable set search_path=pg_catalog,pg_temp as $$
  select v.id,v.recipe_id,v.revision,coalesce(rv.state,'listed'),v.owner_id=a,g.actor is not null
  from (
    select id from recipe_private.versions where owner_id=a and scope_ in ('all','published')
    union
    select version_id from recipe_private.grants where actor=a and scope_ in ('all','acquired')
  ) permitted join recipe_private.versions v on v.id=permitted.id
    left join recipe_private.rich_versions rv on rv.id=v.id
    left join recipe_private.grants g on g.version_id=v.id and g.actor=a
  where v.published_at<=anchor_ and (rv.id is null or rv.state<>'banned')
$$;

create function recipe_private.library_card(version_ uuid,owned_ boolean,acquired_ boolean,state_ text) returns jsonb
language sql stable set search_path=pg_catalog,pg_temp as $$
  select (recipe_private.catalog_card(v,true)#-'{public,overview}') ||
    jsonb_build_object('owned',owned_,'acquired',acquired_,'state',state_)
  from recipe_private.versions v where v.id=version_
$$;

create function recipe_private.library_cursor(value_ jsonb) returns text
language sql stable set search_path=pg_catalog,pg_temp as $$
  select encode(body,'hex')||'.'||encode(recipe_private.code_mac('library-cursor:v1',body),'hex')
  from (select convert_to(value_::text,'UTF8') body) p
$$;
create function recipe_private.library_cursor_read(token_ text,binding_ jsonb) returns jsonb
language plpgsql stable set search_path=pg_catalog,pg_temp as $$
declare body bytea; value_ jsonb;
begin
  if length(token_)>1600 or token_!~'^[a-f0-9]+[.][a-f0-9]{64}$' then raise exception 'invalid_input'; end if;
  body:=decode(split_part(token_,'.',1),'hex');
  if encode(recipe_private.code_mac('library-cursor:v1',body),'hex')<>split_part(token_,'.',2) then raise exception 'invalid_input'; end if;
  value_:=convert_from(body,'UTF8')::jsonb;
  if value_->'binding' is distinct from binding_ or value_->>'anchor' is null or value_->>'after' is null then raise exception 'invalid_input'; end if;
  return value_;
exception when others then raise exception 'invalid_input';
end $$;

create function recipe_api.reader_recipe_groups(scope_ text,token_ text default null) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid:=recipe_private.actor(); binding_ jsonb; cur jsonb; anchor_ timestamptz:=statement_timestamp();
  after_ uuid; result jsonb; next_ uuid;
begin
  if scope_ is null or scope_ not in ('all','acquired','published') then raise exception 'invalid_input'; end if;
  binding_:=jsonb_build_object('actor',a,'scope',scope_,'kind','groups');
  if token_ is not null then
    cur:=recipe_private.library_cursor_read(token_,binding_);
    begin anchor_:=(cur->>'anchor')::timestamptz;after_:=(cur->>'after')::uuid;
    exception when others then raise exception 'invalid_input'; end;
  end if;
  with eligible as materialized (select * from recipe_private.library_visible_versions(a,scope_,anchor_)),
  grouped as (
    select recipe_id,count(*)::integer version_count,(array_agg(version_id order by revision desc))[1] version_id
    from eligible group by recipe_id
  ), page as (
    select * from grouped where after_ is null or recipe_id<after_ order by recipe_id desc limit 51
  ), items as (select * from page order by recipe_id desc limit 50)
  select jsonb_build_object('items',coalesce(jsonb_agg(
    recipe_private.library_card(e.version_id,e.owned,e.acquired,e.state)||jsonb_build_object('versionCount',i.version_count)
    order by i.recipe_id desc),'[]'::jsonb)),
    case when (select count(*) from page)>50 then (array_agg(i.recipe_id order by i.recipe_id))[1] end
  into result,next_ from items i join eligible e on e.version_id=i.version_id;
  return result||jsonb_build_object('nextCursor',case when next_ is not null then recipe_private.library_cursor(
    jsonb_build_object('binding',binding_,'anchor',anchor_,'after',next_)) end);
end $$;

create function recipe_api.reader_recipe_group_versions(recipe_ uuid,scope_ text,token_ text default null) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid:=recipe_private.actor(); binding_ jsonb; cur jsonb; anchor_ timestamptz:=statement_timestamp();
  after_ integer; result jsonb; next_ integer;
begin
  if recipe_ is null or scope_ is null or scope_ not in ('all','acquired','published') then raise exception 'invalid_input'; end if;
  binding_:=jsonb_build_object('actor',a,'scope',scope_,'kind','versions','recipe',recipe_);
  if token_ is not null then
    cur:=recipe_private.library_cursor_read(token_,binding_);
    begin anchor_:=(cur->>'anchor')::timestamptz;after_:=(cur->>'after')::integer;
      if after_<1 then raise exception 'invalid_input'; end if;
    exception when others then raise exception 'invalid_input'; end;
  end if;
  if not exists(select from recipe_private.library_visible_versions(a,scope_,anchor_) v where v.recipe_id=recipe_) then raise exception 'not_found'; end if;
  with page as (
    select * from recipe_private.library_visible_versions(a,scope_,anchor_) v
      where v.recipe_id=recipe_ and (after_ is null or v.revision<after_) order by v.revision desc limit 51
  ), items as (select * from page order by revision desc limit 50)
  select jsonb_build_object('items',coalesce(jsonb_agg(recipe_private.library_card(version_id,owned,acquired,state) order by revision desc),'[]'::jsonb)),
    case when (select count(*) from page)>50 then min(revision) end into result,next_ from items;
  return result||jsonb_build_object('nextCursor',case when next_ is not null then recipe_private.library_cursor(
    jsonb_build_object('binding',binding_,'anchor',anchor_,'after',next_)) end);
end $$;

revoke all on function recipe_private.library_visible_versions(uuid,text,timestamptz),recipe_private.library_card(uuid,boolean,boolean,text),
  recipe_private.library_cursor(jsonb),recipe_private.library_cursor_read(text,jsonb) from public,recipe_api;
revoke all on function recipe_api.reader_recipe_groups(text,text),recipe_api.reader_recipe_group_versions(uuid,text,text) from public;
do $$
declare role_ text;
begin
  foreach role_ in array array['anon','authenticated'] loop
    if exists(select from pg_roles where rolname=role_) then
      execute format('revoke all on function recipe_api.reader_recipe_groups(text,text),recipe_api.reader_recipe_group_versions(uuid,text,text) from %I',role_);
    end if;
  end loop;
end $$;
grant execute on function recipe_api.reader_recipe_groups(text,text),recipe_api.reader_recipe_group_versions(uuid,text,text) to recipe_api;

reset role;
do $migration_role$
declare actor text := current_setting('vonvon.recipe_m202611160005_actor'); memberships jsonb;
  can_set boolean := current_setting('vonvon.recipe_m202611160005_can_set')::boolean;
  self_grant boolean := current_setting('vonvon.recipe_m202611160005_self_grant')::boolean;
begin
  if actor is distinct from session_user then raise exception 'migration_role_session_changed'; end if;
  if not can_set and not self_grant then
    execute format('revoke recipe_owner from %I',actor);
  end if;
  select coalesce(jsonb_agg(to_jsonb(m) order by m.roleid,m.member,m.grantor),'[]'::jsonb)
    into memberships from pg_catalog.pg_auth_members m;
  if memberships is distinct from current_setting('vonvon.recipe_m202611160005_memberships')::jsonb then
    raise exception 'migration_role_memberships_changed';
  end if;
end $migration_role$;
