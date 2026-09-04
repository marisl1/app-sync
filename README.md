# app-sync

Record-level sync client for the household apps that talk to
[`app-server`](https://github.com/marisl1/app-server).

Zero runtime dependencies. Its own repo because npm cannot install a
subdirectory of a git repository — depending on `app-server` would pull Fastify
and `node-windows` into every app build.

## Shape

Two halves with a narrow seam:

- **The engine** owns the protocol: pairing, the pull/push loop, cursors,
  conflict outcomes, blob transfer. Written once, ever.
- **The adapter** owns the database: which records changed, how to apply a
  remote change, where the cursor lives. Written once per app.

```ts
import { createSync } from 'app-sync'

const sync = createSync({ adapter })

await sync.pair('https://homeserver.lan:8443', 'PAIRCODE', 'Pixel')
const report = await sync.run()
```

`run()` never throws. Failures come back on the report, so a sync that could not
happen leaves the local database exactly as it was.

## The loop order matters

Pull, apply, push, settle — always in that order. Pulling first is what makes
`baseSeq` meaningful: a push then states the server version the client actually
saw, so the server can tell an ordinary edit apart from a real divergence.
Pushing first would make every concurrent edit look like a conflict.

## Using it with IndexedDB

Most apps do not need to implement an adapter at all.  has one,
written once for every app that stores records in IndexedDB:

\
The app supplies the opener rather than this package opening one, so nothing
here can trigger a migration.

Every write path that touches a synced store also calls ,
**in the same transaction as the record itself** — a record written without its
mark would never sync, and a mark without its record would push a row that is
not there.

Deletes are marked rather than dropped. The tombstone lives in the sync
metadata, not on the record, so the app's own queries never have to filter it
out and none of its existing code had to change.

 marks everything already stored, for a library that
predates sync. It is idempotent and never clears a dirty flag.

## Using it with IndexedDB

Most apps do not need to write an adapter at all. `app-sync/idb` has one,
written once for every app that stores records in IndexedDB:

```ts
import { createIdbAdapter, markInTransaction } from 'app-sync/idb'

const adapter = createIdbAdapter({
  app: 'yarnus',
  collections: ['yarn/yarns', 'yarn/skeins', 'yarn/photos'],
  openDatabase, // the app's own opener: it keeps control of schema and version
  metaStore: 'sync/meta',
  stateStore: 'sync/state',
})
```

The app supplies the opener rather than this package opening one, so nothing
here can trigger a migration.

Every write path that touches a synced store also calls `markInTransaction`,
**in the same transaction as the record itself** — a record written without its
mark would never sync, and a mark written without its record would push a row
that is not there.

Deletes are marked, not dropped. The tombstone lives in the sync metadata rather
than on the record, so the app's own queries never have to filter it out and
none of its existing code has to change.

`adapter.backfill()` marks everything already stored, for a library that
predates sync. It is idempotent and never clears a dirty flag.

## Implementing an adapter by hand by hand

See `SyncAdapter` in `src/types.ts`. The contract is deliberately small, because
everything on that side is written once per app.

Blobs are optional: an app with no pictures never implements `blobs`, and the
engine simply never has a hash to move.

## Tests

```bash
npm test
```

The engine is tested against a fake adapter and a stub fetch. The protocol
itself is covered by a contract test in `app-server`, which drives this package
against a real server on a real database — no mocks on either side.

## Why `dist/` is committed

Because this is installed straight from git, and a git dependency that builds
itself on install is only as reliable as the install actually running its
`prepare` script. On Vercel it did not: the build was handed a `dist/` from an
older commit and failed with `"startLive" is not exported by
app-sync/dist/index.js` — an error that points squarely at the consuming app and
says nothing at all about the stale artifact behind it.

So the build output is checked in, and the package needs no build step to be
usable. `pretest` rebuilds it, so running the tests before a commit — the habit
here anyway — keeps `dist/` from drifting away from `src/`.
