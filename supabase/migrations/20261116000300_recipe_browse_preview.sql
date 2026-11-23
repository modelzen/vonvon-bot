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
  perform set_config('vonvon.recipe_m202611160003_actor',actor,true);
  perform set_config('vonvon.recipe_m202611160003_memberships',memberships::text,true);
  perform set_config('vonvon.recipe_m202611160003_can_set',can_set::text,true);
  perform set_config('vonvon.recipe_m202611160003_self_grant',self_grant::text,true);
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


create table recipe_private.browse_previews (
  version_id uuid primary key references recipe_private.versions on delete cascade,
  content_sha256 text not null check(content_sha256 ~ '^[a-f0-9]{64}$'),
  preview jsonb not null check(jsonb_typeof(preview)='object' and octet_length(preview::text)<=65536)
);
alter table recipe_private.browse_previews enable row level security;

create function recipe_private.browse_skill_description(value_ text) returns text
language plpgsql immutable set search_path=pg_catalog,pg_temp as $$
declare front_ text; line_ text;
begin
  if value_ is null or value_ !~ E'^---[ \\t]*\\r?\\n' then return ''; end if;
  front_:=substring(left(value_,8192) from E'^---[ \\t]*\\r?\\n(.*?)\\r?\\n---(\\r?\\n|$)');
  if front_ is null then return ''; end if;
  line_:=substring(front_ from E'(?n)^description[ \\t]*:[ \\t]*([^\\r\\n]*)');
  if line_ is null or btrim(line_) in ('>','|','>-','|-','>+','|+') then return ''; end if;
  line_:=btrim(line_);
  if (left(line_,1)='"' and right(line_,1)='"') or (left(line_,1)=chr(39) and right(line_,1)=chr(39)) then
    line_:=substring(line_ from 2 for length(line_)-2);
  end if;
  return left(regexp_replace(line_,'[[:cntrl:]]',' ','g'),400);
end $$;

create function recipe_private.browse_projection(canonical_ bytea,descriptions_ jsonb default '{}'::jsonb) returns jsonb
language plpgsql immutable set search_path=pg_catalog,pg_temp as $$
declare c jsonb; setting_ jsonb; skill_ jsonb; file_ jsonb; settings_ jsonb:='[]'; skills_ jsonb:='[]';
  description_ text; omitted_ int:=0; result_ jsonb;
