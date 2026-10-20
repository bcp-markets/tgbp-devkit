import { type ChildProcess, spawn } from 'node:child_process'

/**
 * Starts a throwaway anvil node on a free port and resolves with its URL.
 * Needs Foundry's `anvil` on PATH (CI installs it with foundry-toolchain).
 */
export async function startAnvil(): Promise<{ url: string; stop: () => void }> {
  const child: ChildProcess = spawn('anvil', ['--port', '0', '--block-time', '1'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const url = await new Promise<string>((resolve, reject) => {
    let output = ''
    // Kill the child on failure so a half-started anvil never outlives the test run.
    const fail = (error: Error) => {
      clearTimeout(timer)
      child.kill()
      reject(error)
    }
    const timer = setTimeout(() => fail(new Error(`anvil did not start:\n${output}`)), 20_000)
    child.on('error', fail)
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      const match = /Listening on ([\d.]+:\d+)/.exec(output)
      if (match) {
        clearTimeout(timer)
        resolve(`http://${match[1]}`)
      }
    })
  })
  return { url, stop: () => child.kill() }
}
