create role recipe_object_verifier nologin nosuperuser nocreatedb nocreaterole nobypassrls;
grant recipe_owner to current_user;
create schema recipe_objects authorization recipe_owner;
set local role recipe_owner;
revoke all on schema recipe_objects from public;
grant usage on schema recipe_objects to recipe_object_verifier;

create table recipe_private.object_packages (
  id uuid primary key,
  actor uuid not null references recipe_private.accounts,
  draft_id uuid not null,
  cap integer not null check (cap between 1 and 4194304),
  state text not null default 'open' check (state in ('open','closing','attached','closed')),
  created_at timestamptz not null default clock_timestamp(),
  deadline timestamptz not null default clock_timestamp() + interval '10 minutes'
);
create index object_packages_actor on recipe_private.object_packages(actor,state,created_at);
create table recipe_private.object_attempts (
  id uuid primary key default gen_random_uuid(),
  package_id uuid not null references recipe_private.object_packages on delete cascade,
  ordinal integer not null check (ordinal between 0 and 65),
  kind text not null check (kind in ('text','manifest','finalLogo')),
  input_bytes integer not null check (input_bytes between 0 and 2097152),
  input_hash text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  final_cap integer not null check (final_cap between 0 and 1048576),
  final_bytes integer check (final_bytes between 0 and final_cap),
  final_hash text check (final_hash ~ '^[0-9a-f]{64}$'),
  ingress boolean not null default true,
  state text not null default 'preparing' check (state in ('preparing','ready','deleting','gone')),
  temp_state text not null default 'none' check (temp_state in ('none','writing','present','deleting','gone')),
  final_state text not null default 'none' check (final_state in ('none','writing','present','deleting','gone')),
  unique(package_id,ordinal)
);
create unique index object_one_logo on recipe_private.object_attempts(package_id) where kind='finalLogo';
create unique index object_one_manifest on recipe_private.object_attempts(package_id) where kind='manifest';
create table recipe_private.object_draft_refs (
  draft_id uuid not null references recipe_private.drafts,
  object_id uuid not null references recipe_private.object_attempts,
  primary key (draft_id,object_id)
);
create index object_by_draft_ref on recipe_private.object_draft_refs(object_id);
create table recipe_private.object_version_refs (
  version_id uuid not null references recipe_private.versions,
  object_id uuid not null references recipe_private.object_attempts,
  primary key (version_id,object_id)
);
create index object_by_version_ref on recipe_private.object_version_refs(object_id);
create table recipe_private.object_backup_pins (
  object_id uuid not null references recipe_private.object_attempts,
  backup_id uuid not null,
  primary key (object_id,backup_id)
);
alter table recipe_private.object_packages enable row level security;
alter table recipe_private.object_attempts enable row level security;
alter table recipe_private.object_draft_refs enable row level security;
alter table recipe_private.object_version_refs enable row level security;
alter table recipe_private.object_backup_pins enable row level security;

create function recipe_private.object_referenced(obj uuid) returns boolean
language sql stable set search_path = pg_catalog,pg_temp as $$
  select exists(select from recipe_private.object_draft_refs where object_id=obj)
    or exists(select from recipe_private.object_version_refs where object_id=obj)
$$;
create function recipe_private.object_budget(a uuid) returns bigint
language sql stable set search_path = pg_catalog,pg_temp as $$
  select coalesce((select sum(cap) from recipe_private.object_packages
    where actor=a and state in ('open','closing')),0)
    + coalesce((select sum(m.final_bytes) from recipe_private.object_attempts m
      join recipe_private.object_packages op on op.id=m.package_id
      where op.actor=a and op.state='attached' and m.final_state<>'gone'
        and not recipe_private.object_referenced(m.id)),0)
$$;

