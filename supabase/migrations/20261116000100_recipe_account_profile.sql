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
  perform set_config('vonvon.recipe_m202611160001_actor',actor,true);
  perform set_config('vonvon.recipe_m202611160001_memberships',memberships::text,true);
  perform set_config('vonvon.recipe_m202611160001_can_set',can_set::text,true);
  perform set_config('vonvon.recipe_m202611160001_self_grant',self_grant::text,true);
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



alter table recipe_private.creator_profiles
  add column avatar_data_url text,
  add column revision integer not null default 1 check (revision > 0),
  add constraint account_avatar_small_webp check (avatar_data_url is null or
    (octet_length(avatar_data_url) <= 174787 and avatar_data_url ~ '^data:image/webp;base64,[A-Za-z0-9+/]+={0,2}$'));

create function recipe_private.account_nickname(name_ text) returns text
language sql immutable strict set search_path=pg_catalog,pg_temp as $$
  select btrim(regexp_replace(normalize(name_,NFKC),U&'[ \1680\2000-\200A\2028\2029\202F\205F\3000]+',' ','g'))
$$;
create collation recipe_private.account_nickname_case (provider=icu,locale='und',deterministic=true);
create function recipe_private.account_nickname_key(name_ text) returns text
language sql immutable strict set search_path=pg_catalog,pg_temp as $$
  select lower(recipe_private.account_nickname(regexp_replace(recipe_private.account_nickname(name_),
    U&'[\200D\FE00-\FE0F\+0E0000-\+0E007F\+0E0100-\+0E01EF]','','g')) collate recipe_private.account_nickname_case)
$$;
create function recipe_private.account_nickname_valid(name_ text) returns boolean
language sql immutable set search_path=pg_catalog,pg_temp as $$
  select name_ is not null and length(recipe_private.account_nickname(name_)) between 1 and 60
    and name_ !~ U&'[@[:cntrl:]\007F-\009F\00AD\034F\061C\115F-\1160\17B4-\17B5\180B-\180F\200B-\200C\200E-\200F\202A-\202E\2060-\206F\3164\FEFF\FFA0\FFF0-\FFF8\+01BCA0-\+01BCA3\+01D173-\+01D17A\+0E0080-\+0E00FF\+0E01F0-\+0E0FFF]'
    and recipe_private.account_nickname(name_) !~ '@'
    and btrim(recipe_private.account_nickname_key(name_))<>''
$$;
create function recipe_private.account_default_nickname(account_ uuid) returns text
language sql immutable strict set search_path=pg_catalog,pg_temp as $$
  select 'Vonvon 用户-'||replace(account_::text,'-','')
$$;
create function recipe_private.account_nickname_owned(name_ text,account_ uuid) returns boolean
language sql immutable strict set search_path=pg_catalog,pg_temp as $$
  select recipe_private.account_nickname_key(name_) !~ '^vonvon 用户-[0-9a-f]{32}$'
    or recipe_private.account_nickname_key(name_)=recipe_private.account_nickname_key(recipe_private.account_default_nickname(account_))
$$;
alter table recipe_private.creator_profiles add column nickname_key text
  generated always as (recipe_private.account_nickname_key(display_name)) stored;

-- The oldest deterministic account order keeps a contested name; every profile survives the migration.
create temporary table account_nickname_migration_keys (nickname_key text primary key) on commit drop;
do $$
declare r record; base_ text; name_ text; suffix_ text; attempt_ integer; reserved_ integer;
begin
  for r in select account_id,display_name from recipe_private.creator_profiles order by account_id loop
    base_:=left(recipe_private.account_nickname(regexp_replace(r.display_name,
      U&'[\00AD\034F\061C\115F-\1160\17B4-\17B5\180B-\180F\200B-\200C\200E-\200F\202A-\202E\2060-\206F\3164\FEFF\FFA0\FFF0-\FFF8\+01BCA0-\+01BCA3\+01D173-\+01D17A\+0E0080-\+0E00FF\+0E01F0-\+0E0FFF]','','g')),60);
    if not recipe_private.account_nickname_valid(base_) then base_:='Vonvon 用户'; end if;
    if not recipe_private.account_nickname_owned(base_,r.account_id) then base_:=recipe_private.account_default_nickname(r.account_id); end if;
    name_:=base_; attempt_:=0;
    loop
      insert into account_nickname_migration_keys values(recipe_private.account_nickname_key(name_)) on conflict do nothing;
      get diagnostics reserved_=row_count;
      exit when reserved_=1;
      attempt_:=attempt_+1;
      suffix_:='-'||r.account_id::text||case when attempt_=1 then '' else '-'||attempt_::text end;
      name_:=left(base_,60-length(suffix_))||suffix_;
    end loop;
    update recipe_private.creator_profiles set display_name=name_ where account_id=r.account_id;
  end loop;
end $$;
create unique index creator_profiles_nickname_key_unique on recipe_private.creator_profiles(nickname_key);
alter table recipe_private.creator_profiles add constraint account_nickname_valid
  check (recipe_private.account_nickname_valid(display_name) and recipe_private.account_nickname_owned(display_name,account_id));

create or replace function recipe_private.public_creator(owner_ uuid) returns jsonb
language sql stable set search_path=pg_catalog,pg_temp as $$
  select jsonb_build_object('authorId',owner_,'displayName',coalesce(
    (select display_name from recipe_private.creator_profiles where account_id=owner_),recipe_private.account_default_nickname(owner_)))
$$;

create function recipe_api.rich_account_profile_read() returns jsonb
language sql stable security definer set search_path=pg_catalog,pg_temp as $$
  select recipe_private.public_creator(a.id) || jsonb_build_object('revision', coalesce(p.revision,0)) ||
    case when p.avatar_data_url is null then '{}'::jsonb else jsonb_build_object('avatarDataUrl',p.avatar_data_url) end
  from (select recipe_private.actor() id) a left join recipe_private.creator_profiles p on p.account_id=a.id
