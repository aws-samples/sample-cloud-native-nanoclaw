// ClawBot Cloud — Control Plane Configuration
// Environment variable names match CDK ControlPlaneStack container environment

import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

// Values resolved at startup from SSM Parameter Store.
// SSM parameter names are set via CDK env vars (*_SSM); the actual values are
// written by FrontendStack (webhook URL) and post-deploy.sh (AgentCore ARN).
let webhookBaseUrl = process.env.WEBHOOK_BASE_URL || '';
const webhookBaseUrlSsm = process.env.WEBHOOK_BASE_URL_SSM || '';

let agentcoreRuntimeArn = process.env.AGENTCORE_RUNTIME_ARN || '';
const agentcoreRuntimeArnSsm = process.env.AGENTCORE_RUNTIME_ARN_SSM || '';

export const config = {
  port: Number(process.env.PORT) || 3000,
  region: process.env.AWS_REGION || 'us-east-1',
  stage: process.env.STAGE || 'dev',

  // DynamoDB table names (match CDK: USERS_TABLE, BOTS_TABLE, etc.)
  tables: {
    users: process.env.USERS_TABLE || 'nanoclawbot-dev-users',
    bots: process.env.BOTS_TABLE || 'nanoclawbot-dev-bots',
    channels: process.env.CHANNELS_TABLE || 'nanoclawbot-dev-channels',
    groups: process.env.GROUPS_TABLE || 'nanoclawbot-dev-groups',
    messages: process.env.MESSAGES_TABLE || 'nanoclawbot-dev-messages',
    tasks: process.env.TASKS_TABLE || 'nanoclawbot-dev-tasks',
    sessions: process.env.SESSIONS_TABLE || 'nanoclawbot-dev-sessions',
    providers: process.env.PROVIDERS_TABLE || 'nanoclawbot-dev-providers',
    skills: process.env.SKILLS_TABLE || 'nanoclawbot-dev-skills',
  },

  // SQS queue URLs (match CDK: MESSAGE_QUEUE_URL, REPLY_QUEUE_URL)
  queues: {
    messages: process.env.MESSAGE_QUEUE_URL || '',
    replies: process.env.REPLY_QUEUE_URL || '',
  },

  // S3 (match CDK: DATA_BUCKET)
  s3Bucket: process.env.DATA_BUCKET || 'nanoclawbot-dev-data',

  // Cognito
  cognito: {
    userPoolId: process.env.COGNITO_USER_POOL_ID || '',
    clientId: process.env.COGNITO_CLIENT_ID || '',
    region: process.env.COGNITO_REGION || process.env.AWS_REGION || 'us-east-1',
  },

  // CORS
  corsOrigin: process.env.CORS_ORIGIN || '*',

  // SEC-C05: Origin verification — CloudFront sends this header, ALB app validates it
  originVerifySecret: process.env.ORIGIN_VERIFY_SECRET || '',

  // AgentCore — getter so resolveConfig() writes take effect
  agentcore: {
    get runtimeArn() {
      return agentcoreRuntimeArn;
    },
  },

  // EventBridge Scheduler
  scheduler: {
    roleArn: process.env.SCHEDULER_ROLE_ARN || '',
    messageQueueArn: process.env.MESSAGE_QUEUE_ARN || '',
  },

  // Webhook base URL — getter so resolveConfig() writes take effect
  get webhookBaseUrl() {
    return webhookBaseUrl;
  },

  // Concurrency
  maxConcurrentDispatches: Number(process.env.MAX_CONCURRENT_DISPATCHES) || 20,

  // Cache TTL
  cacheTtlMs: Number(process.env.CACHE_TTL_MS) || 5 * 60 * 1000, // 5 minutes
} as const;

/**
 * Resolve config values that require async calls (SSM Parameter Store).
 * Must be called once at startup before serving requests.
 */
export async function resolveConfig(): Promise<void> {
  const ssm = new SSMClient({ region: config.region });

  const resolve = async (
    current: string,
    ssmName: string,
    label: string,
  ): Promise<string> => {
    if (current || !ssmName) return current;
    try {
      const res = await ssm.send(new GetParameterCommand({ Name: ssmName }));
      if (res.Parameter?.Value) return res.Parameter.Value;
    } catch (err) {
      console.warn(`Failed to read ${label} from SSM (${ssmName}):`, err);
    }
    return current;
  };

  webhookBaseUrl = await resolve(
    webhookBaseUrl,
    webhookBaseUrlSsm,
    'webhook base URL',
  );
  agentcoreRuntimeArn = await resolve(
    agentcoreRuntimeArn,
    agentcoreRuntimeArnSsm,
    'AgentCore runtime ARN',
  );
}
