import { proxyActivities, log, ApplicationFailure } from '@temporalio/workflow';
import type * as activities from './activities';
import type { SerializedWorkflow, SerializedBlock } from '@/serializer/types';
import type { BlockOutput } from '@/blocks/types';
import type { BlockLog } from '@/executor/types';

// Define activities
const {
  executeBlockActivity,
  fetchWorkflowContext,
  startLoggingSessionActivity,
  completeLoggingSessionActivity,
  processWebhookInputActivity
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '10m',
  retry: {
    initialInterval: '1s',
    maximumInterval: '1m',
    maximumAttempts: 3,
  }
});

function areDependenciesMet(
  block: SerializedBlock,
  workflow: SerializedWorkflow,
  executedBlocks: Set<string>,
  blockStates: Map<string, any>
): boolean {
  const incoming = workflow.connections.filter(c => c.target === block.id);
  if (incoming.length === 0) return true;
  return incoming.every(conn => {
    if (!executedBlocks.has(conn.source)) return false;
    const sourceState = blockStates.get(conn.source);
    if (sourceState?.error && conn.sourceHandle !== 'error') return false;
    if (!sourceState?.error && conn.sourceHandle === 'error') return false;
    return true;
  });
}

// Shared execution logic
async function executeWorkflowLoop(
    workflowDefinition: SerializedWorkflow,
    input: any,
    contextData: any,
    workflowId: string,
    executionId: string,
    triggerType: string
) {
    const executedBlocks = new Set<string>();
    const blockStates = new Map<string, BlockOutput>();
    const allLogs: BlockLog[] = [];
    const startTime = Date.now();

    const starter = workflowDefinition.blocks.find(b => b.metadata?.id === 'starter' || (triggerType === 'webhook' && b.config.params?.triggerMode));
    // For webhooks, we might start at a specific block if provided, or find the trigger block.
    // If input has 'blockId', we use that.
    // However, `runWorkflow` assumes 'starter' block.
    // We should adapt based on trigger type.

    let startBlock = starter;
    // If webhook, maybe finding the block that matches.
    // But typically `input` is fed to the start block.

    if (!startBlock) {
        // Fallback for API workflows
        startBlock = workflowDefinition.blocks.find(b => b.metadata?.id === 'starter');
    }

    if (!startBlock) throw ApplicationFailure.nonRetryable('No starter/trigger block found');

    blockStates.set(startBlock.id, { output: input });
    executedBlocks.add(startBlock.id);

    allLogs.push({
        blockId: startBlock.id,
        blockName: startBlock.metadata?.name || 'Start',
        blockType: startBlock.metadata?.id || 'start',
        startedAt: new Date(startTime).toISOString(),
        endedAt: new Date(startTime).toISOString(),
        durationMs: 0,
        success: true,
        output: input
    });

    let active = true;
    while (active) {
        active = false;

        const pendingBlocks = workflowDefinition.blocks.filter(block => {
            if (executedBlocks.has(block.id)) return false;
            if (block.enabled === false) return false;
            return areDependenciesMet(block, workflowDefinition, executedBlocks, blockStates);
        });

        if (pendingBlocks.length > 0) {
            active = true;

            await Promise.all(pendingBlocks.map(async (block) => {
                log.info(`Executing block ${block.id}`);

                const currentContext = {
                    ...contextData,
                    blockStates: Object.fromEntries(blockStates)
                };

                try {
                    const result = await executeBlockActivity(
                        block.id,
                        workflowDefinition,
                        currentContext
                    );

                    blockStates.set(block.id, result.output);
                    executedBlocks.add(block.id);

                    if (result.logs) {
                        allLogs.push(...result.logs);
                    }
                } catch (err) {
                    log.error(`Block ${block.id} failed`, err);
                    blockStates.set(block.id, { error: String(err) });
                    executedBlocks.add(block.id);
                    allLogs.push({
                        blockId: block.id,
                        blockName: block.metadata?.name || '',
                        blockType: block.metadata?.id || '',
                        startedAt: new Date().toISOString(),
                        endedAt: new Date().toISOString(),
                        durationMs: 0,
                        success: false,
                        error: String(err)
                    });
                }
            }));
        }
    }

    const endTime = Date.now();
    const duration = endTime - startTime;

    const traceSpans = allLogs.map(l => ({
        id: l.blockId,
        name: l.blockName,
        type: 'block',
        startTime: l.startedAt,
        endTime: l.endedAt,
        duration: l.durationMs,
        status: l.success ? 'success' : 'error',
        output: l.output,
        error: l.error ? { message: l.error } : undefined,
        children: []
    }));

    await completeLoggingSessionActivity(
        workflowId,
        executionId,
        triggerType,
        {
            endedAt: new Date(endTime).toISOString(),
            totalDurationMs: duration,
            finalOutput: Object.fromEntries(blockStates),
            traceSpans
        }
    );

    log.info(`Workflow ${workflowId} completed`);
    return {
        status: 'completed',
        outputs: Object.fromEntries(blockStates)
    };
}

export async function runWorkflow(
  params: { workflowId: string; userId: string; input: any; executionId?: string }
): Promise<any> {
  const { workflowId, userId, input } = params;
  const executionId = params.executionId || `exec-${Date.now()}`;

  log.info(`Starting workflow ${workflowId} execution ${executionId}`);

  const context = await fetchWorkflowContext(workflowId, userId, input);

  await startLoggingSessionActivity(
      workflowId,
      executionId,
      'api',
      userId,
      context.environmentVariables
  );

  const contextData = {
    workflowId,
    executionId,
    userId,
    environmentVariables: context.environmentVariables,
    workflowVariables: {},
    blockStates: {},
    loopIterations: {},
    loopItems: {}
  };

  return executeWorkflowLoop(
      context.workflow as SerializedWorkflow,
      input,
      contextData,
      workflowId,
      executionId,
      'api'
  );
}

export async function runWebhookWorkflow(
    params: { payload: any; executionId: string }
): Promise<any> {
    const { payload, executionId } = params;
    const { workflowId, userId } = payload;

    log.info(`Starting webhook workflow ${workflowId} execution ${executionId}`);

    const context = await fetchWorkflowContext(workflowId, userId, {});

    // Process input (Airtable, etc)
    const processedInput = await processWebhookInputActivity(payload, executionId);

    if (!processedInput && payload.provider === 'whatsapp') {
        // Early exit
        return { message: 'No messages in WhatsApp payload' };
    }

    await startLoggingSessionActivity(
        workflowId,
        executionId,
        'webhook',
        userId,
        context.environmentVariables
    );

    const contextData = {
        workflowId,
        executionId,
        userId,
        environmentVariables: context.environmentVariables,
        workflowVariables: {},
        blockStates: {},
        loopIterations: {},
        loopItems: {}
    };

    return executeWorkflowLoop(
        context.workflow as SerializedWorkflow,
        processedInput || {}, // If processedInput is null/undefined, pass empty object or check logic
        contextData,
        workflowId,
        executionId,
        'webhook'
    );
}
