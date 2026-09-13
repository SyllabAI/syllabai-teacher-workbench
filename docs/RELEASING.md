# Release & repository hygiene policy (R3-7)

## Releases

- Release bundles (source tarballs, dump objects, evidence archives) belong
  in **GitHub Releases**, never in git history. A release asset is
  immutable, hash-verifiable, and does not bloat clones.
- Tag convention: `t-c04-<milestone>-<slug>` on `SyllabAI/syllabai-core`
  (campaign series). Attach: evidence pack files, `SHA256SUMS`, and a
  release-notes body with claim labels.
- After upload, re-download EVERY asset and verify sha256 against the
  manifest before declaring durability VERIFIED.

## Git hygiene

- Large artifacts: `scripts/check-large-files.sh` fails >50MB, warns >5MB.
  Wire it into CI or run it before pushing.
- A pre-commit hook blocks release-bundle artifacts (`*.tar.gz`, `*.dump`,
  `*.dump.gz`) and reviewer-identity state
  (`reviewers.json`, `provisioning-log.jsonl`). Install with:
  `git config core.hooksPath scripts/hooks`
- Reviewer identity state and session secrets are NEVER versioned. They live
  only on the server, 0600, outside git (see REVIEWER-PROVISIONING.md in the
  R3-7 evidence pack).

## Historical exceptions (frozen, documented — do not rewrite)

- `download/evidence-r3-6-b/workbench-source-2f6e8a7.tar.gz` (60MB): swept
  into history by sandbox auto-commit `4c58b19`. Byte-identical to the R3-6
  release asset; contents already public in the repo. Left frozen to
  preserve commit-SHA stability; future tarballs are blocked by ignore rule
  and hook.
- `db/custom.db` (19.6MB empty scaffold sqlite): harmless; untrack it at the
  next convenient commit (`git rm --cached db/custom.db` + ignore rule).
