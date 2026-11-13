-- Apply in one transaction after stopping and draining acquisition writers.
grant recipe_owner to current_user;
set local role recipe_owner;

lock table recipe_private.grants, recipe_private.receipts in access exclusive mode;
alter table recipe_private.grants add column acquisition_proof text not null default 'legacy-grant-only'
  check (acquisition_proof in ('legacy-grant-only','legacy-with-raw','v2-with-raw'));
update recipe_private.grants g set acquisition_proof='legacy-with-raw'
  where exists(select from recipe_private.receipts r where r.actor=g.actor and r.action='acquire' and r.request_id=g.original_request);
update recipe_private.receipts r set subject_id=g.version_id
  from recipe_private.grants g where r.actor=g.actor and r.action='acquire' and r.request_id=g.original_request;

create table recipe_private.acquisition_state (
  actor uuid primary key references recipe_private.accounts(id),
  effective_at timestamptz not null,
  utc_day date not null,
  accepted integer not null check (accepted between 0 and 256)
);
alter table recipe_private.acquisition_state enable row level security;
-- Snapshot successful keys before pruning. UTC and the upper bound are explicit.
with migration as (select clock_timestamp() as wall)
insert into recipe_private.acquisition_state(actor,effective_at,utc_day,accepted)
select r.actor,m.wall,(m.wall at time zone 'UTC')::date,
  least(256,count(*) filter(where r.created_at >= date_trunc('day',m.wall at time zone 'UTC') at time zone 'UTC'
    and r.created_at <= m.wall))::integer
from recipe_private.receipts r cross join migration m where r.action='acquire'
group by r.actor,m.wall;
with ranked as (
  select actor,request_id,created_at,row_number() over(partition by actor order by created_at desc,request_id desc) as n
  from recipe_private.receipts where action='acquire' and subject_id is null
)
delete from recipe_private.receipts r using ranked x
where r.actor=x.actor and r.action='acquire' and r.request_id=x.request_id
  and (x.n>2048 or x.created_at<=clock_timestamp()-interval '168 hours');
create index acquisition_noop_expiry on recipe_private.receipts(actor,created_at)
  where action in ('acquire','acquire_v2') and subject_id is null;

create function recipe_private.acquisition_birth(req uuid) returns timestamptz
language sql immutable strict set search_path = pg_catalog, pg_temp as $$
  select to_timestamp(('x'||substr(replace(req::text,'-',''),1,12))::bit(48)::bigint::double precision/1000)
$$;

