-- Apply on hosted Storage only, after migration 009. Run in one transaction.
grant recipe_owner to current_user;
grant usage on schema storage to recipe_owner;
grant select(id,public) on storage.buckets to recipe_owner;
grant select(bucket_id,name) on storage.objects to recipe_owner;
create policy recipe_objects_bucket_lookup on storage.buckets for select to recipe_owner
  using (id='recipe-private');
create policy recipe_objects_exact_lookup on storage.objects for select to recipe_owner
  using (bucket_id='recipe-private');
set local role recipe_owner;
create function recipe_objects.storage_absent(p_bucket text,p_key text) returns boolean
language sql stable security definer set search_path = pg_catalog,pg_temp as $$
  select p_bucket='recipe-private'
    and p_key ~ '^(temp|final)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and exists(select from storage.buckets where id=p_bucket and not public)
    and not exists(select from storage.objects where bucket_id=p_bucket and name=p_key)
$$;
grant execute on function recipe_objects.storage_absent(text,text) to recipe_object_verifier;
reset role;
revoke recipe_owner from current_user;
