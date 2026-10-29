/**
 * x402 middleware and client, against a fake facilitator. The client tests run
 * on a local anvil chain with MockTgbp, so pause, ban and balance checks read
 * real contract state.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types'
import { SettleError } from '@x402/core/types'
import express from 'express'
import {
  type Address,
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  type PublicClient,
  verifyTypedData,
  type WalletClient,
  zeroAddress,
} from 'viem'
import { foundry } from 'viem/chains'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { sellerApp } from '../examples/x402-seller/seller.js'
import { createSpendGuard, type SpendGuard, type SpendPolicy } from '../src/agent/index.js'
import { isTgbpKitError } from '../src/errors.js'
import type { EvmTokenDeployment } from '../src/evm/index.js'
import { createTgbpPaymentFetch, quoteTgbpPayment } from '../src/x402/client.js'
import { TGBP_BASE_SEPOLIA, tgbpPaymentMiddleware, tgbpPrice } from '../src/x402/server.js'
import { paymentKey, settleOnce } from '../src/x402/settlement.js'
import { startAnvil } from './anvil.js'
import { mockTgbpAbi, mockTgbpBytecode } from './fixtures/mock-tgbp.js'
import { fakeFacilitator, SETTLE_HASH, serve } from './x402-fakes.js'

const FIVE_PENCE = 5n * 10n ** 16n
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
const PAY_TO = '0x1111111111111111111111111111111111111111'
const PAYER = '0x2222222222222222222222222222222222222222'

/**
 * A payment header for the route's first offer, shaped like an exact-scheme
 * Permit2 payment. The fake facilitator checks no signature, so the server
 * tests need no chain.
 */
async function paymentFor(
  url: string,
  nonce = '1',
  signature = `0x${'cd'.repeat(65)}`,
): Promise<string> {
  const unpaid = await fetch(url)
  const required = decodeHeader(unpaid.headers.get('PAYMENT-REQUIRED')) as {
    resource: unknown
    accepts: [{ amount: string; asset: string; payTo: string }]
  }
  const accepted = required.accepts[0]
  const payload = {
    x402Version: 2,
    resource: required.resource,
    accepted,
    payload: {
      signature,
      permit2Authorization: {
        from: PAYER,
        permitted: { token: accepted.asset, amount: accepted.amount },
        spender: '0x402085c248EeA27D92E8b30b2C58ed07f9E20001',
        nonce,
        deadline: String(Math.floor(Date.now() / 1000) + 300),
        witness: { to: accepted.payTo, validAfter: '0' },
      },
    },
  }
  return Buffer.from(JSON.stringify(payload)).toString('base64')
}

/** A server that answers every request with 402 and these terms, to test what the client refuses to sign. */
async function serveTerms(paymentRequired: Record<string, unknown>) {
  const app = express()
  app.use((_req, res) => {
    const header = Buffer.from(JSON.stringify(paymentRequired)).toString('base64')
    res.status(402).set('PAYMENT-REQUIRED', header).json({})
  })
  return serve(app)
}

function decodeHeader(value: string | null): Record<string, unknown> {
  if (value === null) throw new Error('header missing')
  return JSON.parse(Buffer.from(value, 'base64').toString('utf8'))
}

describe('tgbpPrice', () => {
  it('prices whole pence in base units, through Permit2, under the tGBP EIP-712 domain', () => {
    expect(tgbpPrice(5)).toEqual({
      asset: TGBP_BASE_SEPOLIA.address,
      amount: '50000000000000000',
      extra: { name: 'tGBP', version: '1', assetTransferMethod: 'permit2' },
    })
  })

  it('refuses fractions, zero and negative pence', () => {
    expect(() => tgbpPrice(1.5)).toThrow(RangeError)
    expect(() => tgbpPrice(0)).toThrow(RangeError)
    expect(() => tgbpPrice(-1n)).toThrow(RangeError)
  })
})

