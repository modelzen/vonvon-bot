#!/usr/bin/env python3
"""Deliver authenticated readers a bounded, immutable snapshot of a verified stable release."""

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import uuid
import zipfile

# Code and tests shipped in the product. The service never receives other Git objects.
PACKAGES = ('daemon', 'desktop', 'protocol', 'client', 'ui')
FILE = re.compile(r'(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*')
CODE = {'.ts', '.tsx', '.mts', '.mjs', '.js', '.jsx', '.css', '.go', '.cs', '.c', '.h', '.swift'}
MAX_FILES = 16000
MAX_FILE = 4 * 1024 * 1024
MAX_TOTAL = 128 * 1024 * 1024
VERSION = re.compile(r'(?:0|[1-9][0-9]{0,8})(?:\.(?:0|[1-9][0-9]{0,8})){2}')
SHA = re.compile(r'[0-9a-f]{40}')
GENERATION = re.compile(r'snapshot-[0-9]+\.[0-9]+\.[0-9]+-[0-9a-f]{40}')
# Known credential forms. Code/redaction fixtures containing these are omitted in full.
CREDENTIAL = re.compile(
    rb'-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|'
    rb'(?<![A-Za-z0-9_-])(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|'
    rb'github_pat_[A-Za-z0-9_]{20,}|xox[abp]-[A-Za-z0-9-]{8,}|AKIA[A-Z0-9]{16}|'
    rb'AIza[A-Za-z0-9_-]{30,}|eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,})')
RETIRE_SECONDS = 600


def require(condition, message):
    if not condition:
        raise ValueError(message)


def allowed(name):
    if len(name) > 600 or not FILE.fullmatch(name):
        return False
    parts = name.split('/')
    if len(parts) < 3 or parts[0] != 'packages' or parts[1] not in PACKAGES:
        return False
    if len(parts) == 3:
        return parts[2] in ('package.json', 'tsconfig.json')
    root = parts[2]
    return (root in ('src', 'test') or (root == 'native' and parts[1] == 'daemon')) and Path(name).suffix in CODE


def metadata(version, sha):
    require(isinstance(version, str) and VERSION.fullmatch(version) and isinstance(sha, str) and SHA.fullmatch(sha),
            'invalid stable release identity')
    return {'version': version, 'sourceSha': sha}


def encode(obj):
    return (json.dumps(obj, sort_keys=True, separators=(',', ':')) + '\n').encode()


def check_code(data):
    require(b'\0' not in data and not CREDENTIAL.search(data), 'binary code or a credential pattern in selected files')
    data.decode('utf-8', errors='strict')


def published(out, repo):
    require(not (out / 'CANCEL').exists(), 'release was cancelled')
    handoff = json.loads((out / 'release-handoff.json').read_bytes())
    state = json.loads((out / 'release-orchestration.json').read_bytes())
    require(handoff.get('readyForWebsite') is True and handoff.get('format') == 1 and state.get('format') == 1
            and state.get('version') == handoff.get('version') and state.get('sha') == handoff.get('sourceSha')
            and Path(state['out']).resolve() == out.resolve(), 'verified stable handoff does not match release run')
    info = metadata(handoff['version'], handoff['sourceSha'])
    repo = Path(repo or state['seedRepo'])
    for pkg in ('daemon', 'desktop'):
        pkg_data = subprocess.check_output(['git', 'show', info['sourceSha'] + ':packages/' + pkg + '/package.json'], cwd=repo)
        require(json.loads(pkg_data)['version'] == info['version'], 'source package version differs from stable')
    return repo, info


def add_file(bundle, path, content):
    entry = zipfile.ZipInfo(path)  # Stored, fixed-date entries have a reproducible digest across hosts.
    entry.external_attr = (stat.S_IFREG | 0o640) << 16
    bundle.writestr(entry, content, compress_type=zipfile.ZIP_STORED)


