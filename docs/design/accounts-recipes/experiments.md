# 本地 PostgreSQL 可复现实验

这是并发与数据库约束的最小模型。2026-11-13 在独立 PostgreSQL 15.19、Unix socket 上执行；每个竞争者是独立 psql 连接。用合成账号和内容，未运行 Supabase Auth、飞书或正式 daemon。例子里的码用短测试标识；生产必须使用云设计里的随机码/摘要/授权，并且不能接受客户端自报身份。

**复跑。** 只在全新、一次性、无业务数据的数据库中运行。需要可用的 PostgreSQL、Python 3、psql。将下面三个 Python 代码块按顺序分别保存为 `redeem.py`、`visibility.py`、`handoff.py`。以下为 macOS Homebrew PostgreSQL 15 的命令示例，其他环境使用对应 PostgreSQL bin 路径。目录故意保留，便于检查结果。

```sh
export PATH="/opt/homebrew/opt/postgresql@15/bin:$PATH"
trial_dir=$(mktemp -d)
mkdir -m 700 "$trial_dir/socket"
initdb -D "$trial_dir/db" -A trust --no-locale
pg_ctl -D "$trial_dir/db" -l "$trial_dir/db.log" -o "-k '$trial_dir/socket' -p 56486 -c listen_addresses='' -c unix_socket_permissions=0700" start
export PGHOST="$trial_dir/socket" PGPORT=56486 PGDATABASE=postgres
python3 redeem.py
python3 visibility.py
python3 handoff.py
pg_ctl -D "$trial_dir/db" stop
```

## 兑换、重试与槽位修订

```python
"""Disposable Postgres contract experiment, not the Vonvon schema or backend."""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from threading import Event
import subprocess,sys,time
t=Path(__file__).parent
base=['psql','-XAtq','-v','ON_ERROR_STOP=1']
def query(sql):
 return subprocess.run(base,input=sql,text=True,check=True,capture_output=True).stdout.strip()
query("""
create table releases (v int primary key, public boolean not null, intro text, body text);
create table sample_codes(c text primary key, v int not null references releases, enabled boolean not null default true, claimed_by text);
create table entitlements(u text, v int references releases, primary key(u,v));
create table receipts(u text,k text, fingerprint text, result text, primary key(u,k));
create function claim(who text, ver int, code text, idem text) returns text language plpgsql as $$
declare cinfo sample_codes%rowtype; last receipts%rowtype; fingerprint text:=concat(ver, ':',code); answer text;
begin
 perform pg_advisory_xact_lock(hashtextextended(who||':'||ver,0));
 select * into last from receipts where u=who and k=idem;
 if found then return case when last.fingerprint=fingerprint then last.result else 'key_conflict' end; end if;
 if exists(select 1 from entitlements where u=who and v=ver) then answer:='already_owned';
 else
 select * into cinfo from sample_codes where c=code and v=ver for update;
 if not found or not cinfo.enabled or cinfo.claimed_by is not null then return 'unavailable'; end if;
 update sample_codes set claimed_by=who where c=code;
 insert into entitlements values(who,ver);answer:='redeemed';
 end if;
 insert into receipts values(who,idem,fingerprint,answer);return answer;
end $$;
insert into releases values(1,false,'public A','ONLY-IN-PACKAGE'),(2,false,'public B','B-PRIVATE');
insert into sample_codes(c,v) values('X',1),('Y',1),('Z',1),('W',2);
""")
def get(who,ver,code,idem):
 return query("select claim('%s',%d,'%s','%s');"%(who,ver,code,idem))
gate=Event()
def simultaneous(inputs):
 gate.clear()
 with ThreadPoolExecutor(max_workers=len(inputs)) as pool:
  def work(args):
   gate.wait();return get(*args)
  jobs=[pool.submit(work,args) for args in inputs];gate.set()
  return [j.result() for j in jobs]
i=[('actor'+str(n),1,'X','first') for n in range(16)]
r=simultaneous(i);assert r.count('redeemed')==1 and r.count('unavailable')==15, r
winner=i[r.index('redeemed')][0]
assert get(winner,1,'X','first')=='redeemed'
assert get(winner,1,'Y','first')=='key_conflict'
r=simultaneous([('same',1,'Y','a'),('same',1,'Z','b')]);assert sorted(r)==['already_owned','redeemed']
assert query("select count(*) from sample_codes where c in('Y','Z') and claimed_by is null")=='1'
assert get('new',2,'X','bad-version')=='unavailable'
query("update sample_codes set enabled=false where c='W'");assert get('new',2,'W','already-stopped')=='unavailable'
assert query('select count(*) from entitlements')=='2'
print(query("show server_version"))
print('PASS 16 independent database connections/one code: 1 winner, 15 rejected; replay identical receipt, changed payload rejected; two codes same user released once; wrong version and disabled code do not grant.')
query("""
create table slots(bot text,g text, rev int, installed int, choice text, primary key(bot,g));
insert into slots values ('A','same-group',3,1,'local'),('B','same-group',2,null,'other');
""")
def apply(new):
 return query("with applied as (update slots set installed="+str(new)+",rev=rev+1 where bot='A' and g='same-group' and rev=3 and installed=1 returning 1) select count(*) from applied")
with ThreadPoolExecutor(max_workers=2) as pool: results=list(pool.map(apply,[2,3]))
assert sorted(results)==['0','1'];assert query("select rev||':'||choice from slots where bot='B'")=='2:other'
print('PASS competing slot commits: 1 accepted, stale update rejected, other Bot in same chat untouched.')
```