describe('tgbpPaymentMiddleware', () => {
  it('answers an unpaid request with 402 and the tGBP payment terms', async () => {
    const { facilitator } = fakeFacilitator('eip155:84532')
    const app = express()
    app.use(
      tgbpPaymentMiddleware({
        routes: { 'GET /quote': { pence: 5, payTo: PAY_TO, description: 'A quote' } },
        facilitator,
      }),
    )
    app.get('/quote', (_req, res) => res.json({ quote: 'paid' }))
    const server = await serve(app)
    try {
      const response = await fetch(`${server.url}/quote`)
      expect(response.status).toBe(402)
      const required = decodeHeader(response.headers.get('PAYMENT-REQUIRED'))
      expect(required).toMatchObject({
        x402Version: 2,
        resource: { url: `${server.url}/quote`, description: 'A quote' },
        accepts: [
          {
            scheme: 'exact',
            network: 'eip155:84532',
            asset: TGBP_BASE_SEPOLIA.address,
            amount: '50000000000000000',
            payTo: PAY_TO,
            maxTimeoutSeconds: 300,
            extra: { name: 'tGBP', version: '1', assetTransferMethod: 'permit2' },
          },
        ],
        extensions: { eip2612GasSponsoring: expect.any(Object) },
      })
    } finally {
      await server.close()
    }
  })

  it('refuses a mainnet token without an explicit facilitator', () => {
    expect(() =>
      tgbpPaymentMiddleware({
        routes: { 'GET /x': { pence: 1, payTo: PAY_TO } },
        token: { ...TGBP_BASE_SEPOLIA, network: 'mainnet' },
      }),
    ).toThrow(TypeError)
  })

  it('refuses a payment window over 600 seconds', () => {
    const { facilitator } = fakeFacilitator('eip155:84532')
    expect(() =>
      tgbpPaymentMiddleware({
        routes: { 'GET /x': { pence: 1, payTo: PAY_TO, maxTimeoutSeconds: 601 } },
        facilitator,
      }),
    ).toThrow(RangeError)
  })

  it('refuses a payTo that is not an EVM address', () => {
    const { facilitator } = fakeFacilitator('eip155:84532')
    expect(() =>
      tgbpPaymentMiddleware({ routes: { 'GET /x': { pence: 1, payTo: 'nope' } }, facilitator }),
    ).toThrow(TypeError)
    expect(() =>
      tgbpPaymentMiddleware({
        routes: { 'GET /x': { pence: 1, payTo: zeroAddress } },
        facilitator,
      }),
    ).toThrow(TypeError)
  })
})

