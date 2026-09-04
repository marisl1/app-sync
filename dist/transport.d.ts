import type { RemoteChange, SettleResult } from './types.js';
/** A sync that did not happen, carrying a message fit to show a person. */
export declare class SyncError extends Error {
    readonly status: number;
    constructor(message: string, status?: number);
}
/** The device token was refused: the app has to pair again. */
export declare class NotPairedError extends SyncError {
    constructor(message?: string);
}
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export interface TransportOptions {
    serverUrl: string;
    deviceToken?: string;
    fetch?: FetchLike;
}
export declare class Transport {
    private readonly options;
    private readonly base;
    private readonly doFetch;
    constructor(options: TransportOptions);
    private headers;
    private send;
    /** Swaps the pairing code for a device token. Done once per device. */
    pair(app: string, code: string, deviceName: string, user: string): Promise<{
        deviceId: string;
        token: string;
        user: string;
    }>;
    pull(app: string, since: number, limit: number): Promise<{
        changes: RemoteChange[];
        seq: number;
        hasMore: boolean;
    }>;
    /** The server's current seq for this device's scope. The cheap "anything new?". */
    seq(app: string): Promise<number>;
    /**
     * Opens the change stream and calls `onChange` for each notification.
     *
     * Read with `fetch` rather than `EventSource`, which cannot send an
     * `Authorization` header — the alternative was putting a long-lived device
     * token in the query string, where it would land in every access log and
     * proxy history between here and the server.
     *
     * Resolves when the stream ends. `signal` is how the caller stops it.
     */
    stream(app: string, onChange: (seq: number) => void, signal: AbortSignal): Promise<void>;
    push(app: string, changes: unknown[]): Promise<{
        results: SettleResult[];
        seq: number;
    }>;
    /** True when the server already holds these bytes, so they need not be sent. */
    hasBlob(hash: string): Promise<boolean>;
    putBlob(bytes: Uint8Array): Promise<{
        hash: string;
    }>;
    /** The bytes, or null when the server does not hold them. */
    getBlob(hash: string): Promise<Uint8Array | null>;
    /** Pairing issues a token, so the transport is rebuilt with it. */
    withToken(deviceToken: string): Transport;
}
//# sourceMappingURL=transport.d.ts.map