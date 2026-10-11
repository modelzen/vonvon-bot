#!/usr/bin/env python3
import argparse
import json
import os
import shutil
import subprocess
from pathlib import Path

parser = argparse.ArgumentParser(description='Check local disk limits before creating a worktree or installing dependencies.')
parser.add_argument('action', choices=['inspect', 'create', 'install'])
parser.add_argument('--target', type=Path)
parser.add_argument('--max-worktrees', type=int, default=64)
parser.add_argument('--max-installed', type=int, default=48)
parser.add_argument('--min-free-gib', type=int, default=20)
args = parser.parse_args()
if min(args.max_worktrees, args.max_installed, args.min_free_gib) < 1:
    parser.error('Limits must be positive integers.')

root = Path(subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], text=True).strip()).resolve()
if args.action != 'inspect' and args.target is None:
    parser.error('create and install require --target pointing to the operation destination.')
if args.action == 'create' and os.path.lexists(args.target):
    parser.error('The create target must not exist yet.')
target = (args.target or root).resolve()
listing = subprocess.check_output(['git', 'worktree', 'list', '--porcelain', '-z'])
paths = [Path(os.fsdecode(block.split(b'\0', 1)[0][9:])) for block in listing.split(b'\0\0') if block]
if args.action == 'install' and (not target.is_dir() or target not in {path.resolve() for path in paths}):
    parser.error('The install target must be an existing registered worktree root.')
installed = []
for path in paths:
    dependency_dirs = [path / 'node_modules', *path.glob('packages/*/node_modules')]
    if any(directory.is_dir() and any(entry.name not in {'.cache', '.vite', '.vite-temp'} for entry in directory.iterdir()) for directory in dependency_dirs):
        installed.append(path.resolve())

projected_worktrees = len(paths) + (args.action == 'create')
projected_installed = len(installed) + (args.action == 'install' and target not in installed)
disk_path = next(path for path in [target, *target.parents] if path.exists())
free_bytes = shutil.disk_usage(disk_path).free
violations = []
if args.action in {'inspect', 'create'} and projected_worktrees > args.max_worktrees:
    violations.append('Reuse or clean an inactive worktree before creating another.')
if args.action in {'inspect', 'install'} and projected_installed > args.max_installed:
    violations.append('Reuse an installed worktree or remove inactive dependencies before installing.')
if free_bytes < args.min_free_gib * 1024**3:
    violations.append('Reclaim disk space before creating a worktree or installing dependencies.')
print(json.dumps({
    'action': args.action,
    'target': str(target),
    'allowed': not violations,
    'worktrees': len(paths),
    'installedWorktrees': len(installed),
    'projectedWorktrees': projected_worktrees,
    'projectedInstalledWorktrees': projected_installed,
    'freeGiB': round(free_bytes / 1024**3, 2),
    'limits': {'worktrees': args.max_worktrees, 'installedWorktrees': args.max_installed, 'minFreeGiB': args.min_free_gib},
    'violations': violations,
}, indent=2))
raise SystemExit(1 if violations else 0)
