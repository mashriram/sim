import { type NextRequest, NextResponse } from 'next/server'
import { createLogger } from '@/lib/logs/console/logger'
import { AgentBlockHandler } from '@/executor/handlers/agent/agent-handler'

const logger = createLogger('AgentExecuteAPI')

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { inputs, contextData } = body

    logger.info('Executing agent via API', { workflowId: contextData?.workflowId })

    // Reconstruct context
    // We need to map blockStates object back to Map if AgentBlockHandler expects Map
    // collectBlockData expects context.blockStates.entries()
    const blockStates = new Map(Object.entries(contextData.blockStates || {}))

    const context = {
      ...contextData,
      blockStates,
      // Add minimal defaults if needed
      decisions: { router: new Map(), condition: new Map() },
      loopIterations: new Map(),
      loopItems: new Map(),
      completedLoops: new Set(),
      executedBlocks: new Set(),
      activeExecutionPath: new Set(),
      workflow: { blocks: [] }, // Minimal mock if needed, collectBlockData might try to find block in workflow
    }

    // collectBlockData uses context.workflow.blocks to find block names
    // If we want tag resolution to work, we need the workflow blocks.
    // contextData might need to include blocks? Or we fetch them.
    // Fetching here adds latency.
    // For now, if we don't pass blocks, tag resolution for <block.name> might fail or fallback to IDs.
    // Assuming inputs are already resolved (variables replaced) before calling execute?
    // Usually Executor resolves inputs.
    // AgentBlockHandler receives `inputs`.
    // However, custom tools might need `blockData` / `blockNameMapping`.
    // `collectBlockData` builds `blockNameMapping` from `context.workflow`.

    // If we want full functionality, we should probably fetch the workflow or pass block names map from client.
    // Passing blockNames map from client is efficient.
    // I'll assume contextData contains `blockNames` if needed, or we skip it.

    const handler = new AgentBlockHandler()
    // Pass a dummy block object as we only need the ID usually, but AgentBlockHandler doesn't use block properties much except ID for logging
    const dummyBlock = { id: 'api-agent-block', metadata: { id: 'agent' } }

    const result = await handler.execute(dummyBlock as any, inputs, context as any)

    return NextResponse.json(result)
  } catch (error: any) {
    logger.error('Agent execution failed', error)
    return NextResponse.json({ error: error.message || 'Agent execution failed' }, { status: 500 })
  }
}
