/**
 * The spend ledger: an append-only JSON Lines file of every value-moving
 * action a spend policy allowed, so the daily cap survives a restart.
 *
 * An action is recorded before it is signed or sent, and stays recorded if it
 * then fails: the ledger may overstate what was spent, never understate it.
 */
import { open, readFile, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

import { type SpendAction, toPolicyUnits } from './policy.js'

export interface LedgerEntry {
  /** ISO time the action was recorded. */
  at: string
  /** The UTC day it counts against, `YYYY-MM-DD`. */
  day: string
  action: SpendAction
  chain: string
  destination: string
  /** Pounds, as a decimal string. */
  amount: string
  /** x402 payments only: the URL paid for. */
  url?: string
  /** x402 payments only: the price in pence, as a decimal string. */
  pence?: string
  /** x402 payments only: why the agent paid. */
  reason?: string
  /** x402 payments only: the policy's `x402.services` match the URL paid. */
  service?: string
  /** x402 payments only: the budget the payment spent from. */
  category?: string
  /** x402 payments only: set on the first payment to a service, which its owner approved. */
  firstPayment?: true
}

export type ReserveResult<R> = { ok: true } | { ok: false; refusal: R }

const LOCK_WAIT_MS = 5_000
const LOCK_RETRY_MS = 25

export class SpendLedger {
  /**
   * `lockWaitMs` is how long to wait for another process to release the
   * ledger lock before refusing.
   */
  constructor(
    readonly path: string,
    private readonly lockWaitMs = LOCK_WAIT_MS,
  ) {}

  /** What the ledger records as spent on `day`, at `POLICY_DECIMALS`. Throws if it cannot be read. */
  async spentOn(day: string): Promise<bigint> {
    return sumDay(await this.entries(), day)
  }

  /**
   * Record `entry` unless `refuse` returns a refusal for the entries already
   * recorded. The read, the check and the append run under a lock file, so
   * two processes sharing a ledger cannot both spend the last of a cap. The
   * append is synced to disk before this resolves, so a crash after it cannot
   * lose the record.
   */
  async reserve<R>(
    entry: LedgerEntry,
    refuse: (entries: LedgerEntry[]) => R | undefined,
  ): Promise<ReserveResult<R>> {
    return this.withLock(async () => {
      const refusal = refuse(await this.entries())
      if (refusal !== undefined) return { ok: false, refusal }
      const handle = await open(this.path, 'a', 0o600)
      let created: boolean
      try {
        created = (await handle.stat()).size === 0
        await handle.write(`${JSON.stringify(entry)}\n`)
        await handle.sync()
      } finally {
        await handle.close()
      }
      // A new file is durable only once its directory entry is, too.
      if (created) await syncDirectory(dirname(this.path))
      return { ok: true }
    })
  }

  /** Every entry, oldest first. Throws if the ledger cannot be read. */
  async entries(): Promise<LedgerEntry[]> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      // No file yet means nothing spent yet; any other failure is fatal.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    return text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line, index) => parseEntry(line, index + 1, this.path))
  }

  /**
   * Only the holder ever removes the lock. A lock left by a process that died
   * is never broken automatically, because a slow holder looks the same; the
   * ledger refuses until someone who knows the process is gone deletes it.
   */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const lockPath = `${this.path}.lock`
    const deadline = Date.now() + this.lockWaitMs
    for (;;) {
      try {
        const handle = await open(lockPath, 'wx', 0o600)
        await handle.close()
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (Date.now() > deadline) {
          throw new Error(
            `The ledger lock ${lockPath} is held. If no tgbp process is running, delete it.`,
          )
        }
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS))
      }
    }
    try {
      return await fn()
    } finally {
      // Never let the release hide fn's own result or error. A lock that
      // could not be removed makes the next action refuse, which surfaces it.
      await unlink(lockPath).catch(() => {})
    }
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** The UTC day `date` falls on, `YYYY-MM-DD`. */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** What `entries` spent on `day`, at `POLICY_DECIMALS`. */
export function sumDay(entries: LedgerEntry[], day: string): bigint {
  return entries
    .filter((entry) => entry.day === day)
    .reduce((total, entry) => total + toPolicyUnits(entry.amount), 0n)
}

function parseEntry(line: string, lineNumber: number, path: string): LedgerEntry {
  let entry: unknown
  try {
    entry = JSON.parse(line)
  } catch (error) {
    throw new Error(`${path}:${lineNumber} is not valid JSON`, { cause: error })
  }
  const { at, day, amount } = (entry ?? {}) as Partial<LedgerEntry>
  if (
    typeof at !== 'string' ||
    // A time that does not parse would drop out of every rolling window.
    Number.isNaN(Date.parse(at)) ||
    typeof day !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    typeof amount !== 'string'
  ) {
    throw new Error(`${path}:${lineNumber} is not a ledger entry`)
  }
  try {
    toPolicyUnits(amount)
  } catch (error) {
    // A corrupt amount must never count as zero.
    throw new Error(`${path}:${lineNumber} has a malformed amount`, { cause: error })
  }
  return entry as LedgerEntry
}
