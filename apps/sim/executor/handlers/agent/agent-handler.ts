import { getEnv } from '@/lib/env'
import { createLogger } from '@/lib/logs/console/logger'
import { getAllBlocks } from '@/blocks'
import type { BlockOutput } from '@/blocks/types'
import { BlockType } from '@/executor/consts'
import type {
  AgentInputs,
  Message,
  StreamingConfig,
  ToolInput,
} from '@/executor/handlers/agent/types'
import type { BlockHandler, ExecutionContext, StreamingExecution } from '@/executor/types'
import { transformBlockTool } from '@/providers/utils'
import type { SerializedBlock } from '@/serializer/types'
import { executeTool } from '@/tools'
import { getTool, getToolAsync } from '@/tools/utils'
import { runLangGraphAgent } from '@/lib/langchain/agent'

const logger = createLogger('AgentBlockHandler')

const DEFAULT_MODEL = 'gpt-4o'
const DEFAULT_FUNCTION_TIMEOUT = 5000
const CUSTOM_TOOL_PREFIX = 'custom_'

/**
 * Helper function to collect runtime block outputs and name mappings
 * for tag resolution in custom tools and prompts
 */
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
        // Map both the display name and normalized form
        blockNameMapping[workflowBlock.metadata.name] = id
        const normalized = workflowBlock.metadata.name.replace(/\s+/g, '').toLowerCase()
        blockNameMapping[normalized] = id
      }
    }
  }

  return { blockData, blockNameMapping }
}

/**
 * Handler for Agent blocks that process LLM requests with optional tools.
 */
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

    const formattedTools = await this.formatTools(inputs.tools || [], context)

    // Add executeToolCallback to context for LangChain agent to call back
    const contextWithCallback = {
       ...context,
       executeToolCallback: async (toolDef: any, input: any) => {
          // Re-find the formatted tool to get code or other metadata if needed
          // Or we can embed it in toolDef
          if (toolDef.executeFunction) {
              return await toolDef.executeFunction(input);
          }
          // Default behavior for standard tools?
          // We probably need to map back to executeTool logic.
          return `Executed ${toolDef.name}`;
       }
    };

    try {
        const result = await runLangGraphAgent(inputs, formattedTools, contextWithCallback);

        return {
            content: result.content,
            model: result.model,
            tokens: result.tokens,
            toolCalls: {
                list: (result.toolCalls || []).map((tc: any) => ({
                    name: tc.name,
                    input: tc.args,
                    output: tc.output // If available
                })),
                count: result.toolCalls?.length || 0
            }
        };
    } catch (error: any) {
        logger.error(`LangGraph execution failed: ${error}`);
        throw error;
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

    // Import the utility function
    const { filterSchemaForLLM, mergeToolParameters } = await import('@/tools/params')

    // Create schema excluding user-provided parameters
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
        // Merge user-provided parameters with LLM-generated parameters
        const mergedParams = mergeToolParameters(userProvidedParams, callParams)

        // Collect block outputs for tag resolution
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
          false, // skipProxy
          false, // skipPostProcess
          context // execution context for file processing
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
