-- The network service verifies Supabase identity before opening this transaction.
-- Its LOGIN role is provisioned separately and inherits only recipe_api.
create role recipe_owner nologin nosuperuser nocreatedb nocreaterole nobypassrls;
create role recipe_api nologin nosuperuser nocreatedb nocreaterole nobypassrls;
grant recipe_owner to current_user;
create schema recipe_private authorization recipe_owner;
create schema recipe_api authorization recipe_owner;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
grant usage on schema extensions to recipe_owner;

set local role recipe_owner;
revoke all on schema recipe_private, recipe_api from public;
alter default privileges revoke execute on functions from public;
grant usage on schema recipe_api to recipe_api;

create table recipe_private.recipes (
  id uuid primary key,
  owner_id uuid not null,
  revision integer not null default 0
);

create table recipe_private.drafts (
  id uuid primary key,
  owner_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  recipe_id uuid not null,
  base_revision integer not null,
  revision integer not null check (revision > 0),
  public_info jsonb not null,
  config jsonb not null,
  bytes integer not null check (bytes between 0 and 1048576)
);
create index drafts_owner on recipe_private.drafts (owner_id);

-- Stable ID tombstones retain neither content nor user-entered fields. This
-- makes a retired caller-generated ID permanently unavailable for recreation.
create table recipe_private.retired_drafts (
  id uuid primary key,
  owner_id uuid not null,
  created_at timestamptz not null
);
create index retired_drafts_by_actor_day on recipe_private.retired_drafts(owner_id,created_at);

create table recipe_private.versions (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references recipe_private.recipes,
  owner_id uuid not null,
  revision integer not null,
  public_info jsonb not null,
  config jsonb not null,
  bytes integer not null check (bytes between 0 and 1048576),
  published_at timestamptz not null default clock_timestamp(),
  unique (recipe_id, revision)
);
create unique index version_labels on recipe_private.versions(recipe_id, (public_info->>'version'));
create index version_order on recipe_private.versions(published_at desc, id desc);
create index author_history on recipe_private.versions(owner_id, published_at desc);
create index author_recipes on recipe_private.recipes(owner_id);

create table recipe_private.grants (
  actor uuid not null,
  version_id uuid not null references recipe_private.versions,
  original_request uuid not null,
  original_digest bytea not null,
  unique (actor, original_request),
  primary key (actor, version_id)
);
create table recipe_private.codes (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references recipe_private.versions,
  owner_id uuid not null,
  nonce bytea,
  lookup_digest bytea not null unique,
  suffix text not null,
  created_at timestamptz not null default clock_timestamp(),
  redeemed_by uuid,
  redeemed_at timestamptz,
  status text not null default 'available',
  check ((status='available' and nonce is not null and redeemed_by is null and redeemed_at is null)
      or (status='disabled' and nonce is null and redeemed_by is null and redeemed_at is null)
      or (status='redeemed' and nonce is null and redeemed_by is not null and redeemed_at is not null))
);
create index version_codes on recipe_private.codes(version_id, id);
create index author_codes on recipe_private.codes(owner_id, created_at);
create table recipe_private.receipts (
  actor uuid not null,
  action text not null,
  request_id uuid not null,
  digest bytea not null,
  result jsonb not null,
  subject_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  primary key (actor, action, request_id)
);
create index recent_draft_receipts on recipe_private.receipts(actor, subject_id, created_at desc, request_id)
  where action='save';
alter table recipe_private.recipes enable row level security;
alter table recipe_private.drafts enable row level security;
alter table recipe_private.retired_drafts enable row level security;
alter table recipe_private.versions enable row level security;
alter table recipe_private.grants enable row level security;
alter table recipe_private.codes enable row level security;
alter table recipe_private.receipts enable row level security;

create function recipe_private.actor(required boolean default true) returns uuid
language plpgsql stable set search_path = pg_catalog, pg_temp as $$
declare a uuid := nullif(current_setting('app.recipe_account',true),'')::uuid;
begin
  if required and a is null then raise exception 'auth_required'; end if;
  return a;
end $$;