describe('tgbpPaymentMiddleware settlement', () => {
  let fake: ReturnType<typeof fakeFacilitator>
  let server: Awaited<ReturnType<typeof serve>>
  let handled: number

  beforeEach(async () => {
    fake = fakeFacilitator('eip155:84532')
    handled = 0
    const app = express()
    app.use(
      tgbpPaymentMiddleware({
        routes: {
          'GET /quote': { pence: 5, payTo: PAY_TO },
          'GET /other': { pence: 5, payTo: PAY_TO },
        },
        facilitator: fake.facilitator,
      }),
    )
    const answer: express.RequestHandler = (_req, res) => {
      handled += 1
      res.json({ quote: 'paid' })
    }
    app.get('/quote', answer)
    app.get('/other', answer)
    server = await serve(app)
  })

  afterEach(() => server.close())

  const send = (payment: string, path = '/quote') =>
    fetch(`${server.url}${path}`, { headers: { 'PAYMENT-SIGNATURE': payment } })

  it('answers 503 with Retry-After and withholds the response while settlement is pending', async () => {
    fake.pend()
    const response = await send(await paymentFor(`${server.url}/quote`))
    expect(response.status).toBe(503)
    expect(response.headers.get('Retry-After')).toBe('2')
    expect(await response.text()).not.toContain('paid')
    expect(decodeHeader(response.headers.get('PAYMENT-RESPONSE'))).toMatchObject({
      success: false,
      errorReason: 'settlement_pending',
      transaction: SETTLE_HASH,
    })
  })

  it('delivers the response once a retry of the pending payment confirms, without verifying it again', async () => {
    const payment = await paymentFor(`${server.url}/quote`)
    fake.pend()
    expect((await send(payment)).status).toBe(503)

    fake.pend(false)
    const retry = await send(payment)
    expect(retry.status).toBe(200)
    expect(await retry.json()).toEqual({ quote: 'paid' })
    expect(decodeHeader(retry.headers.get('PAYMENT-RESPONSE'))).toMatchObject({
      success: true,
      transaction: SETTLE_HASH,
    })
    // The facilitator saw the payment verified once; a real one would refuse its spent nonce.
    expect(fake.calls.verify).toHaveLength(1)
  })

  it('settles a payment sent twice once, and refuses the second response', async () => {
    const payment = await paymentFor(`${server.url}/quote`)
    expect((await send(payment)).status).toBe(200)

    const replay = await send(payment)
    expect(replay.status).toBe(402)
    expect(await replay.text()).not.toContain('paid')
    expect(fake.calls.settle).toHaveLength(1)
    expect(fake.calls.verify).toHaveLength(1)
  })

  it('refuses a settled payment replayed on another route with the same price', async () => {
    const payment = await paymentFor(`${server.url}/quote`)
    expect((await send(payment)).status).toBe(200)
    expect((await send(payment, '/other')).status).toBe(402)
    expect(fake.calls.settle).toHaveLength(1)
  })

  it('settles the same payment sent twice at once only once', async () => {
    const payment = await paymentFor(`${server.url}/quote`)
    const statuses = (await Promise.all([send(payment), send(payment)])).map((r) => r.status)
    expect(statuses.sort()).toEqual([200, 402])
    expect(fake.calls.settle).toHaveLength(1)
  })

  it('treats a facilitator that throws during settlement as pending, so the same payment can retry', async () => {
    const payment = await paymentFor(`${server.url}/quote`)
    fake.throwOnSettle(new Error('socket hang up'))
    const response = await send(payment)
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('paid')

    fake.throwOnSettle(undefined)
    expect((await send(payment)).status).toBe(200)
    expect(fake.calls.settle).toHaveLength(2)
  })

  it('forgets a payment whose settlement failed, so the facilitator rules on a retry', async () => {
    const payment = await paymentFor(`${server.url}/quote`)
    fake.failSettleWith('invalid_exact_evm_transaction_failed')
    expect((await send(payment)).status).toBe(402)
    expect(handled).toBe(1)
    expect((await send(payment)).status).toBe(402)
    expect(fake.calls.verify).toHaveLength(2)
    expect(fake.calls.settle).toHaveLength(2)
  })

  it('keeps a pending payment pending when a retry is refused, since the first submission may still land', async () => {
    const payment = await paymentFor(`${server.url}/quote`)
    fake.pend()
    expect((await send(payment)).status).toBe(503)

    fake.pend(false)
    fake.failSettleWith('permit2_invalid_nonce')
    const refused = await send(payment)
    expect(refused.status).toBe(503)
    expect(decodeHeader(refused.headers.get('PAYMENT-RESPONSE'))).toMatchObject({
      errorReason: 'settlement_pending',
      transaction: SETTLE_HASH,
    })
  })

  it('keeps a payment pending when its first refusal names a transaction', async () => {
    const payment = await paymentFor(`${server.url}/quote`)
    fake.failSettleWith('invalid_transaction_state', SETTLE_HASH)
    expect((await send(payment)).status).toBe(503)

    fake.failSettleWith('permit2_invalid_nonce')
    expect((await send(payment)).status).toBe(503)
    expect(fake.calls.verify).toHaveLength(1)
  })

  it('treats a facilitator 5xx as pending and a 4xx as a refusal', async () => {
    fake.throwOnSettle(
      new SettleError(502, {
        success: false,
        errorReason: 'unexpected_settle_error',
        transaction: '',
        network: 'eip155:84532',
      }),
    )
    expect((await send(await paymentFor(`${server.url}/quote`, '1'))).status).toBe(503)

    fake.throwOnSettle(
      new SettleError(400, {
        success: false,
        errorReason: 'invalid_exact_evm_payload_signature',
        transaction: '',
        network: 'eip155:84532',
      }),
    )
    expect((await send(await paymentFor(`${server.url}/quote`, '2'))).status).toBe(402)
  })

  it('tells the buyer nothing about why the facilitator failed', async () => {
    fake.throwOnSettle(new Error('connect ECONNREFUSED 10.0.0.7:443'))
    const response = await send(await paymentFor(`${server.url}/quote`))
    expect(response.status).toBe(503)
    expect(JSON.stringify(decodeHeader(response.headers.get('PAYMENT-RESPONSE')))).not.toContain(
      'ECONNREFUSED',
    )
  })

  it('answers another payload under a pending payment with pending, and still settles the original', async () => {
    const original = await paymentFor(`${server.url}/quote`, '7')
    const other = await paymentFor(`${server.url}/quote`, '7', `0x${'ef'.repeat(65)}`)
    fake.pend()
    expect((await send(original)).status).toBe(503)
    // The x402 server asks once more at once when a settlement answers pending.
    expect(fake.calls.settle).toHaveLength(2)

    fake.pend(false)
    expect((await send(other)).status).toBe(503)
    expect(fake.calls.settle).toHaveLength(2)

    expect((await send(original)).status).toBe(200)
    expect(fake.calls.settle.at(-1)?.payload).toMatchObject({ signature: `0x${'cd'.repeat(65)}` })
  })

  it('keeps payments with different nonces apart', async () => {
    expect((await send(await paymentFor(`${server.url}/quote`, '1'))).status).toBe(200)
    expect((await send(await paymentFor(`${server.url}/quote`, '2'))).status).toBe(200)
    expect(fake.calls.settle).toHaveLength(2)
  })
})

