/**
 * The submission journal: an append-only JSON Lines file that records the
 * idempotency key of every mint, redemption and swap before it is sent.
 *
 * A process that dies between sending a request and reading its answer
 * cannot know whether the API acted on it. The journal keys each submission
 * by its inputs, so a retry with the same inputs finds the key the first
 * attempt sent and sends it again. The API returns the first record instead
 * of creating a second.
 *
 * A submission stays open until its answer arrives. Once it closes, the
 * same inputs are a new submission with a new key.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { assertIdempotencyKey, generateIdempotencyKey } from '../api/http.js'
import { appendSynced, LOCK_WAIT_MS, withFileLock } from './ledger.js'

/** The API keeps an idempotency key for 24 hours; an older open submission cannot be deduped. */
export const SUBMISSION_KEY_LIFETIME_MS = 24 * 60 * 60_000

export type SubmissionTool = 'mint' | 'redeem' | 'swap'

/**
 * `submitted`: the key is saved and the request may have been sent.
 * `burning`: the redemption exists and its burn may have been sent.
 * `closed`: the answer arrived; the same inputs start a new submission.
 */
export type SubmissionStage = 'submitted' | 'burning' | 'closed'

export interface SubmissionEntry {
  /** ISO time this line was written. */
  at: string
  /** The hash of the tool and its inputs. */
  inputs: string
  tool: SubmissionTool
  idempotencyKey: string
  stage: SubmissionStage
  /** Redemptions only, from `burning` on: the redemption whose burn was sent. */
  redemptionId?: string
}

export interface Submission {
  readonly idempotencyKey: string
  /** True when an earlier attempt with these inputs saved this key and never closed it. */
  readonly resumed: boolean
}

export class SubmissionJournal {
  constructor(
    readonly path: string,
    private readonly now: () => Date = () => new Date(),
    private readonly lockWaitMs = LOCK_WAIT_MS,
  ) {}

