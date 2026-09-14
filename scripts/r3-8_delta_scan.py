#!/usr/bin/env python3
"""Compute the R3-8 delta: untracked+unignored files in the pre-reset snapshot
(/tmp/my-project) vs the fresh clone of remote main (c42ab03f)."""
import os, subprocess

SNAP = '/tmp/my-project'
CLONE = '/tmp/wb-clone'
PRUNE = {
    '.git', 'node_modules', '.next', 'jdk-25.0.4.1+1', 'skills', '.venv',
    '__pycache__', '.bun', '.local', '.cache', '.zscripts', 'upload',
    'tool-results', 'protective-snapshot-20260913', 'protective-snapshot-r3',
    'jdk25.tgz', 'tectonic', 'hsperfdata_root',
}

# 1) gather candidate untracked files from snapshot
cands = []
tracked = set()
out = subprocess.run(['git', 'ls-files', '-z'], capture_output=True, cwd=CLONE).stdout
for f in out.decode().split('\0'):
    if f:
        tracked.add(f)

for dp, dn, fn in os.walk(SNAP):
    rel = os.path.relpath(dp, SNAP)
    dn[:] = [d for d in dn if d not in PRUNE and not d.endswith('.d')]
    for f in fn:
        p = os.path.join(dp, f)
        r = os.path.relpath(p, SNAP)
        if r in tracked:
            continue
        try:
            sz = os.path.getsize(p)
        except OSError:
            continue
        cands.append((r, sz))

print(f'candidates before ignore-filter: {len(cands)}')

# 2) batch check-ignore (chunks to stay under ARG_MAX)
ignored = set()
CH = 500
for i in range(0, len(cands), CH):
    chunk = [c[0] for c in cands[i:i + CH]]
    r = subprocess.run(['git', 'check-ignore', '-z', '--stdin'], cwd=CLONE,
                       input='\0'.join(chunk).encode(), capture_output=True)
    for f in r.stdout.decode().split('\0'):
        if f:
            ignored.add(f)

final = sorted((sz, rel) for rel, sz in cands if rel not in ignored)
print(f'untracked + unignored: {len(final)}   (ignored skipped: {len(ignored)})')
for sz, rel in final:
    print(f'{sz:>10}  {rel}')
