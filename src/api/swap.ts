/**
 * The tGBP Swap API client: USDC to tGBP and back. Types come from the
 * published spec, generated into swap.generated.ts.
 */
import {
  assertHttpOptions,
  assertIdempotencyKey,
  generateIdempotencyKey,
  type HttpConfig,
  type HttpOptions,
  type HttpResponse,
  incompleteCreate,
  normaliseBaseUrl,
  request,
} from './http.js'
import type { components, operations } from './swap.generated.js'

type Schemas = components['schemas']
type Query<Op extends keyof operations> = NonNullable<operations[Op]['parameters']['query']>
type Data<T> = { data?: T }

export type SwapQuote = Schemas['Quote']
export type SwapLimits = Schemas['SwapLimits']
export type SupportedNetwork = Schemas['SupportedNetwork']
export type DepositSession = Schemas['DepositSession']
export type Deposit = Schemas['Deposit']
export type DepositBalance = Schemas['DepositBalance']
export type SwapIntent = Schemas['SwapIntent']
export type Conversion = Schemas['Conversion']
/** `id` is the swap intent's idempotency key; the client generates one if you omit it. */
export type CreateSwapIntentRequest = Omit<Schemas['CreateSwapIntentRequest'], 'id'> & {
  id?: string
}
export type CreateConversionRequest = Schemas['CreateConversionRequest']
export type SwapQuoteQuery = Query<'getQuote'>
export type ListDepositsQuery = Query<'listDeposits'>
export type DepositBalanceQuery = Query<'getDepositBalance'>

/** The swap API's SwapIntentId format. */
const SWAP_INTENT_ID = /^[A-Za-z0-9_-]{6,128}$/

export const SWAP_PRODUCTION_URL = 'https://swap-api.tgbp.io'

export type TgbpSwapClientOptions = HttpOptions & {
  /** Defaults to production. For staging, pass the swap host from your onboarding pack. */
  baseUrl?: string
}

export interface SwapCreateResult<T> {
  data: T
  /** The key the request was sent with. Keep it to retry the same request. */
  idempotencyKey: string
}

export function createTgbpSwapClient(options: TgbpSwapClientOptions) {
  assertHttpOptions(options)
  const config: HttpConfig = {
    ...options,
    baseUrl: normaliseBaseUrl(options.baseUrl ?? SWAP_PRODUCTION_URL),
  }

  const get = async <T>(path: string, query?: object, pathParams?: Record<string, string>) =>
    (
      await request<Data<T>>(config, {
        method: 'GET',
        path,
        pathParams,
        query: query as never,
        retry: true,
      })
    ).body

  return {
    getQuote: (query: SwapQuoteQuery) => get<SwapQuote>('/api/quote', query),
    getLimits: () => get<SwapLimits>('/api/limits'),
    getSupportedNetworks: () => get<SupportedNetwork[]>('/api/supported-networks'),
    getDepositSession: () => get<DepositSession>('/api/deposit-session'),
    /** Creates or recovers your deposit address (per the swap API reference), so a repeat is safe. */
    createDepositAddress: async () =>
      (
        await request<Data<DepositSession>>(config, {
          method: 'POST',
          path: '/api/deposit-session/address',
          retry: true,
        })
      ).body,
    listDeposits: (query: ListDepositsQuery) => get<Deposit[]>('/api/deposits', query),
    /** The balance deposited to your swap deposit address on one chain. */
    getDepositBalance: (query: DepositBalanceQuery) =>
      get<DepositBalance>('/api/deposit-balance', query),
    /**
     * Fix a firm quote before you fund a swap. The swap API dedupes intents
     * on `id`, so a retry with the same `id` returns the same intent.
     */
    createSwapIntent: async (
      body: CreateSwapIntentRequest,
    ): Promise<SwapCreateResult<SwapIntent>> => {
      const id = body.id ?? generateIdempotencyKey()
      if (!SWAP_INTENT_ID.test(id)) {
        throw new RangeError(
          `Invalid swap intent id "${id}": use 6 to 128 letters, digits, "_" or "-"`,
        )
      }
      const res = await request<Data<SwapIntent>>(config, {
        method: 'POST',
        path: '/api/swap-intents',
        body: { ...body, id },
        dedupeKey: { name: 'swapIntentId', value: id },
        retry: true,
      })
      const data = requireData(res, '/api/swap-intents', id)
      return { data, idempotencyKey: id }
    },
    getSwapIntent: (id: string) => get<SwapIntent>('/api/swap-intents/{id}', undefined, { id }),
    /** Cancel an unfunded swap intent. Not retried: the reference does not say a repeat is safe. */
    cancelSwapIntent: async (id: string) =>
      (
        await request<Data<SwapIntent>>(config, {
          method: 'POST',
          path: '/api/swap-intents/{id}/cancel',
          pathParams: { id },
          retry: false,
        })
      ).body,
    /** Accept a swap for a confirmed deposit and settle it to the recipient. */
    createConversion: async (
      body: CreateConversionRequest,
      opts: { idempotencyKey?: string } = {},
    ): Promise<SwapCreateResult<Conversion>> => {
      const idempotencyKey = opts.idempotencyKey ?? generateIdempotencyKey()
      assertIdempotencyKey(idempotencyKey)
      const res = await request<Data<Conversion>>(config, {
        method: 'POST',
        path: '/api/conversions',
        body,
        idempotencyKey,
        retry: true,
      })
      return { data: requireData(res, '/api/conversions', idempotencyKey), idempotencyKey }
    },
  }
}

export type TgbpSwapClient = ReturnType<typeof createTgbpSwapClient>

function requireData<T>(res: HttpResponse<Data<T>>, path: string, key: string): T {
  const data = res.body?.data
  if (typeof data !== 'object' || data === null) {
    throw incompleteCreate(path, res.status, res.body, key, 'the created record')
  }
  return data
}
