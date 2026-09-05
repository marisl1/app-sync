// The IndexedDB adapter's backfill.
//
// Backfill is the step that gets a library which predates sync onto the server,
// and it runs once, at pairing. Anything it silently skips is invisible: the
// sync reports success, the records simply never appear, and nothing anywhere
// says so.

import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { createIdbAdapter } from '../idb/index.js'

const META = 'sync/meta'
const STATE = 'sync/state'

/** ml-app's real shape: media/items keys on `id`, media/covers on `itemId`. */
const ITEMS = 'media/items'
const COVERS = 'media/covers'

let dbName = ''

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      db.createObjectStore(ITEMS, { keyPath: 'id' })
      db.createObjectStore(COVERS, { keyPath: 'itemId' })
      db.createObjectStore(META, { keyPath: 'key' })
      db.createObjectStore(STATE, { keyPath: 'key' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function put(store: string, record: object): Promise<void> {
  return new Promise((resolve, reject) => {
    void openDatabase().then((db) => {
      const transaction = db.transaction([store], 'readwrite')
      transaction.objectStore(store).put(record)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
  })
}

function adapter() {
  return createIdbAdapter({
    app: 'ml-app',
    collections: [ITEMS, COVERS],
    openDatabase,
    metaStore: META,
    stateStore: STATE,
  })
}

beforeEach(() => {
  dbName = `backfill-${Math.random().toString(36).slice(2)}`
})

describe('backfill', () => {
  it('queues records from a store keyed on id', async () => {
    await put(ITEMS, { id: 'i1', title: 'Supernatural' })
    expect(await adapter().backfill(1000)).toBe(1)
  })

  // The bug: media/covers keys on `itemId`, so reading `record.id` found
  // undefined and skipped every cover. 39 covers stayed on the phone, the
  // server showed none, and the count backfill returned still looked right
  // because the items and episodes beside them had queued fine.
  it('queues records from a store keyed on something other than id', async () => {
    await put(COVERS, { itemId: 'i1', dataUrl: 'data:image/png;base64,AAA' })
    expect(await adapter().backfill(1000)).toBe(1)
  })

  it('queues both kinds together', async () => {
    await put(ITEMS, { id: 'i1', title: 'Supernatural' })
    await put(COVERS, { itemId: 'i1', dataUrl: 'data:image/png;base64,AAA' })
    expect(await adapter().backfill(1000)).toBe(2)

    const pending = await adapter().pending(10)
    expect(pending.map((change) => change.collection).sort()).toEqual([COVERS, ITEMS])
    expect(pending.find((change) => change.collection === COVERS)?.id).toBe('i1')
  })

  it('is idempotent, so it is safe to run more than once', async () => {
    await put(ITEMS, { id: 'i1', title: 'Supernatural' })
    await put(COVERS, { itemId: 'i1', dataUrl: 'data:image/png;base64,AAA' })

    expect(await adapter().backfill(1000)).toBe(2)
    expect(await adapter().backfill(2000)).toBe(0)
  })

  it('queues only what is new when it runs again', async () => {
    await put(COVERS, { itemId: 'i1', dataUrl: 'data:image/png;base64,AAA' })
    expect(await adapter().backfill(1000)).toBe(1)

    await put(COVERS, { itemId: 'i2', dataUrl: 'data:image/png;base64,BBB' })
    expect(await adapter().backfill(2000)).toBe(1)
  })
})
