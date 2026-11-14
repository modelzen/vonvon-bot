grant recipe_owner to current_user;
set local role recipe_owner;

-- The preparation UUID is the only source correspondence that leaves the device.
alter table recipe_private.drafts add column source_operation_id uuid;
alter table recipe_private.retired_drafts add column source_operation_id uuid,
  add column source_version_id uuid references recipe_private.versions(id),
  add check (source_version_id is null or source_operation_id is not null);

create unique index drafts_source_operation on recipe_private.drafts(owner_id,source_operation_id)
  where source_operation_id is not null;
create unique index retired_source_operation on recipe_private.retired_drafts(owner_id,source_operation_id)
  where source_operation_id is not null;

create function recipe_private.record_source_preparation() returns trigger
language plpgsql set search_path=pg_catalog,pg_temp as $$
begin
  update recipe_private.drafts set source_operation_id=new.id
    where id=(new.receipt->>'draftId')::uuid and owner_id=new.account_id and source_operation_id is null;
  if not found then raise exception 'integrity_error'; end if;
  return null;
end $$;
create trigger accept_source_preparation after update of state on recipe_private.authoring_operations
  for each row when (new.state='accepted' and old.state<>'accepted' and new.purpose='prepareDraft')
  execute function recipe_private.record_source_preparation();

create function recipe_private.retire_source_preparation() returns trigger
language plpgsql set search_path=pg_catalog,pg_temp as $$
begin
  select source_operation_id into new.source_operation_id from recipe_private.drafts
    where id=new.id and owner_id=new.owner_id;
  return new;
end $$;
create trigger retire_source_preparation before insert on recipe_private.retired_drafts
  for each row execute function recipe_private.retire_source_preparation();

create function recipe_private.record_source_publication() returns trigger
language plpgsql set search_path=pg_catalog,pg_temp as $$
begin
  update recipe_private.retired_drafts set source_version_id=(new.result->>'versionId')::uuid
    where id=(new.result->>'draftId')::uuid and owner_id=new.actor and source_operation_id is not null;
  return null;
end $$;
create trigger publish_source_preparation after insert on recipe_private.receipts
  for each row when (new.action='publish') execute function recipe_private.record_source_publication();

-- Exact acceptance and publication receipts are the only pre-migration evidence.
update recipe_private.drafts d set source_operation_id=o.id from recipe_private.authoring_operations o
where o.purpose='prepareDraft' and o.state='accepted' and o.account_id=d.owner_id
  and o.receipt->>'draftId'=d.id::text;
update recipe_private.retired_drafts d set source_operation_id=o.id from recipe_private.authoring_operations o
where o.purpose='prepareDraft' and o.state='accepted' and o.account_id=d.owner_id
  and o.receipt->>'draftId'=d.id::text;
update recipe_private.retired_drafts d set source_version_id=v.id from recipe_private.receipts r
  join recipe_private.versions v on v.id=(r.result->>'versionId')::uuid and v.owner_id=r.actor
where r.action='publish' and d.owner_id=r.actor and d.id=(r.result->>'draftId')::uuid
  and d.source_operation_id is not null;

create function recipe_api.source_history(p_operations uuid[]) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid:=recipe_private.actor(); entries jsonb;
begin
  if cardinality(p_operations) is null or cardinality(p_operations) not between 1 and 32
    or array_ndims(p_operations)<>1 or exists (
      select from unnest(p_operations) op group by op
      having count(*)>1 or op is null or op::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ) then raise exception 'invalid_input'; end if;
  select jsonb_agg(jsonb_build_object(
    'operationId',p.op, 'draftId',coalesce(d.id,case when v.id is not null then t.id end),
    'recipeId',coalesce(d.recipe_id,v.recipe_id), 'versionId',v.id,
    'state',case when d.id is not null then 'draft' when v.id is not null then 'published' else 'unknown' end
  ) || case when coalesce(d.id,v.id) is null then '{}'::jsonb else jsonb_build_object(
    'revision',coalesce(d.revision,v.revision), 'name',coalesce(d.public_info,v.public_info)->>'name',
    'version',coalesce(d.public_info,v.public_info)->>'version'
  ) end order by p.ordinal) into entries
  from unnest(p_operations) with ordinality p(op,ordinal)
  left join recipe_private.drafts d on d.owner_id=a and d.source_operation_id=p.op
  left join recipe_private.retired_drafts t on t.owner_id=a and t.source_operation_id=p.op
  left join recipe_private.versions v on v.id=t.source_version_id and v.owner_id=a;
  return jsonb_build_object('entries',entries);
end $$;
grant execute on function recipe_api.source_history(uuid[]) to recipe_api;
reset role;
revoke recipe_owner from current_user;
