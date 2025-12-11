import type { BlockOutput } from '@/blocks/types';
import type { SerializedWorkflow } from '@/serializer/types';
import type { ExecutionContext, BlockLog } from '@/executor/types';
import {
  AgentBlockHandler,
  ApiBlockHandler,
  ConditionBlockHandler,
  EvaluatorBlockHandler,
  FunctionBlockHandler,
  GenericBlockHandler,
  LoopBlockHandler,
  ParallelBlockHandler,
  ResponseBlockHandler,
  RouterBlockHandler,
  TriggerBlockHandler,
  WorkflowBlockHandler
} from '@/executor/handlers';
import { InputResolver } from '@/executor/resolver/resolver';
import { PathTracker } from '@/executor/path/path';
import { LoopManager } from '@/executor/loops/loops';
import { BlockPathCalculator } from '@/lib/block-path-calculator';
import { createLogger } from '@/lib/logs/console/logger';
import { loadDeployedWorkflowState } from '@/lib/workflows/db-helpers';
import { mergeSubblockState } from '@/stores/workflows/server-utils';
import { db } from '@/db';
import { environment as environmentTable, webhook } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { decryptSecret } from '@/lib/utils';
import { Serializer } from '@/serializer';
import { LoggingSession } from '@/lib/logs/execution/logging-session';
import { fetchAndProcessAirtablePayloads, formatWebhookInput } from '@/lib/webhooks/utils';

const logger = createLogger('TemporalActivities');

export async function fetchWorkflowContext(workflowId: string, userId: string, input: any) {
    logger.info(`Fetching context for workflow ${workflowId}`);

    const deployedData = await loadDeployedWorkflowState(workflowId);
    const { blocks, edges, loops, parallels } = deployedData;
    const mergedStates = mergeSubblockState(blocks);

    const [userEnv] = await db
      .select()
      .from(environmentTable)
      .where(eq(environmentTable.userId, userId))
      .limit(1);

    const variables = (userEnv?.variables as Record<string, string>) || {};
    const decryptedEnvVars: Record<string, string> = {};

    for (const [key, encryptedValue] of Object.entries(variables)) {
      try {
        const { decrypted } = await decryptSecret(encryptedValue);
        decryptedEnvVars[key] = decrypted;
      } catch (error) {
        logger.error(`Failed to decrypt env var ${key}`, error);
      }
    }

    const serializer = new Serializer();
    const serializedWorkflow = serializer.serializeWorkflow(
      mergedStates,
      edges,
      loops,
      parallels,
      true
    );

    return {
        workflow: serializedWorkflow,
        environmentVariables: decryptedEnvVars,
    };
}

export async function startLoggingSessionActivity(
  workflowId: string,
  executionId: string,
  triggerType: any,
  userId: string,
  variables: any
) {
    const loggingSession = new LoggingSession(workflowId, executionId, triggerType);
    await loggingSession.safeStart({ userId, variables });
    return true;
}

export async function completeLoggingSessionActivity(
  workflowId: string,
  executionId: string,
  triggerType: any,
  params: any
) {
    const loggingSession = new LoggingSession(workflowId, executionId, triggerType);
    await loggingSession.safeComplete(params);
    return true;
}

export async function processWebhookInputActivity(payload: any, requestId: string) {
    if (payload.provider === 'airtable') {
        const [webhookRecord] = await db
            .select()
            .from(webhook)
            .where(eq(webhook.id, payload.webhookId))
            .limit(1);

        if (!webhookRecord) {
            throw new Error(`Webhook record not found: ${payload.webhookId}`);
        }

        const webhookData = {
            id: payload.webhookId,
            provider: payload.provider,
            providerConfig: webhookRecord.providerConfig,
        };

        const mockWorkflow = {
            id: payload.workflowId,
            userId: payload.userId,
        };

        return await fetchAndProcessAirtablePayloads(webhookData, mockWorkflow, requestId);
    }

    const mockWebhook = {
        provider: payload.provider,
        blockId: payload.blockId,
    };
    const mockWorkflow = {
        id: payload.workflowId,
        userId: payload.userId,
    };
    const mockRequest = {
        headers: new Map(Object.entries(payload.headers)),
    } as any;

    return formatWebhookInput(mockWebhook, mockWorkflow, payload.body, mockRequest);
}

