import { Worker } from '@temporalio/worker';
import { getEnv } from '@/lib/env';
import * as activities from './temporal/activities';

async function run() {
  const connection = await import('@temporalio/worker').then(m => m.NativeConnection.connect({
    address: getEnv('TEMPORAL_ADDRESS') || 'localhost:7233',
  }));

  const worker = await Worker.create({
    connection,
    namespace: getEnv('TEMPORAL_NAMESPACE') || 'default',
    taskQueue: 'workflow-execution-queue',
    workflowsPath: require.resolve('./temporal/workflows'),
    activities,
  });

  await worker.run();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
