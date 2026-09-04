// An adapter over IndexedDB, written once for every app that uses one.
//
// The three household apps share a hand-copied `lib/idb` layer, so what differs
// between them is the app's name, which stores sync, and where the bookkeeping
// lives. That is configuration, not code — and keeping it as code would mean
// finding the same bug three times. The pending-edit guard below was found
// once, in yarnus, and every app gets it for nothing.
//
// The app supplies a database opener rather than this module opening one: the
// app owns its schema, its version and its upgrade path, and nothing here
// should be able to trigger a migration.

import type {
  BlobStore,
  LocalChange,
  RemoteChange,
  SettleResult,
  SyncAdapter,
  SyncState,
} from '../types.js'
import { acceptsRemote, metaKey, nextMeta, remoteMeta, settledMeta, type SyncMeta } from './meta.js'
import {
  decodeDataUrl,
  encodeDataUrl,
  hashBytes,
  isBlobMarker,
  type BlobMarker,
} from './blobs.js'

const STATE_KEY = 'state'

export interface IdbAdapterOptions {
  /** The name the server knows this app by, e.g. `yarnus`. */
  app: string
  /** Object stores whose records travel. Never the bookkeeping stores. */
  collections: readonly string[]
  /** The app's own opener, so it keeps control of schema and version. */
  openDatabase: () => Promise<IDBDatabase>
  /** Store holding one `SyncMeta` per record, keyed `key`. */
  metaStore: string
  /** Store holding the single sync state row, keyed `key`. */
  stateStore: string
  /**
   * Fields holding a data URL, by collection — e.g. `{ 'yarn/photos': 'dataUrl' }`.
   *
   * Named fields travel as content-addressed bytes instead of inside the
   * payload, so twenty retained versions of a photo record cost one copy of the
   * picture rather than twenty. Requires `blobStore`.
   */
  binaryFields?: Record<string, string>
  /**
   * Store caching those bytes locally, keyed `hash`, holding `{ hash, dataUrl }`.
   *
   * Marked `local: true` in the app's schema: it is derived from records that
   * are themselves backed up, so backing it up too would store every picture
   * twice.
   */
  blobStore?: string
  blobs?: BlobStore
}

interface StoredState extends SyncState {
  key: string
}

function request<T>(source: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    source.onsuccess = () => resolve(source.result)
    source.onerror = () => reject(source.error ?? new Error('IndexedDB request failed.'))
  })
}

/** Resolves once the transaction has committed, so callers know it is durable. */
function committed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('Transaction failed.'))
    transaction.onabort = () => reject(transaction.error ?? new Error('Transaction aborted.'))
  })
}

/**
 * Records a local write inside a transaction the caller already owns.
 *
 * The same transaction as the record itself, deliberately: a record written
 * without its mark would never sync, and a mark written without its record
 * would push a row that is not there. Apps call this from every write path that
 * touches a synced store.
 */
export function markInTransaction(
  transaction: IDBTransaction,
  metaStore: string,
  collection: string,
  id: string,
  now: number,
  deleted = false,
): void {
  const store = transaction.objectStore(metaStore)
  const read = store.get(metaKey(collection, id))

  read.onsuccess = () => {
    store.put(nextMeta(read.result as SyncMeta | undefined, collection, id, now, deleted))
  }

  announceOnCommit(transaction)
}

/** Listeners for "this device just wrote something that needs to travel". */
const localListeners = new Set<() => void>()

/** Transactions already being watched, so a batch of marks announces once. */
const announced = new WeakSet<IDBTransaction>()

/**
 * Fires the local-change listeners once this transaction commits.
 *
 * **On commit, not on the mark.** A mark in a transaction that later aborts did
 * not happen, and announcing it would start a sync that pushes nothing and
 * reports success — the kind of thing that looks like it works until the day
 * you check.
 *
 * `addEventListener` rather than `oncomplete`, because the app almost certainly
 * set that itself and this must not quietly replace it.
 */
function announceOnCommit(transaction: IDBTransaction): void {
  if (announced.has(transaction)) {
    return
  }
  announced.add(transaction)

  // A real IDBTransaction is an EventTarget, so this is the path that runs in
  // every browser. Test doubles are often just `{ objectStore, oncomplete }`,
  // and throwing at them would make this change break suites in apps that never
  // asked for automatic sync.
  if (typeof transaction.addEventListener !== 'function') {
    return
  }

  transaction.addEventListener('complete', () => {
    for (const listener of localListeners) {
      try {
        listener()
      } catch {
        // A broken listener must not take down the write that triggered it.
      }
    }
  })
}

