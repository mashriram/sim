import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage, AIMessage, BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { AgentInputs } from '@/executor/handlers/agent/types';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { ensureZodObject } from '../json-schema-utils';
import { createLogger } from '@/lib/logs/console/logger';

const logger = createLogger('LangChainAgent');

// Helper to get the LangChain model instance based on string
export function getChatModel(inputs: AgentInputs): BaseChatModel {
  const modelName = inputs.model || 'gpt-4o';

  // Azure OpenAI Support
  if (inputs.azureEndpoint || modelName.includes('azure')) {
      return new ChatOpenAI({
          modelName,
          azureOpenAIApiKey: inputs.apiKey,
          azureOpenAIApiInstanceName: inputs.azureEndpoint,
          azureOpenAIApiVersion: inputs.azureApiVersion,
          temperature: inputs.temperature,
          maxTokens: inputs.maxTokens,
          configuration: {
              baseURL: inputs.azureEndpoint
          }
      });
  }

  // Map common model names to provider classes
  if (modelName.startsWith('gpt-')) {
    return new ChatOpenAI({
      modelName,
      openAIApiKey: inputs.apiKey,
      temperature: inputs.temperature,
      maxTokens: inputs.maxTokens,
      configuration: {
        baseURL: inputs.azureEndpoint
      }
    });
  } else if (modelName.startsWith('claude-')) {
    return new ChatAnthropic({
      modelName,
      anthropicApiKey: inputs.apiKey,
      temperature: inputs.temperature,
      maxTokens: inputs.maxTokens,
    });
  }

  // Generic Fallback (OpenAI Compatible)
  return new ChatOpenAI({
    modelName,
    openAIApiKey: inputs.apiKey || 'dummy',
    temperature: inputs.temperature,
    configuration: {
       baseURL: inputs.azureEndpoint
    }
  });
}

// Helper to create tools
export function createLangChainTools(toolsInput: any[], context: any): DynamicStructuredTool[] {
  return toolsInput.map(t => {
     let schema = z.any();
     try {
       if (t.schema) {
         // Parameters are usually in t.schema.function.parameters for OpenAI style tools
         // or t.schema itself
         const params = t.schema.function?.parameters || t.schema;
         schema = ensureZodObject(logger, params);
       }
     } catch (e) {
       logger.warn(`Failed to convert tool schema for ${t.title || 'unknown'}: ${e}`);
     }

     return new DynamicStructuredTool({
       name: t.schema?.function?.name || t.title || 'unknown_tool',
       description: t.schema?.function?.description || '',
       schema,
       func: async (input) => {
         if (context.executeToolCallback) {
            return await context.executeToolCallback(t, input);
         }
         return `Tool ${t.title} executed with input ${JSON.stringify(input)}`;
       }
     });
  });
}

export async function runLangGraphAgent(
  inputs: AgentInputs,
  tools: any[], // Internal tool definitions
  context: any
) {
  const model = getChatModel(inputs);
  const lcTools = createLangChainTools(tools || [], context);

  // Initialize Checkpointer (Memory)
  const checkpointer = (inputs as any).enableMemory ? new MemorySaver() : undefined;

  // Use createReactAgent (LangGraph v1 Prebuilt)
  // This automatically sets up the Agent -> Tool -> Agent loop with tool binding
  const agent = createReactAgent({
      llm: model,
      tools: lcTools,
      checkpointSaver: checkpointer,
      // We can inject state modifier (system prompt) here
      stateModifier: inputs.systemPrompt,
  });

  // Initial messages
  const initialMessages: BaseMessage[] = [];

  // Convert internal messages (memories)
  if (inputs.memories) {
      const mems = Array.isArray(inputs.memories) ? inputs.memories : inputs.memories?.memories || [];
      mems.forEach((m: any) => {
          if (m.role === 'user') initialMessages.push(new HumanMessage(m.content));
          if (m.role === 'system') initialMessages.push(new SystemMessage(m.content));
          if (m.role === 'assistant') initialMessages.push(new AIMessage(m.content));
      });
  }

  // If system prompt is not handled by stateModifier (e.g. specialized layout), add it here
  // But createReactAgent handles stateModifier as system prompt mostly.
  // We'll trust stateModifier for system prompt.

  if (inputs.userPrompt) {
      const content = typeof inputs.userPrompt === 'string' ? inputs.userPrompt : JSON.stringify(inputs.userPrompt);
      initialMessages.push(new HumanMessage(content));
  }

  // Ensure there is at least one message
  if (initialMessages.length === 0 && !inputs.systemPrompt) {
      initialMessages.push(new HumanMessage("Hello"));
  }

  // Invoke with config
  // Thread ID required if checkpointer is used
  // We use workflowId or executionId as thread_id if available in context
  const threadId = context.executionId || "default-thread";
  const config = checkpointer ? { configurable: { thread_id: threadId } } : undefined;

  const result = await agent.invoke({ messages: initialMessages }, config);

  // Result in createReactAgent is the final state
  const messages = result.messages;
  const lastMsg = messages[messages.length - 1];

  const usage = lastMsg.response_metadata?.tokenUsage || {};

  return {
    content: lastMsg.content,
    model: inputs.model,
    tokens: {
        prompt: usage.promptTokens || 0,
        completion: usage.completionTokens || 0,
        total: usage.totalTokens || 0
    },
    // Extract tool calls from the conversation history
    toolCalls: messages
        .filter((m: any) => m.tool_calls && m.tool_calls.length > 0)
        .flatMap((m: any) => m.tool_calls)
  };
}
