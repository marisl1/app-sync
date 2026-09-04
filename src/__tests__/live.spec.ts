// Automatic sync.
//
// The engine is a stub here: what is being tested is *when* a run happens and
// how many happen, which is the whole substance of this module. Whether the run
// itself is correct is engine.spec's job.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Sync } from '../engine.js'
import { startLive } from '../live.js'
import { NotPairedError } from '../transport.js'
import type { SyncReport } from '../types.js'

const REPORT: SyncReport = {
  ok: true,
  pulled: 0,
  pushed: 0,
  superseded: 0,
  conflicts: 0,
  blobsUploaded: 0,
  cursor: 0,
}

/** A stub engine that records runs and lets a test drive the stream by hand. */
function stubSync(overrides: Partial<Record<'run' | 'stream', unknown>> = {}) {
  const runs: number[] = []
  let notify: ((seq: number) => void) | null = null
  let streamRejects: Error | null = null

  const sync = {
    run: vi.fn(async () => {
      runs.push(Date.now())
      return REPORT
    }),
    stream: vi.fn(async (_app: string, onChange: (seq: number) => void, signal: AbortSignal) => {
      if (streamRejects !== null) {
        throw streamRejects
      }
      notify = onChange
      // Resolves only when the caller aborts, like the real one.
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve()
          return
        }
        signal.addEventListener('abort', () => resolve())
      })
    }),
    ...overrides,
  } as unknown as Sync

  return {
    sync,
    runs,
    serverSays: (seq = 1) => notify?.(seq),
    breakStream: (error: Error) => (streamRejects = error),
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('startLive', () => {
  it('syncs once on start, to catch up on anything missed', async () => {
    const stub = stubSync()
    const live = startLive(stub.sync, 'yarnus', { watchLocal: () => () => {} })

    await vi.advanceTimersByTimeAsync(500)

    expect(stub.sync.run).toHaveBeenCalled()
    live.stop()
  })

  it('syncs when this device writes', async () => {
    let fire = (): void => {}
    const stub = stubSync()
    const live = startLive(stub.sync, 'yarnus', {
      localDelayMs: 100,
      watchLocal: (listener) => {
        fire = listener
        return () => {}
      },
    })

    await vi.advanceTimersByTimeAsync(500)
    const before = (stub.sync.run as ReturnType<typeof vi.fn>).mock.calls.length

    fire()
    await vi.advanceTimersByTimeAsync(200)

    expect((stub.sync.run as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before + 1)
    live.stop()
  })

  it('coalesces a burst of local writes into one sync', async () => {
    // Typing into a form is dozens of writes. One push, not dozens.
    let fire = (): void => {}
    const stub = stubSync()
    const live = startLive(stub.sync, 'yarnus', {
      localDelayMs: 100,
      watchLocal: (listener) => {
        fire = listener
        return () => {}
      },
    })

    await vi.advanceTimersByTimeAsync(500)
    const before = (stub.sync.run as ReturnType<typeof vi.fn>).mock.calls.length

    for (let i = 0; i < 20; i += 1) {
      fire()
    }
    await vi.advanceTimersByTimeAsync(300)

    expect((stub.sync.run as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before + 1)
    live.stop()
  })

  it('syncs when the server says it has something', async () => {
    const stub = stubSync()
    const live = startLive(stub.sync, 'yarnus', { remoteDelayMs: 10, watchLocal: () => () => {} })

    await vi.advanceTimersByTimeAsync(200)
    const before = (stub.sync.run as ReturnType<typeof vi.fn>).mock.calls.length

    stub.serverSays(12)
    await vi.advanceTimersByTimeAsync(100)

    expect((stub.sync.run as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before + 1)
    live.stop()
  })

  it('never runs two syncs at once', async () => {
    // Two concurrent runs would race over the same cursor.
    let release = (): void => {}
    let active = 0
    let overlapped = false

    const sync = {
      run: vi.fn(async () => {
        active += 1
        if (active > 1) {
          overlapped = true
        }
        await new Promise<void>((resolve) => (release = resolve))
        active -= 1
        return REPORT
      }),
      stream: vi.fn(async (_app: string, _onChange: unknown, signal: AbortSignal) => {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
      }),
    } as unknown as Sync

    let fire = (): void => {}
    const live = startLive(sync, 'yarnus', {
      localDelayMs: 10,
      watchLocal: (listener) => {
        fire = listener
        return () => {}
      },
    })

    await vi.advanceTimersByTimeAsync(50)
    fire()
    await vi.advanceTimersByTimeAsync(50)
    fire()
    await vi.advanceTimersByTimeAsync(50)
    release()
    await vi.advanceTimersByTimeAsync(50)
    release()
    await vi.advanceTimersByTimeAsync(50)

    expect(overlapped).toBe(false)
    live.stop()
  })

  it('goes round again when a change lands mid-run', async () => {
    let release = (): void => {}
    let runs = 0

    const sync = {
      run: vi.fn(async () => {
        runs += 1
        await new Promise<void>((resolve) => (release = resolve))
        return REPORT
      }),
      stream: vi.fn(async (_app: string, _onChange: unknown, signal: AbortSignal) => {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
      }),
    } as unknown as Sync

    let fire = (): void => {}
    const live = startLive(sync, 'yarnus', {
      localDelayMs: 10,
      remoteDelayMs: 10,
      watchLocal: (listener) => {
        fire = listener
        return () => {}
      },
    })

    await vi.advanceTimersByTimeAsync(50)
    expect(runs).toBe(1)

    // Arrives while the first run is still in flight.
    fire()
    await vi.advanceTimersByTimeAsync(50)
    release()
    await vi.advanceTimersByTimeAsync(50)

    expect(runs).toBe(2)
    live.stop()
  })

  it('keeps polling when the stream cannot be opened', async () => {
    // Automatic has to degrade to slower, never to silently off.
    const stub = stubSync()
    stub.breakStream(new Error('no stream here'))

    const live = startLive(stub.sync, 'yarnus', {
      pollMs: 1_000,
      remoteDelayMs: 10,
      watchLocal: () => () => {},
    })

    await vi.advanceTimersByTimeAsync(100)
    const before = (stub.sync.run as ReturnType<typeof vi.fn>).mock.calls.length

    await vi.advanceTimersByTimeAsync(2_500)

    expect((stub.sync.run as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(before)
    live.stop()
  })

  it('stops reconnecting once the device is no longer paired', async () => {
    // A forgotten device would otherwise reconnect forever, 401 every time.
    const stub = stubSync()
    stub.breakStream(new NotPairedError())
    const errors: Error[] = []

    const live = startLive(stub.sync, 'yarnus', {
      watchLocal: () => () => {},
      onError: (error) => errors.push(error),
    })

    await vi.advanceTimersByTimeAsync(5_000)

    expect(errors.some((error) => error instanceof NotPairedError)).toBe(true)
    expect((stub.sync.stream as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
    live.stop()
  })

  it('reports each run to the app', async () => {
    const reports: SyncReport[] = []
    const stub = stubSync()
    const live = startLive(stub.sync, 'yarnus', {
      watchLocal: () => () => {},
      onReport: (report) => reports.push(report),
    })

    await vi.advanceTimersByTimeAsync(500)

    expect(reports.length).toBeGreaterThan(0)
    live.stop()
  })

  it('reports a failed run instead of throwing it into the void', async () => {
    // Nothing is awaiting an automatic sync, so a throw becomes an unhandled
    // rejection and the app never hears about it.
    const errors: Error[] = []
    const sync = {
      run: vi.fn(async () => {
        throw new Error('the server is off')
      }),
      stream: vi.fn(async (_app: string, _onChange: unknown, signal: AbortSignal) => {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
      }),
    } as unknown as Sync

    const live = startLive(sync, 'yarnus', {
      watchLocal: () => () => {},
      onError: (error) => errors.push(error),
    })

    await vi.advanceTimersByTimeAsync(500)

    expect(errors[0]?.message).toBe('the server is off')
    live.stop()
  })

  it('stops everything when stopped', async () => {
    let fire = (): void => {}
    let unsubscribed = false
    const stub = stubSync()

    const live = startLive(stub.sync, 'yarnus', {
      localDelayMs: 10,
      pollMs: 100,
      watchLocal: (listener) => {
        fire = listener
        return () => (unsubscribed = true)
      },
    })

    await vi.advanceTimersByTimeAsync(200)
    live.stop()
    const after = (stub.sync.run as ReturnType<typeof vi.fn>).mock.calls.length

    fire()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(unsubscribed).toBe(true)
    expect((stub.sync.run as ReturnType<typeof vi.fn>).mock.calls.length).toBe(after)
  })

  it('syncs on demand when the app asks', async () => {
    const stub = stubSync()
    const live = startLive(stub.sync, 'yarnus', { watchLocal: () => () => {} })

    await vi.advanceTimersByTimeAsync(500)
    const before = (stub.sync.run as ReturnType<typeof vi.fn>).mock.calls.length

    live.syncNow()
    await vi.advanceTimersByTimeAsync(50)

    expect((stub.sync.run as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before + 1)
    live.stop()
  })
})
