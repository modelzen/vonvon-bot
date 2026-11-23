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
  perform set_config('vonvon.recipe_m202611150002_actor',actor,true);
  perform set_config('vonvon.recipe_m202611150002_memberships',memberships::text,true);
  perform set_config('vonvon.recipe_m202611150002_can_set',can_set::text,true);
  perform set_config('vonvon.recipe_m202611150002_self_grant',self_grant::text,true);
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


create or replace function recipe_api.rich_save_plan(p_id uuid,p_inputs text,p_manifest text,p_payload text,p_access text,p_parent uuid,p_records jsonb,p_items jsonb,p_logo jsonb) returns void
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid:=recipe_private.actor(); i recipe_private.rich_intents; row jsonb; src jsonb; edge jsonb;
begin
  perform recipe_api.rich_plan_context(p_id);
  select * into strict i from recipe_private.rich_intents where id=p_id;
  if i.input_hash is not null and (i.input_hash,i.manifest_hash,i.payload_hash) is distinct from (p_inputs,p_manifest,p_payload) then raise exception 'conflict'; end if;
  if exists(select from jsonb_array_elements(p_records) x where x->>'kind'='memory')
    or exists(select from jsonb_array_elements(p_items) x where x->>'kind'='memory') then raise exception 'invalid_input'; end if;
  perform recipe_private.check_rich_upload(a,i.draft_id,p_logo);
  if p_access not in ('direct','coded') or p_inputs!~'^[a-f0-9]{64}$' or p_manifest!~'^[a-f0-9]{64}$' or p_payload!~'^[a-f0-9]{64}$'
    or jsonb_array_length(p_records)>320 or jsonb_array_length(p_items) not between 4 and 320 then raise exception 'invalid_input'; end if;
  if p_parent is not null and not exists(select from recipe_private.versions v join recipe_private.recipes r on r.id=v.recipe_id and r.revision=v.revision
    join recipe_private.rich_versions rv on rv.id=v.id and rv.state='listed' where v.id=p_parent and v.owner_id=a) then raise exception 'source_unavailable'; end if;
  for row in select value from jsonb_array_elements(p_records) loop
    src:=row->'source';
    if src->>'kind'='accountClaim' then
      if row->>'kind' in ('role','rule','skill','file','task','memory','setup','finalLogo') and exists(
        select from recipe_private.rich_members m join recipe_private.versions v on v.id=m.version_id
        join recipe_private.grants g on g.version_id=v.id and g.actor=a
        where v.owner_id<>a and v.public_info->>'access'='coded' and m.kind=row->>'kind' and m.fingerprint=row->>'contentFingerprint')
        then raise exception 'source_unavailable'; end if;
    elsif src->>'kind'='releaseItem' then
      if not exists(select from recipe_private.rich_members m where m.version_id=(src->>'versionId')::uuid
         and m.item_id=(src->>'itemId')::uuid and m.baseline=src->>'baselineSha256' and m.kind=row->>'kind') then raise exception 'source_unavailable'; end if;
    elsif src->>'kind'='releaseItems' then
      if jsonb_array_length(src->'parents') not between 1 and 64 then raise exception 'source_unavailable'; end if;
      for edge in select value from jsonb_array_elements(src->'parents') loop
        if not exists(select from recipe_private.rich_members m where m.version_id=(edge->>'versionId')::uuid and m.item_id=(edge->>'itemId')::uuid
          and (m.kind=row->>'kind' or row->>'kind'='setup') and m.baseline=edge->>'baselineSha256') then raise exception 'source_unavailable'; end if;
      end loop;
    elsif row->>'donorOriginId' is null then raise exception 'source_unavailable'; end if;
    insert into recipe_private.rich_origins(id,account_id,kind,intent,candidate,baseline,parent_version,parent_item,parent_digest,donor)
    values((row->>'originId')::uuid,a,row->>'kind',p_id,coalesce((row->>'candidateId')::uuid,(row->>'itemId')::uuid),row->>'baselineSha256',
      (src->>'versionId')::uuid,(src->>'itemId')::uuid,src->>'baselineSha256',(row->>'donorOriginId')::uuid) on conflict do nothing;
    if src->>'kind'='releaseItems' then
      insert into recipe_private.rich_parent_edges select (row->>'originId')::uuid,(e->>'versionId')::uuid,(e->>'itemId')::uuid,e->>'baselineSha256'
        from jsonb_array_elements(src->'parents') e on conflict do nothing;
    end if;
  end loop;
  if (select count(*) from recipe_private.rich_origins where account_id=a)>250000 then raise exception 'quota_exceeded'; end if;
  for row in select value from jsonb_array_elements(p_items) loop
    if exists(select from recipe_private.rich_members m join recipe_private.versions v on v.id=m.version_id
        join recipe_private.grants g on g.version_id=v.id and g.actor=a where v.owner_id<>a and v.public_info->>'access'='coded'
        and m.kind in ('role','rule','skill','file','task','memory','setup','finalLogo') and m.kind=row->>'kind' and m.fingerprint=row->>'contentFingerprint')
      then raise exception 'source_unavailable'; end if;
    perform recipe_private.check_rich_origin(a,(row->>'originId')::uuid,row->>'kind');
  end loop;
  perform recipe_private.check_rich_logo(a,p_items,coalesce(p_parent,(select parent_version from recipe_private.rich_drafts where id=i.draft_id)));
  update recipe_private.rich_intents set input_hash=p_inputs,manifest_hash=p_manifest,payload_hash=p_payload,
    logo_package=(p_logo->>'packageId')::uuid,logo_evidence=p_logo,access=p_access,parent_version=p_parent,reviewed_items=p_items where id=p_id;
