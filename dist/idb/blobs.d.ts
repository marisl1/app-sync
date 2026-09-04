/** What a data-URL field becomes in a synced payload. */
export interface BlobMarker {
    $blob: string;
    mime: string;
}
export declare function isBlobMarker(value: unknown): value is BlobMarker;
export interface DecodedDataUrl {
    mime: string;
    bytes: Uint8Array;
}
/** The bytes a data URL carries, or null when it is not one. */
export declare function decodeDataUrl(value: unknown): DecodedDataUrl | null;
export declare function encodeDataUrl(mime: string, bytes: Uint8Array): string;
/**
 * The content hash the server addresses these bytes by.
 *
 * `crypto.subtle` needs a secure context, which is why the server is served
 * over HTTPS even on the LAN — the same constraint that made the certificate
 * non-optional in the first place.
 */
export declare function hashBytes(bytes: Uint8Array): Promise<string>;
//# sourceMappingURL=blobs.d.ts.map