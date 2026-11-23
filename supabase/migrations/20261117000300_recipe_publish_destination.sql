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
  perform set_config('vonvon.recipe_m202611170003_actor',actor,true);
  perform set_config('vonvon.recipe_m202611170003_memberships',memberships::text,true);
  perform set_config('vonvon.recipe_m202611170003_can_set',can_set::text,true);
  perform set_config('vonvon.recipe_m202611170003_self_grant',self_grant::text,true);
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
create function recipe_api.publish_into(d_id uuid, rev int, req uuid, recipe_ uuid, version_ uuid, canonical bytea, descriptions_ jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid:=recipe_private.actor(); args jsonb:=jsonb_build_array(d_id,rev,recipe_,version_,encode(sha256(canonical),'hex'));
  prior jsonb:=recipe_private.prior(a,'publishDestination',req,args); parent_rev int:=0; is_rich boolean;
begin
  if (recipe_ is null) <> (version_ is null) then raise exception 'invalid_input'; end if;
  if prior is null then
    perform 1 from recipe_private.drafts where id=d_id and owner_id=a and revision=rev for update;
    if not found then raise exception 'conflict'; end if;
    is_rich:=exists(select from recipe_private.rich_drafts where id=d_id);
    if is_rich <> (canonical is not null) then raise exception 'request_upgrade_required'; end if;
    if recipe_ is not null then
      select r.revision into parent_rev from recipe_private.recipes r join recipe_private.versions v
        on v.recipe_id=r.id left join recipe_private.rich_versions rv on rv.id=v.id
        where r.id=recipe_ and r.owner_id=a and v.id=version_ and coalesce(rv.state,v.legacy_state) in ('listed','withdrawn')
          and not exists(select from recipe_private.versions later left join recipe_private.rich_versions lr on lr.id=later.id
            where later.recipe_id=r.id and later.revision>v.revision and coalesce(lr.state,later.legacy_state)<>'deleted')
        for update of r;
      if not found then raise exception 'conflict'; end if;
    end if;
    if is_rich then perform set_config('app.rich_mutation','v2',true); end if;
    update recipe_private.drafts set recipe_id=coalesce(recipe_,d_id),base_revision=parent_rev where id=d_id;
    perform recipe_private.remember(a,'publishDestination',req,args,'true'::jsonb,d_id);
  end if;
  if canonical is null then return recipe_api.publish_draft(d_id,rev,req); end if;
  if descriptions_ is null then return recipe_api.rich_publish(d_id,rev,req,canonical); end if;
  return recipe_api.rich_publish(d_id,rev,req,canonical,descriptions_);
end $$;
revoke all on function recipe_api.publish_into(uuid,int,uuid,uuid,uuid,bytea,jsonb) from public;
grant execute on function recipe_api.publish_into(uuid,int,uuid,uuid,uuid,bytea,jsonb) to recipe_api;

reset role;
do $migration_role$
declare actor text := current_setting('vonvon.recipe_m202611170003_actor'); memberships jsonb;
  can_set boolean := current_setting('vonvon.recipe_m202611170003_can_set')::boolean;
  self_grant boolean := current_setting('vonvon.recipe_m202611170003_self_grant')::boolean;
begin
  if actor is distinct from session_user then raise exception 'migration_role_session_changed'; end if;
  if not can_set and not self_grant then
    execute format('revoke recipe_owner from %I',actor);
  end if;
  select coalesce(jsonb_agg(to_jsonb(m) order by m.roleid,m.member,m.grantor),'[]'::jsonb)
    into memberships from pg_catalog.pg_auth_members m;
  if memberships is distinct from current_setting('vonvon.recipe_m202611170003_memberships')::jsonb then
    raise exception 'migration_role_memberships_changed';
  end if;
end $migration_role$;