-- Every mutation for one actor serializes quota and idempotency tests. Code
-- consumption by different actors is additionally arbitrated by the code row.
create function recipe_private.prior(a uuid, op text, req uuid, body jsonb) returns jsonb
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare prev recipe_private.receipts;
begin
  if req is null then raise exception 'invalid_input'; end if;
  perform pg_advisory_xact_lock(hashtextextended(a::text, 187511));
  select * into prev from recipe_private.receipts where actor=a and action=op and request_id=req;
  if not found then return null; end if;
  if prev.digest <> sha256(convert_to(body::text,'UTF8')) then raise exception 'conflict'; end if;
  return prev.result;
end $$;

create function recipe_private.remember(a uuid, op text, req uuid, body jsonb, result jsonb, subject uuid default null)
returns jsonb language sql set search_path = pg_catalog, pg_temp as $$
  insert into recipe_private.receipts(actor,action,request_id,digest,result,subject_id)
  values(a,op,req,sha256(convert_to(body::text,'UTF8')),result,subject) returning receipts.result
$$;

create function recipe_private.check_fields(pub jsonb, cfg jsonb, ready boolean) returns void
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
begin
  if jsonb_typeof(pub) is distinct from 'object' or jsonb_typeof(cfg) is distinct from 'object' then
    raise exception 'invalid_input';
  end if;
  if pub - array['name','summary','overview','version','access'] <> '{}'::jsonb
     or not (pub ?& array['name','summary','overview','version','access'])
     or exists (select from jsonb_each(pub) where jsonb_typeof(value) <> 'string')
     or cfg - 'role' <> '{}'::jsonb or jsonb_typeof(cfg->'role') is distinct from 'string'
     or length(pub->>'name') > 60 or length(pub->>'summary') > 240 or length(pub->>'version') > 40
     or octet_length(pub->>'overview') > 32768 or octet_length(cfg->>'role') > 16384
     or pub->>'access' not in ('direct','coded')
     or (ready and (btrim(pub->>'name')='' or btrim(pub->>'summary')='' or btrim(pub->>'version')='')) then
    raise exception 'invalid_input';
  end if;
end $$;

create function recipe_private.draft_json(d recipe_private.drafts) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('draftId',d.id,'recipeId',d.recipe_id,'revision',d.revision,
    'public',d.public_info,'config',d.config)
$$;

create function recipe_api.save_draft(p_draft uuid,p_expected int,p_public jsonb,p_config jsonb,
                                      p_request uuid,p_recipe uuid default null,p_source_version uuid default null) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  a uuid := recipe_private.actor();
  args jsonb := jsonb_build_array(p_draft,p_expected,p_public,p_config,p_recipe,p_source_version);
  replay jsonb := recipe_private.prior(a,'save',p_request,args);
  d recipe_private.drafts;
  parent recipe_private.recipes;
  bytes_new int;
  others_bytes bigint;
  other_count int;
