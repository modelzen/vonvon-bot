grant recipe_owner to current_user;
set local role recipe_owner;

create function recipe_api.recover_authoring(p_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid:=recipe_private.actor(); op recipe_private.authoring_operations;
begin
  perform pg_advisory_xact_lock(hashtextextended(a::text,187511));
  perform recipe_private.maintain_authoring(a);
  select * into op from recipe_private.authoring_operations where id=p_id;
  if found then
    if op.account_id<>a then raise exception 'not_found'; end if;
    return recipe_private.authoring_json(op);
  end if;
  -- Use the registration clock and cutoff after the same lock. A pruned receipt and an unused old ID
  -- are indistinguishable: neither can write again, but the draft may already have been saved.
  begin
    perform recipe_private.check_operation_birth(p_id);
  exception when raise_exception then
    if sqlerrm<>'operation_expired' then raise; end if;
    return jsonb_build_object('operationId',p_id,'accountId',a,'unredeemable',true);
  end;
  raise exception 'not_found';
end $$;

grant execute on function recipe_api.recover_authoring(uuid) to recipe_api;
reset role;
revoke recipe_owner from current_user;