def build(out, repo, destination):
    repo, info = published(out, repo)
    names = subprocess.check_output(['git', 'ls-tree', '-r', '-z', info['sourceSha'], '--', 'packages'], cwd=repo)
    selected = []
    for row in names.split(b'\0'):
        if not row:
            continue
        record, raw_name = row.split(b'\t', 1)
        mode, kind, oid = record.split()
        name = os.fsdecode(raw_name)
        if mode in (b'100644', b'100755') and kind == b'blob' and allowed(name):
            selected.append((name, oid))
    require(0 < len(selected) < MAX_FILES, 'unsupported release file count')
    with zipfile.ZipFile(destination, 'w') as bundle, subprocess.Popen(['git', 'cat-file', '--batch'], cwd=repo,
                                                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE) as blobs:
        try:
            add_file(bundle, 'release.json', encode(info))
            total = 0
            for name, oid in selected:
                blobs.stdin.write(oid + b'\n')
                blobs.stdin.flush()
                response = blobs.stdout.readline(200).split()
                require(len(response) == 3 and response[:2] == [oid, b'blob'], 'unexpected Git object')
                size = int(response[2])
                total += size
                require(0 <= size <= MAX_FILE and total <= MAX_TOTAL, 'source release exceeds limit')
                data = blobs.stdout.read(size)
                require(len(data) == size and blobs.stdout.read(1) == b'\n', 'incomplete Git object')
                if CREDENTIAL.search(data):
                    print('Excluded credential pattern in ' + name, file=sys.stderr)
                    continue
                check_code(data)
                add_file(bundle, 'tree/' + name, data)
        finally:
            blobs.stdin.close()
            blobs.stdout.close()
        require(blobs.wait() == 0, 'Git blob read failed')
    return info


def digest_file(file):
    h = hashlib.sha256()
    for part in iter(lambda: file.read(256 * 1024), b''):
        h.update(part)
    return h.hexdigest()


def send(out, repo, host):
    require(host and re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.@-]*', host), 'expected SSH deployment alias')
    with tempfile.TemporaryDirectory(prefix='vonvon-release-code-') as temp:
        bundle = Path(temp, 'release.zip')
        info = build(out, repo, bundle)
        with bundle.open('rb') as src:
            digest = digest_file(src)
            src.seek(0)
            header = encode({'bytes': bundle.stat().st_size, 'sha256': digest})
            require(not (out / 'CANCEL').exists(), 'release was cancelled')
            # A dedicated key runs only the receiver via authorized_keys command=. No remote shell argument.
            ssh = ['ssh', '-T', '-oBatchMode=yes', '-oStrictHostKeyChecking=yes', '-oConnectTimeout=10',
                   '-oServerAliveInterval=15', '-oServerAliveCountMax=3', host]
            with subprocess.Popen(ssh, stdin=subprocess.PIPE, stdout=subprocess.PIPE) as remote:
                try:
                    remote.stdin.write(header)
                    shutil.copyfileobj(src, remote.stdin)
                finally:
                    remote.stdin.close()
                response = remote.stdout.read(2048)
                require(len(response) < 2048 and remote.wait() == 0, 'snapshot receiver failed')
        receipt = {**info, 'sha256': digest}
        require(json.loads(response) == receipt, 'snapshot receiver did not confirm this exact publication')
        receipt_file = out / ('release-code-receipt.' + uuid.uuid4().hex + '.tmp')
        receipt_file.write_bytes(encode(receipt))
        receipt_file.replace(out / 'release-code-receipt.json')
        return receipt


def receive_bundle(source, target):
    header = source.readline(257)
    require(len(header) <= 256 and header.endswith(b'\n'), 'invalid transfer header')
    data = json.loads(header)
    size, digest = data['bytes'], data['sha256']
    require(type(size) is int and 0 < size <= MAX_TOTAL + MAX_FILE and re.fullmatch(r'[0-9a-f]{64}', digest),
            'unsupported transfer')
    with target.open('xb') as output:
        remain = size
        h = hashlib.sha256()
        while remain:
            part = source.read(min(remain, 256 * 1024))
            require(part, 'incomplete transfer')
            output.write(part)
            h.update(part)
            remain -= len(part)
        require(not source.read(1) and h.hexdigest() == digest, 'snapshot checksum mismatch')
    return digest


