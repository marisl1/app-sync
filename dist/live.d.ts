import type { Sync } from './engine.js';
import type { SyncReport } from './types.js';
export interface LiveOptions {
    /**
     * Called after each automatic run, so an app can refresh what is on screen.
     *
     * Errors are reported here too rather than thrown: nothing is awaiting an
     * automatic sync, so a throw would land in an unhandled rejection.
     */
    onReport?: (report: SyncReport) => void;
    onError?: (error: Error) => void;
    /** Told when the change stream comes and goes, for a connection indicator. */
    onConnectionChange?: (connected: boolean) => void;
    /** Wait after a local write before pushing, so a burst becomes one push. */
    localDelayMs?: number;
    /** Wait after a server notification. Short: the data is already there. */
    remoteDelayMs?: number;
    /** How often to poll when the stream is not available. */
    pollMs?: number;
    /** Subscribes to local writes. Defaults to the IndexedDB adapter's. */
    watchLocal?: (listener: () => void) => () => void;
}
export interface LiveHandle {
    /** Stops everything: the stream, the timers and the listeners. */
    stop: () => void;
    /** Asks for a run now, as the app's own "sync now" button would. */
    syncNow: () => void;
    /** Whether the change stream is currently held open. */
    readonly connected: boolean;
}
export declare function startLive(sync: Sync, app: string, options?: LiveOptions): LiveHandle;
//# sourceMappingURL=live.d.ts.map