export async function executeBlockActivity(
  blockId: string,
  workflow: SerializedWorkflow,
  contextData: {
    workflowId: string;
    executionId: string;
    userId: string;
    environmentVariables: Record<string, string>;
    workflowVariables: Record<string, any>;
    blockStates: Record<string, any>;
    loopIterations: Record<string, number>;
    loopItems: Record<string, any>;
  }
): Promise<{ output: BlockOutput, logs: BlockLog[] }> {
  logger.info(`Executing block ${blockId} via Temporal Activity`);

  const block = workflow.blocks.find(b => b.id === blockId);
  if (!block) {
    throw new Error(`Block ${blockId} not found in workflow`);
  }

  const blockStatesMap = new Map();
  Object.entries(contextData.blockStates || {}).forEach(([k, v]) => blockStatesMap.set(k, v));

  const loopIterationsMap = new Map();
  Object.entries(contextData.loopIterations || {}).forEach(([k, v]) => loopIterationsMap.set(k, v));

  const loopItemsMap = new Map();
  Object.entries(contextData.loopItems || {}).forEach(([k, v]) => loopItemsMap.set(k, v));

  const executedBlocksSet = new Set<string>(Object.keys(contextData.blockStates || {}));

  const accessibleBlocksMap = BlockPathCalculator.calculateAccessibleBlocksForWorkflow(workflow);
  const loopManager = new LoopManager(workflow.loops || {});

  const resolver = new InputResolver(
    workflow,
    contextData.environmentVariables,
    contextData.workflowVariables,
    loopManager,
    accessibleBlocksMap
  );

  const pathTracker = new PathTracker(workflow);

  const context: ExecutionContext = {
    workflowId: contextData.workflowId,
    executionId: contextData.executionId,
    userId: contextData.userId,
    workflow: workflow,
    blockStates: blockStatesMap,
    blockLogs: [],
    metadata: { startTime: new Date().toISOString() },
    environmentVariables: contextData.environmentVariables,
    workflowVariables: contextData.workflowVariables,
    decisions: { router: new Map(), condition: new Map() },
    loopIterations: loopIterationsMap,
    loopItems: loopItemsMap,
    completedLoops: new Set(),
    executedBlocks: executedBlocksSet,
    activeExecutionPath: new Set(),
  };

  executedBlocksSet.forEach(id => context.activeExecutionPath.add(id));

  const handlers = [
    new TriggerBlockHandler(),
    new AgentBlockHandler(),
    new RouterBlockHandler(pathTracker),
    new ConditionBlockHandler(pathTracker, resolver),
    new EvaluatorBlockHandler(),
    new FunctionBlockHandler(),
    new ApiBlockHandler(),
    new LoopBlockHandler(resolver, pathTracker),
    new ParallelBlockHandler(resolver, pathTracker),
    new ResponseBlockHandler(),
    new WorkflowBlockHandler(),
    new GenericBlockHandler(),
  ];

  const handler = handlers.find(h => h.canHandle(block));
  if (!handler) {
    throw new Error(`No handler found for block type: ${block.metadata?.id}`);
  }

  let inputs = {};
  try {
     inputs = resolver.resolveInputs(block, context);
  } catch (err) {
      logger.warn(`Input resolution warning for block ${blockId}: ${err}`);
  }

  try {
    const result = await handler.execute(block, inputs, context);

    let output = result as BlockOutput;

    if (result && typeof result === 'object' && 'stream' in result) {
       const streamingExec = result as any;
       const reader = streamingExec.stream.getReader();
       const decoder = new TextDecoder();
       let fullContent = '';

       while (true) {
         const { done, value } = await reader.read();
         if (done) break;
         fullContent += decoder.decode(value, { stream: true });
       }

       if (streamingExec.execution?.output) {
           streamingExec.execution.output.content = fullContent;
           output = streamingExec.execution.output;
       } else {
           output = { content: fullContent };
       }
    }

    // Return logs captured in context.blockLogs
    return { output, logs: context.blockLogs };

  } catch (error: any) {
    logger.error(`Block execution failed: ${error}`);
    // Capture logs even on error if any
    return {
        output: { error: String(error) },
        logs: context.blockLogs
    };
  }
}
