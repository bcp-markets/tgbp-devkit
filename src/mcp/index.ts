// The tGBP MCP server. Needs @modelcontextprotocol/server, zod and viem.
// `tgbp-mcp` runs it over stdio; see the README for its environment.
export { createTgbpMcpServer, type TgbpMcpServerOptions } from './server.js'
