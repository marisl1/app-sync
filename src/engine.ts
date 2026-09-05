// The sync loop.
//
// Pull, apply, push, settle — in that order, every time.
//
// The order is the whole design. Pulling first is what makes `baseSeq`
// meaningful: a push then states the server version this client actually saw,
// so the server can tell "edited from current" apart from a real divergence.
// Pushing first would make every ordinary edit look like a conflict, and the
// conflict list would fill with things nobody disagreed about.

import { NotPairedError, SyncError, Transport, type FetchLike } from './transport.js'
import type { LocalChange, SyncAdapter, SyncReport, SyncState } from './types.js'

const PULL_LIMIT = 500
const PUSH_LIMIT = 200

export interface SyncOptions {
  adapter: SyncAdapter
  /** Injected in tests; defaults to the global. */
  fetch?: FetchLike
  pullLimit?: number
  pushLimit?: number
}

export class Sync {
  private readonly adapter: SyncAdapter
  private readonly pullLimit: number
  private readonly pushLimit: number
  private readonly fetchImpl: FetchLike | undefined
  private backfilled = false

  constructor(options: SyncOptions) {
    this.adapter = options.adapter
    this.pullLimit = options.pullLimit ?? PULL_LIMIT
    this.pushLimit = options.pushLimit ?? PUSH_LIMIT
    this.fetchImpl = options.fetch
  }

  private transport(state: Pick<SyncState, 'serverUrl' | 'deviceToken'>): Transport {
    return new Transport({
      serverUrl: state.serverUrl,
      deviceToken: state.deviceToken,
      ...(this.fetchImpl === undefined ? {} : { fetch: this.fetchImpl }),
    })
  }

  async isPaired(): Promise<boolean> {
    const state = await this.adapter.loadState()
    return state !== null && state.deviceToken !== ''
  }

  async state(): Promise<SyncState | null> {
    return this.adapter.loadState()
  }

  /**
   * Exchanges a pairing code for a device token and stores it.
   *
   * The cursor starts at 0 so a freshly paired device pulls everything the
   * server holds before it pushes anything — which is what lets a second device
   * adopt an existing library instead of fighting it.
   */
  async pair(
    serverUrl: string,
    code: string,
    deviceName: string,
    user: string,
  ): Promise<SyncState> {
    const transport = new Transport({
      serverUrl,
      ...(this.fetchImpl === undefined ? {} : { fetch: this.fetchImpl }),
    })

    const paired = await transport.pair(this.adapter.app, code, deviceName, user)

    const state: SyncState = {
      serverUrl: serverUrl.replace(/\/+$/, ''),
      deviceToken: paired.token,
      deviceId: paired.deviceId,
      // The server's normalised form, not what was typed.
      user: paired.user,
      cursor: 0,
    }
    await this.adapter.saveState(state)

    return state
  }

  async unpair(): Promise<void> {
    await this.adapter.clearState()
  }

  /** One full cycle. Never throws: failures come back in the report. */
  async run(): Promise<SyncReport> {
    const empty: SyncReport = {
      ok: false,
      pulled: 0,
      pushed: 0,
      superseded: 0,
      conflicts: 0,
      blobsUploaded: 0,
      cursor: 0,
    }

    const state = await this.adapter.loadState()
    if (state === null || state.deviceToken === '') {
      return { ...empty, error: 'This app is not paired with a server yet.' }
    }

    const report: SyncReport = { ...empty, cursor: state.cursor }

    try {
      const transport = this.transport(state)

      await this.backfillOnce()

      report.pulled = await this.pull(transport, state, report)
      const pushed = await this.push(transport, report)
      report.pushed = pushed

      report.ok = true
      return report
    } catch (cause) {
      if (cause instanceof NotPairedError) {
        // The token is gone for good; keeping it would fail forever and never
        // tell anyone why. Clearing it sends the app back to the pairing screen.
        await this.adapter.clearState()
      }
      report.error =
        cause instanceof SyncError ? cause.message : `Sync failed: ${String(cause)}`
      return report
    }
  }

  /**
   * Queues anything stored that sync has never heard of, once per session.
   *
   * Pairing used to be the only place this happened, which was enough only as
   * long as the synced set never grew. Add a store to it afterwards — or fix a
   * backfill that had been skipping one — and an already-paired device has
   * nothing that would ever queue those records: sync keeps reporting success
   * while quietly pushing none of them. ml-app's cover images sat on a phone
   * that way.
   *
   * Once per session rather than per run: the auto-sync loop ticks often, and
   * this reads all of the bookkeeping. A failure is swallowed on purpose —
   * backfill is an optimisation over "the user edits each record again", and it
   * must never be the reason a sync that would otherwise work does not.
   */
  private async backfillOnce(): Promise<void> {
    if (this.backfilled || this.adapter.backfill === undefined) {
      return
    }
    this.backfilled = true

    try {
      await this.adapter.backfill()
    } catch {
      // Nothing here is worth failing a sync over.
    }
  }

