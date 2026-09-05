// Pictures travelling as bytes rather than inside the payload.
//
// The point of the whole exercise is the first test: a photo record's payload
// must not contain the picture. Everything else guards the round trip that
// makes that safe.

import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { createIdbAdapter, type IdbAdapter } from '../adapter.js'
import { decodeDataUrl, encodeDataUrl, hashBytes, isBlobMarker } from '../blobs.js'
import type { RemoteChange } from '../../types.js'

const PHOTOS = 'yarn/photos'
const YARNS = 'yarn/yarns'
const META = 'sync/meta'
const STATE = 'sync/state'
const BLOBS = 'sync/blobs'

// A tiny but real JPEG-ish payload: enough bytes to be worth not duplicating.
const BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
const PHOTO_URL = encodeDataUrl('image/jpeg', BYTES)

let dbName = ''
let adapter: IdbAdapter

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      db.createObjectStore(PHOTOS, { keyPath: 'id' })
      db.createObjectStore(YARNS, { keyPath: 'id' })
      db.createObjectStore(META, { keyPath: 'key' })
      db.createObjectStore(STATE, { keyPath: 'key' })
      db.createObjectStore(BLOBS, { keyPath: 'hash' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function writeRecord(store: string, value: { id: string } & Record<string, unknown>, now: number): Promise<void> {
  const { markInTransaction } = await import('../adapter.js')
  const db = await open()
  const transaction = db.transaction([store, META], 'readwrite')
  transaction.objectStore(store).put(value)
  markInTransaction(transaction, META, store, value.id, now)
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
  db.close()
}

async function readRecord(store: string, id: string): Promise<Record<string, unknown> | undefined> {
  const db = await open()
  const transaction = db.transaction([store], 'readonly')
  const row = await new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
    const request = transaction.objectStore(store).get(id)
    request.onsuccess = () => resolve(request.result as Record<string, unknown> | undefined)
    request.onerror = () => reject(request.error)
  })
  db.close()
  return row
}

beforeEach(() => {
  dbName = `blobs-${Math.random().toString(36).slice(2)}`
  adapter = createIdbAdapter({
    app: 'yarnus',
    collections: [PHOTOS, YARNS],
    openDatabase: open,
    metaStore: META,
    stateStore: STATE,
    blobStore: BLOBS,
    binaryFields: { [PHOTOS]: 'dataUrl' },
  })
})

describe('data URLs', () => {
  it('round-trips bytes and mime', () => {
    const decoded = decodeDataUrl(PHOTO_URL)
    expect(decoded?.mime).toBe('image/jpeg')
    expect([...(decoded?.bytes ?? [])]).toEqual([...BYTES])
  })

  it('is not fooled by a plain string', () => {
    expect(decodeDataUrl('just text')).toBeNull()
    expect(decodeDataUrl(undefined)).toBeNull()
  })

  it('handles a payload larger than the argument limit', async () => {
    // A megabyte spread into String.fromCharCode blows the argument limit, and
    // a photo is exactly the size where that starts to happen.
    const big = new Uint8Array(300_000).fill(7)
    const url = encodeDataUrl('image/png', big)
    expect(decodeDataUrl(url)?.bytes.length).toBe(big.length)
  })
})

