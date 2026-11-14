begin;
set local role recipe_owner;

alter function recipe_api.library(uuid) rename to library_all_generations;
alter function recipe_api.library_all_generations(uuid) set schema recipe_private;
alter function recipe_api.publications() rename to publications_all_generations;
alter function recipe_api.publications_all_generations() set schema recipe_private;
alter function recipe_api.list_drafts() rename to drafts_all_generations;
alter function recipe_api.drafts_all_generations() set schema recipe_private;
alter function recipe_api.version_detail(uuid,uuid) rename to detail_role_generation;
alter function recipe_api.detail_role_generation(uuid,uuid) set schema recipe_private;
alter function recipe_api.get_draft(uuid) rename to draft_role_generation;
alter function recipe_api.draft_role_generation(uuid) set schema recipe_private;
alter function recipe_api.install_preview(uuid) rename to preview_role_generation;
alter function recipe_api.preview_role_generation(uuid) set schema recipe_private;

create function recipe_private.require_role_generation(version_ uuid) returns void
language plpgsql stable set search_path=pg_catalog,pg_temp as $$
begin
  if exists(select from recipe_private.rich_versions where id=version_) then raise exception 'request_upgrade_required'; end if;
end $$;
create function recipe_api.version_detail(recipe_ uuid,version_ uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
begin
  perform recipe_private.require_role_generation(version_);
  return recipe_private.detail_role_generation(recipe_,version_);
end $$;
create function recipe_api.get_draft(draft_ uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
begin
  if exists(select from recipe_private.rich_drafts where id=draft_) then raise exception 'request_upgrade_required'; end if;
  return recipe_private.draft_role_generation(draft_);
end $$;
create function recipe_api.install_preview(version_ uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
begin
  perform recipe_private.require_role_generation(version_);
  return recipe_private.preview_role_generation(version_);
end $$;
create or replace function recipe_api.acquire(p_version uuid,p_code text,p_request text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
  perform recipe_private.require_role_generation(p_version);
  return recipe_private.acquire_core(p_version,p_code,p_request);
end $$;
create function recipe_api.reader_acquire(p_version uuid,p_code text,p_request text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare st text;
begin
  select state into st from recipe_private.rich_versions where id=p_version for share;
  if found and st<>'listed' then raise exception 'forbidden'; end if;
  return recipe_private.acquire_core(p_version,p_code,p_request);
end $$;
create function recipe_api.library(cursor_ uuid default null) returns jsonb
language sql stable security definer set search_path=pg_catalog,pg_temp as $$
  select jsonb_set(page,'{items}',coalesce((select jsonb_agg(item) from jsonb_array_elements(page->'items') item
    where not exists(select from recipe_private.rich_versions where id=(item->>'versionId')::uuid)),'[]'))
  from (select recipe_private.library_all_generations(cursor_) page) p
$$;
create function recipe_api.publications() returns jsonb
language sql stable security definer set search_path=pg_catalog,pg_temp as $$
  select jsonb_build_object('items',coalesce((select jsonb_agg(item) from jsonb_array_elements(page->'items') item
    where not exists(select from recipe_private.rich_versions where id=(item->>'versionId')::uuid)),'[]'))
  from (select recipe_private.publications_all_generations() page) p
$$;
create function recipe_api.list_drafts() returns jsonb
language sql stable security definer set search_path=pg_catalog,pg_temp as $$
  select jsonb_build_object('items',coalesce((select jsonb_agg(item) from jsonb_array_elements(page->'items') item
    where not exists(select from recipe_private.rich_drafts where id=(item->>'draftId')::uuid)),'[]'))
  from (select recipe_private.drafts_all_generations() page) p
$$;
create function recipe_api.reader_library(cursor_ uuid default null) returns jsonb
language sql stable security definer set search_path=pg_catalog,pg_temp as $$
  select jsonb_set(page,'{items}',coalesce((select jsonb_agg(recipe_private.catalog_card(v,true))
    from jsonb_array_elements(page->'items') item join recipe_private.versions v on v.id=(item->>'versionId')::uuid),'[]'))
  from (select recipe_private.library_all_generations(cursor_) page) p
$$;
create function recipe_api.reader_publications() returns jsonb
language sql stable security definer set search_path=pg_catalog,pg_temp as $$
  select jsonb_build_object('items',coalesce(jsonb_agg(recipe_private.catalog_card(v,true) order by v.published_at desc,v.id desc),'[]'))
  from recipe_private.versions v where v.owner_id=recipe_private.actor()
$$;
create function recipe_api.reader_drafts() returns jsonb
language sql stable security definer set search_path=pg_catalog,pg_temp as $$
  select jsonb_build_object('items',coalesce(jsonb_agg(case when r.id is null then
    recipe_private.draft_json(d)||jsonb_build_object('format','role-v1') else
    recipe_api.rich_draft(d.id)||jsonb_build_object('public',d.public_info) end order by d.created_at desc,d.id desc),'[]'))
  from recipe_private.drafts d left join recipe_private.rich_drafts r on r.id=d.id where d.owner_id=recipe_private.actor()
$$;

revoke all on function recipe_private.library_all_generations(uuid),recipe_private.publications_all_generations(),recipe_private.drafts_all_generations(),
 recipe_private.detail_role_generation(uuid,uuid),recipe_private.draft_role_generation(uuid),recipe_private.preview_role_generation(uuid),recipe_private.require_role_generation(uuid) from public,recipe_api;
revoke all on function recipe_api.reader_library(uuid),recipe_api.reader_publications(),recipe_api.reader_drafts(),recipe_api.reader_acquire(uuid,text,text),
 recipe_api.library(uuid),recipe_api.publications(),recipe_api.list_drafts(),recipe_api.version_detail(uuid,uuid),recipe_api.get_draft(uuid),recipe_api.install_preview(uuid) from public;
grant execute on function recipe_api.reader_library(uuid),recipe_api.reader_publications(),recipe_api.reader_drafts(),recipe_api.reader_acquire(uuid,text,text),
 recipe_api.library(uuid),recipe_api.publications(),recipe_api.list_drafts(),recipe_api.version_detail(uuid,uuid),recipe_api.get_draft(uuid),recipe_api.install_preview(uuid) to recipe_api;
commit;
