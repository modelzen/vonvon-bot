-- Optional, applied with psql by the database owner when enabling code lookup.
begin;
do $$begin
  if not exists (select from pg_roles where rolname='release_code_auth') then
    create role release_code_auth nologin;
  end if;
end$$;
create schema if not exists release_code_oauth;
revoke all on schema release_code_oauth from public;
create table if not exists release_code_oauth.objects(
  model text not null, id text not null, payload jsonb not null,
  expires_at timestamptz, primary key(model,id)
);
create index if not exists oauth_uid on release_code_oauth.objects(model,(payload->>'uid'));
create index if not exists oauth_usercode on release_code_oauth.objects(model,(payload->>'userCode'));
create index if not exists oauth_grant on release_code_oauth.objects((payload->>'grantId'));
create index if not exists oauth_expiration on release_code_oauth.objects(expires_at);
create table if not exists release_code_oauth.bindings(
  grant_id text primary key, account_id uuid not null, session_id uuid not null,
  web_session text not null, expires_at timestamptz not null
);
create index if not exists oauth_logout on release_code_oauth.bindings(web_session);

-- Only the database owner resolves the private account mapping and Auth session.
-- The network service gets a boolean and cannot read either underlying schema.
create or replace function release_code_oauth.active(p_account uuid,p_session uuid)
returns boolean language sql stable security definer set search_path=pg_catalog,pg_temp as $$
  select exists(
    select from recipe_private.accounts a
    join recipe_private.account_identities i on i.account_id=a.id
    join recipe_private.identity_deployment d on d.issuer=i.issuer
    join auth.users u on u.id=i.subject
    join auth.sessions s on s.user_id=u.id and s.id=p_session
    where a.id=p_account and a.status='active' and u.deleted_at is null
      and not coalesce(u.is_anonymous,false)
      and (u.banned_until is null or u.banned_until <= now())
      and (s.not_after is null or s.not_after>now())
  )
$$;
revoke all on function release_code_oauth.active(uuid,uuid) from public;
grant usage on schema release_code_oauth to release_code_auth;
grant select,insert,update,delete on release_code_oauth.objects,release_code_oauth.bindings to release_code_auth;
grant execute on function release_code_oauth.active(uuid,uuid) to release_code_auth;
commit;
