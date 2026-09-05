import type { BlobStore, LocalChange, RemoteChange, SettleResult, SyncAdapter, SyncState } from '../types.js';
export interface IdbAdapterOptions {
    /** The name the server knows this app by, e.g. `yarnus`. */
    app: string;
    /** Object stores whose records travel. Never the bookkeeping stores. */
    collections: readonly string[];
    /** The app's own opener, so it keeps control of schema and version. */
    openDatabase: () => Promise<IDBDatabase>;
    /** Store holding one `SyncMeta` per record, keyed `key`. */
    metaStore: string;
    /** Store holding the single sync state row, keyed `key`. */
    stateStore: string;
    /**
     * Fields holding a data URL, by collection — e.g. `{ 'yarn/photos': 'dataUrl' }`.
     *
     * Named fields travel as content-addressed bytes instead of inside the
     * payload, so twenty retained versions of a photo record cost one copy of the
     * picture rather than twenty. Requires `blobStore`.
     */
    binaryFields?: Record<string, string>;
    /**
     * Store caching those bytes locally, keyed `hash`, holding `{ hash, dataUrl }`.
     *
     * Marked `local: true` in the app's schema: it is derived from records that
     * are themselves backed up, so backing it up too would store every picture
     * twice.
     */
    blobStore?: string;
    blobs?: BlobStore;
}
/**
 * Records a local write inside a transaction the caller already owns.
 *
 * The same transaction as the record itself, deliberately: a record written
 * without its mark would never sync, and a mark written without its record
 * would push a row that is not there. Apps call this from every write path that
 * touches a synced store.
 */
export declare function markInTransaction(transaction: IDBTransaction, metaStore: string, collection: string, id: string, now: number, deleted?: boolean): void;
/**
 * Called whenever this device writes to a synced store. Returns an unsubscribe.
 *
 * Hung off `markInTransaction` rather than asked of each app, so automatic sync
 * covers every write path that already syncs at all. An app cannot add a new
 * write that pushes but does not trigger, because the mark is what makes it
 * push in the first place.
 */
export declare function onLocalChange(listener: () => void): () => void;
export declare class IdbAdapter implements SyncAdapter {
    private readonly options;
    readonly app: string;
    readonly blobs?: BlobStore;
    constructor(options: IdbAdapterOptions);
    /** The engine's view of the local byte cache. */
    private cacheStore;
    private binaryField;
    private syncs;
    pending(limit: number): Promise<LocalChange[]>;
    /**
     * Replaces a record's data-URL field with a marker naming its content hash,
     * caching the bytes so the engine can upload them.
     *
     * Returns the record untouched when the collection has no binary field, or
     * when the field does not hold a data URL — a record written by an older
     * build, or one that already carries a marker because it came from the
     * server and has not been re-saved since.
     */
    private detach;
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
    apply(changes: RemoteChange[]): Promise<void>;
    /**
     * Parses a pulled payload and puts any blob marker back as a data URL.
     *
     * A marker whose bytes are missing leaves the field absent rather than
     * failing: the server may legitimately not hold them yet, and the record is
     * still worth having. The app shows whatever it shows for a picture-less
     * record, which every one of these apps already handles.
     */
    private attach;
    settle(results: SettleResult[]): Promise<void>;
    loadState(): Promise<SyncState | null>;
    saveState(state: SyncState): Promise<void>;
    clearState(): Promise<void>;
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
     *
     * The ids come from `getAllKeys`, which asks the store for its own primary
     * keys rather than assuming they live on a field called `id`. Reading
     * `record.id` looked equivalent and was not: ml-app's `media/covers` keys on
     * `itemId`, so every cover was skipped, and the count still looked right
     * because the items beside them queued fine. Keys are also all this needs —
     * `getAll` was loading every record, which for a store of cover images meant
     * pulling tens of megabytes of base64 into memory to read one field off each.
     */
    backfill(now?: number): Promise<number>;
}
export declare function createIdbAdapter(options: IdbAdapterOptions): IdbAdapter;
//# sourceMappingURL=adapter.d.ts.map