$$;

create function recipe_api.rich_account_profile(name_ text, avatar_action_ text, avatar_ text, revision_ integer)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid:=recipe_private.actor(); current_ integer; constraint_ text;
begin
  if not recipe_private.account_nickname_valid(name_)
    or avatar_action_ is null or avatar_action_ not in ('keep','remove','replace')
    or (revision_ is not null and revision_<0)
    or (avatar_action_='replace')<>(avatar_ is not null)
    or (avatar_ is not null and (octet_length(avatar_)>174787 or avatar_ !~ '^data:image/webp;base64,[A-Za-z0-9+/]+={0,2}$')) then
    raise exception 'invalid_input';
  end if;
  if not recipe_private.account_nickname_owned(name_,a) then raise exception 'nickname_taken'; end if;
  -- A first save has no profile row to lock. Serialize it without upgrading the account share lock.
  perform pg_advisory_xact_lock(hashtextextended(a::text,934539));
  select revision into current_ from recipe_private.creator_profiles where account_id=a;
  if revision_ is not null and revision_<>coalesce(current_,0) then raise exception 'conflict'; end if;
  if current_=2147483647 then raise exception 'quota_exceeded'; end if;
  begin
    insert into recipe_private.creator_profiles(account_id,display_name,avatar_data_url,revision)
      values(a,recipe_private.account_nickname(name_),case when avatar_action_='replace' then avatar_ else null end,1)
    on conflict(account_id) do update set display_name=excluded.display_name,
      avatar_data_url=case when avatar_action_='keep' then recipe_private.creator_profiles.avatar_data_url else excluded.avatar_data_url end,
      revision=recipe_private.creator_profiles.revision+1;
  exception when unique_violation then
    get stacked diagnostics constraint_=constraint_name;
    if constraint_='creator_profiles_nickname_key_unique' then raise exception 'nickname_taken'; end if;
    raise;
  end;
  return recipe_api.rich_account_profile_read();
end $$;

create function recipe_api.rich_account_profile_initialize(name_ text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid:=recipe_private.actor(); base_ text; candidate_ text; suffix_ text; attempt_ integer:=0; constraint_ text;
begin
  perform pg_advisory_xact_lock(hashtextextended(a::text,934539));
  if exists(select from recipe_private.creator_profiles where account_id=a) then return recipe_api.rich_account_profile_read(); end if;
  if not recipe_private.account_nickname_valid(name_) then raise exception 'invalid_input'; end if;
  base_:=recipe_private.account_nickname(name_); candidate_:=base_;
  if not recipe_private.account_nickname_owned(candidate_,a) then
    base_:=recipe_private.account_default_nickname(a);candidate_:=base_;
  end if;
  loop
    begin
      insert into recipe_private.creator_profiles(account_id,display_name) values(a,candidate_);
      return recipe_api.rich_account_profile_read();
    exception when unique_violation then
      get stacked diagnostics constraint_=constraint_name;
      if constraint_<>'creator_profiles_nickname_key_unique' then raise; end if;
    end;
    attempt_:=attempt_+1;
    suffix_:='-'||case when attempt_=1 then left(a::text,8) when attempt_=2 then replace(a::text,'-','') else a::text end||
      case when attempt_>3 then '-'||attempt_::text else '' end;
    candidate_:=left(base_,60-length(suffix_))||suffix_;
  end loop;
end $$;

-- Older clients can still rename a profile without clearing its avatar.
create or replace function recipe_api.rich_profile(name_ text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
  perform recipe_api.rich_account_profile(name_,'keep',null,null);
  return recipe_private.public_creator(recipe_private.actor());
end $$;
revoke all on function recipe_private.account_nickname(text),recipe_private.account_nickname_key(text),recipe_private.account_nickname_valid(text),
  recipe_private.account_default_nickname(uuid),recipe_private.account_nickname_owned(text,uuid) from public;
revoke all on function recipe_api.rich_account_profile(text,text,text,integer),recipe_api.rich_account_profile_read(),recipe_api.rich_account_profile_initialize(text) from public;
do $$
declare role_ text;
begin
  foreach role_ in array array['anon','authenticated','recipe_object_verifier'] loop
    if exists(select from pg_roles where rolname=role_) then
      execute format('revoke all on function recipe_api.rich_account_profile(text,text,text,integer),recipe_api.rich_account_profile_read(),recipe_api.rich_account_profile_initialize(text) from %I',role_);
    end if;
  end loop;
end $$;
grant execute on function recipe_api.rich_account_profile(text,text,text,integer),recipe_api.rich_account_profile_read(),recipe_api.rich_account_profile_initialize(text) to recipe_api;

reset role;
do $migration_role$
declare actor text := current_setting('vonvon.recipe_m202611160001_actor'); memberships jsonb;
  can_set boolean := current_setting('vonvon.recipe_m202611160001_can_set')::boolean;
  self_grant boolean := current_setting('vonvon.recipe_m202611160001_self_grant')::boolean;
begin
  if actor is distinct from session_user then raise exception 'migration_role_session_changed'; end if;
  if not can_set and not self_grant then
    execute format('revoke recipe_owner from %I',actor);
  end if;
  select coalesce(jsonb_agg(to_jsonb(m) order by m.roleid,m.member,m.grantor),'[]'::jsonb)
    into memberships from pg_catalog.pg_auth_members m;
  if memberships is distinct from current_setting('vonvon.recipe_m202611160001_memberships')::jsonb then
    raise exception 'migration_role_memberships_changed';
  end if;
end $migration_role$;