create function recipe_api.reserve_object_package(p_id uuid,p_draft uuid,p_cap integer) returns jsonb
language plpgsql security definer set search_path = pg_catalog,pg_temp as $$
declare a uuid := recipe_private.actor(); op recipe_private.object_packages;
begin
  perform pg_advisory_xact_lock(hashtextextended(a::text,187511));
  select * into op from recipe_private.object_packages where id=p_id;
  if found then
    if op.actor<>a then raise exception 'not_found'; end if;
    if (op.draft_id,op.cap) is distinct from (p_draft,p_cap) then raise exception 'conflict'; end if;
  else
    perform recipe_private.check_operation_birth(p_id);
    if p_draft is null or (p_cap between 1 and 4194304) is not true then raise exception 'invalid_input'; end if;
    if exists(select from recipe_private.drafts where id=p_draft and owner_id<>a)
      or exists(select from recipe_private.retired_drafts where id=p_draft) then raise exception 'not_found'; end if;
    if (select count(*) from recipe_private.object_packages where actor=a and state in ('open','closing'))>=3
      or recipe_private.object_budget(a)+p_cap>4194304 then raise exception 'object_capacity'; end if;
    if (select count(*) from recipe_private.object_packages where actor=a
      and created_at>=date_trunc('day',clock_timestamp(),'UTC'))>=60 then raise exception 'rate_limited'; end if;
    insert into recipe_private.object_packages(id,actor,draft_id,cap) values(p_id,a,p_draft,p_cap)
      returning * into op;
  end if;
  return jsonb_build_object('operationId',op.id,'draftId',op.draft_id,'cap',op.cap,'state',op.state,'deadline',op.deadline);
end $$;

create function recipe_api.cancel_object_package(p_id uuid) returns void
language plpgsql security definer set search_path = pg_catalog,pg_temp as $$
declare a uuid := recipe_private.actor();
begin
  perform pg_advisory_xact_lock(hashtextextended(a::text,187511));
  update recipe_private.object_packages set state=case when state='open' then 'closing' else state end
    where id=p_id and actor=a;
  if not found then raise exception 'not_found'; end if;
end $$;

create function recipe_api.object_capacity() returns jsonb
language sql stable security definer set search_path = pg_catalog,pg_temp as $$
  select jsonb_build_object('heldBytes',recipe_private.object_budget(recipe_private.actor()),'maxBytes',4194304)
$$;
grant execute on function recipe_api.object_capacity() to recipe_api;
grant execute on function recipe_api.reserve_object_package(uuid,uuid,integer),
  recipe_api.cancel_object_package(uuid) to recipe_api;

create function recipe_private.object_lock(p_id uuid,p_actor uuid) returns recipe_private.object_packages
language plpgsql set search_path = pg_catalog,pg_temp as $$
declare op recipe_private.object_packages;
begin
  select * into op from recipe_private.object_packages where id=p_id;
  if not found or op.actor is distinct from p_actor then raise exception 'not_found'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_actor::text,187511));
  select * into strict op from recipe_private.object_packages where id=p_id for update;
  return op;
end $$;
create function recipe_private.object_check_open(op recipe_private.object_packages) returns void
language plpgsql set search_path = pg_catalog,pg_temp as $$
begin
  if not exists(select from recipe_private.accounts where id=op.actor and status='active' for share)
    then raise exception 'account_disabled'; end if;
  if op.state<>'open' or op.deadline<=clock_timestamp() then raise exception 'operation_expired'; end if;
end $$;

create function recipe_objects.open_member(p_actor uuid,p_id uuid,p_ordinal integer,p_kind text,p_size integer,p_hash text)
returns recipe_private.object_attempts language plpgsql security definer set search_path = pg_catalog,pg_temp as $$
declare op recipe_private.object_packages := recipe_private.object_lock(p_id,p_actor);
  m recipe_private.object_attempts; held bigint; final_cap integer;
