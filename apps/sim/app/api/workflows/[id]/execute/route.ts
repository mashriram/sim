import { eq, sql } from 'drizzle-orm'
import { type NextRequest, NextResponse } from 'next/server'
import { v4 as uuidv4 } from 'uuid'
import { getSession } from '@/lib/auth'
import { checkServerSideUsageLimits } from '@/lib/billing'
import { createLogger } from '@/lib/logs/console/logger'
import { getTemporalClient } from '@/lib/temporal/client'
import {
  createHttpResponseFromBlock,
  updateWorkflowRunCounts,
  workflowHasResponseBlock,
} from '@/lib/workflows/utils'
import { validateWorkflowAccess } from '@/app/api/workflows/middleware'
import { createErrorResponse, createSuccessResponse } from '@/app/api/workflows/utils'
import { db } from '@/db'
import { subscription, userStats } from '@/db/schema'
import {
  RateLimitError,
  RateLimiter,
  type SubscriptionPlan,
  type TriggerType,
} from '@/services/queue'

const logger = createLogger('WorkflowExecuteAPI')

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Keep track of running executions to prevent duplicate requests
// Use a combination of workflow ID and request ID to allow concurrent executions with different inputs
const runningExecutions = new Set<string>()

// Utility function to filter out logs and workflowConnections from API response
function createFilteredResult(result: any) {
  return {
    ...result,
    logs: undefined,
    metadata: result.metadata
      ? {
          ...result.metadata,
          workflowConnections: undefined,
        }
      : undefined,
  }
}

// Custom error class for usage limit exceeded
class UsageLimitError extends Error {
  statusCode: number
  constructor(message: string, statusCode = 402) {
    super(message)
    this.statusCode = statusCode
  }
}

