import { Connection, WorkflowClient } from '@temporalio/client'
import { getEnv } from '@/lib/env'

let client: WorkflowClient | undefined

export async function getTemporalClient() {
  if (client) {
    return client
  }

  const connection = await Connection.connect({
    address: getEnv('TEMPORAL_ADDRESS') || 'localhost:7233',
  })

  client = new WorkflowClient({
    connection,
    namespace: getEnv('TEMPORAL_NAMESPACE') || 'default',
  })

  return client
}