  /**
   * The key to send for `inputs`: the key of an open submission with the same
   * inputs, else `idempotencyKey`, else a new one. It is on disk before this
   * resolves. A redemption whose burn may have been sent throws instead,
   * because a second burn would destroy the tGBP twice.
   */
  async open(
    tool: SubmissionTool,
    inputs: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<Submission> {
    // A key the API would refuse must never be saved, or every retry would resend it.
    if (idempotencyKey !== undefined) assertIdempotencyKey(idempotencyKey)
    const hash = hashInputs(tool, inputs)
    return withFileLock(this.path, 'submission journal', this.lockWaitMs, async () => {
      const last = this.latest(await this.entries(), hash)
      if (last?.stage === 'burning') throw burnMayHaveBeenSent(last)
      // An explicit key is the agent naming the attempt it retries.
      if (last && (idempotencyKey === undefined || idempotencyKey === last.idempotencyKey)) {
        return { idempotencyKey: last.idempotencyKey, resumed: true }
      }
      const key = idempotencyKey ?? generateIdempotencyKey()
      await this.append({ inputs: hash, tool, idempotencyKey: key, stage: 'submitted' })
      return { idempotencyKey: key, resumed: false }
    })
  }

  /**
   * Records that the burn for `redemptionId` is about to be sent. Throws if
   * another attempt already recorded it, so only one process ever burns.
   */
  async burning(
    inputs: Record<string, unknown>,
    idempotencyKey: string,
    redemptionId: string,
  ): Promise<void> {
    const hash = hashInputs('redeem', inputs)
    await withFileLock(this.path, 'submission journal', this.lockWaitMs, async () => {
      const last = this.latest(await this.entries(), hash)
      if (last?.idempotencyKey !== idempotencyKey || last.stage !== 'submitted') {
        throw new Error(
          `Another attempt is burning redemption ${redemptionId}; nothing was burned here`,
        )
      }
      await this.append({
        inputs: hash,
        tool: 'redeem',
        idempotencyKey,
        stage: 'burning',
        redemptionId,
      })
    })
  }

  /**
   * Throws if a redemption with these inputs may have had its burn sent, so a
   * retry is refused before the spend guard counts it or asks a human.
   */
  async assertNotBurning(inputs: Record<string, unknown>): Promise<void> {
    const last = this.latest(await this.entries(), hashInputs('redeem', inputs))
    if (last?.stage === 'burning') throw burnMayHaveBeenSent(last)
  }

  /**
   * Closes the submission: its answer arrived, so the same inputs are a new
   * submission. Does nothing unless `idempotencyKey` is still the open key at
   * `stage`, so a slower attempt never closes a newer one or its burn record.
   */
  async close(
    tool: SubmissionTool,
    inputs: Record<string, unknown>,
    idempotencyKey: string,
    stage: 'submitted' | 'burning' = 'submitted',
  ): Promise<void> {
    const hash = hashInputs(tool, inputs)
    await withFileLock(this.path, 'submission journal', this.lockWaitMs, async () => {
      const last = this.latest(await this.entries(), hash)
      if (last?.idempotencyKey !== idempotencyKey || last.stage !== stage) return
      await this.append({ inputs: hash, tool, idempotencyKey, stage: 'closed' })
    })
  }

  /** Every entry, oldest first. Throws if the journal cannot be read. */
  async entries(): Promise<SubmissionEntry[]> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    return text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line, index) => parseEntry(line, index + 1, this.path))
  }

  /**
   * The open submission for `hash`: one whose key is young enough for the API
   * to dedupe it, or a redemption whose burn may have been sent, at any age.
   */
  private latest(entries: SubmissionEntry[], hash: string): SubmissionEntry | undefined {
    let last: SubmissionEntry | undefined
    let opened: SubmissionEntry | undefined
    for (const entry of entries) {
      if (entry.inputs !== hash) continue
      if (!last || last.stage === 'closed' || entry.idempotencyKey !== last.idempotencyKey) {
        opened = entry
      }
      last = entry
    }
    if (!last || !opened || last.stage === 'closed') return undefined
    // A burn that may have been sent never expires: a second one would destroy the tGBP twice.
    if (last.stage === 'burning') return last
    if (this.now().getTime() - Date.parse(opened.at) > SUBMISSION_KEY_LIFETIME_MS) return undefined
    return last
  }

  private append(entry: Omit<SubmissionEntry, 'at'>): Promise<void> {
    const line: SubmissionEntry = { at: this.now().toISOString(), ...entry }
    return appendSynced(this.path, `${JSON.stringify(line)}\n`)
  }
}

function burnMayHaveBeenSent(entry: SubmissionEntry): Error {
  return new Error(
    `Redemption ${entry.redemptionId} for these inputs was created and its burn may have been sent ` +
      `(idempotency key ${entry.idempotencyKey}); nothing was sent now. Check the burn address on chain. ` +
      'If the burn never arrived, cancel that redemption and redeem with a different reference.',
  )
}

/** A stable hash of the tool and its canonical inputs; absent and undefined fields are the same. */
export function hashInputs(tool: SubmissionTool, inputs: Record<string, unknown>): string {
  const fields = Object.entries(inputs)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return createHash('sha256')
    .update(JSON.stringify([tool, fields]))
    .digest('hex')
}

const STAGES: readonly string[] = ['submitted', 'burning', 'closed']
const TOOLS: readonly string[] = ['mint', 'redeem', 'swap']

function parseEntry(line: string, lineNumber: number, path: string): SubmissionEntry {
  let entry: unknown
  try {
    entry = JSON.parse(line)
  } catch (error) {
    throw new Error(`${path}:${lineNumber} is not valid JSON`, { cause: error })
  }
  const e = (entry ?? {}) as Partial<SubmissionEntry>
  if (
    typeof e.at !== 'string' ||
    Number.isNaN(Date.parse(e.at)) ||
    typeof e.inputs !== 'string' ||
    typeof e.idempotencyKey !== 'string' ||
    !TOOLS.includes(e.tool as string) ||
    !STAGES.includes(e.stage as string) ||
    (e.redemptionId !== undefined && typeof e.redemptionId !== 'string')
  ) {
    throw new Error(`${path}:${lineNumber} is not a submission journal entry`)
  }
  return entry as SubmissionEntry
}
