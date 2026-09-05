// The seam between the engine and an app.
//
// Everything here is deliberately about records and bytes, never about yarn or
// filament or films. The engine is written once; an adapter is written once per
// app, so the smaller this file is the less each new app has to implement.

/** A record the app has changed and not yet pushed. */
export interface LocalChange {
  collection: string
  id: string
  /** Epoch milliseconds. The ordering key the server merges on. */
  updatedAt: number
  /** A delete is a record, not an absence — see the tombstone note in the design. */
  deleted: boolean
  /** JSON text. Opaque to the engine and to the server. */
  payload: string
  /** SHA-256 hashes of binary payloads this record references. */
  blobHashes: string[]
  /** The server seq this client last saw for the record; 0 when it saw none. */
  baseSeq: number
}

/** A record as the server reports it. */
export interface RemoteChange {
  collection: string
  id: string
  seq: number
  updatedAt: number
  deviceId: string
  deleted: boolean
  payload: string
  blobHashes: string[]
}

/** What the server did with one pushed record. */
export type Outcome = 'applied' | 'superseded' | 'conflict'

export interface SettleResult {
  collection: string
  id: string
  outcome: Outcome
  /** The record's seq after the push — the next push's `baseSeq`. */
  seq: number
}

/** Everything needed to resume syncing, held in the app's own storage. */
export interface SyncState {
  /** Origin of the server, e.g. `https://homeserver.lan:8443`. No trailing slash. */
  serverUrl: string
  deviceToken: string
  deviceId: string
  /**
   * Which person on the server this device belongs to, as the server
   * normalised it. Kept for display only: every request derives the user from
   * the token, so nothing is trusted to send it back.
   */
  user: string
  /** The highest seq this client has pulled and applied. */
  cursor: number
}

/**
 * Where an app keeps binary payloads.
 *
 * Optional: an app with no pictures never implements it, and the engine simply
 * never has a hash to move.
 */
export interface BlobStore {
  read(hash: string): Promise<Uint8Array | null>
  write(hash: string, bytes: Uint8Array): Promise<void>
  has(hash: string): Promise<boolean>
}

/**
 * What an app must provide. The engine owns the protocol; the adapter owns the
 * database, and neither reaches across.
 */
export interface SyncAdapter {
  /** The name the server knows this app by, e.g. `yarnus`. */
  readonly app: string

  /** Records changed locally since their last successful push, newest last. */
  pending(limit: number): Promise<LocalChange[]>

  /** Apply remote changes to local storage. Must be atomic per call. */
  apply(changes: RemoteChange[]): Promise<void>

  /** Store what the server assigned, so the next push carries the right baseSeq. */
  settle(results: SettleResult[]): Promise<void>

  loadState(): Promise<SyncState | null>
  saveState(state: SyncState): Promise<void>
  clearState(): Promise<void>

  /**
   * Queues stored records that have no sync metadata yet.
   *
   * Optional because not every adapter has records that predate its
   * bookkeeping. An adapter that implements it must be idempotent: the engine
   * calls it once per session, not only at pairing, because a store added to
   * the synced set after a device paired would otherwise never travel — and
   * would never say so, since sync would report success and simply push
   * nothing.
   */
  backfill?(now?: number): Promise<number>

  blobs?: BlobStore
}

export interface SyncReport {
  ok: boolean
  pulled: number
  pushed: number
  /** Pushed records the server refused because a newer version won. */
  superseded: number
  /** Pushed records that won but diverged — the server logged a conflict. */
  conflicts: number
  blobsUploaded: number
  cursor: number
  error?: string
}
