# 本地 PostgreSQL 可复现实验

这是并发与数据库约束的最小模型。2026-11-13 在独立 PostgreSQL 15.19、Unix socket 上执行；每个竞争者是独立 psql 连接。用合成账号和内容，未运行 Supabase Auth、飞书或正式 daemon。例子里的码用短测试标识；生产必须使用云设计里的随机码/摘要/授权，并且不能接受客户端自报身份。

**复跑。** 只在全新、一次性、无业务数据的数据库中运行。需要可用的 PostgreSQL、Python 3、psql。将下面四个 Python 代码块按顺序分别保存为 `redeem.py`、`visibility.py`、`handoff.py`、`quota.py`。以下为 macOS Homebrew PostgreSQL 15 的命令示例，其他环境使用对应 PostgreSQL bin 路径。目录故意保留，便于检查结果。

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
python3 quota.py
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

## 体积与并发占额

```python
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import json, subprocess,sys,os
cap=1024*1024
def b(obj):return len(json.dumps(obj,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode('utf8'))
def total(m,parts):return b(m)+sum(map(len,parts.values()))
m={'name':'开发晨报','version':'1.0','parts':['doc','logo']}
assert b(m)>len(json.dumps(m,sort_keys=True,ensure_ascii=False,separators=(',',':')))
logo=b'x'*(16*1024); size=cap-b(m)-len(logo)
assert total(m,{'doc':b'x'*size,'logo':logo})==cap
assert total(m,{'doc':b'x'*(size+1),'logo':logo})>cap
assert total(m,{'doc':'今天已完成事项'.encode(),'logo':logo})<cap
print('PASS byte accounting: a small Chinese fixture, exact 1 MiB accepted, +1 byte rejected, binary Logo included.')
def sql(s):
 return subprocess.run(['psql','-XAtq','-v','ON_ERROR_STOP=1'],input=s,text=True,capture_output=True,check=True).stdout.strip()
sql("""create table proof_quota(a text primary key,bytes bigint not null);
create table proof_uploads(a text,op text,size bigint,primary key(a,op));
insert into proof_quota values('demo',25*1024*1024-1024*1024);
create function qpublish(id text,n bigint) returns text language plpgsql as $$
declare used bigint; previous bigint;begin
 select bytes into used from proof_quota where a='demo' for update;
 select size into previous from proof_uploads where a='demo' and op=id;
 if found then return case when previous=n then 'saved' else 'conflict' end;end if;
 if n<0 or n>1048576 or used+n>26214400 then return 'over_limit';end if;
 insert into proof_uploads values('demo',id,n);update proof_quota set bytes=bytes+n where a='demo';return 'saved';end $$;""")
def put(n):return sql("select qpublish('op"+str(n)+"',1048576)")
with ThreadPoolExecutor(max_workers=6) as pool:res=list(pool.map(put,range(6)))
assert res.count('saved')==1 and res.count('over_limit')==5
assert put(res.index('saved'))=='saved' and sql('select bytes from proof_quota')=='26214400'
print('PASS real database: six concurrent releases with only 1 MiB remaining; 1 saved, 5 rejected, replay never double-charged.')
```

## 草稿与发码争用：额外一轮

在独立数据库并行开启两个 READ COMMITTED 事务，第一连接持作者额度锁，第二连接提交同账号的另一请求。在观察连接用 `pg_blocking_pids` 确认第二连接确实阻塞，再提交第一连接。第二连接必须重新读剩余额度并拒绝超限操作。此轮也从真实表回读数量／字节／修订和日计数，不能只核对 HTTP 风格的返回值。每项输入都是合成数据。

| 情况 | 实际观察 |
| --- | --- |
| 剩一个草稿名额，两请求 | 19 → 20，第二次被拒。 |
| 只余 1 MiB，新建两份各 1 MiB | 只新建一份，总计 10,485,760 字节。 |
| 只余 256 字节，两份旧稿各增加 256 字节 | 只有一个草稿修订成功，总量恰等于 10 MiB。 |
| 同版本可用码已有 499；账号尚有日额与累计额 | 只新发一枚到 500。停用后可用变 499，当日/累计不减，可另签一枚。 |
| 同账号跨版本：当日已签 499 / 历史已签 4,999，分别测试 | 当日最多到 500，停用当天不返还，次日可重发；累计到 5,000 后次日仍拒。 |
| 仅余一个可用位却要求批量签两枚 | 整批拒绝，原 499 枚未变。 |
