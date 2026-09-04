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
}

export class IdbAdapter implements SyncAdapter {
  readonly app: string
  readonly blobs?: BlobStore

  constructor(private readonly options: IdbAdapterOptions) {
    this.app = options.app
    if (options.blobs !== undefined) {
      this.blobs = options.blobs
    }
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

      changes.push({
        collection: meta.collection,
        id: meta.id,
        updatedAt: meta.updatedAt,
        deleted: false,
        payload: JSON.stringify(record),
        blobHashes: [],
        baseSeq: meta.seq,
      })
    }

    return changes
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
    const { metaStore } = this.options
    const stores = [...new Set(changes.map((c) => c.collection))].filter((c) => this.syncs(c))

    const transaction = db.transaction([...stores, metaStore], 'readwrite')
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
        try {
          parsed = JSON.parse(change.payload)
        } catch {
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