  /**
   * Pulls every page since the cursor, applying as it goes.
   *
   * The cursor advances only after a page has been applied, so an interruption
   * re-fetches that page rather than skipping it. Applying twice is harmless —
   * the adapter writes by primary key — while skipping once loses a record.
   */
  private async pull(
    transport: Transport,
    state: SyncState,
    report: SyncReport,
  ): Promise<number> {
    let pulled = 0
    let cursor = state.cursor

    for (;;) {
      const page = await transport.pull(this.adapter.app, cursor, this.pullLimit)
      if (page.changes.length === 0) {
        break
      }

      await this.fetchMissingBlobs(transport, page.changes.flatMap((c) => c.blobHashes))
      await this.adapter.apply(page.changes)

      pulled += page.changes.length
      cursor = page.changes[page.changes.length - 1]?.seq ?? cursor

      await this.adapter.saveState({ ...state, cursor })
      state.cursor = cursor
      report.cursor = cursor

      if (!page.hasMore) {
        break
      }
    }

    return pulled
  }

  /** Downloads bytes this device does not have. A missing blob is not fatal. */
  private async fetchMissingBlobs(transport: Transport, hashes: string[]): Promise<void> {
    const store = this.adapter.blobs
    if (store === undefined || hashes.length === 0) {
      return
    }

    for (const hash of new Set(hashes)) {
      if (await store.has(hash)) {
        continue
      }

      const bytes = await transport.getBlob(hash)
      if (bytes !== null) {
        await store.write(hash, bytes)
      }
      // null: the server does not hold it either. The record still applies and
      // the app shows a placeholder rather than failing the whole pull.
    }
  }

  private async push(transport: Transport, report: SyncReport): Promise<number> {
    let pushed = 0

    for (;;) {
      const pending = await this.adapter.pending(this.pushLimit)
      if (pending.length === 0) {
        break
      }

      report.blobsUploaded += await this.uploadBlobs(transport, pending)

      const { results } = await transport.push(this.adapter.app, pending)
      await this.adapter.settle(results)

      for (const result of results) {
        if (result.outcome === 'superseded') {
          report.superseded += 1
        } else if (result.outcome === 'conflict') {
          report.conflicts += 1
        }
      }

      pushed += pending.length

      // A short page means there was nothing more waiting. Without this the
      // loop would keep asking an adapter that has already settled everything.
      if (pending.length < this.pushLimit) {
        break
      }
    }

    return pushed
  }

  /**
   * Uploads bytes the server lacks, before the records that reference them.
   *
   * Order matters: a record pushed first could name a hash the server cannot
   * serve, and every other device would pull a broken reference.
   */
  private async uploadBlobs(transport: Transport, pending: LocalChange[]): Promise<number> {
    const store = this.adapter.blobs
    if (store === undefined) {
      return 0
    }

    const hashes = new Set(pending.flatMap((change) => change.blobHashes))
    let uploaded = 0

    for (const hash of hashes) {
      if (await transport.hasBlob(hash)) {
        continue
      }

      const bytes = await store.read(hash)
      if (bytes === null) {
        // Referenced but not held locally either — nothing to send, and the
        // record is still worth syncing.
        continue
      }

      await transport.putBlob(bytes)
      uploaded += 1
    }

    return uploaded
  }

  /**
   * Holds the change stream open, calling `onChange` when the server has news.
   *
   * Lives on the engine rather than being reached through the transport by
   * callers, so the device token stays this class's business.
   */
  async stream(
    app: string,
    onChange: (seq: number) => void,
    signal: AbortSignal,
    onOpen?: () => void,
  ): Promise<void> {
    const state = await this.adapter.loadState()
    if (state === null || state.deviceToken === '') {
      throw new NotPairedError()
    }
    return this.transport(state).stream(app, onChange, signal, onOpen)
  }

  /** The server's seq for this device's scope, without syncing anything. */
  async serverSeq(app: string): Promise<number> {
    const state = await this.adapter.loadState()
    if (state === null || state.deviceToken === '') {
      throw new NotPairedError()
    }
    return this.transport(state).seq(app)
  }
}

export function createSync(options: SyncOptions): Sync {
  return new Sync(options)
}