create function recipe_api.acquire(p_version uuid,p_code text,p_request text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  a uuid := recipe_private.actor();
  req uuid; op text; is_v2 boolean;
  args jsonb := jsonb_build_array(p_version,p_code);
  raw_digest bytea := sha256(convert_to(args::text,'UTF8'));
  code text := upper(replace(btrim(p_code),'-',''));
  normalized_digest bytea := sha256(convert_to(jsonb_build_array(p_version,code)::text,'UTF8'));
  previous recipe_private.receipts; g recipe_private.grants; v recipe_private.versions;
  state recipe_private.acquisition_state; wall timestamptz; effective timestamptz;
  born timestamptz; day date; accepted integer; result jsonb; lookup bytea; first_grant boolean := false;
begin
  if p_request ~* '^a2\.[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    req := substr(p_request,4)::uuid; op := 'acquire_v2'; is_v2 := true;
  elsif p_request ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    req := p_request::uuid; op := 'acquire'; is_v2 := false;
  else raise exception 'invalid_input'; end if;
  perform pg_advisory_xact_lock(hashtextextended(a::text,187511));
  -- Capture time only after waiting for the shared business-account lock.
  wall := clock_timestamp();
  select * into previous from recipe_private.receipts where actor=a and action=op and request_id=req;
  if found then
    if previous.digest<>raw_digest then raise exception 'conflict'; end if;
    return previous.result;
  end if;
  select * into g from recipe_private.grants where actor=a and original_request=req;
  if found then
    if is_v2 <> (g.acquisition_proof='v2-with-raw') then raise exception 'conflict'; end if;
    if g.acquisition_proof<>'legacy-grant-only' then raise exception 'integrity_error'; end if;
    if g.original_digest<>normalized_digest then raise exception 'conflict'; end if;
    select * into v from recipe_private.versions where id=g.version_id;
    if not found or v.id<>p_version then raise exception 'integrity_error'; end if;
    result := jsonb_build_object('recipeId',v.recipe_id,'versionId',v.id,'owned',v.owner_id=a,'acquired',v.owner_id<>a);
    insert into recipe_private.receipts(actor,action,request_id,digest,result,subject_id,created_at)
      values(a,op,req,raw_digest,result,v.id,wall);
    update recipe_private.grants set acquisition_proof='legacy-with-raw' where actor=a and version_id=g.version_id;
    return result;
  end if;
  if not is_v2 then raise exception 'request_upgrade_required'; end if;
  select * into state from recipe_private.acquisition_state where actor=a;
  effective := greatest(wall,state.effective_at);
  born := recipe_private.acquisition_birth(req);
  if born<effective-interval '5 minutes' then raise exception 'operation_expired'; end if;
  if born>effective+interval '2 minutes' then raise exception 'operation_clock_skew'; end if;
  day := (effective at time zone 'UTC')::date;
  accepted := case when day=state.utc_day then state.accepted else 0 end;
  if accepted>=256 then
    raise exception 'acquire_rate_limited' using detail=ceil(extract(epoch from
      (((day+1)::timestamp at time zone 'UTC')-wall)))::bigint::text;
  end if;
  select * into v from recipe_private.versions where id=p_version;
  if not found then raise exception 'not_found'; end if;
  if v.owner_id<>a and not exists(select from recipe_private.grants where actor=a and version_id=v.id) then
    if v.public_info->>'access'='coded' then
      if code is null or code !~ '^[0-9A-F]{32}$' then raise exception 'invalid_code'; end if;
      lookup := recipe_private.code_mac('recipe-code-lookup:v1',convert_to(code,'UTF8'));
      update recipe_private.codes set status='redeemed',redeemed_at=effective,redeemed_by=a,nonce=null
        where lookup_digest=lookup and version_id=v.id and status='available';
      if not found then raise exception 'invalid_code'; end if;
    end if;
    insert into recipe_private.grants(actor,version_id,original_request,original_digest,acquisition_proof)
      values(a,v.id,req,normalized_digest,'v2-with-raw');
    first_grant := true;
  end if;
  result := jsonb_build_object('recipeId',v.recipe_id,'versionId',v.id,'owned',v.owner_id=a,'acquired',v.owner_id<>a);
  insert into recipe_private.receipts(actor,action,request_id,digest,result,subject_id,created_at)
    values(a,op,req,raw_digest,result,case when first_grant then v.id end,effective);
  delete from recipe_private.receipts where actor=a and action in ('acquire','acquire_v2') and subject_id is null
    and created_at<=effective-interval '168 hours';
  insert into recipe_private.acquisition_state values(a,effective,day,accepted+1)
    on conflict(actor) do update set effective_at=excluded.effective_at,utc_day=excluded.utc_day,accepted=excluded.accepted;
  return result;
end $$;

-- Previously authorized callers may recover known legacy operations but cannot
-- create another unbounded legacy receipt. Keep the old signature safely closed.
create or replace function recipe_api.acquire(p_version uuid,p_code text,p_request uuid) returns jsonb
language sql security definer set search_path = pg_catalog, pg_temp as $$
  select recipe_api.acquire(p_version,p_code,p_request::text)
$$;
revoke all on function recipe_api.acquire(uuid,text,text),recipe_api.acquire(uuid,text,uuid),recipe_private.acquisition_birth(uuid) from public;
grant execute on function recipe_api.acquire(uuid,text,text),recipe_api.acquire(uuid,text,uuid) to recipe_api;
reset role;
revoke recipe_owner from current_user;
