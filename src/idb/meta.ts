// What a device knows about each record's relationship with the server.
//
// Kept apart from the records themselves on purpose. A `deleted` flag on a
// domain record would mean every query in every app had to remember to filter
// tombstones out, and the one that forgot would show a deleted row forever.
// Here the app's own code is untouched: it deletes the row as it always did,
// and the tombstone lives beside it where only sync looks.
//
// Every function here is pure, so the rules are testable without a database and
// there is one place they are stated rather than one per app.

export interface SyncMeta {
  /** `<collection>/<id>` — the primary key. */
  key: string
  collection: string
  id: string
  /** Epoch ms of the local edit. The ordering key the server merges on. */
  updatedAt: number
  /** The server seq last known for this record; 0 when it has never synced. */
  seq: number
  /** Waiting to be pushed. */
  dirty: boolean
  /** Deleted locally. The row is gone; this is all that remains to send. */
  deleted: boolean
}

export function metaKey(collection: string, id: string): string {
  return `${collection}/${id}`
}

/**
 * The meta row to write for a local edit, given whatever was there before.
 *
 * `seq` survives an edit: losing it would make the next push claim the record
 * is new, which the server reads as a divergence and logs as a conflict nobody
 * caused.
 */
export function nextMeta(
  existing: SyncMeta | undefined,
  collection: string,
  id: string,
  now: number,
  deleted = false,
): SyncMeta {
  return {
    key: metaKey(collection, id),
    collection,
    id,
    updatedAt: now,
    seq: existing?.seq ?? 0,
    dirty: true,
    deleted,
  }
}

/** The meta row after the server has accepted or rejected a push. */
export function settledMeta(existing: SyncMeta, seq: number, accepted: boolean): SyncMeta {
  return {
    ...existing,
    // A rejected push keeps the seq it had; the winner arrives on the next pull
    // and overwrites this row anyway.
    seq: accepted ? seq : existing.seq,
    // Cleared either way. Leaving it dirty would resend a losing edit forever.
    dirty: false,
  }
}

/**
 * Whether a change from the server may overwrite what is stored locally.
 *
 * It may not when there is a local edit still waiting to go. A client re-pulls
 * its own writes — a cursor cannot cover seqs the server had not assigned yet —
 * and letting that returning copy land would overwrite the pending change and
 * clear its dirty flag. A delete made just before a sync was resurrected by the
 * very sync meant to carry it.
 *
 * Skipping is also right for a real collision: the local edit keeps its
 * `baseSeq`, goes up on the push, and the server arbitrates. This side never
 * has to decide who wins.
 */
export function acceptsRemote(existing: SyncMeta | undefined): boolean {
  return existing?.dirty !== true
}

/** The meta row for a record that arrived from the server. */
export function remoteMeta(
  collection: string,
  id: string,
  seq: number,
  updatedAt: number,
  deleted: boolean,
): SyncMeta {
  return {
    key: metaKey(collection, id),
    collection,
    id,
    updatedAt,
    seq,
    // It came from the server, so by definition there is nothing to send back.
    dirty: false,
    deleted,
  }
}
