// ECS Task Registration — registers this task in DynamoDB on startup
// Fetches taskArn and privateIp from ECS Task Metadata Endpoint v4

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { Logger } from 'pino';

const METADATA_URI = process.env.ECS_CONTAINER_METADATA_URI_V4;

interface TaskMetadata {
  taskArn: string;
  privateIp: string;
}

/** Fetch task ARN and private IP from ECS Task Metadata Endpoint v4. */
async function getTaskMetadata(): Promise<TaskMetadata> {
  if (!METADATA_URI) {
    throw new Error('ECS_CONTAINER_METADATA_URI_V4 not set — not running in ECS?');
  }

  const taskRes = await fetch(`${METADATA_URI}/task`);
  const taskMeta = await taskRes.json() as {
    TaskARN: string;
    Containers: Array<{ Networks: Array<{ IPv4Addresses: string[] }> }>;
  };

  const taskArn = taskMeta.TaskARN;
  const privateIp = taskMeta.Containers?.[0]?.Networks?.[0]?.IPv4Addresses?.[0];

  if (!taskArn || !privateIp) {
    throw new Error(`Failed to get task metadata: taskArn=${taskArn}, privateIp=${privateIp}`);
  }

  return { taskArn, privateIp };
}

/** Register this task as a warm task in DynamoDB sessions table. */
export async function registerTask(logger: Logger): Promise<TaskMetadata> {
  const meta = await getTaskMetadata();

  const sessionsTable = process.env.SESSIONS_TABLE || 'nanoclawbot-dev-sessions';
  const region = process.env.AWS_REGION || 'us-east-1';

  const client = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region }),
    { marshallOptions: { removeUndefinedValues: true } },
  );

  await client.send(
    new PutCommand({
      TableName: sessionsTable,
      Item: {
        pk: 'warm',
        sk: meta.taskArn,
        taskArn: meta.taskArn,
        taskIp: meta.privateIp,
        taskStatus: 'warm',
        startedAt: new Date().toISOString(),
      },
    }),
  );

  logger.info({ taskArn: meta.taskArn, privateIp: meta.privateIp }, 'Task registered as warm');
  return meta;
}
