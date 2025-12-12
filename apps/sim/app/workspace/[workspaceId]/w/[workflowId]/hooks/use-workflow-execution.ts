import { useCallback, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { createLogger } from '@/lib/logs/console/logger'
import type { BlockLog, ExecutionResult } from '@/executor/types'
import { useExecutionStore } from '@/stores/execution/store'
import { useConsoleStore } from '@/stores/panel/console/store'
import { useVariablesStore } from '@/stores/panel/variables/store'
import { useEnvironmentStore } from '@/stores/settings/environment/store'
import { useGeneralStore } from '@/stores/settings/general/store'
import { useWorkflowRegistry } from '@/stores/workflows/registry/store'
import { useCurrentWorkflow } from './use-current-workflow'

const logger = createLogger('useWorkflowExecution')

// Debug state validation result
interface DebugValidationResult {
  isValid: boolean
  error?: string
}

export function useWorkflowExecution() {
  const currentWorkflow = useCurrentWorkflow()
  const { activeWorkflowId, workflows } = useWorkflowRegistry()
  const { toggleConsole } = useConsoleStore()
  const { getAllVariables } = useEnvironmentStore()
  const { isDebugModeEnabled } = useGeneralStore()
  const { getVariablesByWorkflowId, variables } = useVariablesStore()
  const {
    isExecuting,
    isDebugging,
    pendingBlocks,
    debugContext,
    setIsExecuting,
    setIsDebugging,
    setPendingBlocks,
    setDebugContext,
    setActiveBlocks,
  } = useExecutionStore()
  const [executionResult, setExecutionResult] = useState<ExecutionResult | null>(null)

  /**
   * Resets all debug-related state
   */
  const resetDebugState = useCallback(() => {
    setIsExecuting(false)
    setIsDebugging(false)
    setDebugContext(null)
    setPendingBlocks([])
    setActiveBlocks(new Set())

    // Reset debug mode setting if it was enabled
    if (isDebugModeEnabled) {
      useGeneralStore.getState().toggleDebugMode()
    }
  }, [
    setIsExecuting,
    setIsDebugging,
    setDebugContext,
    setPendingBlocks,
    setActiveBlocks,
    isDebugModeEnabled,
  ])

  // Placeholder for step debug (not supported via API yet)
  const handleStepDebug = useCallback(async () => {
    logger.warn('Step Debug not supported via API execution yet.')
  }, [])

  // Placeholder for resume debug
  const handleResumeDebug = useCallback(async () => {
    logger.warn('Resume Debug not supported via API execution yet.')
  }, [])

  /**
   * Handles cancelling the current debugging session
   */
  const handleCancelDebug = useCallback(() => {
    logger.info('Debug session cancelled')
    resetDebugState()
  }, [resetDebugState])

  /**
   * Handles cancelling the current workflow execution
   */
  const handleCancelExecution = useCallback(() => {
    logger.info('Workflow execution cancellation requested')
    // Reset execution state
    setIsExecuting(false)
    setIsDebugging(false)
    setActiveBlocks(new Set())

    if (isDebugging) {
      resetDebugState()
    }
  }, [isDebugging, resetDebugState, setIsExecuting, setIsDebugging, setActiveBlocks])

  const handleRunWorkflow = useCallback(
    async (workflowInput?: any, enableDebug = false) => {
      if (!activeWorkflowId) return

      // Get workspaceId from workflow metadata
      const workspaceId = workflows[activeWorkflowId]?.workspaceId

      if (!workspaceId) {
        logger.error('Cannot execute workflow without workspaceId')
        return
      }

      // Reset execution result and set execution state
      setExecutionResult(null)
      setIsExecuting(true)

      if (enableDebug) {
        // Debug mode not supported via API yet, warn user
        logger.warn('Debug mode not supported via API execution')
        // setIsDebugging(true)
      }

      const isChatExecution =
        workflowInput && typeof workflowInput === 'object' && 'input' in workflowInput

      const executionId = uuidv4()

      try {
        // Call API to execute workflow
        const response = await fetch(`/api/workflows/${activeWorkflowId}/execute`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Execution-Mode': 'sync', // Use sync mode to wait for result?
            // If chat, we ideally want stream. But API doesn't stream yet.
            // For now, wait for result.
          },
          body: JSON.stringify(workflowInput || {}),
        })

        if (!response.ok) {
          const errorText = await response.text()
          throw new Error(`Execution failed: ${response.status} ${errorText}`)
        }

        const result = await response.json()

        // Result should be ExecutionResult
        if (result?.success) {
          setExecutionResult(result)

          // If chat, simulated streaming via single chunk
          if (isChatExecution && result.output && result.output.content) {
            // We can't stream via hook if API doesn't stream.
            // Just show final result.
            // Update console with logs if available
            if (result.logs) {
              result.logs.forEach((log: BlockLog) => {
                useConsoleStore
                  .getState()
                  .updateConsole(
                    log.blockId,
                    { replaceOutput: log.output, success: true },
                    executionId
                  )
              })
            }
          }
        } else {
          setExecutionResult(result) // Contains error
        }
      } catch (error: any) {
        logger.error('Execution error:', error)
        setExecutionResult({
          success: false,
          output: {},
          error: error.message || String(error),
          logs: [],
        })
      } finally {
        setIsExecuting(false)
        setIsDebugging(false)
        setActiveBlocks(new Set())
      }
    },
    [
      activeWorkflowId,
      currentWorkflow,
      toggleConsole,
      getAllVariables,
      getVariablesByWorkflowId,
      isDebugModeEnabled,
      setIsExecuting,
      setIsDebugging,
      setDebugContext,
      setPendingBlocks,
      setActiveBlocks,
    ]
  )

  return {
    isExecuting,
    isDebugging,
    pendingBlocks,
    executionResult,
    handleRunWorkflow,
    handleStepDebug,
    handleResumeDebug,
    handleCancelDebug,
    handleCancelExecution,
  }
}
