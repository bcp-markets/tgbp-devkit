import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // EVM tests each start their own anvil; give a cold start room.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