## 授权读取

```python
import subprocess
from pathlib import Path
t=Path(__file__).parent
ps=['psql','-XAtq','-v','ON_ERROR_STOP=1']
def sql(s):return subprocess.run(ps,input=s,text=True,capture_output=True,check=True).stdout.strip()
sql("""
create role web_guest;create role web_account;
create table release_p(v int primary key,author_name text, kind text, title text);
create table release_bundle(v int primary key references release_p, content text);
create table rights(actor text,v int,primary key(actor,v));
insert into release_p values(1,'writer','code','A'),(2,'writer','open','B');
insert into release_bundle values(1,'nonpublic-A'),(2,'public-B');insert into rights values('reader',1);
grant select on release_p,release_bundle to web_guest,web_account;grant select on rights to web_guest,web_account;
alter table rights enable row level security;
create policy right_read on rights for select using(actor=current_setting('app.actor',true));
alter table release_bundle enable row level security;
create policy body_read on release_bundle for select using(exists(select 1 from release_p p where p.v=release_bundle.v and
(p.kind='open' or p.author_name=current_setting('app.actor',true) or exists(select 1 from rights r where r.v=p.v and r.actor=current_setting('app.actor',true)))));
""")
def view(role,u,table):
 return sql("set role "+role+"; set app.actor='"+u+"'; select count(*) from "+table)
assert view('web_guest','','release_p')=='2' and view('web_guest','','release_bundle')=='1'
assert view('web_account','reader','release_bundle')=='2' and view('web_account','another','release_bundle')=='1' and view('web_account','writer','release_bundle')=='2'
assert view('web_account','another','rights')=='0'
msg=subprocess.run(ps,input="set role web_account;insert into rights values('another',1);",text=True,capture_output=True);assert msg.returncode and "permission denied" in msg.stderr
print("PASS Postgres RLS/grants with nonprivileged roles: guest public metadata and open bundle only; owner/entitled account can read coded bundle; another cannot read entitlement or self-grant. Server-set example identity; not testing Supabase JWT.")
```

## 取消与草稿提交

```python
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import subprocess
t=Path(__file__).parent
def sql(s):return subprocess.run(['psql','-XAtq','-v','ON_ERROR_STOP=1'],input=s,text=True,check=True,capture_output=True).stdout.strip()
sql("""
create table hreq(id int primary key, actor text not null,device text not null,st text not null,expires timestamptz not null);
create table returned_draft(id int primary key references hreq,owner_name text not null);
create function htransition(k int,u text,d text,verb text) returns text language plpgsql as $$
declare r hreq%rowtype;
begin
 select * into r from hreq where id=k for update;
 if not found or u<>r.actor or d<>r.device then return 'denied';end if;
 if r.st='complete' then return 'draft';end if;
 if r.st='cancelled' then return 'cancelled';end if;
 if now()>=r.expires then return 'expired';end if;
 if verb='cancel' then update hreq set st='cancelled' where id=k;return 'cancelled';end if;
 if verb<>'submit' then return 'invalid';end if;
 insert into returned_draft values(k,u);update hreq set st='complete' where id=k;return 'draft';
end $$;
insert into hreq select n,'owner','machine','waiting',now()+interval '1 hour' from generate_series(1,12) n;
insert into hreq values(20,'owner','machine','waiting',now()-interval '1 second');
""")
def tr(k,v,user='owner',device='machine'):
 return sql("select htransition(%d,'%s','%s','%s')"%(k,user,device,v))
assert tr(1,'submit','wrong')=='denied' and tr(1,'submit',device='other')=='denied' and tr(20,'submit')=='expired'
summary={}
with ThreadPoolExecutor(max_workers=8) as pool:
 for k in range(1,13):
  verbs=['submit','cancel','submit'] if k%2 else ['cancel','submit','submit']
  results=list(pool.map(lambda op:tr(k,op),verbs))
  final=sql('select st from hreq where id='+str(k));n=sql('select count(*) from returned_draft where id='+str(k))
  assert (final,n) in [('complete','1'),('cancelled','0')]
  assert len(set(results))==1,(final,results)
  assert tr(k,'submit')==('draft' if n=='1' else 'cancelled')
  summary[final]=summary.get(final,0)+1
print('PASS 12 concurrent cancel/deliver/redeliver races: at most one private draft; no late resurrection. Wrong owner/device and expiry refused.',summary)
```
