/**
 * Reads at most `maxBytes` of a response body as text, and cancels the rest,
 * so a server cannot make the reader hold an unbounded body in memory.
 * Internal; not part of the public API.
 */
export async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: '', truncated: false }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (size <= maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      size += value.byteLength
    }
  } catch (error) {
    // Release the connection; the read error is the one worth reporting.
    await reader.cancel().catch(() => undefined)
    throw error
  }
  const truncated = size > maxBytes
  if (truncated) await reader.cancel()
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { text: new TextDecoder().decode(bytes.subarray(0, maxBytes)), truncated }
}