describe('pushing a picture', () => {
  it('does not put the picture in the payload', async () => {
    await writeRecord(PHOTOS, { id: 'p1', ownerId: 'y1', dataUrl: PHOTO_URL }, 1000)

    const [change] = await adapter.pending(50)
    const payload = JSON.parse(change?.payload ?? '{}')

    // The whole point. The server keeps twenty versions of every record.
    expect(payload.dataUrl).not.toContain('base64')
    expect(isBlobMarker(payload.dataUrl)).toBe(true)
    expect(change?.payload.length).toBeLessThan(200)
  })

  it('names the bytes by their content hash', async () => {
    await writeRecord(PHOTOS, { id: 'p1', dataUrl: PHOTO_URL }, 1000)

    const [change] = await adapter.pending(50)
    expect(change?.blobHashes).toEqual([await hashBytes(BYTES)])
  })

  it('caches the bytes so the engine can upload them', async () => {
    await writeRecord(PHOTOS, { id: 'p1', dataUrl: PHOTO_URL }, 1000)
    const [change] = await adapter.pending(50)

    const cached = await adapter.blobs?.read(change?.blobHashes[0] ?? '')
    expect([...(cached ?? [])]).toEqual([...BYTES])
    expect(await adapter.blobs?.has(change?.blobHashes[0] ?? '')).toBe(true)
  })

  it('gives two records of the same picture one hash', async () => {
    await writeRecord(PHOTOS, { id: 'p1', dataUrl: PHOTO_URL }, 1000)
    await writeRecord(PHOTOS, { id: 'p2', dataUrl: PHOTO_URL }, 2000)

    const changes = await adapter.pending(50)
    // Deduplication is what makes twenty retained versions affordable.
    expect(new Set(changes.flatMap((c) => c.blobHashes)).size).toBe(1)
  })

  it('leaves a record with no picture alone', async () => {
    await writeRecord(YARNS, { id: 'y1', name: 'Merino' }, 1000)

    const [change] = await adapter.pending(50)
    expect(change?.blobHashes).toEqual([])
    expect(JSON.parse(change?.payload ?? '{}').name).toBe('Merino')
  })

  it('leaves a photo record whose field is not a data URL alone', async () => {
    await writeRecord(PHOTOS, { id: 'p1', dataUrl: '' }, 1000)

    const [change] = await adapter.pending(50)
    expect(change?.blobHashes).toEqual([])
  })
})

describe('pulling a picture', () => {
  function remote(payload: string, seq = 1): RemoteChange {
    return {
      collection: PHOTOS,
      id: 'p9',
      seq,
      updatedAt: 5000,
      deviceId: 'other',
      deleted: false,
      payload,
      blobHashes: [],
    }
  }

  it('puts the picture back on the record', async () => {
    const hash = await hashBytes(BYTES)
    await open()
    await adapter.blobs?.write(hash, BYTES)

    await adapter.apply([
      remote(JSON.stringify({ id: 'p9', dataUrl: { $blob: hash, mime: 'image/jpeg' } })),
    ])

    const stored = await readRecord(PHOTOS, 'p9')
    // The app reads `photo.dataUrl` and never learned any of this happened.
    expect(stored?.dataUrl).toBe(PHOTO_URL)
  })

  it('stores the record without the picture when the bytes are missing', async () => {
    await open()
    await adapter.apply([
      remote(JSON.stringify({ id: 'p9', ownerId: 'y1', dataUrl: { $blob: 'a'.repeat(64), mime: 'image/jpeg' } })),
    ])

    const stored = await readRecord(PHOTOS, 'p9')
    // Failing the whole record over a missing thumbnail would strand the rest.
    expect(stored?.ownerId).toBe('y1')
    expect(stored?.dataUrl).toBeUndefined()
  })

  it('accepts a record from an older build with the picture still inline', async () => {
    await open()
    await adapter.apply([remote(JSON.stringify({ id: 'p9', dataUrl: PHOTO_URL }))])

    expect((await readRecord(PHOTOS, 'p9'))?.dataUrl).toBe(PHOTO_URL)
  })

  it('survives a full round trip through push and pull', async () => {
    await writeRecord(PHOTOS, { id: 'p1', ownerId: 'y1', dataUrl: PHOTO_URL }, 1000)
    const [change] = await adapter.pending(50)

    // Stand in for the server: it keeps the payload and the bytes separately.
    const bytes = await adapter.blobs?.read(change?.blobHashes[0] ?? '')

    // A second device, with its own empty database.
    dbName = `blobs-${Math.random().toString(36).slice(2)}`
    const other = createIdbAdapter({
      app: 'yarnus',
      collections: [PHOTOS, YARNS],
      openDatabase: open,
      metaStore: META,
      stateStore: STATE,
      blobStore: BLOBS,
      binaryFields: { [PHOTOS]: 'dataUrl' },
    })
    await open()
    await other.blobs?.write(change?.blobHashes[0] ?? '', bytes ?? new Uint8Array())

    await other.apply([
      {
        collection: PHOTOS,
        id: 'p1',
        seq: 1,
        updatedAt: 1000,
        deviceId: 'first',
        deleted: false,
        payload: change?.payload ?? '{}',
        blobHashes: change?.blobHashes ?? [],
      },
    ])

    expect((await readRecord(PHOTOS, 'p1'))?.dataUrl).toBe(PHOTO_URL)
  })
})
