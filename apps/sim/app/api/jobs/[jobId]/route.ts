import { eq } from 'drizzle-orm'
import { type NextRequest, NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { createLogger } from '@/lib/logs/console/logger'
import { getTemporalClient } from '@/lib/temporal/client'
import { createErrorResponse } from '@/app/api/workflows/utils'
import { db } from '@/db'
import { apiKey as apiKeyTable } from '@/db/schema'

const logger = createLogger('TaskStatusAPI')

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId: taskId } = await params
  const requestId = crypto.randomUUID().slice(0, 8)

  try {
    logger.debug(`[${requestId}] Getting status for task: ${taskId}`)

    const session = await getSession()
    let authenticatedUserId: string | null = session?.user?.id || null

    if (!authenticatedUserId) {
      const apiKeyHeader = request.headers.get('x-api-key')
      if (apiKeyHeader) {
        const [apiKeyRecord] = await db
          .select({ userId: apiKeyTable.userId })
          .from(apiKeyTable)
          .where(eq(apiKeyTable.key, apiKeyHeader))
          .limit(1)

        if (apiKeyRecord) {
          authenticatedUserId = apiKeyRecord.userId
        }
      }
    }

    if (!authenticatedUserId) {
      return createErrorResponse('Authentication required', 401)
    }

    const client = await getTemporalClient()
    const handle = client.workflow.getHandle(`execution-${taskId}`)

    let description
    try {
      description = await handle.describe()
    } catch (e: any) {
      if (e.code === 5 || e.message?.includes('not found')) {
        return createErrorResponse('Task not found', 404)
      }
      throw e
    }

    const statusMap: Record<string, string> = {
      RUNNING: 'processing',
      COMPLETED: 'completed',
      FAILED: 'failed',
      CANCELLED: 'cancelled',
      TERMINATED: 'failed',
      TIMED_OUT: 'failed',
      CONTINUED_AS_NEW: 'processing',
    }

    const mappedStatus = statusMap[description.status.name] || 'unknown'

    const response: any = {
      success: true,
      taskId,
      status: mappedStatus,
      metadata: {
        startedAt: description.startTime.toISOString(),
      },
    }

    if (mappedStatus === 'completed') {
      // We need the result. For completed workflows, handle.result() returns it.
      try {
        const result = await handle.result()
        response.output = result.outputs
        response.metadata.completedAt = description.closeTime?.toISOString()
      } catch (e) {
        // Should not happen if status is completed
      }
    }

    if (mappedStatus === 'failed') {
      // Can we get error details?
      response.error = 'Workflow execution failed'
      response.metadata.completedAt = description.closeTime?.toISOString()
    }

    if (mappedStatus === 'processing') {
      response.estimatedDuration = 180000
    }

    return NextResponse.json(response)
  } catch (error: any) {
    logger.error(`[${requestId}] Error fetching task status:`, error)
    return createErrorResponse('Failed to fetch task status', 500)
  }
}
