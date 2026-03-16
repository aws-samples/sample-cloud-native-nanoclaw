/**
 * ClawBot Cloud — STS ABAC Scoped Credentials
 *
 * Replaces NanoClaw's credential proxy with AWS-native security.
 * Each agent invocation gets short-lived credentials scoped to
 * (userId, botId) via STS session tags. IAM policies use ABAC
 * conditions to restrict S3, DynamoDB, SQS, and Scheduler access
 * to only that tenant's resources.
 */

import { STSClient, AssumeRoleCommand, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SchedulerClient } from '@aws-sdk/client-scheduler';
import { SQSClient } from '@aws-sdk/client-sqs';

const sts = new STSClient({});
const SCOPED_ROLE_ARN = process.env.SCOPED_ROLE_ARN || '';
const REGION = process.env.AWS_REGION || 'us-east-1';
const SESSION_BUCKET = process.env.SESSION_BUCKET || '';

export interface ScopedClients {
  s3: S3Client;
  dynamodb: DynamoDBDocumentClient;
  scheduler: SchedulerClient;
  sqs: SQSClient;
}

/**
 * Assume a scoped IAM role with session tags for ABAC.
 * Returns pre-configured AWS SDK clients restricted to this (userId, botId).
 */
export async function getScopedClients(userId: string, botId: string): Promise<ScopedClients> {
  console.log(`[ABAC-DEBUG] AssumeRole with tags: userId=${userId}, botId=${botId}, roleArn=${SCOPED_ROLE_ARN}`);

  const assumed = await sts.send(
    new AssumeRoleCommand({
      RoleArn: SCOPED_ROLE_ARN,
      RoleSessionName: `agent-${botId}`,
      DurationSeconds: 3600,
      Tags: [
        { Key: 'userId', Value: userId },
        { Key: 'botId', Value: botId },
      ],
    }),
  );

  if (!assumed.Credentials?.AccessKeyId || !assumed.Credentials?.SecretAccessKey) {
    throw new Error('STS AssumeRole did not return credentials');
  }

  console.log(`[ABAC-DEBUG] AssumeRole succeeded. AssumedRoleUser: ${assumed.AssumedRoleUser?.Arn}`);
  console.log(`[ABAC-DEBUG] PackedPolicySize: ${assumed.PackedPolicySize ?? 'N/A'}`);

  const credentials = {
    accessKeyId: assumed.Credentials.AccessKeyId,
    secretAccessKey: assumed.Credentials.SecretAccessKey,
    sessionToken: assumed.Credentials.SessionToken,
  };

  // Diagnostic: verify caller identity with scoped credentials
  const scopedSts = new STSClient({ region: REGION, credentials });
  try {
    const identity = await scopedSts.send(new GetCallerIdentityCommand({}));
    console.log(`[ABAC-DEBUG] Scoped identity: ${identity.Arn}`);
  } catch (err) {
    console.log(`[ABAC-DEBUG] GetCallerIdentity failed: ${err}`);
  }

  // Diagnostic: test S3 ListBucket with exact expected prefix
  const testPrefix = `${userId}/${botId}/`;
  console.log(`[ABAC-DEBUG] Testing S3 ListObjectsV2: bucket=${SESSION_BUCKET}, prefix=${testPrefix}`);
  const s3 = new S3Client({ region: REGION, credentials });
  try {
    const resp = await s3.send(new ListObjectsV2Command({
      Bucket: SESSION_BUCKET,
      Prefix: testPrefix,
      MaxKeys: 1,
    }));
    console.log(`[ABAC-DEBUG] S3 ListBucket OK — keyCount=${resp.KeyCount}`);
  } catch (err: unknown) {
    const e = err as Error;
    console.log(`[ABAC-DEBUG] S3 ListBucket FAILED: ${e.name}: ${e.message}`);
  }

  return {
    s3,
    dynamodb: DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION, credentials })),
    scheduler: new SchedulerClient({ region: REGION, credentials }),
    sqs: new SQSClient({ region: REGION, credentials }),
  };
}
