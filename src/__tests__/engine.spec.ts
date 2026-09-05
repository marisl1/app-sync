import { beforeEach, describe, expect, it } from 'vitest'
import { createSync } from '../engine.js'
import type {
  BlobStore,
  LocalChange,
  RemoteChange,
  SettleResult,
  SyncAdapter,
  SyncState,
} from '../types.js'

/**
 * A adapter that records what the engine asked it to do. Deliberately not a
 * mock library: the assertions are about the order and content of those calls,
 * and a hand-written double makes that readable.
 */
class FakeAdapter implements SyncAdapter {
  readonly app = 'yarnus'
  state: SyncState | null = {
    serverUrl: 'https://server:8443',
    deviceToken: 'tok',
    deviceId: 'dev',
    user: 'home',
    cursor: 0,
  }
  queue: LocalChange[] = []
  applied: RemoteChange[][] = []
  settled: SettleResult[] = []
  calls: string[] = []
  blobs?: BlobStore

  async pending(limit: number): Promise<LocalChange[]> {
    this.calls.push('pending')
    return this.queue.splice(0, limit)
  }
  async apply(changes: RemoteChange[]): Promise<void> {
    this.calls.push('apply')
    this.applied.push(changes)
  }
  async settle(results: SettleResult[]): Promise<void> {
    this.calls.push('settle')
    this.settled.push(...results)
  }
  async loadState(): Promise<SyncState | null> {
    return this.state
  }
  async saveState(state: SyncState): Promise<void> {
    this.state = state
  }
  async clearState(): Promise<void> {
    this.state = null
  }

  backfilled = 0
  async backfill(): Promise<number> {
    this.calls.push('backfill')
    this.backfilled += 1
    return 0
  }
}

class FakeBlobs implements BlobStore {
  held = new Map<string, Uint8Array>()
  async read(hash: string): Promise<Uint8Array | null> {
    return this.held.get(hash) ?? null
  }
  async write(hash: string, bytes: Uint8Array): Promise<void> {
    this.held.set(hash, bytes)
  }
  async has(hash: string): Promise<boolean> {
    return this.held.has(hash)
  }
}

interface Route {
  status?: number
  body?: unknown
  bytes?: Uint8Array
}