describe('settleOnce', () => {
  const payment = (nonce: string, deadline: number) =>
    ({
      x402Version: 2,
      accepted: { network: 'eip155:84532' },
      payload: { permit2Authorization: { from: PAYER, nonce, deadline: String(deadline) } },
    }) as unknown as PaymentPayload
  const requirements = { network: 'eip155:84532' } as unknown as PaymentRequirements

  it('identifies a Permit2 payment by network, payer and nonce, however the nonce is spelt', () => {
    expect(paymentKey(payment('0x01', 0))).toBe(paymentKey(payment('1', 0)))
    expect(paymentKey(payment('1', 0))).not.toBe(paymentKey(payment('2', 0)))
  })

  it('forgets a settled payment ten minutes after its deadline', async () => {
    const fake = fakeFacilitator('eip155:84532')
    let time = 1_000_000_000_000
    const guarded = settleOnce(fake.facilitator, () => time)
    const paid = payment('1', time / 1000 + 300)

    expect((await guarded.settle(paid, requirements)).success).toBe(true)
    expect(await guarded.verify(paid, requirements)).toMatchObject({
      isValid: false,
      invalidReason: 'payment_already_settled',
    })
    expect(fake.calls.verify).toHaveLength(0)

    time += (300 + 600) * 1000
    await guarded.verify(paid, requirements)
    expect(fake.calls.verify).toHaveLength(1)
  })
})

