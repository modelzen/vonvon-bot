grant recipe_owner to current_user;
set local role recipe_owner;

create function recipe_api.rich_profile_read() returns jsonb
language sql stable security definer set search_path=pg_catalog,pg_temp as $$
  select recipe_private.public_creator(recipe_private.actor())
$$;
revoke all on function recipe_api.rich_profile_read() from public;
do $$
declare role_ text;
begin
  foreach role_ in array array['anon','authenticated'] loop
    if exists(select from pg_roles where rolname=role_) then
      execute format('revoke all on function recipe_api.rich_profile_read() from %I',role_);
    end if;
  end loop;
end $$;
grant execute on function recipe_api.rich_profile_read() to recipe_api;

reset role;
revoke recipe_owner from current_user;