end $$;

create or replace function recipe_api.rich_accept(op_id uuid,ticket bytea,nonce bytea,proof bytea,payload bytea,canonical bytea,manifest uuid,pkg uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare i recipe_private.rich_intents; op recipe_private.authoring_operations; cap recipe_private.authoring_capabilities;
  d recipe_private.drafts; base recipe_private.versions; a uuid; info jsonb; c jsonb; r jsonb; x jsonb; total int; retained int;
begin
  select account_id into a from recipe_private.rich_intents where id=op_id;
  if not found then raise exception 'not_found'; end if;
  perform set_config('app.recipe_account',a::text,true);
  perform 1 from recipe_private.accounts where id=a and status='active' for share;
  if not found then raise exception 'account_disabled'; end if;
  perform pg_advisory_xact_lock(hashtextextended(a::text,187511));
  select * into strict i from recipe_private.rich_intents where id=op_id;
  select * into strict op from recipe_private.authoring_operations where id=op_id for update;
  select * into cap from recipe_private.authoring_capabilities where operation_id=op_id and stage='accept';
  if not found or sha256(ticket) is distinct from sha256(cap.ticket) or sha256(proof) is distinct from cap.proof_hash
    or recipe_private.b64url(sha256(nonce)) is distinct from op.nonce_commitment then raise exception 'invalid_operation_proof'; end if;
  if cap.payload_digest is distinct from sha256(payload) or i.manifest_hash is distinct from encode(sha256(canonical),'hex')
    or i.payload_hash is distinct from encode(sha256(payload),'hex') then raise exception 'conflict'; end if;
  if op.state='accepted' then
    if op.terminal_at<clock_timestamp()-interval '7 days' then raise exception 'operation_expired'; end if;
    if op.receipt->>'manifestId' is distinct from manifest::text or op.receipt->>'packageId' is distinct from pkg::text then raise exception 'conflict'; end if;
    return op.receipt;
  end if;
  if op.state<>'dispatched' or op.revision<>(cap.binding->>'stateRevision')::int then raise exception 'conflict'; end if;
  if op.expires_at<=clock_timestamp() or cap.deadline<=extract(epoch from clock_timestamp())*1000 then raise exception 'operation_expired'; end if;
  if convert_from(payload,'UTF8')::jsonb->>'purpose' is distinct from op.purpose then raise exception 'conflict'; end if;
  if i.logo_package is not null and i.logo_package is distinct from pkg then raise exception 'conflict'; end if;
  perform recipe_private.check_rich_upload(a,i.draft_id,i.logo_evidence);
  c:=convert_from(canonical,'UTF8')::jsonb;
  if c->>'format' is distinct from 'rich-v2' or c->>'schemaVersion' is distinct from '2' then raise exception 'invalid_input'; end if;
  if c->'memories' is distinct from '[]'::jsonb
    or exists(select from jsonb_array_elements(i.reviewed_items) policy_item where policy_item->>'kind'='memory')
    or (op.purpose='prepareDraft' and convert_from(payload,'UTF8')::jsonb#>'{content,memories}' is distinct from '[]'::jsonb)
    or (op.purpose='editDraft' and exists(select from jsonb_array_elements(convert_from(payload,'UTF8')::jsonb->'changes') policy_change
      where policy_change->>'op'='copyItem' and policy_change#>>'{source,kind}'='memory'
        or policy_change->>'op'='includeCandidate' and policy_change#>>'{value,kind}'='memory')) then raise exception 'invalid_input'; end if;
  for x in select value from jsonb_array_elements(i.reviewed_items) loop perform recipe_private.check_rich_origin(a,(x->>'originId')::uuid,x->>'kind'); end loop;
  perform recipe_private.check_rich_logo(a,i.reviewed_items,coalesce(i.parent_version,(select parent_version from recipe_private.rich_drafts where id=i.draft_id)));
  select jsonb_object_agg(key,value->'value') into info from jsonb_each(c->'public');info:=info||jsonb_build_object('access',i.access);
  perform set_config('app.rich_mutation','v2',true);
  if op.purpose='prepareDraft' then
    if (select count(*) from recipe_private.drafts where owner_id=a)>=20 then raise exception 'quota_exceeded'; end if;
    if (select count(*) from recipe_private.drafts where owner_id=a and created_at>=date_trunc('day',statement_timestamp(),'UTC'))
      +(select count(*) from recipe_private.retired_drafts where owner_id=a and created_at>=date_trunc('day',statement_timestamp(),'UTC'))>=100 then raise exception 'rate_limited'; end if;
    if i.parent_version is not null then
      select v.* into base from recipe_private.versions v join recipe_private.recipes rp on rp.id=v.recipe_id and rp.revision=v.revision
        where v.id=i.parent_version and v.owner_id=a for share of rp;
      if not found then raise exception 'conflict'; end if;
    end if;
    insert into recipe_private.drafts(id,owner_id,recipe_id,base_revision,revision,public_info,config,bytes)
      values(i.draft_id,a,coalesce(base.recipe_id,i.draft_id),coalesce(base.revision,0),1,info,'{}',0) returning * into d;
  else
    select * into d from recipe_private.drafts where id=i.draft_id and owner_id=a for update;
    if not found or d.revision<>op.base_revision then raise exception 'conflict'; end if;
    update recipe_private.drafts set revision=revision+1,public_info=info where id=d.id returning * into d;
  end if;
  total:=recipe_private.rich_set_refs(a,d.id,pkg,manifest,i.manifest_hash,canonical,c->'parts');
  select coalesce(sum(m.final_bytes),0) into retained from recipe_private.object_draft_refs refs join recipe_private.object_attempts m on m.id=refs.object_id
    where refs.draft_id=d.id and refs.object_id<>manifest and not exists(select from jsonb_array_elements(c->'parts') p where (p->>'objectId')::uuid=m.id);
  if (select coalesce(sum(bytes),0) from recipe_private.drafts where owner_id=a and id<>d.id)+total+retained>10485760 and total+retained>d.bytes then raise exception 'quota_exceeded'; end if;
  update recipe_private.drafts set bytes=total+retained,retained_candidate_bytes=retained where id=d.id;
  insert into recipe_private.rich_drafts values(d.id,manifest,i.reviewed_items,retained,i.parent_version)
    on conflict(id) do update set manifest_id=excluded.manifest_id,items=excluded.items,retained_bytes=excluded.retained_bytes;
  if op.purpose='prepareDraft' then
    insert into recipe_private.rich_candidates(source_intent,owner_id,draft_id,manifest_id,content_hash,items)
    values(op_id,a,d.id,manifest,i.manifest_hash,i.reviewed_items);
  end if;
  r:=jsonb_build_object('format','rich-v2','operationId',op.id,'status','accepted','stateRevision',op.revision+1,
    'draftId',d.id,'recipeId',d.recipe_id,'revision',d.revision,'manifestId',manifest,'packageId',pkg);
  update recipe_private.authoring_operations set state='accepted',revision=revision+1,receipt=r,terminal_at=clock_timestamp() where id=op_id;
  return r;
end $$;

create or replace function recipe_api.rich_publish(d_id uuid,rev int,req uuid,canonical bytea) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid:=recipe_private.actor(); h text:=encode(sha256(canonical),'hex'); args jsonb:=jsonb_build_array(d_id,rev,h);
  prior jsonb:=recipe_private.prior(a,'richPublish',req,args); d recipe_private.drafts; rd recipe_private.rich_drafts; v recipe_private.versions;
  obj jsonb; row jsonb; parent int; first_id uuid; first_code text; result jsonb;
begin
  if prior is null then
    select * into d from recipe_private.drafts where id=d_id and owner_id=a for update;
    select * into rd from recipe_private.rich_drafts where id=d.id;
    if not found then raise exception 'not_found'; end if;
    if convert_from(canonical,'UTF8')::jsonb->'memories' is distinct from '[]'::jsonb
      or exists(select from jsonb_array_elements(rd.items) x where x->>'kind'='memory') then raise exception 'invalid_input'; end if;
    if d.revision<>rev then raise exception 'conflict'; end if;
    obj:=recipe_private.object_descriptor(a,rd.manifest_id);
    if obj->>'sha256' is distinct from h or (obj->>'bytes')::int is distinct from octet_length(canonical) then raise exception 'conflict'; end if;
    if exists(select from jsonb_array_elements(convert_from(canonical,'UTF8')::jsonb->'tasks') t
      where t->'instruction'->>'kind'='part' and not exists(select from recipe_private.rich_text_checks tc
      where tc.object_id=(t->'instruction'->>'objectId')::uuid and tc.nonblank)) then raise exception 'incomplete_setup'; end if;
    for row in select value from jsonb_array_elements(rd.items) loop perform recipe_private.check_rich_origin(a,(row->>'originId')::uuid,row->>'kind'); end loop;
    perform recipe_private.check_rich_logo(a,rd.items,rd.parent_version);
    if (select count(*) from recipe_private.versions where owner_id=a and published_at>=date_trunc('day',statement_timestamp(),'UTC'))>=10 then raise exception 'rate_limited'; end if;
    if (select coalesce(sum(bytes),0) from recipe_private.versions where owner_id=a)+d.bytes-rd.retained_bytes>26214400 then raise exception 'quota_exceeded'; end if;
    if d.base_revision=0 then
      if (select count(*) from recipe_private.recipes where owner_id=a)>=20 then raise exception 'quota_exceeded'; end if;
      insert into recipe_private.recipes(id,owner_id) values(d.recipe_id,a) on conflict do nothing;
      if not found then raise exception 'conflict'; end if;
    end if;
    select revision into parent from recipe_private.recipes where id=d.recipe_id and owner_id=a for update;
    if parent is distinct from d.base_revision then raise exception 'conflict'; end if;
    if parent>=30 then raise exception 'quota_exceeded'; end if;
    if exists(select from recipe_private.versions where recipe_id=d.recipe_id and public_info->>'version'=d.public_info->>'version') then raise exception 'conflict'; end if;
    insert into recipe_private.versions(recipe_id,owner_id,revision,public_info,config,bytes)
      values(d.recipe_id,a,parent+1,d.public_info,'{}',d.bytes-rd.retained_bytes) returning * into v;
    insert into recipe_private.rich_versions(id,manifest_id,parent_version) values(v.id,rd.manifest_id,rd.parent_version);
    insert into recipe_private.rich_members select v.id,(i->>'itemId')::uuid,(i->>'originId')::uuid,i->>'kind',i->>'baselineSha256',i->>'contentFingerprint' from jsonb_array_elements(rd.items) i;
    insert into recipe_private.object_version_refs select v.id,object_id from recipe_private.object_draft_refs where draft_id=d.id and
      (object_id=rd.manifest_id or exists(select from jsonb_array_elements(convert_from(canonical,'UTF8')::jsonb->'parts') pp where (pp->>'objectId')::uuid=object_id));
    update recipe_private.recipes set revision=v.revision where id=v.recipe_id;
    if v.public_info->>'access'='coded' then first_id:=(recipe_private.new_codes(a,v.id,1)->>0)::uuid; end if;
    perform set_config('app.rich_mutation','v2',true);
    delete from recipe_private.object_draft_refs where draft_id=d.id;
    insert into recipe_private.retired_drafts(id,owner_id,created_at) values(d.id,a,d.created_at);
    update recipe_private.retired_drafts set source_version_id=v.id where id=d.id;
    delete from recipe_private.drafts where id=d.id;
    prior:=recipe_private.remember(a,'richPublish',req,args,jsonb_build_object('versionId',v.id,'firstCodeId',first_id),d.id);
  else
    select * into strict v from recipe_private.versions where id=(prior->>'versionId')::uuid;
    first_id:=(prior->>'firstCodeId')::uuid;
  end if;
  select recipe_private.display_code(nonce) into first_code from recipe_private.codes where id=first_id and owner_id=a;
  return recipe_private.summary(v)||jsonb_strip_nulls(jsonb_build_object('firstCode',first_code,'format','rich-v2'));
end $$;

create or replace function recipe_api.rich_save_metadata(p_id uuid,p_draft uuid,binding jsonb,wire_sha text,
  canonical bytea,manifest uuid,access_ text,items jsonb,logo jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare ctx jsonb; a uuid; h text:=encode(sha256(canonical),'hex'); content jsonb; info jsonb;
  rd recipe_private.rich_drafts; d recipe_private.drafts; item jsonb; initial_logo jsonb; next_logo jsonb;
  logical int; retained int; receipt jsonb;
begin
  if wire_sha is null then raise exception 'invalid_input'; end if;
  ctx:=recipe_api.rich_metadata_context(p_id,p_draft,binding,wire_sha);
  if ctx ? 'receipt' then return ctx->'receipt'; end if;
  if ctx ? 'pending' then raise exception 'object_unavailable'; end if;
  a:=(ctx->>'accountId')::uuid;
  select * into strict d from recipe_private.drafts where id=p_draft;
  select * into strict rd from recipe_private.rich_drafts where id=p_draft;
  if not exists(select from recipe_private.object_attempts m where m.package_id=p_id and m.id=manifest
    and m.ordinal=65 and m.kind='manifest' and m.state='ready' and m.final_state='present'
    and m.final_hash=h and m.final_bytes=octet_length(canonical)) then raise exception 'object_unavailable'; end if;

  content:=convert_from(canonical,'UTF8')::jsonb;
  if content->'memories' is distinct from '[]'::jsonb
    or exists(select from jsonb_array_elements(items) x where x->>'kind'='memory') then raise exception 'invalid_input'; end if;
  if (content->>'format'='rich-v2' and content->'schemaVersion'='2'::jsonb
    and access_ in ('direct','coded') and jsonb_array_length(items) between 4 and 320) is not true then
    raise exception 'invalid_input';
  end if;
  select jsonb_object_agg(key,value->'value') into info from jsonb_each(content->'public');
  info:=info||jsonb_build_object('access',access_);
  select value into initial_logo from jsonb_array_elements(rd.items) where value->>'kind'='finalLogo';
  select value into next_logo from jsonb_array_elements(items) where value->>'kind'='finalLogo';
  if logo is not null then
    if (logo->>'packageId')::uuid is distinct from p_id or next_logo is null or
      content#>>'{finalLogo,objectId}' is distinct from logo#>>'{descriptor,objectId}' then raise exception 'conflict'; end if;
    perform recipe_private.check_rich_upload(a,p_draft,logo);
    if initial_logo is null then
      insert into recipe_private.rich_origins(id,account_id,kind,intent,candidate,baseline,provenance)
        values((next_logo->>'originId')::uuid,a,'finalLogo',p_id,(next_logo->>'itemId')::uuid,next_logo->>'baselineSha256','metadata')
        on conflict do nothing;
      if not found then raise exception 'conflict'; end if;
      if (select count(*) from recipe_private.rich_origins where account_id=a)>250000 then raise exception 'quota_exceeded'; end if;
    elsif (initial_logo->>'originId',initial_logo->>'itemId') is distinct from (next_logo->>'originId',next_logo->>'itemId') then
      raise exception 'conflict';
    end if;
  elsif next_logo is not null and next_logo is distinct from initial_logo then
    raise exception 'conflict';
  end if;
  if exists(select from jsonb_array_elements(items) x join recipe_private.rich_members m on m.kind=x->>'kind'
    and m.fingerprint=x->>'contentFingerprint' join recipe_private.versions v on v.id=m.version_id
    join recipe_private.grants g on g.actor=a and g.version_id=v.id where v.owner_id<>a and v.public_info->>'access'='coded'
    and m.kind in ('role','rule','skill','file','task','memory','setup','finalLogo')) then raise exception 'source_unavailable'; end if;
  for item in select value from jsonb_array_elements(items) loop
    perform recipe_private.check_rich_origin(a,(item->>'originId')::uuid,item->>'kind');
  end loop;
  perform recipe_private.check_rich_logo(a,items,rd.parent_version);
  logical:=recipe_private.rich_write_refs(a,p_draft,p_id,manifest,h,canonical,content->'parts');
  select coalesce(sum(m.final_bytes),0) into retained from recipe_private.object_draft_refs refs
    join recipe_private.object_attempts m on m.id=refs.object_id where refs.draft_id=p_draft and refs.object_id<>manifest
    and not exists(select from jsonb_array_elements(content->'parts') p where (p->>'objectId')::uuid=m.id);
  if logical+retained>d.bytes and
    (select coalesce(sum(bytes),0) from recipe_private.drafts where owner_id=a and id<>p_draft)+logical+retained>10485760 then
    raise exception 'quota_exceeded';
  end if;
  perform set_config('app.rich_mutation','v2',true);
  update recipe_private.drafts set revision=revision+1,public_info=info,bytes=logical+retained,retained_candidate_bytes=retained
    where id=p_draft returning revision into d.revision;
  update recipe_private.rich_drafts set manifest_id=manifest,items=rich_save_metadata.items,retained_bytes=retained where id=p_draft;
  receipt:=jsonb_build_object('requestId',p_id,'draftId',p_draft,'revision',d.revision,'manifestSha256',h);
  delete from recipe_private.receipts where actor=a and action='richMetadata' and created_at<clock_timestamp()-interval '9 days';
  perform recipe_private.remember(a,'richMetadata',p_id,jsonb_build_array(p_draft,binding),
    jsonb_build_object('receipt',receipt,'wireSha256',wire_sha),p_draft);
  return receipt;
end $$;

reset role;
do $migration_role$
declare actor text := current_setting('vonvon.recipe_m202611150002_actor'); memberships jsonb;
  can_set boolean := current_setting('vonvon.recipe_m202611150002_can_set')::boolean;
  self_grant boolean := current_setting('vonvon.recipe_m202611150002_self_grant')::boolean;
begin
  if actor is distinct from session_user then raise exception 'migration_role_session_changed'; end if;
  if not can_set and not self_grant then
    execute format('revoke recipe_owner from %I',actor);
  end if;
  select coalesce(jsonb_agg(to_jsonb(m) order by m.roleid,m.member,m.grantor),'[]'::jsonb)
    into memberships from pg_catalog.pg_auth_members m;
  if memberships is distinct from current_setting('vonvon.recipe_m202611150002_memberships')::jsonb then
    raise exception 'migration_role_memberships_changed';
  end if;
end $migration_role$;
