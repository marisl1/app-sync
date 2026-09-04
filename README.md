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

await sync.pair('https://192.168.0.72:8443', 'PAIRCODE', 'Pixel')
const report = await sync.run()
```

`run()` never throws. Failures come back on the report, so a sync that could not
happen leaves the local database exactly as it was.

## The loop order matters

Pull, apply, push, settle — always in that order. Pulling first is what makes
`baseSeq` meaningful: a push then states the server version the client actually
saw, so the server can tell an ordinary edit apart from a real divergence.
Pushing first would make every concurrent edit look like a conflict.

## Implementing an adapter

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
