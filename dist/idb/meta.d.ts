export interface SyncMeta {
    /** `<collection>/<id>` — the primary key. */
    key: string;
    collection: string;
    id: string;
    /** Epoch ms of the local edit. The ordering key the server merges on. */
    updatedAt: number;
    /** The server seq last known for this record; 0 when it has never synced. */
    seq: number;
    /** Waiting to be pushed. */
    dirty: boolean;
    /** Deleted locally. The row is gone; this is all that remains to send. */
    deleted: boolean;
}
export declare function metaKey(collection: string, id: string): string;
/**
 * The meta row to write for a local edit, given whatever was there before.
 *
 * `seq` survives an edit: losing it would make the next push claim the record
 * is new, which the server reads as a divergence and logs as a conflict nobody
 * caused.
 */
export declare function nextMeta(existing: SyncMeta | undefined, collection: string, id: string, now: number, deleted?: boolean): SyncMeta;
/** The meta row after the server has accepted or rejected a push. */
export declare function settledMeta(existing: SyncMeta, seq: number, accepted: boolean): SyncMeta;
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
export declare function acceptsRemote(existing: SyncMeta | undefined): boolean;
/** The meta row for a record that arrived from the server. */
export declare function remoteMeta(collection: string, id: string, seq: number, updatedAt: number, deleted: boolean): SyncMeta;
//# sourceMappingURL=meta.d.ts.map