begin
  perform recipe_private.object_check_open(op);
  if (p_ordinal between 0 and 65 and p_hash ~ '^[0-9a-f]{64}$' and p_size between 0 and
    case p_kind when 'text' then 131072 when 'manifest' then 1048576 when 'finalLogo' then 2097152 end)
    is not true then raise exception 'invalid_input'; end if;
  select * into m from recipe_private.object_attempts where package_id=p_id and ordinal=p_ordinal;
  if found and (m.kind,m.input_bytes,m.input_hash) is distinct from (p_kind,p_size,p_hash) then
    raise exception 'conflict'; end if;
  if m.state='ready' then return m; end if;
  if p_kind<>'text' and exists(select from recipe_private.object_attempts
    where package_id=p_id and kind=p_kind and ordinal<>p_ordinal) then raise exception 'conflict'; end if;
  if (select count(*) from recipe_private.object_attempts s join recipe_private.object_packages o on o.id=s.package_id
    where o.actor=p_actor and s.ingress and s.id is distinct from m.id)>=2 then raise exception 'object_stream_limit'; end if;
  if m.id is null then
    if p_kind='text' and (select count(*) from recipe_private.object_attempts where package_id=p_id and kind='text')>=64
      then raise exception 'quota_exceeded'; end if;
    final_cap := case when p_kind='finalLogo' then 131072 else p_size end;
    select coalesce(sum(case when temp_state='gone' then 0 else input_bytes end
      + case when final_state='gone' then 0 else coalesce(s.final_bytes,s.final_cap) end),0)
      into held from recipe_private.object_attempts s where package_id=p_id;
    if held+p_size+final_cap>op.cap then raise exception 'object_capacity'; end if;
    insert into recipe_private.object_attempts(package_id,ordinal,kind,input_bytes,input_hash,final_cap)
      values(p_id,p_ordinal,p_kind,p_size,p_hash,final_cap) returning * into m;
  else
    if m.state<>'preparing' then raise exception 'conflict'; end if;
    update recipe_private.object_attempts set ingress=true where id=m.id returning * into m;
  end if;
  return m;
end $$;

create function recipe_objects.member(p_actor uuid,p_id uuid,p_ordinal integer)
returns recipe_private.object_attempts language plpgsql security definer set search_path = pg_catalog,pg_temp as $$
declare m recipe_private.object_attempts;
begin
  perform recipe_private.object_lock(p_id,p_actor);
  select * into m from recipe_private.object_attempts where package_id=p_id and ordinal=p_ordinal;
  if not found then raise exception 'not_found'; end if;
  return m;
end $$;

create function recipe_objects.end_ingress(p_actor uuid,p_id uuid,p_ordinal integer) returns void
language plpgsql security definer set search_path = pg_catalog,pg_temp as $$
begin
  perform recipe_private.object_lock(p_id,p_actor);
  update recipe_private.object_attempts set ingress=false where package_id=p_id and ordinal=p_ordinal;
end $$;

create function recipe_objects.start_write(p_actor uuid,p_id uuid,p_ordinal integer,p_lane text,p_size integer,p_hash text)
returns void language plpgsql security definer set search_path = pg_catalog,pg_temp as $$
declare op recipe_private.object_packages := recipe_private.object_lock(p_id,p_actor);
begin
  perform recipe_private.object_check_open(op);
  if p_lane='temp' then
    update recipe_private.object_attempts set temp_state='writing' where package_id=p_id and ordinal=p_ordinal
      and state='preparing' and ingress and temp_state='none' and input_bytes=p_size and input_hash=p_hash;
  elsif p_lane='final' then
    update recipe_private.object_attempts set final_state='writing',final_bytes=p_size,final_hash=p_hash
      where package_id=p_id and ordinal=p_ordinal and state='preparing' and ingress and temp_state='present'
      and final_state='none' and p_size between 0 and final_cap and p_hash ~ '^[0-9a-f]{64}$'
      and (kind='finalLogo' or (input_bytes=p_size and input_hash=p_hash));
  else raise exception 'invalid_input'; end if;
  if not found then raise exception 'conflict'; end if;
end $$;

create function recipe_objects.saw_bytes(p_actor uuid,p_id uuid,p_ordinal integer,p_lane text,p_size integer,p_hash text)
returns void language plpgsql security definer set search_path = pg_catalog,pg_temp as $$
begin
  perform recipe_private.object_lock(p_id,p_actor);
  if p_lane='temp' then
    update recipe_private.object_attempts set temp_state='present' where package_id=p_id and ordinal=p_ordinal
      and temp_state in ('writing','present') and input_bytes=p_size and input_hash=p_hash;
  elsif p_lane='final' then
    update recipe_private.object_attempts set final_state='present' where package_id=p_id and ordinal=p_ordinal
      and final_state in ('writing','present') and final_bytes=p_size and final_hash=p_hash;
  else raise exception 'invalid_input'; end if;
  if not found then raise exception 'integrity_error'; end if;
