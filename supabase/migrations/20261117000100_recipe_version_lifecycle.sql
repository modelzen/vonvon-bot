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
  perform set_config('vonvon.recipe_m202611170001_actor',actor,true);
  perform set_config('vonvon.recipe_m202611170001_memberships',memberships::text,true);
  perform set_config('vonvon.recipe_m202611170001_can_set',can_set::text,true);
  perform set_config('vonvon.recipe_m202611170001_self_grant',self_grant::text,true);
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




-- Each published version owns one slot. Rich versions already carry their distribution state.
alter table recipe_private.versions add column legacy_state text not null default 'listed'
  check (legacy_state in ('listed','withdrawn','deleted'));
alter table recipe_private.rich_versions drop constraint rich_versions_state_check;
alter table recipe_private.rich_versions add check (state in ('listed','withdrawn','deleted','banned'));

create function recipe_private.check_publication_slots() returns trigger
language plpgsql set search_path=pg_catalog,pg_temp as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.owner_id::text,187511));
  if (select count(*) from recipe_private.versions v left join recipe_private.rich_versions rv on rv.id=v.id
      where v.owner_id=new.owner_id and coalesce(rv.state,v.legacy_state)='listed') >= 10 then
    raise exception 'publication_limit';
  end if;
  return new;
end $$;
create trigger publication_slot before insert on recipe_private.versions
  for each row execute function recipe_private.check_publication_slots();

create function recipe_private.close_publication(v_id uuid, target text) returns void
language plpgsql set search_path=pg_catalog,pg_temp as $$
declare a uuid:=recipe_private.actor(); old_state text; legacy text; rich boolean;
begin
  if target not in ('withdrawn','deleted') then raise exception 'invalid_input'; end if;
  perform pg_advisory_xact_lock(hashtextextended(a::text,187511));
  select legacy_state into legacy from recipe_private.versions where id=v_id and owner_id=a for update;
  if not found then raise exception 'not_found'; end if;
  select state into old_state from recipe_private.rich_versions where id=v_id for update;
  rich:=found;
  old_state:=coalesce(old_state,legacy);
  if old_state=target then return; end if;
  if old_state in ('banned','deleted') then raise exception 'forbidden'; end if;
  if rich then perform recipe_private.close_rich_version(v_id,target);
  else
    update recipe_private.versions set legacy_state=target where id=v_id;
    update recipe_private.codes set nonce=null,status='disabled' where version_id=v_id and status='available';
  end if;
end $$;
create or replace function recipe_api.rich_withdraw(v_id uuid) returns void
language sql security definer set search_path=pg_catalog,pg_temp as $$
  select recipe_private.close_publication(v_id,'withdrawn')
$$;
create function recipe_api.delete_publication(v_id uuid) returns void
language sql security definer set search_path=pg_catalog,pg_temp as $$
  select recipe_private.close_publication(v_id,'deleted')
$$;
revoke all on function recipe_api.delete_publication(uuid) from public;
grant execute on function recipe_api.delete_publication(uuid) to recipe_api;

create or replace function recipe_private.rich_access(a uuid,v recipe_private.versions,st text) returns text
language sql stable set search_path=pg_catalog,pg_temp as $$
 select case when st='banned' then 'blocked' when st in ('withdrawn','deleted') then st
   when a=v.owner_id or (st='listed' and v.public_info->>'access'='direct') or exists(select from recipe_private.grants where actor=a and version_id=v.id)
     then 'full' else 'intro' end
$$;


