import { createLogger } from '@/lib/logs/console/logger'
import { getAllBlocks } from '@/blocks'
import type { BlockOutput } from '@/blocks/types'
import { BlockType } from '@/executor/consts'
import type { AgentInputs, ToolInput } from '@/executor/handlers/agent/types'
import type { BlockHandler, ExecutionContext, StreamingExecution } from '@/executor/types'
import { transformBlockTool } from '@/providers/utils'
import type { SerializedBlock } from '@/serializer/types'
import { executeTool } from '@/tools'
import { getTool, getToolAsync } from '@/tools/utils'

const logger = createLogger('AgentBlockHandler')

const DEFAULT_MODEL = 'gpt-4o'
const DEFAULT_FUNCTION_TIMEOUT = 5000
const CUSTOM_TOOL_PREFIX = 'custom_'

function collectBlockData(context: ExecutionContext): {
  blockData: Record<string, any>
  blockNameMapping: Record<string, string>
} {
  const blockData: Record<string, any> = {}
  const blockNameMapping: Record<string, string> = {}

  for (const [id, state] of context.blockStates.entries()) {
    if (state.output !== undefined) {
      blockData[id] = state.output
      const workflowBlock = context.workflow?.blocks?.find((b) => b.id === id)
      if (workflowBlock?.metadata?.name) {
        blockNameMapping[workflowBlock.metadata.name] = id
        const normalized = workflowBlock.metadata.name.replace(/\s+/g, '').toLowerCase()
        blockNameMapping[normalized] = id
      }
    }
  }

  return { blockData, blockNameMapping }
}

export class AgentBlockHandler implements BlockHandler {
  canHandle(block: SerializedBlock): boolean {
    return block.metadata?.id === BlockType.AGENT
  }

  async execute(
    block: SerializedBlock,
    inputs: AgentInputs,
    context: ExecutionContext
  ): Promise<BlockOutput | StreamingExecution> {
    logger.info(`Executing agent block (LangGraph): ${block.id}`)

    try {
      let result

      if (typeof window === 'undefined') {
        // Server Side
        const formattedTools = await this.formatTools(inputs.tools || [], context)

        const contextWithCallback = {
          ...context,
          executeToolCallback: async (toolDef: any, input: any) => {
            if (toolDef.executeFunction) {
              return await toolDef.executeFunction(input)
            }
            // Fallback for standard tools logic if not wrapped in executeFunction
            // (formatTools wraps them, so this should cover most cases)
            return `Executed ${toolDef.name}`
          },
        }

        // Dynamic import to avoid bundling LangGraph on client
        const { runLangGraphAgent } = await import('@/lib/langchain/agent')
        result = await runLangGraphAgent(inputs, formattedTools, contextWithCallback)
      } else {
        // Client Side: Call API
        // We need to serialize the context properly
        const contextData = {
          workflowId: context.workflowId,
          executionId: context.executionId,
          userId: context.userId,
          blockStates: context.blockStates ? Object.fromEntries(context.blockStates) : {},
        }

        const response = await fetch('/api/agent/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            inputs,
            contextData,
          }),
        })

        if (!response.ok) {
          const err = await response.json()
          throw new Error(err.error || 'Agent execution failed on server')
        }
        result = await response.json()
      }

      return {
        content: result.content,
        model: result.model,
        tokens: result.tokens,
        toolCalls: {
          list: (result.toolCalls || []).map((tc: any) => ({
            name: tc.name,
            input: tc.args,
            output: tc.output,
          })),
          count: result.toolCalls?.length || 0,
        },
      }
    } catch (error: any) {
      logger.error(`LangGraph execution failed: ${error}`)
      throw error
    }
  }

  private async formatTools(inputTools: ToolInput[], context: ExecutionContext): Promise<any[]> {
    if (!Array.isArray(inputTools)) return []

    const tools = await Promise.all(
      inputTools
        .filter((tool) => {
          const usageControl = tool.usageControl || 'auto'
          return usageControl !== 'none'
        })
        .map(async (tool) => {
          if (tool.type === 'custom-tool' && tool.schema) {
            return await this.createCustomTool(tool, context)
          }
          return this.transformBlockTool(tool, context)
        })
    )

    return tools.filter(
      (tool): tool is NonNullable<typeof tool> => tool !== null && tool !== undefined
    )
  }

  private async createCustomTool(tool: ToolInput, context: ExecutionContext): Promise<any> {
    const userProvidedParams = tool.params || {}
    const { filterSchemaForLLM, mergeToolParameters } = await import('@/tools/params')
    const filteredSchema = filterSchemaForLLM(tool.schema.function.parameters, userProvidedParams)

    const toolId = `${CUSTOM_TOOL_PREFIX}${tool.title}`
    const base: any = {
      id: toolId,
      name: tool.schema.function.name,
      description: tool.schema.function.description || '',
      params: userProvidedParams,
      parameters: {
        ...filteredSchema,
        type: tool.schema.function.parameters.type,
      },
      usageControl: tool.usageControl || 'auto',
    }

    if (tool.code) {
      base.executeFunction = async (callParams: Record<string, any>) => {
        const mergedParams = mergeToolParameters(userProvidedParams, callParams)
        const { blockData, blockNameMapping } = collectBlockData(context)

        const result = await executeTool(
          'function_execute',
          {
            code: tool.code,
            ...mergedParams,
            timeout: tool.timeout ?? DEFAULT_FUNCTION_TIMEOUT,
            envVars: context.environmentVariables || {},
            workflowVariables: context.workflowVariables || {},
            blockData,
            blockNameMapping,
            isCustomTool: true,
            _context: { workflowId: context.workflowId },
          },
          false,
          false,
          context
        )

        if (!result.success) {
          throw new Error(result.error || 'Function execution failed')
        }
        return result.output
      }
    }

    return base
  }

  private async transformBlockTool(tool: ToolInput, context: ExecutionContext) {
    const transformedTool = await transformBlockTool(tool, {
      selectedOperation: tool.operation,
      getAllBlocks,
      getToolAsync: (toolId: string) => getToolAsync(toolId, context.workflowId),
      getTool,
    })

    if (transformedTool) {
      transformedTool.usageControl = tool.usageControl || 'auto'
    }
    return transformedTool
  }
}