end $$;

create function recipe_objects.ready(p_actor uuid,p_id uuid,p_ordinal integer)
returns recipe_private.object_attempts language plpgsql security definer set search_path = pg_catalog,pg_temp as $$
declare op recipe_private.object_packages := recipe_private.object_lock(p_id,p_actor); m recipe_private.object_attempts;
begin
  perform recipe_private.object_check_open(op);
  update recipe_private.object_attempts set state='ready',ingress=false where package_id=p_id and ordinal=p_ordinal
    and state in ('preparing','ready') and final_state='present' and temp_state='gone' returning * into m;
  if not found then raise exception 'conflict'; end if;
  return m;
end $$;

create function recipe_objects.begin_delete(p_actor uuid,p_id uuid,p_ordinal integer,p_lane text)
returns void language plpgsql security definer set search_path = pg_catalog,pg_temp as $$
declare op recipe_private.object_packages := recipe_private.object_lock(p_id,p_actor); m recipe_private.object_attempts;
begin
  select * into strict m from recipe_private.object_attempts where package_id=p_id and ordinal=p_ordinal for update;
  if op.state='open' and op.deadline<=clock_timestamp() then
    update recipe_private.object_packages set state='closing' where id=p_id returning * into op;
  end if;
  if p_lane='temp' then
    if op.state='open' and m.final_state<>'present' then raise exception 'object_held'; end if;
    if m.temp_state='writing' then raise exception 'object_write_uncertain'; end if;
    update recipe_private.object_attempts set temp_state=case when temp_state in ('none','gone') then 'gone' else 'deleting' end
      where id=m.id;
  elsif p_lane='final' then
    if op.state='open' or recipe_private.object_referenced(m.id)
      or exists(select from recipe_private.object_backup_pins where object_id=m.id) then raise exception 'object_held'; end if;
    if m.final_state='writing' then raise exception 'object_write_uncertain'; end if;
    update recipe_private.object_attempts set state='deleting',
      final_state=case when final_state in ('none','gone') then 'gone' else 'deleting' end where id=m.id;
  else raise exception 'invalid_input'; end if;
end $$;

create function recipe_objects.saw_absence(p_actor uuid,p_id uuid,p_ordinal integer,p_lane text) returns void
language plpgsql security definer set search_path = pg_catalog,pg_temp as $$
begin
  perform recipe_private.object_lock(p_id,p_actor);
  if p_lane='temp' then
    update recipe_private.object_attempts set temp_state='gone' where package_id=p_id and ordinal=p_ordinal
      and temp_state in ('gone','deleting');
  elsif p_lane='final' then
    update recipe_private.object_attempts set final_state='gone' where package_id=p_id and ordinal=p_ordinal
      and final_state in ('gone','deleting');
  else raise exception 'invalid_input'; end if;
  if not found then raise exception 'conflict'; end if;
  update recipe_private.object_attempts set state='gone',ingress=false where package_id=p_id and ordinal=p_ordinal
    and state='deleting' and temp_state='gone' and final_state='gone';
end $$;

create function recipe_objects.close_package(p_actor uuid,p_id uuid) returns void
language plpgsql security definer set search_path = pg_catalog,pg_temp as $$
declare op recipe_private.object_packages := recipe_private.object_lock(p_id,p_actor);
begin
  if op.state='open' and op.deadline<=clock_timestamp() then
    update recipe_private.object_packages set state='closing' where id=p_id returning * into op;
  end if;
  if op.state='closing' and not exists(select from recipe_private.object_attempts where package_id=p_id and state<>'gone') then
    update recipe_private.object_packages set state='closed' where id=p_id;
  end if;
end $$;