/**
 * Called whenever this device writes to a synced store. Returns an unsubscribe.
 *
 * Hung off `markInTransaction` rather than asked of each app, so automatic sync
 * covers every write path that already syncs at all. An app cannot add a new
 * write that pushes but does not trigger, because the mark is what makes it
 * push in the first place.
 */
export function onLocalChange(listener: () => void): () => void {
  localListeners.add(listener)
  return () => localListeners.delete(listener)
}

interface CachedBlob {
  hash: string
  /** Kept as a data URL, not bytes: a Uint8Array comes back from JSON as {}. */
  dataUrl: string
}

export class IdbAdapter implements SyncAdapter {
  readonly app: string
  readonly blobs?: BlobStore

  constructor(private readonly options: IdbAdapterOptions) {
    this.app = options.app

    if (options.blobs !== undefined) {
      this.blobs = options.blobs
    } else if (options.blobStore !== undefined) {
      this.blobs = this.cacheStore(options.blobStore)
    }
  }

  /** The engine's view of the local byte cache. */
  private cacheStore(store: string): BlobStore {
    const open = () => this.options.openDatabase()

    return {
      has: async (hash) => {
        const db = await open()
        const transaction = db.transaction([store], 'readonly')
        const row = await request<CachedBlob | undefined>(
          transaction.objectStore(store).get(hash) as IDBRequest<CachedBlob | undefined>,
        )
        await committed(transaction)
        return row !== undefined
      },
      read: async (hash) => {
        const db = await open()
        const transaction = db.transaction([store], 'readonly')
        const row = await request<CachedBlob | undefined>(
          transaction.objectStore(store).get(hash) as IDBRequest<CachedBlob | undefined>,
        )
        await committed(transaction)
        return row === undefined ? null : (decodeDataUrl(row.dataUrl)?.bytes ?? null)
      },
      write: async (hash, bytes) => {
        const db = await open()
        const transaction = db.transaction([store], 'readwrite')
        // The mime is not known here — the engine only moves bytes. It is
        // recovered from the marker when the record is applied, so what is
        // cached is a plain octet-stream data URL and the record gets the
        // right type put back on it.
        transaction
          .objectStore(store)
          .put({ hash, dataUrl: encodeDataUrl('application/octet-stream', bytes) })
        await committed(transaction)
      },
    }
  }

  private binaryField(collection: string): string | undefined {
    return this.options.binaryFields?.[collection]
  }

  private syncs(collection: string): boolean {
    return this.options.collections.includes(collection)
  }

  async pending(limit: number): Promise<LocalChange[]> {
    const db = await this.options.openDatabase()
    const { metaStore } = this.options

    const all = await (async () => {
      const transaction = db.transaction([metaStore], 'readonly')
      const rows = request<SyncMeta[]>(
        transaction.objectStore(metaStore).getAll() as IDBRequest<SyncMeta[]>,
      )
      await committed(transaction)
      return rows
    })()

    // Oldest edit first, so a long backlog goes out in the order it happened
    // and the server's version history reads the way the user's day did.
    const dirty = (await all)
      .filter((meta) => meta.dirty)
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, limit)

    if (dirty.length === 0) {
      return []
    }

    const stores = [...new Set(dirty.map((meta) => meta.collection))].filter((c) => this.syncs(c))
    const changes: LocalChange[] = []

    const transaction = db.transaction(stores.length === 0 ? [metaStore] : stores, 'readonly')
    const reads = dirty.map((meta) =>
      meta.deleted || !this.syncs(meta.collection)
        ? Promise.resolve(undefined)
        : request<unknown>(transaction.objectStore(meta.collection).get(meta.id)),
    )
    const records = await Promise.all(reads)
    await committed(transaction)

    for (const [index, meta] of dirty.entries()) {
      if (meta.deleted) {
        changes.push({
          collection: meta.collection,
          id: meta.id,
          updatedAt: meta.updatedAt,
          deleted: true,
          // The row is gone, so there is nothing to send but the fact of it.
          payload: '{}',
          blobHashes: [],
          baseSeq: meta.seq,
        })
        continue
      }

      const record = records[index]
      if (record === undefined) {
        // Marked dirty but no longer there, and not marked deleted either — a
        // torn write from an older build. Skipping it is safer than pushing an
        // empty record over a good one on another device.
        continue
      }

      const { payload, blobHashes } = await this.detach(meta.collection, record)

      changes.push({
        collection: meta.collection,
        id: meta.id,
        updatedAt: meta.updatedAt,
        deleted: false,
        payload,
        blobHashes,
        baseSeq: meta.seq,
      })
    }

