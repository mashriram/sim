import { describe, expect, it, vi } from 'vitest';
import { HumanMessage } from '@langchain/core/messages';

// Define mocks before imports
vi.mock('@langchain/openai', () => {
  return {
    ChatOpenAI: vi.fn().mockImplementation(() => ({
      bindTools: vi.fn().mockReturnThis(),
      invoke: vi.fn().mockResolvedValue({ content: 'Mock response' }),
    })),
  };
});

vi.mock('@langchain/anthropic', () => {
  return {
    ChatAnthropic: vi.fn().mockImplementation(() => ({
      bindTools: vi.fn().mockReturnThis(),
      invoke: vi.fn().mockResolvedValue({ content: 'Mock response' }),
    })),
  };
});

vi.mock('@langchain/langgraph', () => {
  return {
    StateGraph: vi.fn().mockImplementation(() => ({
      addNode: vi.fn(),
      setEntryPoint: vi.fn(),
      addConditionalEdges: vi.fn(),
      addEdge: vi.fn(),
      compile: vi.fn().mockReturnValue({
        invoke: vi.fn().mockResolvedValue({
          messages: [
            { content: 'Mock response', response_metadata: { tokenUsage: { totalTokens: 10 } } }
          ]
        })
      }),
    })),
    END: 'END',
    MemorySaver: vi.fn(),
  };
});

vi.mock('@langchain/langgraph/prebuilt', () => {
  return {
    createReactAgent: vi.fn().mockReturnValue({
      invoke: vi.fn().mockResolvedValue({
        messages: [
          { content: 'Mock response', response_metadata: { tokenUsage: { totalTokens: 10 } } }
        ]
      })
    }),
    ToolNode: vi.fn(),
  };
});

// Import after mocks
import { runLangGraphAgent } from './agent';

describe('runLangGraphAgent', () => {
  const mockContext = {
    executionId: 'test-exec-id',
  };

  it('should run an agent with basic inputs', async () => {
    const inputs = {
      model: 'gpt-4o',
      userPrompt: 'Hello',
      apiKey: 'test-key',
    };

    const result = await runLangGraphAgent(inputs, [], mockContext);

    expect(result.content).toBe('Mock response');
    expect(result.model).toBe('gpt-4o');
    expect(result.tokens.total).toBe(10);
  });

  it('should use MemorySaver when enableMemory is true', async () => {
    const inputs = {
      model: 'gpt-4o',
      userPrompt: 'Hello',
      apiKey: 'test-key',
      enableMemory: true,
    };

    await runLangGraphAgent(inputs, [], mockContext);

    // We check if MemorySaver was instantiated via the mock
    const { MemorySaver } = await import('@langchain/langgraph');
    expect(MemorySaver).toHaveBeenCalled();
  });
});