create function recipe_objects.inventory(p_actor uuid,p_id uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog,pg_temp as $$
declare op recipe_private.object_packages := recipe_private.object_lock(p_id,p_actor);
begin
  if op.state='open' and op.deadline<=clock_timestamp() then
    update recipe_private.object_packages set state='closing' where id=p_id returning * into op;
  end if;
  return jsonb_build_object('operationId',op.id,'state',op.state,'deadline',op.deadline,'cap',op.cap,
    'actorHeld',recipe_private.object_budget(op.actor),'members',coalesce((select jsonb_agg(
      jsonb_build_object('ordinal',ordinal,'state',state,'inFlight',ingress,'temp',temp_state,'final',final_state)
      order by ordinal) from recipe_private.object_attempts where package_id=p_id),'[]'::jsonb));
end $$;

create function recipe_private.object_ref_guard() returns trigger
language plpgsql set search_path = pg_catalog,pg_temp as $$
declare m recipe_private.object_attempts; op recipe_private.object_packages; target_actor uuid;
begin
  select * into strict m from recipe_private.object_attempts where id=new.object_id;
  select * into strict op from recipe_private.object_packages where id=m.package_id;
  perform recipe_private.object_lock(op.id,op.actor);
  select * into strict m from recipe_private.object_attempts where id=new.object_id for update;
  if m.state<>'ready' then raise exception 'object_unavailable'; end if;
  if tg_table_name='object_draft_refs' then
    select owner_id into strict target_actor from recipe_private.drafts where id=new.draft_id;
  elsif tg_table_name='object_version_refs' then
    select owner_id into strict target_actor from recipe_private.versions where id=new.version_id;
  else return new; end if;
  if target_actor<>op.actor then raise exception 'not_found'; end if;
  return new;
end $$;
create trigger guard_object_draft before insert or update on recipe_private.object_draft_refs
  for each row execute function recipe_private.object_ref_guard();
create trigger guard_object_version before insert or update on recipe_private.object_version_refs
  for each row execute function recipe_private.object_ref_guard();
create trigger guard_object_pin before insert or update on recipe_private.object_backup_pins
  for each row execute function recipe_private.object_ref_guard();

create function recipe_private.object_drop_ref_guard() returns trigger
language plpgsql set search_path = pg_catalog,pg_temp as $$
declare op recipe_private.object_packages;
begin
  select p.* into strict op from recipe_private.object_attempts m join recipe_private.object_packages p
    on p.id=m.package_id where m.id=old.object_id;
  perform recipe_private.object_lock(op.id,op.actor);
  if recipe_private.object_budget(op.actor)>4194304 then raise exception 'object_capacity'; end if;
  return null;
end $$;
create trigger guard_draft_object_drop after delete or update of object_id on recipe_private.object_draft_refs
  for each row execute function recipe_private.object_drop_ref_guard();
create trigger guard_version_object_drop after delete or update of object_id on recipe_private.object_version_refs
  for each row execute function recipe_private.object_drop_ref_guard();

create function recipe_private.object_descriptor(p_actor uuid,p_object uuid) returns jsonb
language sql stable set search_path = pg_catalog,pg_temp as $$
  select jsonb_build_object('objectId',m.id,'kind',m.kind,'bytes',m.final_bytes,'sha256',m.final_hash,
    'mediaType',case m.kind when 'text' then 'text/plain;charset=utf-8' when 'finalLogo' then 'image/webp'
      when 'manifest' then 'application/json' end)
    from recipe_private.object_attempts m join recipe_private.object_packages p on p.id=m.package_id
    where m.id=p_object and p.actor=p_actor and m.state='ready' and m.final_state='present'
$$;

-- Invoked inside the rich draft CAS transaction, after the draft and its verified logical byte count are written.
create function recipe_private.attach_object_package(p_id uuid,p_draft uuid,p_objects uuid[]) returns void
language plpgsql set search_path = pg_catalog,pg_temp as $$
declare op recipe_private.object_packages := recipe_private.object_lock(p_id,recipe_private.actor());
begin
  if op.draft_id<>p_draft or not exists(select from recipe_private.drafts where id=p_draft and owner_id=op.actor)
    then raise exception 'not_found'; end if;
  if op.state<>'attached' then perform recipe_private.object_check_open(op); end if;
  if p_objects is null or cardinality(p_objects) not between 1 and 66 or
    (select count(*) from recipe_private.object_attempts where package_id=p_id and state='ready'
      and id=any(p_objects))<>cardinality(p_objects) or exists(select from recipe_private.object_attempts
      where package_id=p_id and (state<>'ready' or not(id=any(p_objects)))) then raise exception 'object_unavailable'; end if;
  if op.state='attached' then
    if (select count(*) from recipe_private.object_draft_refs where draft_id=p_draft and object_id=any(p_objects))
        <>cardinality(p_objects) then raise exception 'conflict'; end if;
    return;
  end if;
  insert into recipe_private.object_draft_refs(draft_id,object_id) select p_draft,unnest(p_objects);
  update recipe_private.object_packages set state='attached' where id=p_id;
end $$;

create function recipe_objects.pin_backup(p_actor uuid,p_id uuid,p_ordinal integer,p_backup uuid,p_pin boolean)
returns void language plpgsql security definer set search_path = pg_catalog,pg_temp as $$
declare m recipe_private.object_attempts := recipe_objects.member(p_actor,p_id,p_ordinal);
begin
  if p_pin then
    insert into recipe_private.object_backup_pins(object_id,backup_id) values(m.id,p_backup) on conflict do nothing;
  else
    delete from recipe_private.object_backup_pins where object_id=m.id and backup_id=p_backup;
  end if;
end $$;

create function recipe_objects.prune_closed(p_actor uuid) returns integer
language plpgsql security definer set search_path = pg_catalog,pg_temp as $$
declare n integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_actor::text,187511));
  delete from recipe_private.object_packages where id in (select id from recipe_private.object_packages
    where actor=p_actor and state in ('closed','attached') and deadline<clock_timestamp()-interval '7 days'
      and not exists(select from recipe_private.object_attempts where package_id=object_packages.id and state<>'gone')
    order by created_at limit 60);
  get diagnostics n=row_count;
  return n;
