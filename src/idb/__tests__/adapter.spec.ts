// The adapter against a real IndexedDB implementation.
//
// A hand-written double would agree with whatever this file assumed, and the
// rules worth testing here — a tombstone surviving a pull, a pending edit not
// being overwritten — are exactly the ones a double would get wrong in the same
// direction as the code.

import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { createIdbAdapter, markInTransaction, type IdbAdapter } from '../adapter.js'
import type { RemoteChange } from '../../types.js'

const YARNS = 'yarn/yarns'
const META = 'sync/meta'
const STATE = 'sync/state'

let dbName = ''
let adapter: IdbAdapter

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      db.createObjectStore(YARNS, { keyPath: 'id' })
      db.createObjectStore(META, { keyPath: 'key' })
      db.createObjectStore(STATE, { keyPath: 'key' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/** What an app's own write path does: the record and its mark, one transaction. */
async function writeRecord(id: string, name: string, now: number): Promise<void> {
  const db = await open()
  const transaction = db.transaction([YARNS, META], 'readwrite')
  transaction.objectStore(YARNS).put({ id, name })
  markInTransaction(transaction, META, YARNS, id, now)
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
  db.close()
}

async function deleteRecord(id: string, now: number): Promise<void> {
  const db = await open()
  const transaction = db.transaction([YARNS, META], 'readwrite')
  transaction.objectStore(YARNS).delete(id)
  markInTransaction(transaction, META, YARNS, id, now, true)
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
  db.close()
}

async function readRecords(): Promise<{ id: string; name?: string }[]> {
  const db = await open()
  const transaction = db.transaction([YARNS], 'readonly')
  const rows = await new Promise<{ id: string; name?: string }[]>((resolve, reject) => {
    const request = transaction.objectStore(YARNS).getAll()
    request.onsuccess = () => resolve(request.result as { id: string; name?: string }[])
    request.onerror = () => reject(request.error)
  })
  db.close()
  return rows
}

function remote(id: string, seq: number, payload: string, deleted = false): RemoteChange {
  return {
    collection: YARNS,
    id,
    seq,
    updatedAt: 5000 + seq,
    deviceId: 'other',
    deleted,
    payload,
    blobHashes: [],
  }
}

beforeEach(() => {
  dbName = `test-${Math.random().toString(36).slice(2)}`
  adapter = createIdbAdapter({
    app: 'yarnus',
    collections: [YARNS],
    openDatabase: open,
    metaStore: META,
    stateStore: STATE,
  })
})

describe('pending', () => {
  it('is empty when nothing has been written', async () => {
    await open()
    expect(await adapter.pending(50)).toEqual([])
  })

  it('reports a written record with its payload', async () => {
    await writeRecord('y1', 'Merino', 1000)
    const [change] = await adapter.pending(50)

    expect(change?.id).toBe('y1')
    expect(change?.deleted).toBe(false)
    expect(JSON.parse(change?.payload ?? '{}')).toEqual({ id: 'y1', name: 'Merino' })
    expect(change?.baseSeq).toBe(0)
  })

  it('reports a delete as a tombstone even though the row is gone', async () => {
    await writeRecord('y1', 'Merino', 1000)
    await deleteRecord('y1', 2000)

    const [change] = await adapter.pending(50)
    expect(change?.deleted).toBe(true)
    expect(change?.id).toBe('y1')
  })

  it('sends the oldest edit first', async () => {
    await writeRecord('b', 'Second', 2000)
    await writeRecord('a', 'First', 1000)

    expect((await adapter.pending(50)).map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('honours the limit', async () => {
    await writeRecord('a', 'A', 1000)
    await writeRecord('b', 'B', 2000)
    expect(await adapter.pending(1)).toHaveLength(1)
  })
})

describe('apply', () => {
  it('writes a record from the server and leaves nothing pending', async () => {
    await open()
    await adapter.apply([remote('y9', 4, '{"id":"y9","name":"Alpaca"}')])

    expect(await readRecords()).toEqual([{ id: 'y9', name: 'Alpaca' }])
    expect(await adapter.pending(50)).toEqual([])
  })

  it('deletes a record the server says is gone', async () => {
    await writeRecord('y1', 'Merino', 1000)
    await adapter.settle([{ collection: YARNS, id: 'y1', outcome: 'applied', seq: 1 }])

    await adapter.apply([remote('y1', 2, '{}', true)])
    expect(await readRecords()).toEqual([])
  })

  it('does not overwrite an edit that has not been pushed', async () => {
    await writeRecord('y1', 'Mine', 9000)

    await adapter.apply([remote('y1', 3, '{"id":"y1","name":"Theirs"}')])

    // The local edit survives and is still queued; the server arbitrates on the
    // push, using the baseSeq this side kept.
    expect(await readRecords()).toEqual([{ id: 'y1', name: 'Mine' }])
    expect(await adapter.pending(50)).toHaveLength(1)
  })

  it('does not resurrect a record deleted just before the sync', async () => {
    // The bug this guard exists for: a client re-pulls its own writes, and the
    // returning copy used to overwrite the pending tombstone.
    await writeRecord('y1', 'Merino', 1000)
    await adapter.settle([{ collection: YARNS, id: 'y1', outcome: 'applied', seq: 1 }])
    await deleteRecord('y1', 2000)

    await adapter.apply([remote('y1', 1, '{"id":"y1","name":"Merino"}')])

    expect(await readRecords()).toEqual([])
    expect((await adapter.pending(50))[0]?.deleted).toBe(true)
  })

  it('ignores a collection this build does not know', async () => {
    await open()
    await adapter.apply([{ ...remote('x', 1, '{}'), collection: 'invented/store' }])
    expect(await readRecords()).toEqual([])
  })

  it('skips an unparseable payload without losing the rest of the page', async () => {
    await open()
    await adapter.apply([remote('bad', 1, 'not json'), remote('good', 2, '{"id":"good"}')])

    expect((await readRecords()).map((r) => r.id)).toEqual(['good'])
  })
})

describe('settle', () => {
  it('stops resending an accepted record and remembers its seq', async () => {
    await writeRecord('y1', 'Merino', 1000)
    await adapter.settle([{ collection: YARNS, id: 'y1', outcome: 'applied', seq: 7 }])

    expect(await adapter.pending(50)).toEqual([])

    await writeRecord('y1', 'Merino II', 2000)
    expect((await adapter.pending(50))[0]?.baseSeq).toBe(7)
  })

  it('stops resending a losing record too', async () => {
    await writeRecord('y1', 'Merino', 1000)
    await adapter.settle([{ collection: YARNS, id: 'y1', outcome: 'superseded', seq: 0 }])

    // Leaving it dirty would resend a losing edit on every sync, forever.
    expect(await adapter.pending(50)).toEqual([])
  })
})

describe('state', () => {
  it('round-trips and clears', async () => {
    await open()
    expect(await adapter.loadState()).toBeNull()

    await adapter.saveState({
      serverUrl: 'https://homeserver.lan:8443',
      deviceToken: 'tok',
      deviceId: 'dev',
      user: 'maris',
      cursor: 12,
    })

    expect(await adapter.loadState()).toMatchObject({ cursor: 12, user: 'maris' })

    await adapter.clearState()
    expect(await adapter.loadState()).toBeNull()
  })

  it('treats a device paired before users existed as having none', async () => {
    const db = await open()
    const transaction = db.transaction([STATE], 'readwrite')
    transaction
      .objectStore(STATE)
      .put({ key: 'state', serverUrl: 'https://s', deviceToken: 't', deviceId: 'd', cursor: 3 })
    await new Promise((resolve) => {
      transaction.oncomplete = resolve
    })
    db.close()

    expect((await adapter.loadState())?.user).toBe('')
  })
})

describe('backfill', () => {
  it('queues a library that predates sync', async () => {
    // Records written straight to the store, as an older build would have.
    const db = await open()
    const transaction = db.transaction([YARNS], 'readwrite')
    transaction.objectStore(YARNS).put({ id: 'old-1', name: 'Merino' })
    transaction.objectStore(YARNS).put({ id: 'old-2', name: 'Alpaca' })
    await new Promise((resolve) => {
      transaction.oncomplete = resolve
    })
    db.close()

    expect(await adapter.backfill(1000)).toBe(2)
    expect((await adapter.pending(50)).map((c) => c.id).sort()).toEqual(['old-1', 'old-2'])
  })

  it('is a no-op the second time', async () => {
    await writeRecord('y1', 'Merino', 1000)
    expect(await adapter.backfill(2000)).toBe(0)
  })

  it('does not disturb a record already settled', async () => {
    await writeRecord('y1', 'Merino', 1000)
    await adapter.settle([{ collection: YARNS, id: 'y1', outcome: 'applied', seq: 5 }])

    expect(await adapter.backfill(3000)).toBe(0)
    // It must not re-dirty a clean record or reset its seq.
    expect(await adapter.pending(50)).toEqual([])
  })
})
