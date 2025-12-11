import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage, AIMessage, BaseMessage } from '@langchain/core/messages';
import { StateGraph, END, MemorySaver } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
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

  let modelWithTools = model;
  if (lcTools.length > 0 && typeof (model as any).bindTools === 'function') {
      modelWithTools = (model as any).bindTools(lcTools);
  }

  // Define Graph State
  const graphState = {
    messages: {
      value: (x: BaseMessage[], y: BaseMessage[]) => x.concat(y),
      default: () => [],
    }
  };

  const workflow = new StateGraph({
    channels: graphState
  });

  // Define Nodes
  const callModel = async (state: { messages: BaseMessage[] }) => {
    const response = await modelWithTools.invoke(state.messages);
    return { messages: [response] };
  };

  const toolNode = new ToolNode(lcTools);

  workflow.addNode("agent", callModel);
  workflow.addNode("tools", toolNode);

  workflow.setEntryPoint("agent");

  // Conditional edge to tools or end
  workflow.addConditionalEdges(
    "agent",
    (state) => {
      const lastMessage = state.messages[state.messages.length - 1] as AIMessage;
      if (lastMessage.tool_calls && lastMessage.tool_calls.length > 0) {
        return "tools";
      }
      return END;
    }
  );

  workflow.addEdge("tools", "agent");

  // Compile with Checkpointer if configured (in-memory for now)
  // This allows the agent to handle multi-step tool usage with memory
  const checkpointer = (inputs as any).enableMemory ? new MemorySaver() : undefined;

  const app = workflow.compile({ checkpointer });

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

  if (inputs.systemPrompt) initialMessages.push(new SystemMessage(inputs.systemPrompt));

  if (inputs.userPrompt) {
      const content = typeof inputs.userPrompt === 'string' ? inputs.userPrompt : JSON.stringify(inputs.userPrompt);
      initialMessages.push(new HumanMessage(content));
  }

  // Ensure there is at least one message
  if (initialMessages.length === 0) {
      initialMessages.push(new HumanMessage("Hello"));
  }

  // Invoke with config
  // Thread ID required if checkpointer is used
  const config = checkpointer ? { configurable: { thread_id: "default-thread" } } : undefined;

  const result = await app.invoke({ messages: initialMessages }, config);

  const lastMsg = result.messages[result.messages.length - 1];

  const usage = lastMsg.response_metadata?.tokenUsage || {};

  return {
    content: lastMsg.content,
    model: inputs.model,
    tokens: {
        prompt: usage.promptTokens || 0,
        completion: usage.completionTokens || 0,
        total: usage.totalTokens || 0
    },
    toolCalls: result.messages
        .filter((m: any) => m.tool_calls && m.tool_calls.length > 0)
        .flatMap((m: any) => m.tool_calls)
  };
}
