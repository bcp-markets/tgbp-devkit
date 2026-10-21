/**
 * The tGBP API client: mint and redeem. Types come from the published spec,
 * generated into core.generated.ts.
 */
import type { components, operations } from './core.generated.js'
import {
  assertHttpOptions,
  assertIdempotencyKey,
  generateIdempotencyKey,
  type HttpConfig,
  type HttpOptions,
  incompleteCreate,
  normaliseBaseUrl,
  request,
} from './http.js'

type Schemas = components['schemas']
type JsonBody<T> = T extends { content: { 'application/json': infer B } } ? B : never
type Query<Op extends keyof operations> = NonNullable<operations[Op]['parameters']['query']>

export type Mint = Schemas['Mint']
export type Redemption = Schemas['Redemption']
/** The body `IdempotencyKey` field is deprecated; the client sends the header instead. */
export type MintCreateRequest = Omit<Schemas['MintCreateRequest'], 'IdempotencyKey'>
export type RedemptionCreateRequest = Omit<Schemas['RedemptionCreateRequest'], 'IdempotencyKey'>
export type RedemptionQuoteRequest = Schemas['RedemptionQuoteRequest']
export type BurnConfirmationRequest = Schemas['BurnConfirmationRequest']
export type CancelRequest = Schemas['CancelRequest']
export type ListMintsQuery = Query<'listMints'>
export type ListRedemptionsQuery = Omit<Query<'listRedemptions'>, 'Idempotency-Key'>
export type MintResponse = Schemas['MintResponse']
export type MintListResponse = Schemas['MintListResponse']
export type RedemptionResponse = Schemas['RedemptionResponse']
export type RedemptionListResponse = Schemas['RedemptionListResponse']
export type RedemptionQuoteResponse = Schemas['RedemptionQuoteResponse']
export type BurnConfirmationResponse = Schemas['BurnConfirmationResponse']
export type SimulatePayinResponse = JsonBody<operations['simulateMintPayin']['responses'][200]>

export type TgbpEnvironment = 'production' | 'sandbox'

/** `sandbox` takes staging keys and runs on testnets only. */
export const API_BASE_URLS: Record<TgbpEnvironment, string> = {
  production: 'https://api.tgbp.io',
  sandbox: 'https://sandbox.tgbp.io',
}

export type TgbpClientOptions = HttpOptions &
  ({ environment: TgbpEnvironment; baseUrl?: never } | { baseUrl: string; environment?: never })

export interface CreateOptions {
  /**
   * Reuse a key only to retry the same request; a key lasts 24 hours. Omit it
   * and the client generates one, returned on the result and on any error.
   */
  idempotencyKey?: string
}

/**
 * `created` is a new record and `replayed` is the record an earlier request
 * with the same key created. `pending_approval` means your account needs a
 * second person to approve the action: nothing exists yet, so do not retry.
 */
export type CreateResult<T> =
  | { status: 'created' | 'replayed'; data: T; idempotencyKey: string }
  | { status: 'pending_approval'; approvalRequestId: string; idempotencyKey: string }