begin
  if replay is not null then
    select * into d from recipe_private.drafts where id=p_draft and owner_id=a;
    if not found then raise exception 'not_found'; end if;
    if d.revision<>(replay->>'revision')::integer then raise exception 'conflict'; end if;
    return recipe_private.draft_json(d);
  end if;
  if p_draft is null or p_expected is null or p_expected < 0
     or (p_source_version is not null and (p_expected<>0 or p_recipe is null or p_recipe=p_draft))
  then raise exception 'invalid_input'; end if;
  perform recipe_private.check_fields(p_public,p_config,false);
  bytes_new := octet_length(jsonb_build_object('public',p_public,'config',p_config)::text);
  select count(*),coalesce(sum(bytes),0) into other_count,others_bytes
    from recipe_private.drafts where owner_id=a and id<>p_draft;
  if other_count>=20 or others_bytes+bytes_new>10485760 then raise exception 'quota_exceeded'; end if;
  select * into d from recipe_private.drafts where id=p_draft;
  if found then
    if d.owner_id<>a then raise exception 'not_found'; end if;
    if d.revision<>p_expected or (p_recipe is not null and p_recipe<>d.recipe_id) then raise exception 'conflict'; end if;
    update recipe_private.drafts set revision=revision+1, public_info=p_public,config=p_config,bytes=bytes_new
      where id=p_draft returning * into d;
  else
    if p_expected<>0 then raise exception 'conflict'; end if;
    -- Limit churn as well as live storage. Retiring a draft preserves its
    -- creation date so deleting one never grants another daily allowance.
    if (select count(*) from recipe_private.drafts where owner_id=a
          and created_at>=date_trunc('day',statement_timestamp(),'UTC'))
       + (select count(*) from recipe_private.retired_drafts where owner_id=a
          and created_at>=date_trunc('day',statement_timestamp(),'UTC'))>=100 then raise exception 'rate_limited'; end if;
    -- Do not let an unrelated creation reuse an already finalised draft ID.
    if exists(select from recipe_private.retired_drafts where id=p_draft) then raise exception 'conflict'; end if;
    if p_recipe is not null and p_recipe<>p_draft then
      select * into parent from recipe_private.recipes where id=p_recipe and owner_id=a;
      if not found then raise exception 'not_found'; end if;
      if not exists(select from recipe_private.versions where id=p_source_version
                    and recipe_id=parent.id and revision=parent.revision) then raise exception 'conflict'; end if;
    elsif exists(select from recipe_private.recipes where id=p_draft) then
      raise exception 'conflict';
    end if;
    insert into recipe_private.drafts(id,owner_id,recipe_id,base_revision,revision,public_info,config,bytes)
      values(p_draft,a,coalesce(p_recipe,p_draft),coalesce(parent.revision,0),1,p_public,p_config,bytes_new)
      on conflict do nothing returning * into d;
    if not found then raise exception 'conflict'; end if;
  end if;
  perform recipe_private.remember(a,'save',p_request,args,jsonb_build_object(
    'draftId',d.id,'recipeId',d.recipe_id,'revision',d.revision),d.id);
  -- Retain eight recent keys per live draft. An older exact retry still has
  -- an obsolete expected revision and therefore fails without changing state.
  delete from recipe_private.receipts where actor=a and action='save' and request_id in (
    select request_id from recipe_private.receipts where actor=a and action='save' and subject_id=d.id
    order by created_at desc,request_id desc offset 8);
  return recipe_private.draft_json(d);
end $$;

