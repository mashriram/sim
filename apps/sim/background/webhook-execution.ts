import { v4 as uuidv4 } from 'uuid'
import { getTemporalClient } from '@/lib/temporal/client'
import { createLogger } from '@/lib/logs/console/logger'

const logger = createLogger('TriggerWebhookExecution')

export type WebhookExecutionPayload = {
  webhookId: string
  workflowId: string
  userId: string
  provider: string
  body: any
  headers: Record<string, string>
  path: string
  blockId?: string
}

export async function executeWebhookJob(payload: WebhookExecutionPayload) {
  const executionId = uuidv4()
  const requestId = executionId.slice(0, 8)

  logger.info(`[${requestId}] Starting webhook execution via Temporal`, {
    webhookId: payload.webhookId,
    workflowId: payload.workflowId,
    provider: payload.provider,
    userId: payload.userId,
    executionId,
  })

  try {
    const client = await getTemporalClient()
    const handle = await client.start('runWebhookWorkflow', {
        args: [{ payload, executionId }],
        taskQueue: 'workflow-execution-queue',
        workflowId: `execution-${executionId}`
    })

    logger.info(`[${requestId}] Started Temporal workflow ${handle.workflowId}`)
    return handle
  } catch (error: any) {
    logger.error(`[${requestId}] Webhook execution failed`, error)
    throw error
  }
}

// Legacy task export - keeping it just in case, but it calls new logic
// Ideally we remove this file's "worker" role and just export the function
export const webhookExecution = {
    id: 'webhook-execution',
    run: async (payload: WebhookExecutionPayload) => executeWebhookJob(payload)
}