/** A stub fetch driven by a table of `METHOD /path` → response. */
function stubFetch(routes: Record<string, Route | Route[]>, log: string[] = []) {
  const counters = new Map<string, number>()

  return {
    log,
    fetch: async (input: string, init?: RequestInit): Promise<Response> => {
      const method = (init?.method ?? 'GET').toUpperCase()
      const url = new URL(input)
      const key = `${method} ${url.pathname}${url.search}`
      log.push(key)

      const loose = `${method} ${url.pathname}`
      const entry = routes[key] ?? routes[loose]
      if (entry === undefined) {
        return new Response(JSON.stringify({ error: `no stub for ${key}` }), { status: 500 })
      }

      let route: Route
      if (Array.isArray(entry)) {
        const seen = counters.get(loose) ?? 0
        counters.set(loose, seen + 1)
        route = entry[Math.min(seen, entry.length - 1)] as Route
      } else {
        route = entry
      }

      const status = route.status ?? 200
      if (route.bytes !== undefined) {
        return new Response(route.bytes as BodyInit, { status })
      }
      return new Response(route.body === undefined ? '{}' : JSON.stringify(route.body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    },
  }
}

function remote(id: string, seq: number, payload = '{"v":1}'): RemoteChange {
  return {
    collection: 'yarn/yarns',
    id,
    seq,
    updatedAt: 100 + seq,
    deviceId: 'other',
    deleted: false,
    payload,
    blobHashes: [],
  }
}

function local(id: string, baseSeq = 0, blobHashes: string[] = []): LocalChange {
  return {
    collection: 'yarn/yarns',
    id,
    updatedAt: 500,
    deleted: false,
    payload: '{"local":true}',
    blobHashes,
    baseSeq,
  }
}

let adapter: FakeAdapter

beforeEach(() => {
  adapter = new FakeAdapter()
})

describe('pairing', () => {
  it('stores the token and starts the cursor at zero', async () => {
    adapter.state = null
    const { fetch } = stubFetch({
      'POST /api/pair': { body: { deviceId: 'd1', token: 't1', user: 'maris' } },
    })

    const sync = createSync({ adapter, fetch })
    const state = await sync.pair('https://server:8443/', 'CODE', 'Pixel', 'Maris')

    expect(state.deviceToken).toBe('t1')
    // A fresh device pulls everything before it pushes, so it adopts an
    // existing library rather than fighting it.
    expect(state.cursor).toBe(0)
    // The server's normalised form of what was typed, not the raw input:
    // "Maris" and "maris " have to be the same person.
    expect(state.user).toBe('maris')
    // The trailing slash is normalised away or every path becomes `//api/...`.
    expect(state.serverUrl).toBe('https://server:8443')
    expect((await adapter.loadState())?.deviceToken).toBe('t1')
  })

  it('reports a wrong code plainly instead of asking to pair again', async () => {
    adapter.state = null
    const { fetch } = stubFetch({ 'POST /api/pair': { status: 401 } })

    await expect(createSync({ adapter, fetch }).pair('https://s', 'BAD', 'Pixel', 'maris')).rejects.toThrow(
      /not right/i,
    )
  })

  it('knows when it has not been paired', async () => {
    adapter.state = null
    expect(await createSync({ adapter, fetch: stubFetch({}).fetch }).isPaired()).toBe(false)
  })
})

describe('run', () => {
  it('refuses to sync before pairing, without calling the network', async () => {
    adapter.state = null
    const { fetch, log } = stubFetch({})

    const report = await createSync({ adapter, fetch }).run()

    expect(report.ok).toBe(false)
    expect(report.error).toMatch(/not paired/i)
    expect(log).toEqual([])
  })

  it('pulls before it pushes', async () => {
    adapter.queue = [local('local-1')]
    const { fetch } = stubFetch({
      'GET /api/yarnus/changes?since=0&limit=500': {
        body: { changes: [remote('a', 1)], seq: 1, hasMore: false },
      },
      'GET /api/yarnus/changes?since=1&limit=500': {
        body: { changes: [], seq: 1, hasMore: false },
      },
      'POST /api/yarnus/changes': {
        body: { results: [{ collection: 'yarn/yarns', id: 'local-1', outcome: 'applied', seq: 2 }], seq: 2 },
      },
    })

    await createSync({ adapter, fetch }).run()

    // Pushing first would make every ordinary edit look like a divergence.
    expect(adapter.calls.indexOf('apply')).toBeLessThan(adapter.calls.indexOf('pending'))
  })

  it('authenticates every request, not just the writes', async () => {
    // Pull once went out with no Authorization header. The server answered 401,
    // the engine read that as "this device was forgotten", cleared the pairing,
    // and every sync failed while un-pairing the app. The stub records headers
    // so that cannot come back unnoticed.
    const seen: (string | undefined)[] = []
    const sync = createSync({
      adapter,
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers)
        seen.push(headers.get('authorization') ?? undefined)
        return new Response(JSON.stringify({ changes: [], seq: 0, hasMore: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    })

    await sync.run()

    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((value) => value === 'Bearer tok')).toBe(true)
  })

  it('advances the cursor only after a page is applied', async () => {
    const { fetch } = stubFetch({
      'GET /api/yarnus/changes?since=0&limit=500': {
        body: { changes: [remote('a', 1), remote('b', 2)], seq: 2, hasMore: false },
      },
      'GET /api/yarnus/changes?since=2&limit=500': {
        body: { changes: [], seq: 2, hasMore: false },
      },
    })

    const report = await createSync({ adapter, fetch }).run()

    expect(report.pulled).toBe(2)
    expect(report.cursor).toBe(2)
    expect(adapter.state?.cursor).toBe(2)
  })

  it('follows hasMore through several pages', async () => {
    const { fetch, log } = stubFetch({
      'GET /api/yarnus/changes?since=0&limit=500': {
        body: { changes: [remote('a', 1)], seq: 3, hasMore: true },
      },
      'GET /api/yarnus/changes?since=1&limit=500': {
        body: { changes: [remote('b', 2)], seq: 3, hasMore: false },
      },
    })

    const report = await createSync({ adapter, fetch }).run()

    expect(report.pulled).toBe(2)
    expect(log.filter((l) => l.startsWith('GET /api/yarnus/changes')).length).toBe(2)
  })

  it('counts each push outcome separately', async () => {
    adapter.queue = [local('a'), local('b'), local('c')]
    const { fetch } = stubFetch({
      'GET /api/yarnus/changes': { body: { changes: [], seq: 0, hasMore: false } },
      'POST /api/yarnus/changes': {
        body: {
          results: [
            { collection: 'yarn/yarns', id: 'a', outcome: 'applied', seq: 1 },
            { collection: 'yarn/yarns', id: 'b', outcome: 'superseded', seq: 0 },
            { collection: 'yarn/yarns', id: 'c', outcome: 'conflict', seq: 2 },
          ],
          seq: 2,
        },
      },
    })

    const report = await createSync({ adapter, fetch }).run()

    expect(report.pushed).toBe(3)
    expect(report.superseded).toBe(1)
    expect(report.conflicts).toBe(1)
    expect(report.ok).toBe(true)
    expect(adapter.settled).toHaveLength(3)
  })

  it('hands every outcome to the adapter so baseSeq can be updated', async () => {
    adapter.queue = [local('a')]
    const { fetch } = stubFetch({
      'GET /api/yarnus/changes': { body: { changes: [], seq: 0, hasMore: false } },
      'POST /api/yarnus/changes': {
        body: { results: [{ collection: 'yarn/yarns', id: 'a', outcome: 'applied', seq: 7 }], seq: 7 },
      },
    })

    await createSync({ adapter, fetch }).run()

    expect(adapter.settled[0]).toEqual({
      collection: 'yarn/yarns',
      id: 'a',
      outcome: 'applied',
      seq: 7,
    })
  })

  it('stops and clears pairing when the token is refused', async () => {
    const { fetch } = stubFetch({ 'GET /api/yarnus/changes': { status: 401 } })

    const report = await createSync({ adapter, fetch }).run()

    expect(report.ok).toBe(false)
    // Keeping a dead token would fail forever without ever saying why.
    expect(adapter.state).toBeNull()
  })

  it('reports an unreachable server without throwing', async () => {
    const sync = createSync({
      adapter,
      fetch: async () => {
        throw new TypeError('network down')
      },
    })

    const report = await sync.run()

    expect(report.ok).toBe(false)
    expect(report.error).toMatch(/could not reach/i)
    // The local database is untouched, and the edits go next time.
    expect(adapter.state).not.toBeNull()
  })

  it('leaves pending work alone when the pull fails', async () => {
    adapter.queue = [local('a')]
    const { fetch } = stubFetch({ 'GET /api/yarnus/changes': { status: 500, body: { error: 'boom' } } })

    const report = await createSync({ adapter, fetch }).run()

    expect(report.ok).toBe(false)
    expect(adapter.calls).not.toContain('pending')
  })
})

describe('blobs', () => {
  beforeEach(() => {
    adapter.blobs = new FakeBlobs()
  })

  it('uploads bytes the server lacks before pushing the record', async () => {
    const blobs = adapter.blobs as FakeBlobs
    blobs.held.set('h1', new Uint8Array([1, 2, 3]))
    adapter.queue = [local('a', 0, ['h1'])]

    const { fetch, log } = stubFetch({
      'GET /api/yarnus/changes': { body: { changes: [], seq: 0, hasMore: false } },
      'HEAD /api/blobs/h1': { status: 404 },
      'POST /api/blobs': { body: { hash: 'h1', size: 3, created: true } },
      'POST /api/yarnus/changes': {
        body: { results: [{ collection: 'yarn/yarns', id: 'a', outcome: 'applied', seq: 1 }], seq: 1 },
      },
    })

    const report = await createSync({ adapter, fetch }).run()

    expect(report.blobsUploaded).toBe(1)
    // A record pushed first could name bytes the server cannot serve, and every
    // other device would pull a broken reference.
    expect(log.indexOf('POST /api/blobs')).toBeLessThan(log.indexOf('POST /api/yarnus/changes'))
  })

  it('skips bytes the server already holds', async () => {
    const blobs = adapter.blobs as FakeBlobs
    blobs.held.set('h1', new Uint8Array([1]))
    adapter.queue = [local('a', 0, ['h1'])]

    const { fetch, log } = stubFetch({
      'GET /api/yarnus/changes': { body: { changes: [], seq: 0, hasMore: false } },
      'HEAD /api/blobs/h1': { status: 200 },
      'POST /api/yarnus/changes': {
        body: { results: [{ collection: 'yarn/yarns', id: 'a', outcome: 'applied', seq: 1 }], seq: 1 },
      },
    })

    const report = await createSync({ adapter, fetch }).run()

    expect(report.blobsUploaded).toBe(0)
    expect(log).not.toContain('POST /api/blobs')
  })

  it('downloads bytes referenced by a pulled record', async () => {
    const blobs = adapter.blobs as FakeBlobs
    const pulled = { ...remote('a', 1), blobHashes: ['h9'] }

    const { fetch } = stubFetch({
      'GET /api/yarnus/changes?since=0&limit=500': {
        body: { changes: [pulled], seq: 1, hasMore: false },
      },
      'GET /api/yarnus/changes?since=1&limit=500': {
        body: { changes: [], seq: 1, hasMore: false },
      },
      'GET /api/blobs/h9': { bytes: new Uint8Array([9, 9]) },
    })

    await createSync({ adapter, fetch }).run()

    expect([...(await blobs.read('h9'))!]).toEqual([9, 9])
  })

  it('applies a record whose blob the server does not have', async () => {
    const pulled = { ...remote('a', 1), blobHashes: ['gone'] }

    const { fetch } = stubFetch({
      'GET /api/yarnus/changes?since=0&limit=500': {
        body: { changes: [pulled], seq: 1, hasMore: false },
      },
      'GET /api/yarnus/changes?since=1&limit=500': {
        body: { changes: [], seq: 1, hasMore: false },
      },
      'GET /api/blobs/gone': { status: 404 },
    })

    const report = await createSync({ adapter, fetch }).run()

    // The picture is missing; the record is not. Failing the whole pull over a
    // thumbnail would strand everything else.
    expect(report.ok).toBe(true)
    expect(adapter.applied[0]).toHaveLength(1)
  })
})

// Backfill used to run only at pairing. That left an already-paired device with
// no way to queue anything it had not queued then — which is exactly what
// happened to ml-app's cover images: they were skipped by a backfill bug, and
// after it was fixed there was still nothing that would run it again.
describe('backfill on run', () => {
  it('queues unsynced records before pushing', async () => {
    const { fetch } = stubFetch({
      'GET /api/yarnus/changes': { body: { changes: [], seq: 0, hasMore: false } },
    })
    await createSync({ adapter, fetch }).run()

    expect(adapter.backfilled).toBe(1)
    expect(adapter.calls.indexOf('backfill')).toBeLessThan(adapter.calls.indexOf('pending'))
  })

  it('runs once per session, not on every tick of the auto-sync loop', async () => {
    const { fetch } = stubFetch({
      'GET /api/yarnus/changes': { body: { changes: [], seq: 0, hasMore: false } },
    })
    const sync = createSync({ adapter, fetch })

    await sync.run()
    await sync.run()
    await sync.run()

    expect(adapter.backfilled).toBe(1)
  })

  it('does not run for an unpaired app, which has nowhere to send anything', async () => {
    adapter.state = null
    const { fetch } = stubFetch({
      'GET /api/yarnus/changes': { body: { changes: [], seq: 0, hasMore: false } },
    })
    await createSync({ adapter, fetch }).run()

    expect(adapter.backfilled).toBe(0)
  })

  it('still syncs when the adapter has no backfill at all', async () => {
    const plain: SyncAdapter = {
      app: 'yarnus',
      pending: async () => [],
      apply: async () => undefined,
      settle: async () => undefined,
      loadState: async () => adapter.state,
      saveState: async () => undefined,
      clearState: async () => undefined,
    }

    const { fetch } = stubFetch({
      'GET /api/yarnus/changes': { body: { changes: [], seq: 0, hasMore: false } },
    })
    expect((await createSync({ adapter: plain, fetch }).run()).ok).toBe(true)
  })
})
