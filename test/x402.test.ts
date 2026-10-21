/**
 * x402 middleware and client, against a fake facilitator. The client tests run
 * on a local anvil chain with MockTgbp, so pause, ban and balance checks read
 * real contract state.
 */
import type { AddressInfo } from 'node:net'
import type { FacilitatorClient } from '@x402/core/server'
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types'
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
} from 'viem'
import { foundry } from 'viem/chains'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { EvmTokenDeployment } from '../src/evm/index.js'
import { createTgbpPaymentFetch } from '../src/x402/client.js'
import { TGBP_BASE_SEPOLIA, tgbpPaymentMiddleware, tgbpPrice } from '../src/x402/server.js'
import { startAnvil } from './anvil.js'
import { mockTgbpAbi, mockTgbpBytecode } from './fixtures/mock-tgbp.js'

const FIVE_PENCE = 5n * 10n ** 16n
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
const PAY_TO = '0x1111111111111111111111111111111111111111'
const SETTLE_HASH = `0x${'ab'.repeat(32)}` as const

/** Records what the middleware sends it; answers verify and settle as told. */
function fakeFacilitator(network: string) {
  const calls: { verify: PaymentPayload[]; settle: PaymentPayload[] } = { verify: [], settle: [] }
  let refuse: string | undefined
  const facilitator: FacilitatorClient = {
    getSupported: async () => ({
      kinds: [{ x402Version: 2, scheme: 'exact', network: network as `${string}:${string}` }],
      extensions: ['eip2612GasSponsoring'],
      signers: {},
    }),
    verify: async (payload: PaymentPayload, _requirements: PaymentRequirements) => {
      calls.verify.push(payload)
      return refuse === undefined
        ? { isValid: true, payer: payload.payload.from as string }
        : { isValid: false, invalidReason: refuse }
    },
    settle: async (payload: PaymentPayload, requirements: PaymentRequirements) => {
      calls.settle.push(payload)
      return { success: true, transaction: SETTLE_HASH, network: requirements.network }
    },
  }
  return { facilitator, calls, refuseWith: (reason: string) => (refuse = reason) }
}

async function serve(app: express.Express): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() })
    })
  })
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
      server.close()
    }
  })

  it('refuses a payTo that is not an EVM address', () => {
    const { facilitator } = fakeFacilitator('eip155:84532')
    expect(() =>
      tgbpPaymentMiddleware({ routes: { 'GET /x': { pence: 1, payTo: 'nope' } }, facilitator }),
    ).toThrow(TypeError)
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
        routes: { 'GET /quote': { pence: 5, payTo: PAY_TO } },
        token,
        facilitator: fake.facilitator,
      }),
    )
    app.get('/quote', (_req, res) => res.json({ quote: 'paid' }))
    app.get('/free', (_req, res) => res.json({ quote: 'free' }))
    server = await serve(app)
  })

  afterEach(() => server.close())

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

  const pay = (maxPencePerRequest = 10) =>
    createTgbpPaymentFetch({ publicClient, walletClient: payerWallet, maxPencePerRequest, token })

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
    })
    await expect(payFromEmpty(`${server.url}/quote`)).rejects.toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
    })
  })

  it('throws PAYMENT_OVER_LIMIT when the price is above the limit', async () => {
    await expect(pay(4)(`${server.url}/quote`)).rejects.toMatchObject({
      code: 'PAYMENT_OVER_LIMIT',
    })
    expect(fake.calls.verify).toHaveLength(0)
  })

  it('throws PAYMENT_REFUSED with the reason when the facilitator rejects the payment', async () => {
    fake.refuseWith('permit2_invalid_signature')
    await expect(pay()(`${server.url}/quote`)).rejects.toMatchObject({
      code: 'PAYMENT_REFUSED',
    })
    expect(fake.calls.settle).toHaveLength(0)
  })

  it('throws PAYMENT_NOT_OFFERED when the server asks for another asset', async () => {
    const wrongToken = createTgbpPaymentFetch({
      publicClient,
      walletClient: payerWallet,
      maxPencePerRequest: 10,
      token: { ...token, address: PAY_TO },
    })
    await expect(wrongToken(`${server.url}/quote`)).rejects.toMatchObject({
      code: 'PAYMENT_NOT_OFFERED',
    })
  })
})