    return changes
  }

  /**
   * Replaces a record's data-URL field with a marker naming its content hash,
   * caching the bytes so the engine can upload them.
   *
   * Returns the record untouched when the collection has no binary field, or
   * when the field does not hold a data URL — a record written by an older
   * build, or one that already carries a marker because it came from the
   * server and has not been re-saved since.
   */
  private async detach(
    collection: string,
    record: unknown,
  ): Promise<{ payload: string; blobHashes: string[] }> {
    const field = this.binaryField(collection)
    const store = this.options.blobStore

    if (field === undefined || store === undefined || typeof record !== 'object' || record === null) {
      return { payload: JSON.stringify(record), blobHashes: [] }
    }

    const value = (record as Record<string, unknown>)[field]

    // Already a marker: this record came down from the server and nothing here
    // has changed it, so it is pushed back exactly as it arrived.
    if (isBlobMarker(value)) {
      return { payload: JSON.stringify(record), blobHashes: [value.$blob] }
    }

    const decoded = decodeDataUrl(value)
    if (decoded === null) {
      return { payload: JSON.stringify(record), blobHashes: [] }
    }

    const hash = await hashBytes(decoded.bytes)

    const db = await this.options.openDatabase()
    const transaction = db.transaction([store], 'readwrite')
    // Cached with its real mime, so a record applied on this device gets the
    // right type back rather than octet-stream.
    transaction.objectStore(store).put({ hash, dataUrl: value as string } satisfies CachedBlob)
    await committed(transaction)

    const marker: BlobMarker = { $blob: hash, mime: decoded.mime }
    return {
      payload: JSON.stringify({ ...(record as Record<string, unknown>), [field]: marker }),
      blobHashes: [hash],
    }
  }

  /**
   * Applies a batch from the server.
   *
   * One transaction over every store involved, so a page lands whole. A
   * half-applied page with an advanced cursor would leave records the client
   * believes it has and never asks for again.
   *
   * A record with a local edit still waiting to go is left alone — see
   * `acceptsRemote`.
   */
  async apply(changes: RemoteChange[]): Promise<void> {
    if (changes.length === 0) {
      return
    }

    const db = await this.options.openDatabase()
    const { metaStore, blobStore } = this.options
    const stores = [...new Set(changes.map((c) => c.collection))].filter((c) => this.syncs(c))

    // Markers are resolved before the write transaction opens: reading the byte
    // cache is itself a transaction, and IndexedDB commits an idle one the
    // moment control returns to the event loop.
    const resolved = new Map<string, unknown>()
    for (const change of changes) {
      if (change.deleted || !this.syncs(change.collection)) {
        continue
      }
      const record = await this.attach(change)
      if (record !== undefined) {
        resolved.set(`${change.collection}/${change.id}`, record)
      }
    }

    const transaction = db.transaction(
      blobStore === undefined ? [...stores, metaStore] : [...stores, metaStore],
      'readwrite',
    )
    const meta = transaction.objectStore(metaStore)

    for (const change of changes) {
      if (!this.syncs(change.collection)) {
        // A collection this build does not know about — a newer app version
        // syncing to the same server. Storing it nowhere is better than
        // guessing which store it belongs in.
        continue
      }

      let parsed: unknown
      if (!change.deleted) {
        parsed = resolved.get(`${change.collection}/${change.id}`)
        if (parsed === undefined) {
          // Unparseable payload: skip the record rather than abort the page and
          // stall every later change behind it.
          continue
        }
      }

      const read = meta.get(metaKey(change.collection, change.id))
      read.onsuccess = () => {
        if (!acceptsRemote(read.result as SyncMeta | undefined)) {
          return
        }

        const store = transaction.objectStore(change.collection)
        if (change.deleted) {
          store.delete(change.id)
        } else {
          store.put(parsed)
        }

        meta.put(
          remoteMeta(change.collection, change.id, change.seq, change.updatedAt, change.deleted),
        )
      }
    }

    await committed(transaction)
  }

  /**
   * Parses a pulled payload and puts any blob marker back as a data URL.
   *
   * A marker whose bytes are missing leaves the field absent rather than
   * failing: the server may legitimately not hold them yet, and the record is
   * still worth having. The app shows whatever it shows for a picture-less
   * record, which every one of these apps already handles.
   */
  private async attach(change: RemoteChange): Promise<unknown> {
    let parsed: unknown
    try {
      parsed = JSON.parse(change.payload)
    } catch {
      return undefined
    }

    const field = this.binaryField(change.collection)
    if (field === undefined || typeof parsed !== 'object' || parsed === null) {
      return parsed
    }

    const record = parsed as Record<string, unknown>
    const marker = record[field]
    if (!isBlobMarker(marker)) {
      // An older build's record, with the picture still inside the payload.
      return record
    }

    const bytes = (await this.blobs?.read(marker.$blob)) ?? null
    if (bytes === null) {
      const { [field]: _absent, ...rest } = record
      return rest
    }

    return { ...record, [field]: encodeDataUrl(marker.mime, bytes) }
  }

  async settle(results: SettleResult[]): Promise<void> {
    if (results.length === 0) {
      return
    }

    const db = await this.options.openDatabase()
    const { metaStore } = this.options
    const transaction = db.transaction([metaStore], 'readwrite')
    const store = transaction.objectStore(metaStore)

    for (const result of results) {
      const read = store.get(metaKey(result.collection, result.id))
      read.onsuccess = () => {
        const existing = read.result as SyncMeta | undefined
        if (existing === undefined) {
          return
        }
        store.put(settledMeta(existing, result.seq, result.outcome !== 'superseded'))
      }
    }

    await committed(transaction)
  }

  async loadState(): Promise<SyncState | null> {
    const db = await this.options.openDatabase()
    const transaction = db.transaction([this.options.stateStore], 'readonly')
    const stored = await request<StoredState | undefined>(
      transaction.objectStore(this.options.stateStore).get(STATE_KEY) as IDBRequest<
        StoredState | undefined
      >,
    )
    await committed(transaction)

    if (stored === undefined) {
      return null
    }

    return {
      serverUrl: stored.serverUrl,
      deviceToken: stored.deviceToken,
      deviceId: stored.deviceId,
      // Absent on a device paired before the server knew about people. The
      // server still resolves it from the token; this is only for display.
      user: stored.user ?? '',
      cursor: stored.cursor,
    }
  }

  async saveState(state: SyncState): Promise<void> {
    const db = await this.options.openDatabase()
    const transaction = db.transaction([this.options.stateStore], 'readwrite')
    transaction.objectStore(this.options.stateStore).put({ key: STATE_KEY, ...state })
    await committed(transaction)
  }

  async clearState(): Promise<void> {
    const db = await this.options.openDatabase()
    const transaction = db.transaction([this.options.stateStore], 'readwrite')
    transaction.objectStore(this.options.stateStore).delete(STATE_KEY)
    await committed(transaction)
  }

  /**
   * Marks every stored record dirty that has no metadata yet.
   *
   * An app rolled out to today has a library that predates sync, and `pending`
   * reads metadata rather than records — so without this the first sync would
   * succeed, push nothing, and leave the user looking at an empty server with
   * no error to explain it.
   *
   * Idempotent: a record that already has a row is left exactly as it is, so it
   * is safe on every start. It never clears a dirty flag and never touches
   * `seq`, so it cannot undo work the engine has done.
   */
  async backfill(now: number = Date.now()): Promise<number> {
    const db = await this.options.openDatabase()
    const { metaStore, collections } = this.options

    const read = db.transaction([metaStore, ...collections], 'readonly')
    const existing = new Set(
      (
        await request<SyncMeta[]>(read.objectStore(metaStore).getAll() as IDBRequest<SyncMeta[]>)
      ).map((meta) => meta.key),
    )
    const perCollection = await Promise.all(
      collections.map((collection) =>
        request<{ id?: unknown }[]>(
          read.objectStore(collection).getAll() as IDBRequest<{ id?: unknown }[]>,
        ),
      ),
    )
    await committed(read)

    const missing: { collection: string; id: string }[] = []
    for (const [index, collection] of collections.entries()) {
      for (const record of perCollection[index] ?? []) {
        const id = record.id
        if (typeof id !== 'string' || id === '') {
          continue
        }
        if (!existing.has(metaKey(collection, id))) {
          missing.push({ collection, id })
        }
      }
    }

    if (missing.length === 0) {
      return 0
    }

    const write = db.transaction([metaStore], 'readwrite')
    const store = write.objectStore(metaStore)
    for (const { collection, id } of missing) {
      // `undefined` as the previous row, so seq starts at 0: the server has
      // never seen these, and claiming otherwise would make the first push look
      // like a divergence.
      store.put(nextMeta(undefined, collection, id, now))
    }
    await committed(write)

    return missing.length
  }
}

export function createIdbAdapter(options: IdbAdapterOptions): IdbAdapter {
  return new IdbAdapter(options)
}
