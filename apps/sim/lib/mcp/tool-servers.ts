// This file defines the MCP tool servers that will be available in the application.

interface McpToolServer {
  name: string
  command: string
  args: string[]
}

export const mcpToolServers: McpToolServer[] = [
  {
    name: 'Time Server',
    command: 'uvx',
    args: ['mcp-server-time', '--local-timezone=America/New_York'],
  },
]
