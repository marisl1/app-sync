// Everything that touches the network.
//
// Isolated so the engine's loop can be tested without a server and so there is
// exactly one place that knows the route shapes — the other side of which lives
// in app-server's `api/`. The contract test in that repo drives this code
// against the real routes, which is what stops the two drifting apart.

import type { RemoteChange, SettleResult } from './types.js'

/** A sync that did not happen, carrying a message fit to show a person. */
export class SyncError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message)
    this.name = 'SyncError'
  }
}

/** The device token was refused: the app has to pair again. */
export class NotPairedError extends SyncError {
  constructor(message = 'This device is not paired with the server any more.') {
    super(message, 401)
    this.name = 'NotPairedError'
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface TransportOptions {
  serverUrl: string
  deviceToken?: string
  fetch?: FetchLike
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown }
    if (typeof body.error === 'string') {
      return body.error
    }
  } catch {
    // Not JSON at all, which is its own diagnosis: something other than the
    // server answered — a captive portal, a proxy, or the wrong port.
    return `The server replied ${response.status} instead of JSON.`
  }
  return `The server replied ${response.status}.`
}

export class Transport {
  private readonly base: string
  private readonly doFetch: FetchLike

  constructor(private readonly options: TransportOptions) {
    // A trailing slash would produce `//api/...`, which some proxies rewrite
    // and others 404. Normalise once rather than at every call site.
    this.base = options.serverUrl.replace(/\/+$/, '')
    this.doFetch = options.fetch ?? ((input, init) => fetch(input, init))
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const token = this.options.deviceToken
    return {
      ...(token === undefined || token === '' ? {} : { authorization: `Bearer ${token}` }),
      ...extra,
    }
  }

  private async send(path: string, init: RequestInit = {}): Promise<Response> {
    let response: Response
    try {
      // The token goes on by default. Leaving it to each call site meant `pull`
      // silently went out unauthenticated: the server answered 401, the engine
      // read that as "this device was forgotten" and cleared the pairing, so
      // every sync failed and un-paired the app.
      response = await this.doFetch(`${this.base}${path}`, {
        ...init,
        headers: this.headers((init.headers ?? {}) as Record<string, string>),
      })
    } catch {
      throw new SyncError(
        'Could not reach the server. It is only reachable on the home network.',
      )
    }

    if (response.status === 401) {
      throw new NotPairedError()
    }
    if (!response.ok) {
      throw new SyncError(await readError(response), response.status)
    }

    return response
  }

  /** Swaps the pairing code for a device token. Done once per device. */
  async pair(
    app: string,
    code: string,
    deviceName: string,
    user: string,
  ): Promise<{ deviceId: string; token: string; user: string }> {
    let response: Response
    try {
      response = await this.doFetch(`${this.base}/api/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app, code, name: deviceName, user }),
      })
    } catch {
      throw new SyncError('Could not reach the server at that address.')
    }

    // Pairing is the one place a 401 means "wrong code" rather than "pair
    // again", so it is handled here instead of by `send`.
    if (response.status === 401) {
      throw new SyncError('That pairing code is not right.', 401)
    }
    if (!response.ok) {
      throw new SyncError(await readError(response), response.status)
    }

    return (await response.json()) as { deviceId: string; token: string; user: string }
  }

  async pull(
    app: string,
    since: number,
    limit: number,
  ): Promise<{ changes: RemoteChange[]; seq: number; hasMore: boolean }> {
    const response = await this.send(
      `/api/${encodeURIComponent(app)}/changes?since=${since}&limit=${limit}`,
    )
    return (await response.json()) as { changes: RemoteChange[]; seq: number; hasMore: boolean }
  }

  /** The server's current seq for this device's scope. The cheap "anything new?". */
  async seq(app: string): Promise<number> {
    const response = await this.send(`/api/${encodeURIComponent(app)}/seq`)
    return ((await response.json()) as { seq: number }).seq
  }

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
  async stream(
    app: string,
    onChange: (seq: number) => void,
    signal: AbortSignal,
    onOpen?: () => void,
  ): Promise<void> {
    let response: Response
    try {
      response = await this.doFetch(`${this.base}/api/${encodeURIComponent(app)}/events`, {
        headers: this.headers({ accept: 'text/event-stream' }),
        signal,
      })
    } catch {
      throw new SyncError('Could not open the change stream.')
    }

    if (response.status === 401) {
      throw new NotPairedError()
    }
    if (!response.ok || response.body === null) {
      throw new SyncError('The server would not open a change stream.', response.status)
    }

    // Only now is the stream genuinely open. Callers use this to say
    // "connected" and to catch up on what they missed — doing either before the
    // response arrives claims a connection that may be about to 404.
    onOpen?.()

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          return
        }

        buffer += decoder.decode(value, { stream: true })

        // Events are separated by a blank line. Anything after the last one is
        // a partial event and stays in the buffer for the next chunk.
        const parts = buffer.split('\n\n')
        buffer = parts.pop() ?? ''

        for (const part of parts) {
          if (!part.includes('event: changed')) {
            continue
          }
          const data = /^data: (.*)$/m.exec(part)?.[1]
          if (data === undefined) {
            continue
          }
          try {
            const parsed = JSON.parse(data) as { seq?: unknown }
            onChange(typeof parsed.seq === 'number' ? parsed.seq : 0)
          } catch {
            // A malformed notification is only ever a hint that something
            // changed; syncing anyway is the safe reading of it.
            onChange(0)
          }
        }
      }
    } finally {
      // Releasing the lock lets the connection actually close on abort.
      try {
        reader.releaseLock()
      } catch {
        // Already released.
      }
    }
  }

  async push(
    app: string,
    changes: unknown[],
  ): Promise<{ results: SettleResult[]; seq: number }> {
    const response = await this.send(`/api/${encodeURIComponent(app)}/changes`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ changes }),
    })
    return (await response.json()) as { results: SettleResult[]; seq: number }
  }

  /** True when the server already holds these bytes, so they need not be sent. */
  async hasBlob(hash: string): Promise<boolean> {
    let response: Response
    try {
      response = await this.doFetch(`${this.base}/api/blobs/${hash}`, {
        method: 'HEAD',
        headers: this.headers(),
      })
    } catch {
      throw new SyncError('Could not reach the server.')
    }

    if (response.status === 401) {
      throw new NotPairedError()
    }
    return response.ok
  }

  async putBlob(bytes: Uint8Array): Promise<{ hash: string }> {
    const response = await this.send('/api/blobs', {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/octet-stream' }),
      body: bytes as BodyInit,
    })
    return (await response.json()) as { hash: string }
  }

  /** The bytes, or null when the server does not hold them. */
  async getBlob(hash: string): Promise<Uint8Array | null> {
    let response: Response
    try {
      response = await this.doFetch(`${this.base}/api/blobs/${hash}`, {
        headers: this.headers(),
      })
    } catch {
      throw new SyncError('Could not reach the server.')
    }

    if (response.status === 401) {
      throw new NotPairedError()
    }
    if (response.status === 404) {
      // A record may legitimately reference bytes that were never uploaded.
      // The record still syncs; only the picture is missing.
      return null
    }
    if (!response.ok) {
      throw new SyncError(await readError(response), response.status)
    }

    return new Uint8Array(await response.arrayBuffer())
  }

  /** Pairing issues a token, so the transport is rebuilt with it. */
  withToken(deviceToken: string): Transport {
    return new Transport({ ...this.options, deviceToken })
  }
}