def unpack(bundle, stage):
    with zipfile.ZipFile(bundle) as archive:
        records = archive.infolist()
        require(0 < len(records) <= MAX_FILES and sum(r.file_size for r in records) <= MAX_TOTAL + 1024,
                'unsupported snapshot size')
        found = set()
        for record in records:
            path = record.filename
            is_meta = path == 'release.json'
            require(path == record.orig_filename and path not in found and (is_meta or (path.startswith('tree/') and allowed(path[5:]))) and
                    stat.S_ISREG(record.external_attr >> 16) and record.file_size <= (1024 if is_meta else MAX_FILE),
                    'unsupported snapshot entry')
            data = archive.read(record)
            if not is_meta:
                check_code(data)
            dst = stage / path
            dst.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
            with dst.open('xb') as file:
                file.write(data)
            found.add(path)
        info = json.loads((stage / 'release.json').read_bytes())
        require(info == metadata(info['version'], info['sourceSha']), 'invalid release metadata')
        for pkg in ('daemon', 'desktop'):
            require(json.loads((stage / 'tree' / 'packages' / pkg / 'package.json').read_bytes())['version']
                    == info['version'], 'snapshot package identity mismatch')
        return info


@contextlib.contextmanager
def locked(root):
    with (root / '.sync.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def active(root):
    current = root / 'current'
    if not current.is_symlink():
        require(not current.exists(), 'current is not a managed link')
        return None
    name = os.readlink(current)
    require(GENERATION.fullmatch(name), 'invalid current release link')
    return name


def prune(root):
    with locked(root):
        current = active(root)
        for path in root.iterdir():
            if (GENERATION.fullmatch(path.name) and not path.is_symlink() and path.is_dir() and path.name != current
                    and time.time() - path.stat().st_mtime >= RETIRE_SECONDS):
                shutil.rmtree(path)


def receive(root, source):
    os.umask(0o027)
    require(root.is_absolute() and root.is_dir(), 'pre-create an absolute release-code root')
    with tempfile.TemporaryDirectory(prefix='.incoming-', dir=root) as tmp:
        bundle = Path(tmp, 'release.zip')
        digest = receive_bundle(source, bundle)
        stage = Path(tmp, 'snapshot')
        stage.mkdir(mode=0o750)
        info = unpack(bundle, stage)
        version, sha = info['version'], info['sourceSha']
        target = root / ('snapshot-' + version + '-' + sha)
        with locked(root):
            old = active(root)
            if old and old != target.name:
                old_version = old.split('-')[1]
                require(tuple(map(int, version.split('.'))) > tuple(map(int, old_version.split('.'))),
                        'newer or different same-version release already active')
            if target.exists():
                require(not target.is_symlink() and (target / 'sha256').read_text() == digest, 'immutable snapshot mismatch')
            else:
                (stage / 'sha256').write_text(digest)
                stage.rename(target)
            if old != target.name:
                link = Path(tmp, 'next')
                link.symlink_to(target.name)
                if old:
                    os.utime(root / old, None)
                link.replace(root / 'current')
    prune(root)
    return {**info, 'sha256': digest}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    upload = commands.add_parser('send')
    upload.add_argument('--out', required=True, type=Path)
    upload.add_argument('--repo', type=Path, help='checkout with the same Git objects if the release worktree has been removed')
    upload.add_argument('--host', default=os.environ.get('VONVON_RELEASE_CODE_SSH'))
    for name in ('receive', 'prune'):
        commands.add_parser(name).add_argument('--root', required=True, type=Path)
    args = parser.parse_args()
    if args.command == 'prune':
        prune(args.root)
    elif args.command == 'receive':
        print(json.dumps(receive(args.root, sys.stdin.buffer)))
    else:
        print(json.dumps(send(args.out, args.repo, args.host)))


if __name__ == '__main__':
    main()
