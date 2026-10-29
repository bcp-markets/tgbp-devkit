/** A fake x402 facilitator and a local server, shared by the x402 and MCP tests. */
import type { AddressInfo } from 'node:net'
import type { FacilitatorClient } from '@x402/core/server'
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types'
import type express from 'express'

export const SETTLE_HASH = `0x${'ab'.repeat(32)}` as const

/** Records what the middleware sends it; answers verify and settle as told. */
export function fakeFacilitator(network: string) {
  const calls: { verify: PaymentPayload[]; settle: PaymentPayload[] } = { verify: [], settle: [] }
  let refuse: string | undefined
  let failSettle: string | undefined
  let failSettleTransaction = ''
  let pendSettle = false
  let throwOnSettle: Error | undefined
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
      if (throwOnSettle) throw throwOnSettle
      if (pendSettle) {
        return {
          success: false,
          errorReason: 'settlement_pending',
          transaction: SETTLE_HASH,
          network: requirements.network,
        }
      }
      return failSettle === undefined
        ? { success: true, transaction: SETTLE_HASH, network: requirements.network }
        : {
            success: false,
            errorReason: failSettle,
            transaction: failSettleTransaction,
            network: requirements.network,
          }
    },
  }
  return {
    facilitator,
    calls,
    refuseWith: (reason: string) => (refuse = reason),
    /** Settlement fails with this reason, naming `transaction` if given. */
    failSettleWith: (reason: string, transaction = '') => {
      failSettle = reason
      failSettleTransaction = transaction
    },
    /** Settlement answers "pending" until called with false. */
    pend: (on = true) => (pendSettle = on),
    /** Settlement throws, as a facilitator that times out does, until called with undefined. */
    throwOnSettle: (error: Error | undefined) => (throwOnSettle = error),
  }
}

export async function serve(
  app: express.Express,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      const close = () =>
        new Promise<void>((done) => {
          server.close(() => done())
          server.closeAllConnections()
        })
      resolve({ url: `http://127.0.0.1:${port}`, close })
    })
  })
}
