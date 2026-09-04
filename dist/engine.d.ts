import { type FetchLike } from './transport.js';
import type { SyncAdapter, SyncReport, SyncState } from './types.js';
export interface SyncOptions {
    adapter: SyncAdapter;
    /** Injected in tests; defaults to the global. */
    fetch?: FetchLike;
    pullLimit?: number;
    pushLimit?: number;
}
export declare class Sync {
    private readonly adapter;
    private readonly pullLimit;
    private readonly pushLimit;
    private readonly fetchImpl;
    constructor(options: SyncOptions);
    private transport;
    isPaired(): Promise<boolean>;
    state(): Promise<SyncState | null>;
    /**
     * Exchanges a pairing code for a device token and stores it.
     *
     * The cursor starts at 0 so a freshly paired device pulls everything the
     * server holds before it pushes anything — which is what lets a second device
     * adopt an existing library instead of fighting it.
     */
    pair(serverUrl: string, code: string, deviceName: string, user: string): Promise<SyncState>;
    unpair(): Promise<void>;
    /** One full cycle. Never throws: failures come back in the report. */
    run(): Promise<SyncReport>;
    /**
     * Pulls every page since the cursor, applying as it goes.
     *
     * The cursor advances only after a page has been applied, so an interruption
     * re-fetches that page rather than skipping it. Applying twice is harmless —
     * the adapter writes by primary key — while skipping once loses a record.
     */
    private pull;
    /** Downloads bytes this device does not have. A missing blob is not fatal. */
    private fetchMissingBlobs;
    private push;
    /**
     * Uploads bytes the server lacks, before the records that reference them.
     *
     * Order matters: a record pushed first could name a hash the server cannot
     * serve, and every other device would pull a broken reference.
     */
    private uploadBlobs;
    /**
     * Holds the change stream open, calling `onChange` when the server has news.
     *
     * Lives on the engine rather than being reached through the transport by
     * callers, so the device token stays this class's business.
     */
    stream(app: string, onChange: (seq: number) => void, signal: AbortSignal, onOpen?: () => void): Promise<void>;
    /** The server's seq for this device's scope, without syncing anything. */
    serverSeq(app: string): Promise<number>;
}
export declare function createSync(options: SyncOptions): Sync;
//# sourceMappingURL=engine.d.ts.map