async function executeWorkflow(workflow: any, requestId: string, input?: any): Promise<any> {
  const workflowId = workflow.id
  const executionId = uuidv4()
  const executionKey = `${workflowId}:${requestId}`

  if (runningExecutions.has(executionKey)) {
    logger.warn(`[${requestId}] Execution is already running: ${executionKey}`)
    throw new Error('Execution is already running')
  }

  // Rate limiting is now handled before entering the sync queue

  const usageCheck = await checkServerSideUsageLimits(workflow.userId)
  if (usageCheck.isExceeded) {
    logger.warn(`[${requestId}] User ${workflow.userId} has exceeded usage limits`, {
      currentUsage: usageCheck.currentUsage,
      limit: usageCheck.limit,
    })
    throw new UsageLimitError(
      usageCheck.message || 'Usage limit exceeded. Please upgrade your plan to continue.'
    )
  }

  logger.info(
    `[${requestId}] Executing workflow via Temporal with input:`,
    input ? JSON.stringify(input, null, 2) : 'No input provided'
  )

  try {
    runningExecutions.add(executionKey)

    const client = await getTemporalClient()
    const handle = await client.start('runWorkflow', {
      args: [{ workflowId, userId: workflow.userId, input, executionId }],
      taskQueue: 'workflow-execution-queue',
      workflowId: `execution-${executionId}`,
    })

    // Wait for result since this is sync execution
    const result = await handle.result()

    // Transform result to expected format
    const executionResult = {
      success: result.status === 'completed',
      output: result.outputs || {},
      metadata: {
        duration: 0, // We could calculate this from result if needed
      },
    }

    if (executionResult.success) {
      await updateWorkflowRunCounts(workflowId)

      await db
        .update(userStats)
        .set({
          totalApiCalls: sql`total_api_calls + 1`,
          lastActive: sql`now()`,
        })
        .where(eq(userStats.userId, workflow.userId))
    }

    return executionResult
  } catch (error: any) {
    logger.error(`[${requestId}] Workflow execution failed: ${workflowId}`, error)
    throw error
  } finally {
    runningExecutions.delete(executionKey)
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = crypto.randomUUID().slice(0, 8)
  const { id } = await params

  try {
    logger.debug(`[${requestId}] GET execution request for workflow: ${id}`)
    const validation = await validateWorkflowAccess(request, id)
    if (validation.error) {
      logger.warn(`[${requestId}] Workflow access validation failed: ${validation.error.message}`)
      return createErrorResponse(validation.error.message, validation.error.status)
    }

    let triggerType: TriggerType = 'manual'
    const session = await getSession()
    if (!session?.user?.id) {
      const apiKeyHeader = request.headers.get('X-API-Key')
      if (apiKeyHeader) {
        triggerType = 'api'
      }
    }

    try {
      if (triggerType === 'api') {
        const [subscriptionRecord] = await db
          .select({ plan: subscription.plan })
          .from(subscription)
          .where(eq(subscription.referenceId, validation.workflow.userId))
          .limit(1)

        const subscriptionPlan = (subscriptionRecord?.plan || 'free') as SubscriptionPlan

        const rateLimiter = new RateLimiter()
        const rateLimitCheck = await rateLimiter.checkRateLimit(
          validation.workflow.userId,
          subscriptionPlan,
          triggerType,
          false
        )

        if (!rateLimitCheck.allowed) {
          throw new RateLimitError(
            `Rate limit exceeded. You have ${rateLimitCheck.remaining} requests remaining. Resets at ${rateLimitCheck.resetAt.toISOString()}`
          )
        }
      }

      const result = await executeWorkflow(validation.workflow, requestId, undefined)

      const hasResponseBlock = workflowHasResponseBlock(result)
      if (hasResponseBlock) {
        return createHttpResponseFromBlock(result)
      }

      const filteredResult = createFilteredResult(result)
      return createSuccessResponse(filteredResult)
    } catch (error: any) {
      if (error.message?.includes('Service overloaded')) {
        return createErrorResponse(
          'Service temporarily overloaded. Please try again later.',
          503,
          'SERVICE_OVERLOADED'
        )
      }
      throw error
    }
  } catch (error: any) {
    logger.error(`[${requestId}] Error executing workflow: ${id}`, error)

    if (error instanceof RateLimitError) {
      return createErrorResponse(error.message, error.statusCode, 'RATE_LIMIT_EXCEEDED')
    }

    if (error instanceof UsageLimitError) {
      return createErrorResponse(error.message, error.statusCode, 'USAGE_LIMIT_EXCEEDED')
    }

    return createErrorResponse(
      error.message || 'Failed to execute workflow',
      500,
      'EXECUTION_ERROR'
    )
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const requestId = crypto.randomUUID().slice(0, 8)
  const logger = createLogger('WorkflowExecuteAPI')
  logger.info(`[${requestId}] Raw request body: `)

  const { id } = await params
  const workflowId = id

  try {
    const validation = await validateWorkflowAccess(request as NextRequest, id)
    if (validation.error) {
      logger.warn(`[${requestId}] Workflow access validation failed: ${validation.error.message}`)
      return createErrorResponse(validation.error.message, validation.error.status)
    }

    const executionMode = request.headers.get('X-Execution-Mode')
    const isAsync = executionMode === 'async'

    const body = await request.text()
    logger.info(`[${requestId}] ${body ? 'Request body provided' : 'No request body provided'}`)

    let input = {}
    if (body) {
      try {
        input = JSON.parse(body)
      } catch (error) {
        logger.error(`[${requestId}] Failed to parse request body as JSON`, error)
        return createErrorResponse('Invalid JSON in request body', 400)
      }
    }

    logger.info(`[${requestId}] Input passed to workflow:`, input)

    let authenticatedUserId: string | null = null
    let triggerType: TriggerType = 'manual'

    const session = await getSession()
    if (session?.user?.id) {
      authenticatedUserId = session.user.id
      triggerType = 'manual'
    } else {
      const apiKeyHeader = request.headers.get('X-API-Key')
      if (apiKeyHeader) {
        authenticatedUserId = validation.workflow.userId
        triggerType = 'api'
      }
    }

    if (!authenticatedUserId) {
      return createErrorResponse('Authentication required', 401)
    }

    const [subscriptionRecord] = await db
      .select({ plan: subscription.plan })
      .from(subscription)
      .where(eq(subscription.referenceId, authenticatedUserId))
      .limit(1)

    const subscriptionPlan = (subscriptionRecord?.plan || 'free') as SubscriptionPlan

    if (isAsync) {
      try {
        const rateLimiter = new RateLimiter()
        const rateLimitCheck = await rateLimiter.checkRateLimit(
          authenticatedUserId,
          subscriptionPlan,
          'api',
          true
        )

        if (!rateLimitCheck.allowed) {
          logger.warn(`[${requestId}] Rate limit exceeded for async execution`, {
            userId: authenticatedUserId,
            remaining: rateLimitCheck.remaining,
            resetAt: rateLimitCheck.resetAt,
          })

          return new Response(
            JSON.stringify({
              error: 'Rate limit exceeded',
              message: `You have exceeded your async execution limit. ${rateLimitCheck.remaining} requests remaining. Limit resets at ${rateLimitCheck.resetAt}.`,
              remaining: rateLimitCheck.remaining,
              resetAt: rateLimitCheck.resetAt,
            }),
            {
              status: 429,
              headers: { 'Content-Type': 'application/json' },
            }
          )
        }

        // Use Temporal for Async
        const executionId = uuidv4()
        const client = await getTemporalClient()
        const handle = await client.start('runWorkflow', {
          args: [{ workflowId, userId: authenticatedUserId, input, executionId }],
          taskQueue: 'workflow-execution-queue',
          workflowId: `execution-${executionId}`,
        })

        logger.info(
          `[${requestId}] Started Temporal workflow ${handle.workflowId} for workflow ${workflowId}`
        )

        return new Response(
          JSON.stringify({
            success: true,
            taskId: handle.workflowId,
            status: 'queued', // Temporal workflow started
            createdAt: new Date().toISOString(),
            links: {
              status: `/api/jobs/${handle.workflowId}`, // Need to map this to new status API
            },
          }),
          {
            status: 202,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      } catch (error: any) {
        logger.error(`[${requestId}] Failed to create Temporal workflow:`, error)
        return createErrorResponse('Failed to queue workflow execution', 500)
      }
    }

    try {
      const rateLimiter = new RateLimiter()
      const rateLimitCheck = await rateLimiter.checkRateLimit(
        authenticatedUserId,
        subscriptionPlan,
        triggerType,
        false
      )

      if (!rateLimitCheck.allowed) {
        throw new RateLimitError(
          `Rate limit exceeded. You have ${rateLimitCheck.remaining} requests remaining. Resets at ${rateLimitCheck.resetAt.toISOString()}`
        )
      }

      const result = await executeWorkflow(validation.workflow, requestId, input)

      const hasResponseBlock = workflowHasResponseBlock(result)
      if (hasResponseBlock) {
        return createHttpResponseFromBlock(result)
      }

      const filteredResult = createFilteredResult(result)
      return createSuccessResponse(filteredResult)
    } catch (error: any) {
      if (error.message?.includes('Service overloaded')) {
        return createErrorResponse(
          'Service temporarily overloaded. Please try again later.',
          503,
          'SERVICE_OVERLOADED'
        )
      }
      throw error
    }
  } catch (error: any) {
    logger.error(`[${requestId}] Error executing workflow: ${workflowId}`, error)

    if (error instanceof RateLimitError) {
      return createErrorResponse(error.message, error.statusCode, 'RATE_LIMIT_EXCEEDED')
    }

    if (error instanceof UsageLimitError) {
      return createErrorResponse(error.message, error.statusCode, 'USAGE_LIMIT_EXCEEDED')
    }

    if (error.message?.includes('Rate limit exceeded')) {
      return createErrorResponse(error.message, 429, 'RATE_LIMIT_EXCEEDED')
    }

    return createErrorResponse(
      error.message || 'Failed to execute workflow',
      500,
      'EXECUTION_ERROR'
    )
  }
}

export async function OPTIONS(_request: NextRequest) {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers':
        'Content-Type, X-API-Key, X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Date, X-Api-Version',
      'Access-Control-Max-Age': '86400',
    },
  })
}
