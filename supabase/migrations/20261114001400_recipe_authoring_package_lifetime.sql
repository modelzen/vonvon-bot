grant recipe_owner to current_user;
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
