// Local writes announcing themselves.
//
// This is what makes automatic push automatic. It hangs off `markInTransaction`
// on purpose: an app cannot add a new write that pushes but does not trigger,
// because the mark is what makes it push at all.

import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { markInTransaction, onLocalChange } from '../adapter.js'

const YARNS = 'yarn/yarns'
const META = 'sync/meta'

let dbName: string
const stopListening: (() => void)[] = []

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      db.createObjectStore(YARNS, { keyPath: 'id' })
      db.createObjectStore(META, { keyPath: 'key' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/** One write, the way an app does it: the record and its mark, one transaction. */
async function writeRecord(ids: string[], abort = false): Promise<void> {
  const db = await open()
  const transaction = db.transaction([YARNS, META], 'readwrite')

  for (const id of ids) {
    transaction.objectStore(YARNS).put({ id, name: id })
    markInTransaction(transaction, META, YARNS, id, 1000)
  }

  await new Promise<void>((resolve) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => resolve()
    transaction.onerror = () => resolve()
    if (abort) {
      transaction.abort()
    }
  })

  db.close()
}

beforeEach(() => {
  dbName = `local-change-${Math.random().toString(36).slice(2)}`
})

afterEach(() => {
  for (const stop of stopListening.splice(0)) {
    stop()
  }
})

describe('onLocalChange', () => {
  it('fires when a synced record is written', async () => {
    let fired = 0
    stopListening.push(onLocalChange(() => (fired += 1)))

    await writeRecord(['y1'])

    expect(fired).toBe(1)
  })

  it('fires once for a transaction that marks several records', async () => {
    // Saving a form touches many rows. That is one thing worth syncing, not
    // one per row.
    let fired = 0
    stopListening.push(onLocalChange(() => (fired += 1)))

    await writeRecord(['y1', 'y2', 'y3', 'y4'])

    expect(fired).toBe(1)
  })

  it('does not fire for a transaction that aborted', async () => {
    // A write that did not happen must not start a sync: it would push nothing
    // and report success, which looks like working until the day you check.
    let fired = 0
    stopListening.push(onLocalChange(() => (fired += 1)))

    await writeRecord(['y1'], true)

    expect(fired).toBe(0)
  })

  it('tells every listener', async () => {
    let a = 0
    let b = 0
    stopListening.push(onLocalChange(() => (a += 1)))
    stopListening.push(onLocalChange(() => (b += 1)))

    await writeRecord(['y1'])

    expect([a, b]).toEqual([1, 1])
  })

  it('stops telling a listener that unsubscribed', async () => {
    let fired = 0
    const stop = onLocalChange(() => (fired += 1))
    stop()

    await writeRecord(['y1'])

    expect(fired).toBe(0)
  })

  it('keeps going when a listener throws', async () => {
    // A broken listener must not take down the write that triggered it.
    let good = 0
    stopListening.push(
      onLocalChange(() => {
        throw new Error('listener is broken')
      }),
    )
    stopListening.push(onLocalChange(() => (good += 1)))

    await expect(writeRecord(['y1'])).resolves.toBeUndefined()
    expect(good).toBe(1)
  })
})