create function recipe_api.get_draft(p_draft uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare d recipe_private.drafts; a uuid := recipe_private.actor();
begin
  select * into d from recipe_private.drafts where id=p_draft and owner_id=a;
  if not found then raise exception 'not_found'; end if;
  return recipe_private.draft_json(d);
end $$;
create function recipe_api.list_drafts() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare a uuid := recipe_private.actor();
begin
  return jsonb_build_object('items',(select coalesce(jsonb_agg(recipe_private.draft_json(d) order by id),'[]')
    from recipe_private.drafts d where owner_id=a));
end $$;

create function recipe_api.delete_draft(p_draft uuid,p_expected int,p_request uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  a uuid := recipe_private.actor();
  args jsonb := jsonb_build_array(p_draft,p_expected);
  replay jsonb := recipe_private.prior(a,'delete',p_request,args);
  rev int;
begin
  if replay is not null then return replay; end if;
  select revision into rev from recipe_private.drafts where id=p_draft and owner_id=a;
  if not found then raise exception 'not_found'; end if;
  if rev is distinct from p_expected then raise exception 'conflict'; end if;
  insert into recipe_private.retired_drafts select id,owner_id,created_at from recipe_private.drafts where id=p_draft;
  delete from recipe_private.receipts where actor=a and action='save' and subject_id=p_draft;
  delete from recipe_private.drafts where id=p_draft;
  return recipe_private.remember(a,'delete',p_request,args,jsonb_build_object('draftId',p_draft,'deleted',true));
end $$;

-- A private nonce recovers the author's copy while a code is available.
-- Consuming or disabling a code permanently clears it. Receipts store IDs.
create function recipe_private.code_mac(domain text, input bytea) returns bytea
language plpgsql stable set search_path = pg_catalog, pg_temp as $$
declare k text := current_setting('app.recipe_code_key', true);
begin
  if k is null or k !~ '^[[:xdigit:]]{64}$' then raise exception 'code_key_unavailable'; end if;
  return extensions.hmac(convert_to(domain,'UTF8') || input,decode(k,'hex'),'sha256');
end $$;
create function recipe_private.display_code(nonce bytea) returns text
language sql stable strict set search_path = pg_catalog, pg_temp as $$
  select upper(encode(substring(recipe_private.code_mac('recipe-code-show:v1',nonce) for 16),'hex'))
$$;

create function recipe_private.new_codes(a uuid,v uuid,n int) returns jsonb
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare total int; today int; active int; ids jsonb;
  midnight timestamptz := date_trunc('day', statement_timestamp(), 'UTC');
begin
  if n is null or n not between 1 and 100 then raise exception 'invalid_input'; end if;
  select count(*),count(*) filter(where created_at>=midnight) into total,today
    from recipe_private.codes where owner_id=a;
  select count(*) into active from recipe_private.codes where version_id=v and status='available';
  if total+n>5000 or active+n>500 then raise exception 'quota_exceeded'; end if;
  if today+n>500 then raise exception 'rate_limited'; end if;
  with seeds as materialized (
    select extensions.gen_random_bytes(32) as seed from generate_series(1,n)
  ), minted as (
    insert into recipe_private.codes(version_id,owner_id,nonce,lookup_digest,suffix)
      select v,a,seed,recipe_private.code_mac('recipe-code-lookup:v1',convert_to(code,'UTF8')),right(code,4)
      from seeds cross join lateral (select recipe_private.display_code(seed) as code) x
      returning id
  ) select jsonb_agg(id order by id) into ids from minted;
  return ids;
end $$;

create function recipe_private.code_json(c recipe_private.codes) returns jsonb
language sql stable set search_path = pg_catalog, pg_temp as $$
  select jsonb_strip_nulls(jsonb_build_object('codeId',c.id,'status',c.status,'code',recipe_private.display_code(c.nonce)))
$$;
create function recipe_private.summary(v recipe_private.versions) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('recipeId',v.recipe_id,'versionId',v.id,'revision',v.revision,'public',v.public_info)
$$;

create function recipe_api.publish_draft(p_draft uuid,p_expected int,p_request uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  a uuid := recipe_private.actor();
  args jsonb := jsonb_build_array(p_draft,p_expected);
  receipt jsonb := recipe_private.prior(a,'publish',p_request,args);
  d recipe_private.drafts; v recipe_private.versions;
  first_id uuid; first_code text; parent_rev int; history_bytes bigint; today int;
begin
  if receipt is null then
    select * into d from recipe_private.drafts where id=p_draft and owner_id=a;
    if not found then raise exception 'not_found'; end if;
    if d.revision is distinct from p_expected then raise exception 'conflict'; end if;
    perform recipe_private.check_fields(d.public_info,d.config,true);
    select count(*) filter(where published_at>=date_trunc('day',statement_timestamp(),'UTC')),coalesce(sum(bytes),0)
      into today,history_bytes from recipe_private.versions where owner_id=a;
    if today>=10 then raise exception 'rate_limited'; end if;
    if history_bytes+d.bytes>26214400 then raise exception 'quota_exceeded'; end if;
    if d.base_revision=0 then
      if (select count(*) from recipe_private.recipes where owner_id=a)>=20 then raise exception 'quota_exceeded'; end if;
      insert into recipe_private.recipes(id,owner_id) values(d.recipe_id,a) on conflict do nothing;
      if not found then raise exception 'conflict'; end if;
    end if;
    select revision into parent_rev from recipe_private.recipes where id=d.recipe_id and owner_id=a for update;
    if parent_rev is distinct from d.base_revision then raise exception 'conflict'; end if;
    if parent_rev>=30 then raise exception 'quota_exceeded'; end if;
    if exists(select from recipe_private.versions where recipe_id=d.recipe_id
              and public_info->>'version'=d.public_info->>'version') then raise exception 'conflict'; end if;
    insert into recipe_private.versions(recipe_id,owner_id,revision,public_info,config,bytes)
      values(d.recipe_id,a,parent_rev+1,d.public_info,d.config,d.bytes) returning * into v;
    update recipe_private.recipes set revision=v.revision where id=d.recipe_id;
    if v.public_info->>'access'='coded' then first_id := (recipe_private.new_codes(a,v.id,1)->>0)::uuid; end if;
    insert into recipe_private.retired_drafts values(d.id,a,d.created_at);
    delete from recipe_private.receipts where actor=a and action='save' and subject_id=d.id;
    delete from recipe_private.drafts where id=d.id;
    receipt := recipe_private.remember(a,'publish',p_request,args,
      jsonb_build_object('draftId',p_draft,'versionId',v.id,'firstCodeId',first_id));
  else
    select * into strict v from recipe_private.versions where id=(receipt->>'versionId')::uuid;
    first_id := (receipt->>'firstCodeId')::uuid;
  end if;
  select recipe_private.display_code(nonce) into first_code from recipe_private.codes where id=first_id and owner_id=a;
  return recipe_private.summary(v) || jsonb_strip_nulls(jsonb_build_object('firstCode',first_code));
end $$;

create function recipe_api.issue_codes(p_version uuid,p_count int,p_request uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  a uuid := recipe_private.actor(); args jsonb := jsonb_build_array(p_version,p_count);
  ids jsonb := recipe_private.prior(a,'issue',p_request,args); access text;
begin
  if ids is null then
    select public_info->>'access' into access from recipe_private.versions where id=p_version and owner_id=a;
    if not found then raise exception 'not_found'; end if;
    if access<>'coded' then raise exception 'invalid_input'; end if;
    ids := recipe_private.remember(a,'issue',p_request,args,recipe_private.new_codes(a,p_version,p_count));
  end if;
  return jsonb_build_object('items',(select jsonb_agg(recipe_private.code_json(c) order by c.id)
    from jsonb_array_elements_text(ids) x join recipe_private.codes c on c.id=x.value::uuid and c.owner_id=a));
end $$;

create function recipe_api.list_codes(p_version uuid,p_cursor uuid default null) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare a uuid := recipe_private.actor(); result jsonb;
begin
  if not exists(select from recipe_private.versions where id=p_version and owner_id=a) then raise exception 'not_found'; end if;
  if p_cursor is not null and not exists(select from recipe_private.codes where version_id=p_version and id=p_cursor) then
    raise exception 'invalid_input';
  end if;
  with page as (
    select * from recipe_private.codes where version_id=p_version and (p_cursor is null or id>p_cursor)
    order by id limit 51
  ), items as (select * from page order by id limit 50)
  select jsonb_build_object('items',coalesce(jsonb_agg(jsonb_build_object('codeId',id,'suffix',suffix,
      'status',status,'redeemedAt',redeemed_at) order by id),'[]'),
      'nextCursor',case when (select count(*) from page)>50 then (array_agg(id order by id desc))[1] end)
    into result from items;
  return result;
end $$;

create function recipe_api.reveal_code(p_code_id uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare a uuid := recipe_private.actor(); c recipe_private.codes;
begin
  select * into c from recipe_private.codes where id=p_code_id and owner_id=a;
  if not found then raise exception 'not_found'; end if;
  if c.status<>'available' then raise exception 'conflict'; end if;
  return recipe_private.code_json(c);
end $$;
create function recipe_api.disable_code(p_code_id uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare a uuid := recipe_private.actor(); c recipe_private.codes;
begin
  select * into c from recipe_private.codes where id=p_code_id and owner_id=a for update;
  if not found then raise exception 'not_found'; end if;
  if c.status='redeemed' then raise exception 'conflict'; end if;
  update recipe_private.codes set nonce=null,status='disabled' where id=c.id and status='available';
  return jsonb_build_object('codeId',c.id,'status','disabled');
end $$;

create function recipe_api.acquire(p_version uuid,p_code text,p_request uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  a uuid := recipe_private.actor(); code text := upper(replace(btrim(p_code),'-',''));
  args jsonb := jsonb_build_array(p_version,code);
  v recipe_private.versions; lookup bytea; prior_digest bytea;
  digest bytea := sha256(convert_to(args::text,'UTF8'));
begin
  if p_request is null then raise exception 'invalid_input'; end if;
  perform pg_advisory_xact_lock(hashtextextended(a::text,187511));
  select original_digest into prior_digest from recipe_private.grants where actor=a and original_request=p_request;
  if found and prior_digest<>digest then raise exception 'conflict'; end if;
  select * into v from recipe_private.versions where id=p_version;
  if not found then raise exception 'not_found'; end if;
  if v.owner_id<>a and not exists(select from recipe_private.grants where actor=a and version_id=v.id) then
    if v.public_info->>'access'='coded' then
      if code is null or code !~ '^[0-9A-F]{32}$' then raise exception 'invalid_code'; end if;
      lookup := recipe_private.code_mac('recipe-code-lookup:v1',convert_to(code,'UTF8'));
      update recipe_private.codes set status='redeemed',redeemed_at=clock_timestamp(),redeemed_by=a,nonce=null
        where lookup_digest=lookup and version_id=v.id and status='available';
      if not found then raise exception 'invalid_code'; end if;
    end if;
    insert into recipe_private.grants values(a,v.id,p_request,digest);
  end if;
  return jsonb_build_object('recipeId',v.recipe_id,'versionId',v.id,'owned',v.owner_id=a,'acquired',v.owner_id<>a);
end $$;

create function recipe_api.version_detail(p_recipe uuid,p_version uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare a uuid := recipe_private.actor(false); v recipe_private.versions; owned boolean; acquired boolean; result jsonb;
begin
  select * into v from recipe_private.versions where id=p_version and recipe_id=p_recipe;
  if not found then raise exception 'not_found'; end if;
  owned := coalesce(a=v.owner_id,false);
  acquired := exists(select from recipe_private.grants where actor=a and version_id=v.id);
  result := recipe_private.summary(v) || jsonb_build_object('owned',owned,'acquired',acquired);
  if owned or acquired or v.public_info->>'access'='direct' then result := result || jsonb_build_object('config',v.config); end if;
  return result;
end $$;

create function recipe_api.library(p_cursor uuid default null) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare a uuid := recipe_private.actor(); cursor_time timestamptz; result jsonb;
begin
  if p_cursor is not null then
    select v.published_at into cursor_time from recipe_private.versions v
      join recipe_private.grants g on g.version_id=v.id where g.actor=a and v.id=p_cursor;
    if not found then raise exception 'invalid_input'; end if;
  end if;
  with latest as (
    select distinct on(v.recipe_id) v as version,v.published_at,v.id
      from recipe_private.grants g join recipe_private.versions v on v.id=g.version_id
      where g.actor=a order by v.recipe_id,v.revision desc
  ), page as (
    select * from latest where p_cursor is null or (published_at,id)<(cursor_time,p_cursor)
      order by published_at desc,id desc limit 51
  ), items as (select * from page order by published_at desc,id desc limit 50)
  select jsonb_build_object('items',coalesce(jsonb_agg(recipe_private.summary(version) #- '{public,overview}'
    order by published_at desc,id desc),'[]'),
    'nextCursor',case when (select count(*) from page)>50 then (array_agg(id order by published_at,id))[1] end)
    into result from items;
  return result;
end $$;

create function recipe_api.publications() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare a uuid := recipe_private.actor();
begin
  return jsonb_build_object('items',(select coalesce(jsonb_agg(jsonb_build_object(
    'recipeId',v.recipe_id,'versionId',v.id,'revision',v.revision,
    'public',v.public_info-array['summary','overview']) order by published_at desc,id desc),'[]')
    from recipe_private.versions v where owner_id=a));
end $$;

create function recipe_api.catalog(p_query text,p_cursor uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare term text := lower(btrim(coalesce(p_query,''))); hero recipe_private.versions;
  cursor_time timestamptz; result jsonb;
begin
  if length(term)>240 then raise exception 'invalid_input'; end if;
  if p_cursor is not null then
    select published_at into cursor_time from recipe_private.versions where id=p_cursor;
    if not found then raise exception 'invalid_input'; end if;
  elsif term='' then
    select v.* into hero from recipe_private.versions v join recipe_private.recipes r on r.id=v.recipe_id and r.revision=v.revision
      order by v.published_at desc,v.id desc limit 1;
  end if;
  with page as (
    select v as version,v.id,v.published_at from recipe_private.versions v
    join recipe_private.recipes r on r.id=v.recipe_id and r.revision=v.revision
    where (p_cursor is null or (v.published_at,v.id)<(cursor_time,p_cursor)) and v.id is distinct from hero.id
      and (term='' or strpos(lower(v.public_info->>'name'),term)>0 or strpos(lower(v.public_info->>'summary'),term)>0)
    order by v.published_at desc,v.id desc limit 9
  ), items as (select * from page order by published_at desc,id desc limit 8)
  select jsonb_build_object('hero',case when hero.id is not null then recipe_private.summary(hero) end,
    'items',coalesce(jsonb_agg(recipe_private.summary(version) order by published_at desc,id desc),'[]'),
    'nextCursor',case when (select count(*) from page)>8 then (array_agg(id order by published_at,id))[1] end)
    into result from items;
  return result;
end $$;

-- Only the bounded interface is accessible to the network service.
grant execute on all functions in schema recipe_api to recipe_api;
reset role;
revoke recipe_owner from current_user;
