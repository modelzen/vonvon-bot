grant recipe_owner to current_user;
set local role recipe_owner;

create table recipe_private.accounts (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'active' check (status in ('active','stopped','disabled')),
  created_at timestamptz not null default clock_timestamp()
);
create table recipe_private.account_identities (
  issuer text not null,
  subject uuid not null,
  account_id uuid not null references recipe_private.accounts,
  primary key (issuer,subject),
  unique (account_id,issuer)
);
create table recipe_private.identity_deployment (
  singleton boolean primary key default true check (singleton),
  issuer text check (length(issuer) between 1 and 2048)
);
insert into recipe_private.identity_deployment(singleton) values(true);

-- Existing business UUIDs retain their data. Their issuer is bound once at
-- service startup from deployment configuration, before HTTP accepts requests.
insert into recipe_private.accounts(id)
select owner_id from recipe_private.recipes
union select owner_id from recipe_private.drafts
union select owner_id from recipe_private.retired_drafts
union select owner_id from recipe_private.versions
union select owner_id from recipe_private.codes
union select redeemed_by from recipe_private.codes where redeemed_by is not null
union select actor from recipe_private.grants
union select actor from recipe_private.receipts;

alter table recipe_private.accounts enable row level security;
alter table recipe_private.account_identities enable row level security;
alter table recipe_private.identity_deployment enable row level security;
alter table recipe_private.recipes add foreign key (owner_id) references recipe_private.accounts;
alter table recipe_private.drafts add foreign key (owner_id) references recipe_private.accounts;
alter table recipe_private.retired_drafts add foreign key (owner_id) references recipe_private.accounts;
alter table recipe_private.versions add foreign key (owner_id) references recipe_private.accounts;
alter table recipe_private.codes add foreign key (owner_id) references recipe_private.accounts;
alter table recipe_private.codes add foreign key (redeemed_by) references recipe_private.accounts;
alter table recipe_private.grants add foreign key (actor) references recipe_private.accounts;
alter table recipe_private.receipts add foreign key (actor) references recipe_private.accounts;

create function recipe_api.bind_identity_issuer(p_issuer text) returns void
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare configured text;
begin
  if p_issuer is null or length(p_issuer) not between 1 and 2048 then raise exception 'invalid_input'; end if;
  select issuer into configured from recipe_private.identity_deployment where singleton for update;
  if configured is null then
    update recipe_private.identity_deployment set issuer=p_issuer where singleton;
    insert into recipe_private.account_identities(issuer,subject,account_id)
      select p_issuer,id,id from recipe_private.accounts;
  elsif configured<>p_issuer then
    raise exception 'identity_issuer_mismatch';
  end if;
end $$;

create function recipe_api.resolve_identity(p_issuer text,p_subject uuid) returns uuid
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare a uuid; account_status text;
begin
  if p_subject is null or p_issuer is null or p_issuer is distinct from
      (select issuer from recipe_private.identity_deployment where singleton) then
    raise exception 'auth_required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_issuer || ':' || p_subject::text,187512));
  select account_id into a from recipe_private.account_identities where issuer=p_issuer and subject=p_subject;
  if not found then
    loop
      a := gen_random_uuid();
      exit when a<>p_subject and not exists(select from recipe_private.accounts where id=a);
    end loop;
    insert into recipe_private.accounts(id) values(a);
    insert into recipe_private.account_identities(issuer,subject,account_id) values(p_issuer,p_subject,a);
  end if;
  select status into account_status from recipe_private.accounts where id=a for share;
  if account_status<>'active' then raise exception 'account_disabled'; end if;
  return a;
end $$;

create or replace function recipe_private.actor(required boolean default true) returns uuid
language plpgsql stable set search_path = pg_catalog, pg_temp as $$
declare a uuid := nullif(current_setting('app.recipe_account',true),'')::uuid; account_status text;
begin
  if a is null then
    if required then raise exception 'auth_required'; end if;
    return null;
  end if;
  select status into account_status from recipe_private.accounts where id=a;
  if not found then raise exception 'auth_required'; end if;
  if account_status<>'active' then raise exception 'account_disabled'; end if;
  return a;
end $$;

create function recipe_api.me() returns jsonb
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('accountId',recipe_private.actor())
$$;

grant execute on function recipe_api.bind_identity_issuer(text), recipe_api.resolve_identity(text,uuid), recipe_api.me() to recipe_api;
reset role;
revoke recipe_owner from current_user;
