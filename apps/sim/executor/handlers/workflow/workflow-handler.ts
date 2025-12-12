import { v4 as uuidv4 } from 'uuid'
import { createLogger } from '@/lib/logs/console/logger'
import { getTemporalClient } from '@/lib/temporal/client'
import type { BlockOutput } from '@/blocks/types'
import { BlockType } from '@/executor/consts'
import type { BlockHandler, ExecutionContext, StreamingExecution } from '@/executor/types'
import type { SerializedBlock } from '@/serializer/types'

const logger = createLogger('WorkflowBlockHandler')

// Maximum allowed depth for nested workflow executions
const MAX_WORKFLOW_DEPTH = 10

/**
 * Handler for workflow blocks that execute other workflows inline via Temporal.
 */
export class WorkflowBlockHandler implements BlockHandler {
  private static executionStack = new Set<string>()

  canHandle(block: SerializedBlock): boolean {
    return block.metadata?.id === BlockType.WORKFLOW
  }

  async execute(
    block: SerializedBlock,
    inputs: Record<string, any>,
    context: ExecutionContext
  ): Promise<BlockOutput | StreamingExecution> {
    logger.info(`Executing workflow block: ${block.id}`)

    const workflowId = inputs.workflowId

    if (!workflowId) {
      throw new Error('No workflow selected for execution')
    }

    try {
      // Check execution depth
      const currentDepth = (context.workflowId?.split('_sub_').length || 1) - 1
      if (currentDepth >= MAX_WORKFLOW_DEPTH) {
        throw new Error(`Maximum workflow nesting depth of ${MAX_WORKFLOW_DEPTH} exceeded`)
      }

      // Check for cycles
      const executionId = `${context.workflowId}_sub_${workflowId}_${block.id}`
      if (WorkflowBlockHandler.executionStack.has(executionId)) {
        throw new Error(`Cyclic workflow dependency detected: ${executionId}`)
      }

      WorkflowBlockHandler.executionStack.add(executionId)

      // Prepare input
      let childWorkflowInput = {}
      if (inputs.input !== undefined) {
        childWorkflowInput = inputs.input
        logger.info(`Passing input to child workflow: ${JSON.stringify(childWorkflowInput)}`)
      }

      const client = await getTemporalClient()

      // Start Child Workflow via Temporal Client
      // We assume context.userId is available (added in previous step)
      if (!context.userId) {
        throw new Error('User ID missing in execution context')
      }

      const handle = await client.start('runWorkflow', {
        args: [
          {
            workflowId,
            userId: context.userId,
            input: childWorkflowInput,
            executionId: uuidv4(), // Generate new execution ID for child
          },
        ],
        taskQueue: 'workflow-execution-queue',
        workflowId: `execution-${executionId}`, // Use unique ID for Temporal
      })

      logger.info(`Started child workflow ${workflowId} (Temporal ID: ${handle.workflowId})`)

      // Wait for result
      const result = await handle.result()

      WorkflowBlockHandler.executionStack.delete(executionId)

      if (result.status !== 'completed') {
        throw new Error(`Child workflow execution failed: ${result.error || 'Unknown error'}`)
      }

      // Map output
      return {
        success: true,
        childWorkflowName: workflowId, // Or fetch name if needed
        result: result.outputs || {},
        // We can try to fetch child trace spans if Temporal logs them somewhere accessible,
        // but for now we rely on the main log.
        // Since LoggingSession writes to DB, the child workflow logs are in DB under its executionId.
      }
    } catch (error: any) {
      logger.error(`Error executing child workflow ${workflowId}:`, error)
      const executionId = `${context.workflowId}_sub_${workflowId}_${block.id}`
      WorkflowBlockHandler.executionStack.delete(executionId)
      throw error
    }
  }
}