end $$;

create table recipe_private.object_quiescence (
  object_id uuid not null references recipe_private.object_attempts on delete cascade,
  lane text not null check (lane in ('temp','final')),
  evidence_sha256 text not null check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz not null default clock_timestamp(),
  primary key (object_id,lane)
);
alter table recipe_private.object_quiescence enable row level security;

-- An operator has fenced every broker process and obtained Storage-side completion evidence for this exact request.
create function recipe_objects.confirm_quiescence(p_actor uuid,p_id uuid,p_ordinal integer,p_lane text,p_evidence text)
returns void language plpgsql security definer set search_path = pg_catalog,pg_temp as $$
declare op recipe_private.object_packages := recipe_private.object_lock(p_id,p_actor);
  m recipe_private.object_attempts;
begin
  if op.state<>'closing' then raise exception 'object_held'; end if;
  select * into strict m from recipe_private.object_attempts where package_id=p_id and ordinal=p_ordinal;
  if p_lane='temp' and m.temp_state='writing' then
    update recipe_private.object_attempts set temp_state='deleting' where id=m.id;
  elsif p_lane='final' and m.final_state='writing' then
    update recipe_private.object_attempts set final_state='deleting',state='deleting' where id=m.id;
  else raise exception 'conflict'; end if;
  insert into recipe_private.object_quiescence(object_id,lane,evidence_sha256) values(m.id,p_lane,p_evidence);
end $$;

create function recipe_objects.pending_cleanup(p_actor uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog,pg_temp as $$
  select coalesce(jsonb_agg(id),'[]'::jsonb) from (select id from recipe_private.object_packages op
    where actor=p_actor and (state='closing' or (state='open' and deadline<=clock_timestamp()) or
      (state='attached' and exists(select from recipe_private.object_attempts m where m.package_id=op.id and m.state<>'gone'
        and not recipe_private.object_referenced(m.id)
        and not exists(select from recipe_private.object_backup_pins where object_id=m.id))))
    order by created_at,id limit 60) jobs
$$;

grant execute on all functions in schema recipe_objects to recipe_object_verifier;
reset role;
revoke recipe_owner from current_user;
