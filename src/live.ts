// Automatic sync: when this device writes, and when the server says it has
// something.
//
// Two triggers, one loop. Local writes announce themselves through the adapter's
// mark, and the server announces itself over a change stream. Both land in the
// same place — "please sync soon" — so a burst of either coalesces into one run
// rather than a run per keystroke.
//
// Three things here are deliberate:
//
//   - **A notification is a hint, never data.** Every run pulls from the
//     device's own stored cursor, so a missed notification costs nothing. That
//     is what keeps the stream from becoming a second source of truth able to
//     disagree with the first.
//   - **Never two runs at once.** A change arriving mid-run sets a flag and the
//     loop goes round again, rather than starting a second sync that would race
//     the first over the same cursor.
//   - **Polling is the floor, not the plan.** If the stream cannot be held open
//     the loop keeps working on a slow poll, so "automatic" degrades to "slower"
//     instead of to "silently off".

import type { Sync } from './engine.js'
import { NotPairedError } from './transport.js'
import type { SyncReport } from './types.js'

export interface LiveOptions {
  /**
   * Called after each automatic run, so an app can refresh what is on screen.
   *
   * Errors are reported here too rather than thrown: nothing is awaiting an
   * automatic sync, so a throw would land in an unhandled rejection.
   */
  onReport?: (report: SyncReport) => void
  onError?: (error: Error) => void
  /** Told when the change stream comes and goes, for a connection indicator. */
  onConnectionChange?: (connected: boolean) => void
  /** Wait after a local write before pushing, so a burst becomes one push. */
  localDelayMs?: number
  /** Wait after a server notification. Short: the data is already there. */
  remoteDelayMs?: number
  /** How often to poll when the stream is not available. */
  pollMs?: number
  /** Subscribes to local writes. Defaults to the IndexedDB adapter's. */
  watchLocal?: (listener: () => void) => () => void
}

const LOCAL_DELAY_MS = 1_500
const REMOTE_DELAY_MS = 250
const POLL_MS = 60_000
const BACKOFF_START_MS = 1_000
const BACKOFF_MAX_MS = 60_000

export interface LiveHandle {
  /** Stops everything: the stream, the timers and the listeners. */
  stop: () => void
  /** Asks for a run now, as the app's own "sync now" button would. */
  syncNow: () => void
  /** Whether the change stream is currently held open. */
  readonly connected: boolean
}

export function startLive(sync: Sync, app: string, options: LiveOptions = {}): LiveHandle {
  const localDelay = options.localDelayMs ?? LOCAL_DELAY_MS
  const remoteDelay = options.remoteDelayMs ?? REMOTE_DELAY_MS
  const pollMs = options.pollMs ?? POLL_MS

  let stopped = false
  let running = false
  let again = false
  let connected = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let poll: ReturnType<typeof setInterval> | null = null
  let controller: AbortController | null = null
  let backoff = BACKOFF_START_MS

  const unsubscribers: (() => void)[] = []

  function setConnected(value: boolean): void {
    if (connected !== value) {
      connected = value
      options.onConnectionChange?.(value)
    }
  }

  async function runOnce(): Promise<void> {
    if (running) {
      // Something changed while a sync was in flight. Go round again after,
      // rather than racing this run over the same cursor.
      again = true
      return
    }

    running = true
    try {
      do {
        again = false
        const report = await sync.run()
        options.onReport?.(report)
      } while (again && !stopped)
    } catch (cause) {
      options.onError?.(cause as Error)
    } finally {
      running = false
    }
  }

  /** Coalesces callers: many asks within `delay` become one run. */
  function schedule(delay: number): void {
    if (stopped || timer !== null) {
      return
    }
    timer = setTimeout(() => {
      timer = null
      void runOnce()
    }, delay)
  }

  // --- the change stream ---------------------------------------------------

  async function connect(): Promise<void> {
    while (!stopped) {
      controller = new AbortController()
      try {
        // Catch up first: anything that changed while the stream was down is
        // waiting, and no notification is coming for it.
        schedule(remoteDelay)

        setConnected(true)
        backoff = BACKOFF_START_MS
        await sync.stream(app, () => schedule(remoteDelay), controller.signal)
      } catch (cause) {
        if (cause instanceof NotPairedError) {
          // The device was forgotten. Reconnecting would 401 forever.
          options.onError?.(cause)
          setConnected(false)
          return
        }
        // Anything else is the network, and the network comes back.
      } finally {
        setConnected(false)
      }

      if (stopped) {
        return
      }

      // Jittered, so a household of devices coming back after a router reboot
      // does not reconnect in lockstep.
      const wait = backoff + Math.random() * backoff
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
  }

  // --- triggers ------------------------------------------------------------

  const watchLocal = options.watchLocal
  if (watchLocal !== undefined) {
    unsubscribers.push(watchLocal(() => schedule(localDelay)))
  }

  if (typeof addEventListener === 'function') {
    // Coming back online, or back to the tab, are both good moments to check:
    // the stream may have died without the socket ever reporting it.
    const wake = (): void => schedule(remoteDelay)
    addEventListener('online', wake)
    unsubscribers.push(() => removeEventListener('online', wake))

    const onVisible = (): void => {
      if (typeof document !== 'undefined' && !document.hidden) {
        wake()
      }
    }
    addEventListener('visibilitychange', onVisible)
    unsubscribers.push(() => removeEventListener('visibilitychange', onVisible))
  }

  // The floor: even with no stream and no local writes, the device checks in.
  poll = setInterval(() => schedule(remoteDelay), pollMs)

  void connect()
  schedule(remoteDelay)

  return {
    stop(): void {
      stopped = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      if (poll !== null) {
        clearInterval(poll)
        poll = null
      }
      controller?.abort()
      for (const off of unsubscribers) {
        off()
      }
      unsubscribers.length = 0
      setConnected(false)
    },
    syncNow(): void {
      schedule(0)
    },
    get connected(): boolean {
      return connected
    },
  }
}