export function createTgbpClient(options: TgbpClientOptions) {
  assertHttpOptions(options)
  const config: HttpConfig = {
    ...options,
    baseUrl: normaliseBaseUrl(options.baseUrl ?? API_BASE_URLS[options.environment]),
  }

  async function create<T>(path: string, body: unknown, opts: CreateOptions = {}) {
    const idempotencyKey = opts.idempotencyKey ?? generateIdempotencyKey()
    assertIdempotencyKey(idempotencyKey)
    const res = await request<{ data: unknown }>(config, {
      method: 'POST',
      path,
      body,
      idempotencyKey,
      retry: true,
    })
    return createResult<T>(path, res.status, res.body, idempotencyKey)
  }

  const get = async <T>(path: string, pathParams?: Record<string, string>, query?: object) =>
    (
      await request<T>(config, {
        method: 'GET',
        path,
        pathParams,
        query: query as never,
        retry: true,
      })
    ).body

  const post = async <T>(
    path: string,
    pathParams: Record<string, string>,
    body: unknown,
    retry: boolean,
  ) => (await request<T>(config, { method: 'POST', path, pathParams, body, retry })).body

  return {
    mints: {
      /** Create a mint. tGBP is minted to `destinationAddress` once the bank transfer arrives. */
      create: (body: MintCreateRequest, opts?: CreateOptions) =>
        create<Mint>('/api/v1/mints', body, opts),
      get: (mintId: string) => get<MintResponse>('/api/v1/mints/{mintId}', { mintId }),
      list: (query: ListMintsQuery = {}) =>
        get<MintListResponse>('/api/v1/mints', undefined, query),
      /**
       * Cancel a pending mint. Retried: the API reference's idempotency guide says a
       * repeated cancel returns the current state or a 409.
       */
      cancel: (mintId: string, body?: CancelRequest) =>
        post<MintResponse>('/api/v1/mints/{mintId}/cancel', { mintId }, body, true),
      /**
       * Sandbox only: simulate the bank transfer for a pending mint. Never
       * retried, because a second call can race the first.
       */
      simulatePayin: (mintId: string) =>
        post<SimulatePayinResponse>(
          '/api/v1/mints/{mintId}/simulate-payin',
          { mintId },
          undefined,
          false,
        ),
    },
    redemptions: {
      /**
       * Create a redemption. Then burn the tGBP by sending it to the returned
       * `burnAddress`; GBP is paid out to `bankId` once the burn confirms.
       */
      create: (body: RedemptionCreateRequest, opts?: CreateOptions) =>
        create<Redemption>('/api/v1/redemptions', body, opts),
      get: (redemptionId: string) =>
        get<RedemptionResponse>('/api/v1/redemptions/{redemptionId}', { redemptionId }),
      list: (query: ListRedemptionsQuery = {}) =>
        get<RedemptionListResponse>('/api/v1/redemptions', undefined, query),
      /**
       * Cancel a pending redemption. Retried: the API reference's idempotency guide
       * says a repeated cancel returns the current state or a 409.
       */
      cancel: (redemptionId: string, body?: CancelRequest) =>
        post<RedemptionResponse>(
          '/api/v1/redemptions/{redemptionId}/cancel',
          { redemptionId },
          body,
          true,
        ),
      /** Screen the address that will send the burn, before you burn. Creates no record. */
      quote: (body: RedemptionQuoteRequest) =>
        post<RedemptionQuoteResponse>('/api/v1/redemptions/quote', {}, body, true),
      /**
       * Fallback when the burn is not detected on its own. The API reference says it
       * is safe to call more than once: the
       * payout is never sent twice.
       */
      confirmBurn: (redemptionId: string, body?: BurnConfirmationRequest) =>
        post<BurnConfirmationResponse>(
          '/api/v1/redemptions/{redemptionId}/burn-confirmation',
          { redemptionId },
          body,
          true,
        ),
    },
  }
}

export type TgbpClient = ReturnType<typeof createTgbpClient>

function createResult<T>(
  path: string,
  status: number,
  body: unknown,
  idempotencyKey: string,
): CreateResult<T> {
  // Only these mean what the result reports; any other 2xx leaves the record's fate unknown.
  if (status !== 200 && status !== 201 && status !== 202) {
    throw incompleteCreate(
      path,
      status,
      body,
      idempotencyKey,
      'a recognised status (200, 201 or 202)',
    )
  }
  const data = (body as { data?: unknown } | undefined)?.data
  if (status === 202) {
    const id = (data as { approval_request_id?: unknown } | undefined)?.approval_request_id
    if (typeof id !== 'string' || id === '') {
      throw incompleteCreate(path, status, body, idempotencyKey, 'an approval_request_id')
    }
    return { status: 'pending_approval', approvalRequestId: id, idempotencyKey }
  }
  if (typeof data !== 'object' || data === null) {
    throw incompleteCreate(path, status, body, idempotencyKey, 'the created record')
  }
  return { status: status === 200 ? 'replayed' : 'created', data: data as T, idempotencyKey }
}