describe('createTgbpPaymentFetch', () => {
  let anvil: Awaited<ReturnType<typeof startAnvil>>
  let publicClient: PublicClient
  let payerWallet: WalletClient
  let payer: Address
  let emptyWallet: WalletClient
  let token: EvmTokenDeployment
  let fake: ReturnType<typeof fakeFacilitator>
  let server: Awaited<ReturnType<typeof serve>>
  let dir: string
  let ledgerPath: string
  let guard: SpendGuard

  /** Pays x402 to PAY_TO on anvil, up to 15p a day. */
  const policy = (): SpendPolicy => ({
    version: 1,
    expiresAt: '2099-01-01T00:00:00Z',
    actions: ['transfer', 'x402'],
    chains: ['anvil'],
    destinations: [PAY_TO],
    perTransferCap: '0.10',
    dailyCap: '0.15',
    redemptionApprovalAbove: '0',
  })

  beforeAll(async () => {
    anvil = await startAnvil()
    const transport = http(anvil.url)
    publicClient = createPublicClient({ chain: foundry, transport, pollingInterval: 100 })
    // anvil's dev accounts are unlocked, so a JSON-RPC account needs no key in this repo.
    const [first, second] = await createWalletClient({ chain: foundry, transport }).getAddresses()
    if (!first || !second) throw new Error('anvil returned no accounts')
    payer = first
    payerWallet = createWalletClient({ chain: foundry, transport, account: payer })
    emptyWallet = createWalletClient({ chain: foundry, transport, account: second })
  })

  afterAll(() => anvil?.stop())

  beforeEach(async () => {
    const hash = await payerWallet.deployContract({
      abi: mockTgbpAbi,
      bytecode: mockTgbpBytecode,
      account: payer,
      chain: foundry,
    })
    const { contractAddress } = await publicClient.waitForTransactionReceipt({ hash })
    if (!contractAddress) throw new Error('MockTgbp did not deploy')
    token = {
      ...TGBP_BASE_SEPOLIA,
      chain: 'anvil',
      chainId: foundry.id,
      address: getAddress(contractAddress),
    }
    await admin('mint', [payer, 10n * FIVE_PENCE])

    fake = fakeFacilitator(`eip155:${foundry.id}`)
    const app = express()
    app.use(
      tgbpPaymentMiddleware({
        routes: {
          'GET /quote': { pence: 5, payTo: PAY_TO },
          'POST /echo': { pence: 5, payTo: PAY_TO },
          'GET /broken': { pence: 5, payTo: PAY_TO },
        },
        token,
        facilitator: fake.facilitator,
      }),
    )
    app.get('/quote', (_req, res) => res.json({ quote: 'paid' }))
    app.post('/echo', express.text(), (req, res) => res.json({ echo: req.body }))
    app.get('/broken', (_req, res) => res.status(500).json({ error: 'handler failed' }))
    app.get('/free', (_req, res) => res.json({ quote: 'free' }))
    server = await serve(app)

    dir = await mkdtemp(join(tmpdir(), 'tgbp-x402-'))
    ledgerPath = join(dir, 'policy.ledger.jsonl')
    guard = createSpendGuard({ policy: policy(), ledgerPath })
  })

  afterEach(async () => {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  })

  /** Valid terms for the anvil token, for a test to spoil one field of. */
  const terms = (
    accept: Record<string, unknown> = {},
    extensions: unknown = { eip2612GasSponsoring: {} },
  ) => ({
    x402Version: 2,
    resource: { url: 'http://127.0.0.1/quote' },
    accepts: [
      {
        scheme: 'exact',
        network: `eip155:${foundry.id}`,
        asset: token.address,
        amount: FIVE_PENCE.toString(),
        payTo: PAY_TO,
        maxTimeoutSeconds: 300,
        extra: { name: 'tGBP', version: '1', assetTransferMethod: 'permit2' },
        ...accept,
      },
    ],
    ...(extensions === null ? {} : { extensions }),
  })

  async function admin(
    functionName: 'mint' | 'setPaused' | 'setBanned',
    args: readonly unknown[],
  ): Promise<void> {
    const hash = await payerWallet.writeContract({
      address: token.address,
      abi: mockTgbpAbi,
      functionName,
      args,
      account: payer,
      chain: foundry,
    } as never)
    await publicClient.waitForTransactionReceipt({ hash })
  }

  const REASON = { reason: 'a quote for the user' }

  /** A payment fetch that gives every payment a reason. */
  const pay = (maxPencePerRequest = 10, spendGuard = guard) => {
    const fetchPaid = createTgbpPaymentFetch({
      publicClient,
      walletClient: payerWallet,
      maxPencePerRequest,
      token,
      guard: spendGuard,
    })
    return (input: string, init?: RequestInit) => fetchPaid(input, init, REASON)
  }

  it('pays 5p through Permit2 with an EIP-2612 permit for Permit2, and returns the settlement', async () => {
    const { response, settlement } = await pay()(`${server.url}/quote`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ quote: 'paid' })
    expect(settlement).toMatchObject({ success: true, transaction: SETTLE_HASH })

    const [payload] = fake.calls.settle
    if (!payload) throw new Error('the facilitator settled nothing')
    expect(payload.accepted).toMatchObject({ amount: FIVE_PENCE.toString(), payTo: PAY_TO })
    const sponsoring = payload.extensions?.eip2612GasSponsoring as { info: Record<string, string> }
    const permit = sponsoring.info
    expect(permit).toMatchObject({
      from: payer,
      asset: token.address,
      spender: PERMIT2,
      amount: FIVE_PENCE.toString(),
    })
    const valid = await verifyTypedData({
      address: payer,
      domain: { name: 'tGBP', version: '1', chainId: foundry.id, verifyingContract: token.address },
      types: {
        Permit: [
          { name: 'owner', type: 'address' },
          { name: 'spender', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      primaryType: 'Permit',
      message: {
        owner: payer,
        spender: PERMIT2,
        value: FIVE_PENCE,
        nonce: BigInt(permit.nonce ?? '0'),
        deadline: BigInt(permit.deadline ?? '0'),
      },
      signature: permit.signature as `0x${string}`,
    })
    expect(valid).toBe(true)
  })

  it('passes a free route through without paying', async () => {
    const { response, settlement } = await pay()(`${server.url}/free`)
    expect(response.status).toBe(200)
    expect(settlement).toBeUndefined()
    expect(fake.calls.verify).toHaveLength(0)
  })

  it('throws TOKEN_PAUSED and signs nothing when the token is paused', async () => {
    await admin('setPaused', [true])
    await expect(pay()(`${server.url}/quote`)).rejects.toMatchObject({ code: 'TOKEN_PAUSED' })
    expect(fake.calls.verify).toHaveLength(0)
  })

  it('throws ADDRESS_BANNED and signs nothing when the payer is banned', async () => {
    await admin('setBanned', [payer, true])
    await expect(pay()(`${server.url}/quote`)).rejects.toMatchObject({
      code: 'ADDRESS_BANNED',
      details: { address: payer },
    })
    expect(fake.calls.verify).toHaveLength(0)
  })

  it('throws ADDRESS_BANNED when the payee is banned', async () => {
    await admin('setBanned', [PAY_TO, true])
    await expect(pay()(`${server.url}/quote`)).rejects.toMatchObject({
      code: 'ADDRESS_BANNED',
      details: { address: PAY_TO },
    })
  })

  it('throws INSUFFICIENT_BALANCE when the payer holds less than the price', async () => {
    const payFromEmpty = createTgbpPaymentFetch({
      publicClient,
      walletClient: emptyWallet,
      maxPencePerRequest: 10,
      token,
      guard,
    })
    await expect(payFromEmpty(`${server.url}/quote`, undefined, REASON)).rejects.toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
    })
  })

  it('throws PAYMENT_OVER_LIMIT when the price is above the limit', async () => {
    await expect(pay(4)(`${server.url}/quote`)).rejects.toMatchObject({
      code: 'PAYMENT_OVER_LIMIT',
    })
    expect(fake.calls.verify).toHaveLength(0)
  })

  it("throws PAYMENT_OVER_LIMIT when the price is above the call's own maxPence", async () => {
    const fetchPaid = createTgbpPaymentFetch({
      publicClient,
      walletClient: payerWallet,
      maxPencePerRequest: 10,
      token,
      guard,
    })
    await expect(
      fetchPaid(`${server.url}/quote`, undefined, { ...REASON, maxPence: 4 }),
    ).rejects.toMatchObject({ code: 'PAYMENT_OVER_LIMIT', details: { limit: 4n * 10n ** 16n } })
    expect(fake.calls.verify).toHaveLength(0)
    expect(await guard.budget()).toMatchObject({ spent: '0' })
  })

  it('quotes a route without signing or asking the guard', async () => {
    const quote = await quoteTgbpPayment(`${server.url}/quote`, undefined, { token })
    expect(quote).toEqual({
      free: false,
      url: `${server.url}/quote`,
      amount: FIVE_PENCE,
      payTo: getAddress(PAY_TO),
      network: `eip155:${foundry.id}`,
    })
    expect(await quoteTgbpPayment(`${server.url}/free`, undefined, { token })).toEqual({
      free: true,
      url: `${server.url}/free`,
      status: 200,
    })
    expect(fake.calls.verify).toHaveLength(0)
    expect(await guard.budget()).toMatchObject({ spent: '0' })
  })

  it('throws PAYMENT_REFUSED with the reason when the facilitator rejects the payment', async () => {
    fake.refuseWith('permit2_invalid_signature')
    const error = await pay()(`${server.url}/quote`).catch((e: unknown) => e)
    expect(error).toMatchObject({
      code: 'PAYMENT_REFUSED',
      details: { payer, payTo: PAY_TO, amount: FIVE_PENCE, deadline: expect.any(Number) },
    })
    expect(fake.calls.settle).toHaveLength(0)
  })

  it('throws PAYMENT_REFUSED with the reason when settlement fails', async () => {
    fake.failSettleWith('invalid_exact_evm_transaction_failed')
    await expect(pay()(`${server.url}/quote`)).rejects.toMatchObject({
      code: 'PAYMENT_REFUSED',
      details: { reason: 'invalid_exact_evm_transaction_failed' },
    })
    expect(fake.calls.settle).toHaveLength(1)
  })

  it('throws PAYMENT_NOT_OFFERED when the server asks for another asset', async () => {
    const wrongToken = createTgbpPaymentFetch({
      publicClient,
      walletClient: payerWallet,
      maxPencePerRequest: 10,
      token: { ...token, address: PAY_TO },
      guard,
    })
    await expect(wrongToken(`${server.url}/quote`, undefined, REASON)).rejects.toMatchObject({
      code: 'PAYMENT_NOT_OFFERED',
    })
  })

  it('pays the example seller 5p for a quote', async () => {
    const seller = await serve(sellerApp({ payTo: PAY_TO, token, facilitator: fake.facilitator }))
    try {
      expect(await (await fetch(`${seller.url}/health`)).json()).toEqual({ ok: true })
      const { response, settlement } = await pay()(`${seller.url}/quote`)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ paidWith: '5p of test tGBP' })
      expect(settlement).toMatchObject({ success: true, transaction: SETTLE_HASH })
      expect(fake.calls.settle[0]?.accepted).toMatchObject({
        amount: FIVE_PENCE.toString(),
        payTo: PAY_TO,
      })
    } finally {
      await seller.close()
    }
  })

  it('sends a POST body again with the payment', async () => {
    const { response } = await pay()(`${server.url}/echo`, { method: 'POST', body: 'hello' })
    expect(await response.json()).toEqual({ echo: 'hello' })
  })

  it('throws PAYMENT_UNCONFIRMED with the deadline when the paid request reports no settlement', async () => {
    await expect(pay()(`${server.url}/broken`)).rejects.toMatchObject({
      code: 'PAYMENT_UNCONFIRMED',
      details: { payer, amount: FIVE_PENCE, deadline: expect.any(Number) },
    })
  })

  it('makes concurrent payments one at a time, so both settle', async () => {
    const payOnce = pay()
    const results = await Promise.all([
      payOnce(`${server.url}/quote`),
      payOnce(`${server.url}/quote`),
    ])
    expect(results.map((r) => r.response.status)).toEqual([200, 200])
    expect(fake.calls.settle).toHaveLength(2)
  })

  it('refuses a 402 served by another origin after a redirect', async () => {
    const elsewhere = express()
    elsewhere.get('/go', (_req, res) => res.redirect(`${server.url}/quote`))
    const redirector = await serve(elsewhere)
    try {
      await expect(pay()(`${redirector.url}/go`)).rejects.toMatchObject({
        code: 'PAYMENT_NOT_OFFERED',
      })
      expect(fake.calls.verify).toHaveLength(0)
    } finally {
      await redirector.close()
    }
  })

  it.each([
    ['a payment window over 600 seconds', { maxTimeoutSeconds: 601 }],
    ['a payment window given as a string', { maxTimeoutSeconds: '300' }],
    ['an amount in hex', { amount: '0x10' }],
    ['a zero amount', { amount: '0' }],
    [
      'another EIP-712 domain',
      { extra: { name: 'Other', version: '1', assetTransferMethod: 'permit2' } },
    ],
    ['the EIP-3009 transfer method', { extra: { name: 'tGBP', version: '1' } }],
  ])('refuses to sign %s', async (_label, spoil) => {
    const crafted = await serveTerms(terms(spoil))
    try {
      await expect(pay()(`${crafted.url}/quote`)).rejects.toMatchObject({
        code: 'PAYMENT_NOT_OFFERED',
      })
    } finally {
      await crafted.close()
    }
  })

  it('refuses when the server offers no gas sponsoring and Permit2 has no allowance', async () => {
    const crafted = await serveTerms(terms({}, null))
    try {
      await expect(pay()(`${crafted.url}/quote`)).rejects.toMatchObject({
        code: 'PAYMENT_NOT_OFFERED',
        details: { allowance: 0n },
      })
    } finally {
      await crafted.close()
    }
  })

  it('signs nothing when the spend guard refuses the payment', async () => {
    const signed: unknown[] = []
    const counting = {
      ...payerWallet,
      signTypedData: (args: never) => {
        signed.push(args)
        return payerWallet.signTypedData(args)
      },
    } as WalletClient
    const noX402 = createSpendGuard({
      policy: { ...policy(), actions: ['transfer'] },
      ledgerPath,
    })
    const fetchPaid = createTgbpPaymentFetch({
      publicClient,
      walletClient: counting,
      maxPencePerRequest: 10,
      token,
      guard: noX402,
    })
    const error = await fetchPaid(`${server.url}/quote`, undefined, REASON).catch((e: unknown) => e)
    expect(isTgbpKitError(error, 'SPEND_POLICY_DENIED') && error.details.rule).toBe('actions')
    expect(signed).toHaveLength(0)
    expect(fake.calls.verify).toHaveLength(0)
    await expect(readFile(ledgerPath)).rejects.toThrow()

    // The same wallet does sign once the guard allows it, so the count above means something.
    await createTgbpPaymentFetch({
      publicClient,
      walletClient: counting,
      maxPencePerRequest: 10,
      token,
      guard,
    })(`${server.url}/quote`, undefined, REASON)
    expect(signed.length).toBeGreaterThan(0)
  })

  it('signs nothing for a payment that gives no reason', async () => {
    const fetchPaid = createTgbpPaymentFetch({
      publicClient,
      walletClient: payerWallet,
      maxPencePerRequest: 10,
      token,
      guard,
    })
    await expect(fetchPaid(`${server.url}/quote`, undefined, undefined as never)).rejects.toThrow(
      RangeError,
    )
    expect(fake.calls.verify).toHaveLength(0)
  })

  it('refuses to build a payment fetch with no spend guard', () => {
    expect(() =>
      createTgbpPaymentFetch({
        publicClient,
        walletClient: payerWallet,
        maxPencePerRequest: 10,
        token,
      } as never),
    ).toThrow('spend guard')
  })

  it('signs nothing for a payee the policy does not allow', async () => {
    const otherPayee = createSpendGuard({
      policy: { ...policy(), destinations: [payer] },
      ledgerPath,
    })
    const error = await pay(10, otherPayee)(`${server.url}/quote`).catch((e: unknown) => e)
    expect(isTgbpKitError(error, 'SPEND_POLICY_DENIED') && error.details.rule).toBe('destinations')
    expect(fake.calls.verify).toHaveLength(0)
  })

  it('refuses the payment that would pass the daily cap, counting other kit spend', async () => {
    await guard.authorize({
      action: 'transfer',
      chain: 'anvil',
      destination: PAY_TO,
      amount: '0.05',
    })
    const payOnce = pay()
    await payOnce(`${server.url}/quote`)
    await payOnce(`${server.url}/quote`)
    const error = await payOnce(`${server.url}/quote`).catch((e: unknown) => e)
    expect(isTgbpKitError(error, 'SPEND_POLICY_DENIED') && error.details).toMatchObject({
      rule: 'dailyCap',
      spentToday: '0.15',
    })
    expect(fake.calls.settle).toHaveLength(2)
  })

  it('writes a ledger entry for each payment: URL, pence, payee, reason and time', async () => {
    const before = Date.now()
    await pay()(`${server.url}/quote?session=secret`)
    const [line] = (await readFile(ledgerPath, 'utf8')).trim().split('\n')
    const entry = JSON.parse(line ?? '')
    expect(entry).toMatchObject({
      action: 'x402',
      chain: 'anvil',
      url: `${server.url}/quote`,
      pence: '5',
      amount: '0.05',
      destination: PAY_TO,
      reason: REASON.reason,
    })
    expect(Date.parse(entry.at)).toBeGreaterThanOrEqual(before - 1000)
    expect(Date.parse(entry.at)).toBeLessThanOrEqual(Date.now())

    // What was signed is what the ledger recorded.
    const [settled] = fake.calls.settle
    if (!settled) throw new Error('the facilitator settled nothing')
    const signed = (
      settled.payload as {
        permit2Authorization: { permitted: { amount: string }; witness: { to: string } }
      }
    ).permit2Authorization
    expect(BigInt(signed.permitted.amount)).toBe(BigInt(entry.pence) * 10n ** 16n)
    expect(getAddress(signed.witness.to)).toBe(getAddress(entry.destination))
  })

  it('lowers the remaining budget by the price of a payment', async () => {
    await expect(guard.budget()).resolves.toMatchObject({ spent: '0', remaining: '0.15' })
    await pay()(`${server.url}/quote`)
    await expect(guard.budget()).resolves.toMatchObject({ spent: '0.05', remaining: '0.1' })
  })

  it('throws PAYMENT_NOT_OFFERED when a 402 carries no x402 terms', async () => {
    const plain = express()
    plain.use((_req, res) => res.status(402).send('pay me'))
    const bare = await serve(plain)
    try {
      await expect(pay()(`${bare.url}/quote`)).rejects.toMatchObject({
        code: 'PAYMENT_NOT_OFFERED',
      })
    } finally {
      await bare.close()
    }
  })

  it('throws PAYMENT_NOT_OFFERED when the terms list no offers', async () => {
    const crafted = await serveTerms({ x402Version: 2, accepts: null })
    try {
      await expect(pay()(`${crafted.url}/quote`)).rejects.toMatchObject({
        code: 'PAYMENT_NOT_OFFERED',
      })
    } finally {
      await crafted.close()
    }
  })

  it('throws PAYMENT_REFUSED with the deadline when a refusal gives a reason that is not a string', async () => {
    const crafted = await serveTerms({ ...terms(), error: 123 })
    try {
      const error = await pay()(`${crafted.url}/quote`).catch((e: unknown) => e)
      expect(error).toMatchObject({ code: 'PAYMENT_REFUSED', details: { reason: undefined } })
      expect((error as { details: { deadline: unknown } }).details.deadline).toEqual(
        expect.any(Number),
      )
    } finally {
      await crafted.close()
    }
  })
})
