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
     or (ready and (btrim(pub->>'name')='' or btrim(pub->>'summary')='' or btrim(pub->>'version')='')) then
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

reset role;
revoke recipe_owner from current_user;