create or replace function recipe_api.browse_preview(recipe_ uuid,version_ uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid:=recipe_private.actor(false); v recipe_private.versions; rv recipe_private.rich_versions; result_ jsonb; display_ jsonb; access_ text;
begin
  select * into v from recipe_private.versions where id=version_ and recipe_id=recipe_;
  if not found then raise exception 'not_found'; end if;
  select * into rv from recipe_private.rich_versions where id=version_;
  if coalesce(rv.state,v.legacy_state) in ('withdrawn','deleted') then
    if v.owner_id=a or exists(select from recipe_private.grants where actor=a and version_id=v.id) then
      return recipe_private.catalog_card(v,true)||jsonb_build_object('public',v.public_info||jsonb_build_object('overview',''),'state',coalesce(rv.state,v.legacy_state),'owned',v.owner_id=a,
        'acquired',exists(select from recipe_private.grants where actor=a and version_id=v.id),'hasDisplayLogo',false);
    end if;
    raise exception 'not_found';
  end if;
  if rv.id is not null then
    access_:=recipe_private.rich_access(a,v,rv.state);
    if access_ in ('withdrawn','blocked') then return jsonb_build_object('state',access_,'versionId',v.id); end if;
    result_:=recipe_private.catalog_card(v,true)||jsonb_build_object('state',rv.state,'owned',coalesce(v.owner_id=a,false),
      'acquired',exists(select from recipe_private.grants where actor=a and version_id=v.id));
    select preview into display_ from recipe_private.browse_previews where version_id=version_;
    return result_||case when found then jsonb_build_object('preview',display_) else jsonb_build_object('previewUnavailable',true) end;
  end if;
  return recipe_private.summary(v)||jsonb_build_object('format','role-v1','state','listed','creator',recipe_private.public_creator(v.owner_id),
    'hasDisplayLogo',false,'owned',coalesce(v.owner_id=a,false),'acquired',exists(select from recipe_private.grants where actor=a and version_id=v.id),
    'preview',jsonb_build_object('settings','[]'::jsonb,'skills','[]'::jsonb,'ruleCount',0,'taskCount',0));
end $$;

create or replace function recipe_api.rich_detail(recipe uuid,version uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid:=recipe_private.actor(false); v recipe_private.versions; rv recipe_private.rich_versions; scope text; result jsonb; manifest jsonb;
begin
  select * into v from recipe_private.versions where id=version and recipe_id=recipe;
  select * into rv from recipe_private.rich_versions where id=v.id;
  if not found then raise exception 'not_found'; end if;
  scope:=recipe_private.rich_access(a,v,rv.state);
  if scope in ('withdrawn','deleted','blocked') then return jsonb_build_object('state',scope,'versionId',v.id); end if;
  result:=recipe_private.summary(v)||jsonb_build_object('format','rich-v2','state',rv.state,'visibility',scope,'creator',recipe_private.public_creator(v.owner_id),
    'hasDisplayLogo',rv.state='listed' and exists(select from recipe_private.object_version_refs dr join recipe_private.object_attempts m on m.id=dr.object_id
       where dr.version_id=v.id and m.kind='finalLogo'),
    'owned',coalesce(v.owner_id=a,false),'acquired',exists(select from recipe_private.grants where version_id=v.id and actor=a));
  if scope='full' then
    manifest:=recipe_private.object_descriptor(v.owner_id,rv.manifest_id);
    result:=result||jsonb_build_object('manifest',manifest,'release',jsonb_build_object('format','rich-v2','recipeId',v.recipe_id,'versionId',v.id,
      'authorId',v.owner_id,'revision',v.revision,'access',v.public_info->>'access','logicalBytes',v.bytes,'contentSha256',manifest->>'sha256'));
  end if;
  return result;
end $$;

create or replace function recipe_api.rich_install_preview(v_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid:=recipe_private.actor(); v recipe_private.versions; rv recipe_private.rich_versions; d jsonb;
begin
  select * into v from recipe_private.versions where id=v_id;
  select * into rv from recipe_private.rich_versions where id=v_id;
  if not found then raise exception 'not_found'; end if;
  if rv.state<>'listed' or (a<>v.owner_id and not exists(select from recipe_private.grants where actor=a and version_id=v.id)) then raise exception 'forbidden'; end if;
  d:=recipe_api.rich_detail(v.recipe_id,v.id);
  return jsonb_build_object('accountId',a,'release',d->'release','manifest',d->'manifest');
end $$;

create or replace function recipe_api.rich_install_authorize(op_id uuid,req jsonb,server_key bytea,ticket_ bytea,
  proof_hash bytea,applied_hash_ bytea,rejected_hash_ bytea,until_ms bigint) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid:=recipe_private.actor(); op recipe_private.install_operations; v recipe_private.versions; rv recipe_private.rich_versions;
  from_ recipe_private.versions; update_ boolean:=req->>'purpose'='updateDirectRichRecipe'; now_ms bigint; body jsonb;
  h bytea:=sha256(convert_to(req::text,'UTF8')); obj jsonb;
begin
  if (req->>'format'='rich-v2' and req->'generation'='2'::jsonb and req->>'purpose' in ('installRichRecipe','updateDirectRichRecipe')
    and req->>'manifestSha256'~'^[0-9a-f]{64}$' and req->>'targetPublicKey'~'^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'
    and req->>'nonceCommitment'~'^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$' and req ? 'versionId'
    and (not update_ or (req ? 'fromVersionId' and req->>'localPlanSha256'~'^[0-9a-f]{64}$'))
    and req-array['format','purpose','versionId','generation','manifestSha256','targetPublicKey','nonceCommitment']
        -case when update_ then array['fromVersionId','localPlanSha256'] else '{}'::text[] end='{}'::jsonb
    and octet_length(server_key)=32 and octet_length(ticket_)=32 and octet_length(proof_hash)=32
    and octet_length(applied_hash_)=32 and octet_length(rejected_hash_)=32) is not true then raise exception 'invalid_input'; end if;
  perform pg_advisory_xact_lock(hashtextextended(a::text,187511));
  delete from recipe_private.install_operations where account_id=a and created_at<clock_timestamp()-interval '7 days';
  select * into op from recipe_private.install_operations where id=op_id for update;
  select * into v from recipe_private.versions where id=(req->>'versionId')::uuid;
  select * into rv from recipe_private.rich_versions where id=v.id for share;
  if not found then raise exception 'not_found'; end if;
  if rv.state<>'listed' then raise exception 'forbidden'; end if;
  now_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
  if op.id is not null then
    if op.account_id<>a or not exists(select from recipe_private.rich_install_cap where id=op_id) then raise exception 'not_found'; end if;
    if op.state='cancelled' then raise exception 'operation_cancelled'; end if;
    if op.request_digest<>h then raise exception 'conflict'; end if;
    if op.state='authorized' and op.deadline<=now_ms then raise exception 'operation_expired'; end if;
  end if;
  if update_ then
    select * into from_ from recipe_private.versions where id=(req->>'fromVersionId')::uuid;
    if from_.recipe_id is distinct from v.recipe_id or from_.revision>=v.revision or v.public_info->>'access'<>'direct'
      or (from_.owner_id<>a and not exists(select from recipe_private.grants where actor=a and version_id=from_.id))
      or exists(select from recipe_private.rich_versions where id=from_.id and state='banned') then raise exception 'forbidden'; end if;
  else perform recipe_api.rich_install_preview(v.id); end if;
  if op.id is not null then return op.binding||jsonb_build_object('ticket',recipe_private.b64url(op.ticket),'status',op.state); end if;
  perform recipe_private.new_operation(a,op_id);
  if until_ms is null or until_ms<=now_ms or until_ms>now_ms+300000 then raise exception 'invalid_input'; end if;
  if (select count(*) from recipe_private.install_operations where account_id=a and (state='redeemed' or state='authorized' and deadline>=now_ms))>=3
    then raise exception 'operation_pending_limit'; end if;
  obj:=recipe_private.object_descriptor(v.owner_id,rv.manifest_id);
  if obj->>'sha256' is distinct from req->>'manifestSha256' then raise exception 'conflict'; end if;
  body:=req||jsonb_build_object('operationId',op_id,'accountId',a,'deadline',until_ms,'serverPublicKey',recipe_private.b64url(server_key));
  insert into recipe_private.install_operations(id,account_id,state,request_digest,version_id,binding,ticket,expected_proof_hash,deadline)
    values(op_id,a,'authorized',h,v.id,body,ticket_,proof_hash,until_ms) on conflict do nothing;
  if not found then raise exception 'conflict'; end if;
  insert into recipe_private.rich_install_cap values(op_id,applied_hash_,rejected_hash_);
  return body||jsonb_build_object('ticket',recipe_private.b64url(ticket_),'status','authorized');
end $$;

create or replace function recipe_api.rich_possess_install(op_id uuid,ticket_ bytea,nonce_ bytea,proof_ bytea,outcome text default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare op recipe_private.install_operations:=recipe_private.rich_install_possession(op_id,ticket_,nonce_,proof_,coalesce(outcome,'redeem'));
  resources jsonb; v recipe_private.versions; st text; disposition text;
begin
  if outcome is null then
    resources:=recipe_private.rich_install_resources(op);
    if op.state='authorized' then
      if op.deadline<=extract(epoch from clock_timestamp())*1000 then raise exception 'operation_expired'; end if;
      update recipe_private.install_operations set state='redeemed' where id=op.id;op.state:='redeemed';
    end if;
    return op.binding||resources||jsonb_build_object('status',op.state);
  end if;
  if op.state not in ('redeemed',outcome) then raise exception 'conflict'; end if;
  select * into strict v from recipe_private.versions where id=op.version_id;
  select state into strict st from recipe_private.rich_versions where id=v.id for share;
  if st<>'listed' then disposition:='blocked';
  elsif outcome='applied' and op.binding->>'purpose'='updateDirectRichRecipe' then
    perform recipe_private.rich_install_resources(op);
    if v.owner_id<>op.account_id and not exists(select from recipe_private.grants where actor=op.account_id and version_id=v.id) then
      insert into recipe_private.grants(actor,version_id,original_request,original_digest,acquisition_proof)
        values(op.account_id,v.id,op.id,op.request_digest,'direct-update-receipt') on conflict(actor,version_id) do nothing;
    end if;
    disposition:='settled';
  else disposition:='recorded'; end if;
  update recipe_private.install_operations set state=outcome where id=op_id;
  return jsonb_build_object('operationId',op_id,'status',outcome,'disposition',disposition);
end $$;

create or replace function recipe_private.rich_install_resources(op recipe_private.install_operations) returns jsonb
language plpgsql set search_path=pg_catalog,pg_temp as $$
declare v recipe_private.versions; rv recipe_private.rich_versions; obj jsonb;
begin
  select * into v from recipe_private.versions where id=op.version_id;
  select * into rv from recipe_private.rich_versions where id=v.id for share;
  if not found or rv.state<>'listed' then raise exception 'forbidden'; end if;
  if op.binding->>'purpose'='updateDirectRichRecipe' then
    if exists(select from recipe_private.rich_versions where id=(op.binding->>'fromVersionId')::uuid and state='banned') then raise exception 'forbidden'; end if;
  elsif op.account_id<>v.owner_id and not exists(select from recipe_private.grants where actor=op.account_id and version_id=v.id) then raise exception 'forbidden'; end if;
  obj:=recipe_private.object_descriptor(v.owner_id,rv.manifest_id);
  if obj->>'sha256' is distinct from op.binding->>'manifestSha256' then raise exception 'integrity_error'; end if;
  return jsonb_build_object('manifest',obj,'release',jsonb_build_object('format','rich-v2','recipeId',v.recipe_id,'versionId',v.id,
    'authorId',v.owner_id,'revision',v.revision,'access',v.public_info->>'access','logicalBytes',v.bytes,'contentSha256',obj->>'sha256'));
end $$;

create or replace function recipe_private.library_visible_versions(a uuid,scope_ text,anchor_ timestamptz)
returns table(version_id uuid,recipe_id uuid,revision integer,state text,owned boolean,acquired boolean)
language sql stable set search_path=pg_catalog,pg_temp as $$
  select v.id,v.recipe_id,v.revision,coalesce(rv.state,v.legacy_state),v.owner_id=a,g.actor is not null
  from (
    select id from recipe_private.versions where owner_id=a and scope_ in ('all','published')
    union
    select version_id from recipe_private.grants where actor=a and scope_ in ('all','acquired')
  ) permitted join recipe_private.versions v on v.id=permitted.id
    left join recipe_private.rich_versions rv on rv.id=v.id
    left join recipe_private.grants g on g.version_id=v.id and g.actor=a
  where v.published_at<=anchor_ and (rv.id is null or rv.state<>'banned')
$$;

create or replace function recipe_api.reader_author_recipes(p_author uuid,p_cursor uuid default null) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
declare cursor_time timestamptz; result jsonb;
begin
  if p_author is null then raise exception 'invalid_input'; end if;
  if not exists(select from recipe_private.versions v
    left join recipe_private.rich_versions rv on rv.id=v.id
    where v.owner_id=p_author and coalesce(rv.state,v.legacy_state)='listed') then
    raise exception 'not_found';
  end if;
  if p_cursor is not null then
    select v.published_at into cursor_time from recipe_private.versions v
      left join recipe_private.rich_versions rv on rv.id=v.id
      where v.id=p_cursor and v.owner_id=p_author and coalesce(rv.state,v.legacy_state)='listed';
    if not found then raise exception 'invalid_input'; end if;
  end if;
  with latest as (
    select distinct on (v.recipe_id) v as version,v.id,v.recipe_id,v.published_at from recipe_private.versions v
      left join recipe_private.rich_versions rv on rv.id=v.id
      where v.owner_id=p_author and coalesce(rv.state,v.legacy_state)='listed'
      order by v.recipe_id,v.revision desc,v.id desc
  ), page as (
    select v.version,v.id,v.published_at from latest v
      where p_cursor is null or (v.published_at,v.id)<(cursor_time,p_cursor)
      order by v.published_at desc,v.id desc limit 51
  ), items as (select * from page order by published_at desc,id desc limit 50)
  select jsonb_build_object('creator',recipe_private.public_creator(p_author),
    'items',coalesce(jsonb_agg(recipe_private.catalog_card(version,true) order by published_at desc,id desc),'[]'::jsonb),
    'nextCursor',case when (select count(*) from page)>50 then (array_agg(id order by published_at,id))[1] end)
    into result from items;
  return result;
end $$;

create or replace function recipe_api.reader_latest(recipe_ uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid:=recipe_private.actor();v recipe_private.versions;rich boolean;
begin
  select ver.* into v from recipe_private.versions ver left join recipe_private.rich_versions rv on rv.id=ver.id
    where ver.recipe_id=recipe_ and coalesce(rv.state,ver.legacy_state)='listed' order by ver.revision desc limit 1;
  if not found then raise exception 'not_found'; end if;
  rich:=exists(select from recipe_private.rich_versions where id=v.id);
  return jsonb_build_object('recipeId',v.recipe_id,'versionId',v.id,'revision',v.revision,'version',v.public_info->>'version',
    'format',case when rich then 'rich-v2' else 'role-v1' end,'access',v.public_info->>'access',
    'entitled',v.owner_id=a or exists(select from recipe_private.grants g where g.actor=a and g.version_id=v.id)
      or rich and v.public_info->>'access'='direct' and exists(select from recipe_private.grants g join recipe_private.versions older on older.id=g.version_id where g.actor=a and older.recipe_id=v.recipe_id and older.revision<v.revision));
end $$;

create or replace function recipe_api.rich_catalog_page(q text,token text,access_ text) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
declare term text:=lower(btrim(coalesce(q,''))); query_hash text; anchor timestamptz:=statement_timestamp(); last_time timestamptz;
  last_recipe uuid; hero_recipe uuid; hero recipe_private.versions; body bytea; sig text; cur jsonb; result jsonb; next_data jsonb;
begin
  if length(term)>120 or (access_ is not null and access_ not in ('coded','direct')) then raise exception 'invalid_input'; end if;
  query_hash:=encode(sha256(convert_to(jsonb_build_array(term,access_,'published_desc')::text,'UTF8')),'hex');
  if token is not null then
    if length(token)>1600 or token!~'^[a-f0-9]+[.][a-f0-9]{64}$' then raise exception 'invalid_input'; end if;
    begin
      body:=decode(split_part(token,'.',1),'hex');sig:=encode(recipe_private.code_mac('catalog-cursor:v2',body),'hex');
      if sig<>split_part(token,'.',2) then raise exception 'invalid_input'; end if;
      cur:=convert_from(body,'UTF8')::jsonb;
      if cur->>'query' is distinct from query_hash then raise exception 'invalid_input'; end if;
      anchor:=(cur->>'anchor')::timestamptz;last_time:=(cur->>'time')::timestamptz;last_recipe:=(cur->>'recipe')::uuid;
      hero_recipe:=(cur->>'hero')::uuid;
    exception when others then raise exception 'invalid_input'; end;
  elsif term='' and access_ is null then
    select v.* into hero from recipe_private.versions v join recipe_private.recipes r on r.id=v.recipe_id and not exists (
        select from recipe_private.versions newer left join recipe_private.rich_versions nr on nr.id=newer.id
        where newer.recipe_id=v.recipe_id and newer.revision>v.revision and coalesce(nr.state,newer.legacy_state)='listed')
      left join recipe_private.rich_versions rv on rv.id=v.id left join recipe_private.rich_feature f on f.version_id=v.id
      where coalesce(rv.state,v.legacy_state)='listed' and v.published_at<=anchor order by (f.version_id is not null) desc,
        v.published_at desc,v.recipe_id desc limit 1;
    hero_recipe:=hero.recipe_id;
  end if;
  with page as (
    select v as version,v.recipe_id,v.published_at from recipe_private.versions v join recipe_private.recipes r on r.id=v.recipe_id and not exists (
        select from recipe_private.versions newer left join recipe_private.rich_versions nr on nr.id=newer.id
        where newer.recipe_id=v.recipe_id and newer.revision>v.revision and coalesce(nr.state,newer.legacy_state)='listed')
      left join recipe_private.rich_versions rv on rv.id=v.id left join recipe_private.creator_profiles cp on cp.account_id=v.owner_id
    where coalesce(rv.state,v.legacy_state)='listed' and v.published_at<=anchor and v.recipe_id is distinct from hero_recipe
      and (last_time is null or (v.published_at,v.recipe_id)<(last_time,last_recipe))
      and (access_ is null or v.public_info->>'access'=access_) and (term='' or strpos(lower(v.public_info->>'name'),term)>0
        or strpos(lower(v.public_info->>'summary'),term)>0 or strpos(lower(coalesce(cp.display_name,recipe_private.account_default_nickname(v.owner_id))),term)>0)
    order by v.published_at desc,v.recipe_id desc limit 9
  ), items as(select * from page order by published_at desc,recipe_id desc limit 8)
  select jsonb_build_object('hero',case when hero.id is not null then recipe_private.catalog_card(hero,true) end,
      'items',coalesce(jsonb_agg(recipe_private.catalog_card(version,true) order by published_at desc,recipe_id desc),'[]')),
    case when (select count(*) from page)>8 then jsonb_build_object('query',query_hash,'anchor',anchor,'hero',hero_recipe,
      'time',(array_agg(published_at order by published_at,recipe_id))[1],'recipe',(array_agg(recipe_id order by published_at,recipe_id))[1]) end
    into result,next_data from items;
  body:=convert_to(next_data::text,'UTF8');
  return result||jsonb_build_object('nextCursor',case when body is not null then encode(body,'hex')||'.'||encode(recipe_private.code_mac('catalog-cursor:v2',body),'hex') end);
end $$;

create or replace function recipe_private.listed_catalog(term text,after_id uuid,rich boolean) returns jsonb
language plpgsql stable set search_path=pg_catalog,pg_temp as $$
declare hero recipe_private.versions; cursor_time timestamptz; result jsonb;
begin
  term:=lower(btrim(coalesce(term,'')));
  if length(term)>120 then raise exception 'invalid_input'; end if;
  if after_id is not null then
    select published_at into cursor_time from recipe_private.versions where id=after_id;
    if not found then raise exception 'invalid_input'; end if;
  end if;
  if term='' then
    select v.* into hero from recipe_private.versions v join recipe_private.recipes p on p.id=v.recipe_id and p.revision=v.revision
      left join recipe_private.rich_versions rv on rv.id=v.id left join recipe_private.rich_feature f on f.version_id=v.id
      where (rv.id is null and v.legacy_state='listed') or (rich and rv.state='listed')
      order by (f.version_id is not null) desc,v.published_at desc,v.id desc limit 1;
  end if;
  with page as (
    select v as version,v.id,v.published_at from recipe_private.versions v join recipe_private.recipes p on p.id=v.recipe_id and p.revision=v.revision
      left join recipe_private.rich_versions rv on rv.id=v.id left join recipe_private.creator_profiles cp on cp.account_id=v.owner_id
    where ((rv.id is null and v.legacy_state='listed') or rich and rv.state='listed') and v.recipe_id is distinct from hero.recipe_id
      and (after_id is null or (v.published_at,v.id)<(cursor_time,after_id))
      and (term='' or strpos(lower(v.public_info->>'name'),term)>0 or strpos(lower(v.public_info->>'summary'),term)>0
        or (rich and strpos(lower(cp.display_name),term)>0))
    order by v.published_at desc,v.id desc limit 9
  ), items as (select * from page order by published_at desc,id desc limit 8)
  select jsonb_build_object('hero',case when after_id is null and hero.id is not null then recipe_private.catalog_card(hero,rich) end,
    'items',coalesce(jsonb_agg(recipe_private.catalog_card(version,rich) order by published_at desc,id desc),'[]'),
    'nextCursor',case when (select count(*) from page)>8 then (array_agg(id order by published_at,id))[1] end) into result from items;
  return result;
end $$;

create or replace function recipe_private.require_role_generation(version_ uuid) returns void
language plpgsql stable set search_path=pg_catalog,pg_temp as $$
begin
  if (select legacy_state from recipe_private.versions where id=version_)<>'listed' then raise exception 'forbidden'; end if;
  if exists(select from recipe_private.rich_versions where id=version_) then raise exception 'request_upgrade_required'; end if;
end $$;

create or replace function recipe_private.install_version(a uuid,p_version uuid) returns recipe_private.versions
language plpgsql set search_path=pg_catalog,pg_temp as $$
begin
  if (select legacy_state from recipe_private.versions where id=p_version for share)<>'listed' then raise exception 'forbidden'; end if;
  if exists(select from recipe_private.rich_versions where id=p_version) then raise exception 'request_upgrade_required'; end if;
  return recipe_private.install_version_v1(a,p_version);
end $$;

create or replace function recipe_api.reader_acquire(p_version uuid,p_code text,p_request text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare st text;
begin
  if (select legacy_state from recipe_private.versions where id=p_version for share)<>'listed' then raise exception 'forbidden'; end if;
  select state into st from recipe_private.rich_versions where id=p_version for share;
  if found and st<>'listed' then raise exception 'forbidden'; end if;
  return recipe_private.acquire_core(p_version,p_code,p_request);
end $$;

create or replace function recipe_private.guard_code_lifecycle() returns trigger language plpgsql set search_path=pg_catalog,pg_temp as $$
declare st text;
begin
  if (select legacy_state from recipe_private.versions where id=new.version_id for share)<>'listed' then raise exception 'forbidden'; end if;
  select state into st from recipe_private.rich_versions where id=new.version_id for share;
  if found and st<>'listed' then raise exception 'forbidden'; end if;return new;
end $$;

reset role;
do $migration_role$
declare actor text := current_setting('vonvon.recipe_m202611170001_actor'); memberships jsonb;
  can_set boolean := current_setting('vonvon.recipe_m202611170001_can_set')::boolean;
  self_grant boolean := current_setting('vonvon.recipe_m202611170001_self_grant')::boolean;
begin
  if actor is distinct from session_user then raise exception 'migration_role_session_changed'; end if;
  if not can_set and not self_grant then
    execute format('revoke recipe_owner from %I',actor);
  end if;
  select coalesce(jsonb_agg(to_jsonb(m) order by m.roleid,m.member,m.grantor),'[]'::jsonb)
    into memberships from pg_catalog.pg_auth_members m;
  if memberships is distinct from current_setting('vonvon.recipe_m202611170001_memberships')::jsonb then
    raise exception 'migration_role_memberships_changed';
  end if;
end $migration_role$;
