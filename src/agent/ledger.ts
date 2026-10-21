/**
 * The spend ledger: an append-only JSON Lines file of every value-moving
 * action a spend policy allowed, so the daily cap survives a restart.
 *
 * An action is recorded before it is signed or sent, and stays recorded if it
 * then fails: the ledger may overstate what was spent, never understate it.
 */
import { appendFile, open, readFile, stat, unlink } from 'node:fs/promises'

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
}

export type ReserveResult = { ok: true } | { ok: false; spent: bigint }

/** A lock older than this is from a process that died holding it. */
const STALE_LOCK_MS = 30_000
const LOCK_WAIT_MS = 5_000
const LOCK_RETRY_MS = 25

export class SpendLedger {
  constructor(readonly path: string) {}

  /** What the ledger records as spent on `day`, at `POLICY_DECIMALS`. Throws if it cannot be read. */
  async spentOn(day: string): Promise<bigint> {
    return sumDay(await this.read(), day)
  }

  /**
   * Record `entry` if it keeps `entry.day` within `cap`. The read, the check
   * and the append run under a lock file, so two processes sharing a ledger
   * cannot both spend the last of the cap.
   */
  async reserve(entry: LedgerEntry, cap: bigint): Promise<ReserveResult> {
    return this.withLock(async () => {
      const spent = sumDay(await this.read(), entry.day)
      if (spent + toPolicyUnits(entry.amount) > cap) return { ok: false, spent }
      await appendFile(this.path, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 })
      return { ok: true }
    })
  }

  private async read(): Promise<LedgerEntry[]> {
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

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const lockPath = `${this.path}.lock`
    const deadline = Date.now() + LOCK_WAIT_MS
    for (;;) {
      try {
        const handle = await open(lockPath, 'wx', 0o600)
        await handle.close()
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const age = await lockAge(lockPath)
        if (age !== undefined && age > STALE_LOCK_MS) {
          await unlink(lockPath).catch(() => {})
          continue
        }
        if (Date.now() > deadline)
          throw new Error(`Timed out waiting for the ledger lock ${lockPath}`)
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS))
      }
    }
    try {
      return await fn()
    } finally {
      await unlink(lockPath).catch(() => {})
    }
  }
}

/** The UTC day `date` falls on, `YYYY-MM-DD`. */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function sumDay(entries: LedgerEntry[], day: string): bigint {
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
  const { day, amount } = (entry ?? {}) as Partial<LedgerEntry>
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || typeof amount !== 'string') {
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

async function lockAge(lockPath: string): Promise<number | undefined> {
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs
  } catch {
    // Released between our open and our stat: retry at once.
    return undefined
  }
}