begin
  if canonical_ is null or octet_length(canonical_)>1048576 or jsonb_typeof(descriptions_) is distinct from 'object' then raise exception 'invalid_input'; end if;
  c:=convert_from(canonical_,'UTF8')::jsonb;
  if c->>'format' is distinct from 'rich-v2' or jsonb_typeof(c->'settings') is distinct from 'array'
    or jsonb_typeof(c->'skills') is distinct from 'array' or jsonb_typeof(c->'files') is distinct from 'array'
    or jsonb_typeof(c->'rules') is distinct from 'array' or jsonb_typeof(c->'tasks') is distinct from 'array'
    or jsonb_array_length(c->'settings')>32 or jsonb_array_length(c->'skills')>16
    or jsonb_array_length(c->'rules')>32 or jsonb_array_length(c->'tasks')>32 then raise exception 'invalid_input'; end if;
  if exists(select from jsonb_each(descriptions_) d where jsonb_typeof(d.value)<>'string' or length(d.value#>>'{}')>400
    or (d.value#>>'{}')~'[[:cntrl:]]' or not exists(select from jsonb_array_elements(c->'skills') s where s->>'itemId'=d.key)) then raise exception 'invalid_input'; end if;
  for setting_ in select value from jsonb_array_elements(c->'settings') loop
    if octet_length(setting_::text)>4096 or octet_length((settings_||jsonb_build_array(setting_))::text)>32768 then omitted_:=omitted_+1;
    else settings_:=settings_||jsonb_build_array(setting_); end if;
  end loop;
  for skill_ in select value from jsonb_array_elements(c->'skills') loop
    if length(skill_->>'name')>1000 then raise exception 'invalid_input'; end if;
    description_:=descriptions_->>(skill_->>'itemId');
    if description_ is null then
      select value into file_ from jsonb_array_elements(c->'files') where value->>'itemId'=skill_->>'entryFileId';
      description_:=case when file_->'text'->>'kind'='inline' then recipe_private.browse_skill_description(file_->'text'->>'value') else '' end;
    end if;
    skills_:=skills_||jsonb_build_array(jsonb_build_object('itemId',skill_->>'itemId','name',regexp_replace(skill_->>'name','[[:cntrl:]]',' ','g'),'description',description_));
  end loop;
  result_:=jsonb_build_object('settings',settings_,'skills',skills_,'ruleCount',jsonb_array_length(c->'rules'),'taskCount',jsonb_array_length(c->'tasks'));
  if omitted_>0 then result_:=result_||jsonb_build_object('omittedSettingCount',omitted_); end if;
  while jsonb_array_length(settings_)>0 and octet_length(result_::text)>65536 loop
    settings_:=settings_-(jsonb_array_length(settings_)-1);omitted_:=omitted_+1;
    result_:=jsonb_set(result_,'{settings}',settings_)||jsonb_build_object('omittedSettingCount',omitted_);
  end loop;
  if octet_length(result_::text)>65536 then raise exception 'invalid_input'; end if;
  return result_;
end $$;

-- Operator-only backfill; the exact published manifest hash and byte length bind its source.
-- Browse calls never fall back to fetching or deriving source objects.
create function recipe_private.cache_browse_preview(version_ uuid,canonical_ bytea,descriptions_ jsonb default '{}'::jsonb) returns void
language plpgsql set search_path=pg_catalog,pg_temp as $$
declare v recipe_private.versions; rv recipe_private.rich_versions; descriptor_ jsonb; h text:=encode(sha256(canonical_),'hex'); prior_ text;
begin
  select * into v from recipe_private.versions where id=version_;
  select * into rv from recipe_private.rich_versions where id=version_;
  if not found then raise exception 'not_found'; end if;
  descriptor_:=recipe_private.object_descriptor(v.owner_id,rv.manifest_id);
  if descriptor_->>'sha256' is distinct from h or (descriptor_->>'bytes')::int is distinct from octet_length(canonical_) then raise exception 'conflict'; end if;
  select content_sha256 into prior_ from recipe_private.browse_previews where version_id=version_;
  if found then
    if prior_ is distinct from h then raise exception 'conflict'; end if;
    if descriptions_='{}'::jsonb then return; end if;
  end if;
  insert into recipe_private.browse_previews(version_id,content_sha256,preview)
    values(version_,h,recipe_private.browse_projection(canonical_,descriptions_))
    on conflict(version_id) do update set preview=excluded.preview;
end $$;

alter function recipe_api.rich_publish(uuid,int,uuid,bytea) rename to rich_publish_without_browse;
alter function recipe_api.rich_publish_without_browse(uuid,int,uuid,bytea) set schema recipe_private;
revoke all on function recipe_private.rich_publish_without_browse(uuid,int,uuid,bytea) from public,recipe_api;
create function recipe_api.rich_publish(d_id uuid,rev int,req uuid,canonical bytea) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare result_ jsonb;
begin
  result_:=recipe_private.rich_publish_without_browse(d_id,rev,req,canonical);
  perform recipe_private.cache_browse_preview((result_->>'versionId')::uuid,canonical);
  return result_;
end $$;

create function recipe_api.rich_publish(d_id uuid,rev int,req uuid,canonical bytea,descriptions_ jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare result_ jsonb;
begin
  result_:=recipe_api.rich_publish(d_id,rev,req,canonical);
  perform recipe_private.cache_browse_preview((result_->>'versionId')::uuid,canonical,descriptions_);
  return result_;
end $$;

create function recipe_api.browse_preview(recipe_ uuid,version_ uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid:=recipe_private.actor(false); v recipe_private.versions; rv recipe_private.rich_versions; result_ jsonb; display_ jsonb; allowed_ boolean;
begin
  select * into v from recipe_private.versions where id=version_ and recipe_id=recipe_;
  if not found then raise exception 'not_found'; end if;
  select * into rv from recipe_private.rich_versions where id=version_;
  if found then
    result_:=recipe_api.rich_detail(recipe_,version_);
    if result_->>'state' in ('withdrawn','blocked') and not result_ ? 'recipeId' then return result_; end if;
    allowed_:=result_->>'visibility'='full';
    result_:=result_-array['visibility','manifest','release'];
    if allowed_ then
      select preview into display_ from recipe_private.browse_previews where version_id=version_;
      result_:=result_||case when found then jsonb_build_object('preview',display_) else jsonb_build_object('previewUnavailable',true) end;
    end if;
    return result_;
  end if;
  allowed_:=v.owner_id=a or exists(select from recipe_private.grants where actor=a and version_id=v.id) or v.public_info->>'access'='direct';
  result_:=recipe_private.summary(v)||jsonb_build_object('format','role-v1','state','listed','creator',recipe_private.public_creator(v.owner_id),
    'hasDisplayLogo',false,'owned',coalesce(v.owner_id=a,false),'acquired',exists(select from recipe_private.grants where actor=a and version_id=v.id));
  if allowed_ then result_:=result_||jsonb_build_object('preview',jsonb_build_object('settings','[]'::jsonb,'skills','[]'::jsonb,'ruleCount',0,'taskCount',0)); end if;
  return result_;
end $$;

-- Raw version members require actual account entitlement, including listed direct releases.
-- Operation-bound direct updates continue through the separate install_descriptor proof path.
create or replace function recipe_api.version_detail(recipe_ uuid,version_ uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
declare result_ jsonb; owner_ uuid;
begin
  perform recipe_private.require_role_generation(version_);
  result_:=recipe_private.detail_role_generation(recipe_,version_);
  select owner_id into owner_ from recipe_private.versions where id=version_ and recipe_id=recipe_;
  if not coalesce((result_->>'owned')::boolean,false) and not coalesce((result_->>'acquired')::boolean,false) then result_:=result_-'config'; end if;
  return result_||jsonb_build_object('creator',recipe_private.public_creator(owner_));
end $$;

create or replace function recipe_objects.read_descriptor(iss text,sub uuid,scope text,target uuid,obj uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,pg_temp as $$
declare a uuid; own uuid; v recipe_private.versions; rv recipe_private.rich_versions;
begin
  if sub is not null or iss is not null then a:=recipe_objects.business_actor(iss,sub); end if;
  if scope='draft' then
    select d.owner_id into own from recipe_private.drafts d join recipe_private.object_draft_refs r on r.draft_id=d.id
      where d.id=target and r.object_id=obj and d.owner_id=a;
  elsif scope='version' then
    select * into v from recipe_private.versions where id=target;
    select * into rv from recipe_private.rich_versions where id=v.id;
    if found and a is not null and (a=v.owner_id or exists(select from recipe_private.grants where actor=a and version_id=v.id))
      and recipe_private.rich_access(a,v,rv.state)='full'
      and exists(select from recipe_private.object_version_refs where version_id=target and object_id=obj) then own:=v.owner_id; end if;
  else raise exception 'invalid_input'; end if;
  if own is null then raise exception 'not_found'; end if;
  return recipe_private.object_descriptor(own,obj);
end $$;

revoke all on function recipe_private.browse_skill_description(text),recipe_private.browse_projection(bytea,jsonb),recipe_private.cache_browse_preview(uuid,bytea,jsonb) from public,recipe_api,recipe_object_verifier;
revoke all on function recipe_api.browse_preview(uuid,uuid),recipe_api.rich_publish(uuid,int,uuid,bytea),recipe_api.rich_publish(uuid,int,uuid,bytea,jsonb) from public;
do $$
declare role_ text;
begin
  foreach role_ in array array['anon','authenticated'] loop
    if exists(select from pg_roles where rolname=role_) then
      execute format('revoke all on function recipe_api.browse_preview(uuid,uuid),recipe_api.rich_publish(uuid,int,uuid,bytea),recipe_api.rich_publish(uuid,int,uuid,bytea,jsonb) from %I',role_);
    end if;
  end loop;
end $$;
grant execute on function recipe_api.browse_preview(uuid,uuid),recipe_api.rich_publish(uuid,int,uuid,bytea),recipe_api.rich_publish(uuid,int,uuid,bytea,jsonb) to recipe_api;

reset role;
do $migration_role$
declare actor text := current_setting('vonvon.recipe_m202611160003_actor'); memberships jsonb;
  can_set boolean := current_setting('vonvon.recipe_m202611160003_can_set')::boolean;
  self_grant boolean := current_setting('vonvon.recipe_m202611160003_self_grant')::boolean;
begin
  if actor is distinct from session_user then raise exception 'migration_role_session_changed'; end if;
  if not can_set and not self_grant then
    execute format('revoke recipe_owner from %I',actor);
  end if;
  select coalesce(jsonb_agg(to_jsonb(m) order by m.roleid,m.member,m.grantor),'[]'::jsonb)
    into memberships from pg_catalog.pg_auth_members m;
  if memberships is distinct from current_setting('vonvon.recipe_m202611160003_memberships')::jsonb then
    raise exception 'migration_role_memberships_changed';
  end if;
end $migration_role$;
