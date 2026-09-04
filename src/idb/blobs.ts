// Moving pictures out of the sync payload.
//
// The apps store pictures as data-URL strings on the record itself, and that is
// deliberate: a `Blob` survives IndexedDB but comes back from a backup as `{}`,
// so every one of these apps made the same choice for the same reason.
//
// The cost is on the wire. A photo record pushed whole carries its picture in
// its payload, and the server keeps twenty versions of every record — so
// re-saving a photo that did not change duplicated a megabyte twenty times.
//
// So the *storage* does not change and the *backup* does not change. Only the
// payload does: on the way out the data URL is replaced by a marker naming its
// hash, and the bytes travel once, deduplicated by content. On the way in the
// marker is resolved and the record is put back exactly as the app expects it.
// No app record changed shape, no component that reads `photo.dataUrl` had to
// learn anything, and a backup still contains the picture.

/** What a data-URL field becomes in a synced payload. */
export interface BlobMarker {
  $blob: string
  mime: string
}

const DATA_URL = /^data:([^;,]+)(;base64)?,(.*)$/s

export function isBlobMarker(value: unknown): value is BlobMarker {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as BlobMarker).$blob === 'string' &&
    typeof (value as BlobMarker).mime === 'string'
  )
}

export interface DecodedDataUrl {
  mime: string
  bytes: Uint8Array
}

/** The bytes a data URL carries, or null when it is not one. */
export function decodeDataUrl(value: unknown): DecodedDataUrl | null {
  if (typeof value !== 'string') {
    return null
  }

  const match = DATA_URL.exec(value)
  if (match === null) {
    return null
  }

  const mime = match[1] ?? 'application/octet-stream'
  const body = match[3] ?? ''

  if (match[2] === undefined) {
    // A rare non-base64 data URL. Percent-decoded text, so its bytes are UTF-8.
    return { mime, bytes: new TextEncoder().encode(decodeURIComponent(body)) }
  }

  const binary = atob(body)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return { mime, bytes }
}

export function encodeDataUrl(mime: string, bytes: Uint8Array): string {
  let binary = ''
  // Chunked: spreading a megabyte into String.fromCharCode blows the argument
  // limit, and a photo is exactly the size where that starts to happen.
  const CHUNK = 8192
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK))
  }
  return `data:${mime};base64,${btoa(binary)}`
}

/**
 * The content hash the server addresses these bytes by.
 *
 * `crypto.subtle` needs a secure context, which is why the server is served
 * over HTTPS even on the LAN — the same constraint that made the certificate
 * non-optional in the first place.
 */
export async function hashBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
