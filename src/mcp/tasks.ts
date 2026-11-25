/**
 * The MCP tasks extension (`io.modelcontextprotocol/tasks`, protocol
 * 2026-07-28) for the tools that wait on the tGBP API. A client that declares
 * the extension on a call gets a task handle at once and polls `tasks/get`
 * until the task is `completed` or `failed`. Every other client gets the
 * result on the call itself.
 *
 * Tasks live in this process's memory, so they end when the server does. A
 * stdio server ends when its client exits; the submission journal makes the
 * retry safe.
 */
import { randomUUID } from 'node:crypto'
import {
  type CallToolResult,
  type McpServer,
  ProtocolError,
  ProtocolErrorCode,
} from '@modelcontextprotocol/server'
import { z } from 'zod'

export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks'

const CLIENT_CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities'
/** How long a finished task stays readable. */
const TASK_TTL_MS = 60 * 60_000
const POLL_INTERVAL_MS = 2_000

export type TaskStatus = 'working' | 'completed' | 'failed'

/** A task as `tasks/get` returns it. */
export interface TgbpTask {
  taskId: string
  status: TaskStatus
  statusMessage?: string
  createdAt: string
  lastUpdatedAt: string
  ttlMs: number
  pollIntervalMs: number
  /** Set once `completed`. */
  result?: CallToolResult
  /** Set once `failed`. */
  error?: TaskError
}

/** A JSON-RPC error whose `data` names the idempotency key and any API reference. */
export interface TaskError {
  code: number
  message: string
  data: Record<string, unknown>
}

/**
 * Holds the tasks of one server, or of every server a host builds per request,
 * since a client polls `tasks/get` on a later request.
 */
export class TaskStore {
  private readonly tasks = new Map<string, TgbpTask>()

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** Starts `run` and returns its task, already readable through `get`. */
  start(run: () => Promise<CallToolResult>, fail: (error: unknown) => TaskError): TgbpTask {
    this.prune()
    const at = this.now().toISOString()
    const task: TgbpTask = {
      taskId: randomUUID(),
      status: 'working',
      createdAt: at,
      lastUpdatedAt: at,
      ttlMs: TASK_TTL_MS,
      pollIntervalMs: POLL_INTERVAL_MS,
    }
    this.tasks.set(task.taskId, task)
    run().then(
      (result) => this.finish(task, { status: 'completed', result }),
      (error: unknown) => {
        const failure = fail(error)
        this.finish(task, { status: 'failed', error: failure, statusMessage: failure.message })
      },
    )
    return { ...task }
  }

  get(taskId: string): TgbpTask | undefined {
    this.prune()
    const task = this.tasks.get(taskId)
    return task && { ...task }
  }

  private finish(task: TgbpTask, update: Partial<TgbpTask>): void {
    Object.assign(task, update, { lastUpdatedAt: this.now().toISOString() })
  }

  /** Drops finished tasks past their time to live. */
  private prune(): void {
    const now = this.now().getTime()
    for (const [id, task] of this.tasks) {
      if (task.status !== 'working' && now - Date.parse(task.lastUpdatedAt) > task.ttlMs) {
        this.tasks.delete(id)
      }
    }
  }
}

/** True when the request declares the tasks extension, so it may be answered with a task. */
export function acceptsTask(envelope: Record<string, unknown> | undefined): boolean {
  const capabilities = envelope?.[CLIENT_CAPABILITIES_KEY] as
    | { extensions?: Record<string, unknown> }
    | undefined
  return capabilities?.extensions?.[TASKS_EXTENSION] !== undefined
}

/** The answer to a task-augmented `tools/call`. The SDK types tool results as CallToolResult only. */
export function taskResult(task: TgbpTask): CallToolResult {
  const { taskId, status, createdAt, lastUpdatedAt, ttlMs, pollIntervalMs } = task
  return {
    resultType: 'task',
    taskId,
    status,
    createdAt,
    lastUpdatedAt,
    ttlMs,
    pollIntervalMs,
  } as unknown as CallToolResult
}

const TaskIdParams = z.object({ taskId: z.string().max(100) })

/** Answers `tasks/get` and `tasks/cancel` from `store`. */
export function registerTaskHandlers(server: McpServer, store: TaskStore): void {
  const find = (taskId: string) => {
    const task = store.get(taskId)
    if (!task) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `No task ${taskId}`)
    return task
  }
  server.server.setRequestHandler(
    'tasks/get',
    { params: TaskIdParams },
    async ({ taskId }) => find(taskId) as never,
  )
  server.server.setRequestHandler('tasks/cancel', { params: TaskIdParams }, async ({ taskId }) => {
    find(taskId)
    // The request may already be with the API, and the journal keeps its key open for a retry.
    throw new ProtocolError(
      ProtocolErrorCode.InvalidRequest,
      'A mint, redemption or swap cannot be cancelled once submitted; wait for the task to finish',
    )
  })
}
