# Review fixes — app-sync

2026-11-10. From a code review of every household repository. This is the fix
the rest wait on: every syncing app inherits it by taking the new version.

The review ran `npm test` (79 pass) and `npm run typecheck` (clean), and checked
that the committed `dist/` matches a fresh build.

## 1. A losing edit is never replaced

A device whose edit loses a conflict keeps showing its own version for good,
while the server and every other device hold the winner. Nothing reports it.

How it happens, in one `run()`:

1. Device A has a pending edit to a record. Device B's newer edit is already on
   the server at seq 9.
2. A pulls. `acceptsRemote` skips the record because it is dirty, and the
   cursor moves past 9.
3. A pushes with its old `baseSeq`. The server answers `superseded`.
4. `settledMeta` clears `dirty` and keeps the old seq. Its comment says the
   winner "arrives on the next pull" — it does not, because the cursor is
   already past it.

Reproduced with the real client (`dist/`) against app-server's store: after two
runs A still showed its older edit, with `ok: true` and nothing left to pull.

The fix, in `src/engine.ts`:

- In `push`, collect the results whose outcome is `superseded`. The server
  returns the record's current seq with each.
- After the push loop, if there are any, set the cursor to the lowest of those
  seqs minus one (never above where it is) and pull again, once. The records
  are clean by then, so `apply` takes the server's copy.
- Count those re-pulled records in the report as `pulled`, so an app's
  sync-arrival listener redraws.
- Correct the comment on `settledMeta` in `src/idb/meta.ts`.

Replaying the pages in between is harmless: `apply` writes by key and still
skips anything dirty.

Tests:

- `engine.spec.ts`: a fake transport where the pull page carries the winner and
  the push answers `superseded`; after one `run()` the adapter has been asked to
  apply the winner with the record clean.
- `adapter.spec.ts`: after `settle` with `superseded` and a second `apply` of
  the same change, the stored record is the server's.
- Prove both by removing the re-pull and watching them fail.

An alternative considered: have app-server return the winning record in the
push response. It saves a request but changes the protocol on both sides; the
re-pull needs no server change.

## 2. A lost push response logs a conflict

When a push is applied but its response never arrives, the next run re-sends
the change with the old `baseSeq`, and the server treats it as a divergence
against itself. The fix is on the server (app-server's plan, fix 3: recognise a
replay and answer `applied`). Nothing changes here, but add an `engine.spec.ts`
case that documents the retry so the two sides stay in step.

## 3. Release

- Bump `version` to 0.4.0. npm decides an installed git dependency is current
  by version, never by commit.
- `npm run build` and commit `dist/`.
- Then each app takes it: yarnus, filamentus, receptus, puzzlus, snagus,
  pantrius, lithophanus, media-tracker, bunny-match, ml-app, factorius.

## 4. CI

This repo has no workflow. Add `.github/workflows/ci.yml` running `npm ci`,
`npm run typecheck`, `npm test`, and a check that `npm run build` leaves `dist/`
unchanged, on every push and pull request.
