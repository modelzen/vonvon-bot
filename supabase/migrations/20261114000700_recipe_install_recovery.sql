grant recipe_owner to current_user;
set local role recipe_owner;

create function recipe_api.unredeemable_operation(p_id uuid,p_account uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare op recipe_private.install_operations; now_ms bigint; born bigint; negative boolean := false;
begin
  if p_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then raise exception 'invalid_input'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_account::text,187511));
  select * into op from recipe_private.install_operations where id=p_id;
  now_ms := floor(extract(epoch from clock_timestamp())*1000)::bigint;
  born := ('x'||substr(replace(p_id::text,'-',''),1,12))::bit(48)::bigint;
  if op.id is null then
    negative := born < now_ms-300000;
  elsif op.account_id=p_account then
    negative := op.state='cancelled' or (op.state='authorized' and op.deadline<now_ms);
  end if;
  return jsonb_build_object('operationId',p_id,'unredeemable',negative);
end $$;

create function recipe_api.latest_install_version(p_recipe uuid) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare v recipe_private.versions; a uuid := recipe_private.actor();
begin
  select * into v from recipe_private.versions where recipe_id=p_recipe order by revision desc limit 1;
  if not found then raise exception 'not_found'; end if;
  return jsonb_build_object('recipeId',v.recipe_id,'versionId',v.id,'revision',v.revision,'version',v.public_info->>'version',
    'entitled',v.owner_id=a or exists(select from recipe_private.grants where actor=a and version_id=v.id));
end $$;

grant execute on function recipe_api.unredeemable_operation(uuid,uuid), recipe_api.latest_install_version(uuid) to recipe_api;
reset role;
revoke recipe_owner from current_user;
