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
  perform set_config('vonvon.recipe_m014_actor',actor,true);
  perform set_config('vonvon.recipe_m014_memberships',memberships::text,true);
  perform set_config('vonvon.recipe_m014_can_set',can_set::text,true);
  perform set_config('vonvon.recipe_m014_self_grant',self_grant::text,true);
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

create or replace function recipe_api.reserve_object_package(p_id uuid,p_draft uuid,p_cap integer) returns jsonb
language plpgsql security definer set search_path = pg_catalog,pg_temp as $$
declare a uuid := recipe_private.actor(); op recipe_private.object_packages;
begin
  perform pg_advisory_xact_lock(hashtextextended(a::text,187511));
  select * into op from recipe_private.object_packages where id=p_id;
  if found then
    if op.actor<>a then raise exception 'not_found'; end if;
    if (op.draft_id,op.cap) is distinct from (p_draft,p_cap) then raise exception 'conflict'; end if;
  else
    -- Confirmation can arrive throughout the registered authoring lifetime.
    -- Only its first matching upload package inherits that admission window.
    if not exists(select from recipe_private.rich_intents i
      join recipe_private.authoring_operations authoring on authoring.id=i.id
      where i.id=p_id and i.account_id=a and authoring.account_id=a and i.draft_id=p_draft
        and authoring.state='dispatched' and authoring.terminal_at is null and authoring.receipt is null
        and authoring.expires_at>clock_timestamp()) then
      perform recipe_private.check_operation_birth(p_id);
    end if;
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

reset role;
do $migration_role$
declare actor text := current_setting('vonvon.recipe_m014_actor'); memberships jsonb;
  can_set boolean := current_setting('vonvon.recipe_m014_can_set')::boolean;
  self_grant boolean := current_setting('vonvon.recipe_m014_self_grant')::boolean;
begin
  if actor is distinct from session_user then raise exception 'migration_role_session_changed'; end if;
  if not can_set and not self_grant then
    execute format('revoke recipe_owner from %I',actor);
  end if;
  select coalesce(jsonb_agg(to_jsonb(m) order by m.roleid,m.member,m.grantor),'[]'::jsonb)
    into memberships from pg_catalog.pg_auth_members m;
  if memberships is distinct from current_setting('vonvon.recipe_m014_memberships')::jsonb then
    raise exception 'migration_role_memberships_changed';
  end if;
end $migration_role$;
