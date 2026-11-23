grant recipe_owner to current_user;
set local role recipe_owner;

create or replace function recipe_private.check_fields(pub jsonb, cfg jsonb, ready boolean) returns void
language plpgsql immutable set search_path = pg_catalog, pg_temp as $$
declare
  setup jsonb := cfg->'setup';
  step jsonb;
  -- Match the editor's String.trim(), including the full-width space used in Chinese.
  whitespace constant text := U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
begin
  if jsonb_typeof(pub) is distinct from 'object' or jsonb_typeof(cfg) is distinct from 'object' then
    raise exception 'invalid_input';
  end if;
  if pub - array['name','summary','overview','version','access'] <> '{}'::jsonb
     or not (pub ?& array['name','summary','overview','version','access'])
     or exists (select from jsonb_each(pub) where jsonb_typeof(value) <> 'string')
     or cfg - array['role','setup'] <> '{}'::jsonb or jsonb_typeof(cfg->'role') is distinct from 'string'
     or length(pub->>'name') > 60 or length(pub->>'summary') > 240 or length(pub->>'version') > 40
     or octet_length(pub->>'overview') > 32768 or octet_length(cfg->>'role') > 16384
     or pub->>'access' not in ('direct','coded')
     or (ready and (btrim(pub->>'name', whitespace)='' or btrim(pub->>'summary', whitespace)='' or btrim(pub->>'version', whitespace)='')) then
    raise exception 'invalid_input';
  end if;
  if not (cfg ? 'setup') then return; end if;
  if jsonb_typeof(setup) is distinct from 'object' then raise exception 'invalid_input'; end if;
  if setup - 'steps' <> '{}'::jsonb or jsonb_typeof(setup->'steps') is distinct from 'array' then
    raise exception 'invalid_input';
  end if;
  if jsonb_array_length(setup->'steps') not between 1 and 8 then raise exception 'invalid_input'; end if;
  for step in select value from jsonb_array_elements(setup->'steps') loop
    if jsonb_typeof(step) is distinct from 'object' then raise exception 'invalid_input'; end if;
    if step - array['kind','title','instructions','required','check'] <> '{}'::jsonb
       or jsonb_typeof(step->'kind') is distinct from 'string' or step->>'kind' not in ('config','tool','context')
       or jsonb_typeof(step->'required') is distinct from 'boolean'
       or jsonb_typeof(step->'title') is distinct from 'string' or length(step->>'title') > 80
       or jsonb_typeof(step->'instructions') is distinct from 'string' or octet_length(step->>'instructions') > 2048
       or (step ? 'check' and (jsonb_typeof(step->'check') is distinct from 'string' or octet_length(step->>'check') > 512)) then
      raise exception 'invalid_input';
    end if;
    if ready and (btrim(step->>'title', whitespace) = '' or btrim(step->>'instructions', whitespace) = '') then
      raise exception 'incomplete_setup';
    end if;
  end loop;
end $$;

create or replace function recipe_api.acquire(p_version uuid,p_code text,p_request uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  a uuid := recipe_private.actor(); code text := upper(replace(btrim(p_code),'-',''));
  args jsonb := jsonb_build_array(p_version,p_code);
  receipt jsonb := recipe_private.prior(a,'acquire',p_request,args);
  v recipe_private.versions; lookup bytea; prior_digest bytea;
  legacy_digest bytea := sha256(convert_to(jsonb_build_array(p_version,code)::text,'UTF8'));
begin
  if receipt is not null then return receipt; end if;
  -- Pre-upgrade grants hold the original normalized request digest.
  select original_digest into prior_digest from recipe_private.grants where actor=a and original_request=p_request;
  if found and prior_digest<>legacy_digest then raise exception 'conflict'; end if;
  select * into v from recipe_private.versions where id=p_version;
  if not found then raise exception 'not_found'; end if;
  if v.owner_id<>a and not exists(select from recipe_private.grants where actor=a and version_id=v.id) then
    if v.public_info->>'access'='coded' then
      if code is null or code !~ '^[0-9A-F]{32}$' then raise exception 'invalid_code'; end if;
      lookup := recipe_private.code_mac('recipe-code-lookup:v1',convert_to(code,'UTF8'));
      update recipe_private.codes set status='redeemed',redeemed_at=clock_timestamp(),redeemed_by=a,nonce=null
        where lookup_digest=lookup and version_id=v.id and status='available';
      if not found then raise exception 'invalid_code'; end if;
    end if;
    insert into recipe_private.grants values(a,v.id,p_request,legacy_digest);
  end if;
  return recipe_private.remember(a,'acquire',p_request,args,
    jsonb_build_object('recipeId',v.recipe_id,'versionId',v.id,'owned',v.owner_id=a,'acquired',v.owner_id<>a));
end $$;

reset role;
revoke recipe_owner from current_user;
