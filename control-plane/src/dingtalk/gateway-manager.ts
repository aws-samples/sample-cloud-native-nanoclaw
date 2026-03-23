// DingTalk Gateway Manager
// Manages DingTalk Stream (WebSocket long-connection) for all DingTalk-connected bots.
// Uses dingtalk-stream SDK's DWClient which handles reconnection automatically.
// Includes DynamoDB-based leader election for ECS multi-task safety.
//
// Pattern: follows feishu/gateway-manager.ts for connection lifecycle and
// adapters/feishu/index.ts for leader election.

import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream';
import type { DWClientDownStream } from 'dingtalk-stream';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  DeleteCommand,
  GetCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import type pino from 'pino';
import type { ChannelConfig } from '@clawbot/shared';
import { config } from '../config.js';
import { handleDingTalkMessage } from './message-handler.js';
import { parseDingTalkMessage } from './message-handler.js';

// -- Leader Election Constants ------------------------------------------------

const LOCK_TABLE = config.tables.sessions;
const LOCK_PK = '__system__';
const LOCK_SK = 'dingtalk-gateway-leader';
const LOCK_TTL_S = 30;
const RENEW_INTERVAL_MS = 10_000;
const POLL_INTERVAL_MS = 10_000;
const POLL_INITIAL_DELAY_MS = 5_000;

// Unique ID for this ECS task instance
const INSTANCE_ID =
  process.env.ECS_TASK_ID ||
  `local-${process.pid}-${Date.now().toString(36)}`;

// -- Clients ------------------------------------------------------------------

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: config.region }),
);
const secretsMgr = new SecretsManagerClient({ region: config.region });

// -- Types --------------------------------------------------------------------

interface DingTalkBotConnection {
  channel: ChannelConfig;
  client: DWClient;
}

// -- DingTalkGatewayManager ---------------------------------------------------

export class DingTalkGatewayManager {
  private logger: pino.Logger;
  private connections = new Map<string, DingTalkBotConnection>();
  private stopped = false;
  private isLeader = false;
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private initialPollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(parentLogger: pino.Logger) {
    this.logger = parentLogger.child({ component: 'dingtalk-gateway' });
  }

  // -- Lifecycle --------------------------------------------------------------

  async start(): Promise<void> {
    this.stopped = false;

    const acquired = await this.tryAcquireLock();
    if (acquired) {
      await this.becomeLeader();
    } else {
      this.logger.info('DingTalk: another instance is leader, entering standby');
      this.startStandbyPoll();
    }
  }

  /**
   * Graceful shutdown: disconnect all stream clients, release leader lock.
   */
  async stopAll(): Promise<void> {
    this.stopped = true;

    if (this.renewTimer) {
      clearInterval(this.renewTimer);
      this.renewTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.initialPollTimer) {
      clearTimeout(this.initialPollTimer);
      this.initialPollTimer = null;
    }

    for (const [botId, conn] of this.connections) {
      try {
        conn.client.disconnect();
        this.logger.info({ botId }, 'DingTalk stream client disconnected');
      } catch (err) {
        this.logger.error({ err, botId }, 'Error disconnecting DingTalk stream client');
      }
    }
    this.connections.clear();

    if (this.isLeader) {
      await this.releaseLock();
      this.isLeader = false;
    }

    this.logger.info('All DingTalk stream connections stopped');
  }

  /**
   * Dynamically add a new bot connection (called when a new dingtalk channel is created).
   * Only the leader instance creates connections; standby instances skip.
   */
  async addBot(botId: string): Promise<void> {
    if (this.stopped || !this.isLeader) return;
    if (this.connections.has(botId)) {
      this.logger.info({ botId }, 'DingTalk bot already connected, skipping');
      return;
    }

    const channels = await this.discoverDingTalkChannels();
    const ch = channels.find((c) => c.botId === botId);
    if (!ch) {
      this.logger.warn({ botId }, 'No DingTalk channel found for bot');
      return;
    }

    try {
      await this.connectBot(ch);
      this.logger.info({ botId }, 'DingTalk stream client added dynamically');
    } catch (err) {
      this.logger.error({ err, botId }, 'Failed to add DingTalk stream client');
    }
  }

  /**
   * Remove a bot connection (called when a dingtalk channel is deleted).
   */
  removeBot(botId: string): void {
    const conn = this.connections.get(botId);
    if (!conn) return;

    try {
      conn.client.disconnect();
    } catch (err) {
      this.logger.error({ err, botId }, 'Error disconnecting DingTalk stream client');
    }

    this.connections.delete(botId);
    this.logger.info({ botId }, 'DingTalk stream client removed');
  }

  /**
   * Check if the manager has any active connections.
   */
  get isActive(): boolean {
    return this.connections.size > 0;
  }

  // -- Leader Election --------------------------------------------------------

  private async tryAcquireLock(): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    try {
      await ddb.send(
        new PutCommand({
          TableName: LOCK_TABLE,
          Item: {
            pk: LOCK_PK,
            sk: LOCK_SK,
            leaderId: INSTANCE_ID,
            expiresAt: now + LOCK_TTL_S,
          },
          // Acquire only if record doesn't exist or has expired
          ConditionExpression:
            'attribute_not_exists(pk) OR expiresAt < :now',
          ExpressionAttributeValues: { ':now': now },
        }),
      );
      this.logger.info({ instanceId: INSTANCE_ID }, 'DingTalk leader lock acquired');
      return true;
    } catch (err: unknown) {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
        return false;
      }
      this.logger.error(err, 'Failed to acquire DingTalk leader lock');
      return false;
    }
  }

  private async renewLock(): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    try {
      await ddb.send(
        new PutCommand({
          TableName: LOCK_TABLE,
          Item: {
            pk: LOCK_PK,
            sk: LOCK_SK,
            leaderId: INSTANCE_ID,
            expiresAt: now + LOCK_TTL_S,
          },
          ConditionExpression: 'leaderId = :me',
          ExpressionAttributeValues: { ':me': INSTANCE_ID },
        }),
      );
      return true;
    } catch (err: unknown) {
      const isConditionalFail = (err as { name?: string }).name === 'ConditionalCheckFailedException';
      if (isConditionalFail) {
        this.logger.warn('DingTalk leader lock taken by another instance, stepping down');
      } else {
        this.logger.error({ err }, 'DingTalk leader lock renewal failed due to unexpected error, stepping down');
      }
      return false;
    }
  }

  private async releaseLock(): Promise<void> {
    try {
      await ddb.send(
        new DeleteCommand({
          TableName: LOCK_TABLE,
          Key: { pk: LOCK_PK, sk: LOCK_SK },
          ConditionExpression: 'leaderId = :me',
          ExpressionAttributeValues: { ':me': INSTANCE_ID },
        }),
      );
      this.logger.info('DingTalk leader lock released');
    } catch (err: unknown) {
      const isConditionalFail = (err as { name?: string }).name === 'ConditionalCheckFailedException';
      if (!isConditionalFail) {
        this.logger.error({ err }, 'Failed to release DingTalk leader lock due to unexpected error');
      }
    }
  }

  private async isLockExpired(): Promise<boolean> {
    try {
      const res = await ddb.send(
        new GetCommand({
          TableName: LOCK_TABLE,
          Key: { pk: LOCK_PK, sk: LOCK_SK },
        }),
      );
      if (!res.Item) return true;
      return (res.Item.expiresAt as number) < Math.floor(Date.now() / 1000);
    } catch (err) {
      this.logger.error({ err }, 'Failed to check DingTalk leader lock status, assuming expired');
      return true;
    }
  }

  // -- Leader Lifecycle -------------------------------------------------------

  private async becomeLeader(): Promise<void> {
    this.isLeader = true;
    this.logger.info('DingTalk: became leader, starting stream connections');

    const channels = await this.discoverDingTalkChannels();
    if (channels.length === 0) {
      this.logger.info('No DingTalk channels configured, gateway idle');
      this.startRenewLoop();
      return;
    }

    this.logger.info(
      { channelCount: channels.length },
      'Starting DingTalk stream connections',
    );

    for (const ch of channels) {
      try {
        await this.connectBot(ch);
      } catch (err) {
        this.logger.error(
          { err, botId: ch.botId },
          'Failed to start DingTalk stream client',
        );
      }
    }

    this.startRenewLoop();
  }

  private startRenewLoop(): void {
    this.renewTimer = setInterval(async () => {
      if (this.stopped) return;
      const ok = await this.renewLock();
      if (!ok) {
        this.logger.warn('Lost DingTalk leader lock, stopping connections');
        // Clear the renew timer FIRST to prevent re-entry
        if (this.renewTimer) {
          clearInterval(this.renewTimer);
          this.renewTimer = null;
        }
        for (const [botId, conn] of this.connections) {
          try {
            conn.client.disconnect();
          } catch (err) {
            this.logger.error(
              { err, botId },
              'Error disconnecting DingTalk client on leadership loss',
            );
          }
        }
        this.connections.clear();
        this.isLeader = false;
        if (!this.stopped) {
          this.startStandbyPoll();
        }
      }
    }, RENEW_INTERVAL_MS);
  }

  // -- Standby ----------------------------------------------------------------

  private startStandbyPoll(): void {
    // Clear any existing timers to prevent duplicate polling
    if (this.initialPollTimer) {
      clearTimeout(this.initialPollTimer);
      this.initialPollTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    const poll = async () => {
      if (this.stopped) return;
      const expired = await this.isLockExpired();
      if (expired) {
        this.logger.info('DingTalk leader lock expired, attempting takeover');
        if (this.pollTimer) {
          clearInterval(this.pollTimer);
          this.pollTimer = null;
        }
        if (this.initialPollTimer) {
          clearTimeout(this.initialPollTimer);
          this.initialPollTimer = null;
        }
        const acquired = await this.tryAcquireLock();
        if (acquired) {
          await this.becomeLeader();
        } else {
          this.startStandbyPoll();
        }
      }
    };
    // First check quickly (covers rolling update where old leader just died)
    this.initialPollTimer = setTimeout(poll, POLL_INITIAL_DELAY_MS);
    // Then regular interval
    this.pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  }

  // -- Private ----------------------------------------------------------------

  private async connectBot(ch: ChannelConfig): Promise<void> {
    const creds = await this.loadCredentials(ch.credentialSecretArn);
    const clientId = creds.clientId;
    const clientSecret = creds.clientSecret;

    if (!clientId || !clientSecret) {
      this.logger.warn(
        { botId: ch.botId },
        'Missing clientId or clientSecret in DingTalk credentials, skipping',
      );
      return;
    }

    const botId = ch.botId;
    const logger = this.logger;

    const dwClient = new DWClient({
      clientId,
      clientSecret,
    });

    // Register callback for robot messages.
    // The callback type is synchronous ((v) => void) so we handle the async
    // message processing via a fire-and-forget IIFE and acknowledge
    // receipt immediately to prevent server-side retries (60s timeout).
    dwClient.registerCallbackListener(TOPIC_ROBOT, (res: DWClientDownStream) => {
      // Acknowledge receipt immediately
      try {
        dwClient.socketCallBackResponse(res.headers.messageId, {
          response: {
            statusLine: { code: 200, reasonPhrase: 'OK' },
            headers: {},
            body: '',
          },
        });
      } catch (ackErr) {
        logger.warn({ err: ackErr, botId }, 'Failed to acknowledge DingTalk message');
      }

      // Process message asynchronously
      void (async () => {
        try {
          const data = parseDingTalkMessage(res.data);
          await handleDingTalkMessage(botId, data.senderStaffId, data, logger);
        } catch (err) {
          logger.error(
            { err, botId },
            'Error handling DingTalk message from stream',
          );
        }
      })();
    });

    await dwClient.connect();

    this.connections.set(botId, {
      channel: ch,
      client: dwClient,
    });

    this.logger.info({ botId }, 'DingTalk stream client connected');
  }

  private async discoverDingTalkChannels(): Promise<ChannelConfig[]> {
    const channels: ChannelConfig[] = [];
    let lastKey: Record<string, unknown> | undefined;

    do {
      const result = await ddb.send(
        new ScanCommand({
          TableName: config.tables.channels,
          FilterExpression: 'channelType = :ct',
          ExpressionAttributeValues: { ':ct': 'dingtalk' },
          ExclusiveStartKey: lastKey,
        }),
      );
      channels.push(...(result.Items || []) as ChannelConfig[]);
      lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);

    return channels;
  }

  private async loadCredentials(
    secretArn: string,
  ): Promise<Record<string, string>> {
    const res = await secretsMgr.send(
      new GetSecretValueCommand({ SecretId: secretArn }),
    );
    if (!res.SecretString) {
      throw new Error(`Secret ${secretArn} has no SecretString (binary secret or empty)`);
    }
    try {
      return JSON.parse(res.SecretString);
    } catch (err) {
      throw new Error(`Secret ${secretArn} contains invalid JSON: ${(err as Error).message}`);
    }
  }
}

// -- Singleton ----------------------------------------------------------------

let _manager: DingTalkGatewayManager | null = null;

export function getDingTalkGatewayManager(): DingTalkGatewayManager | null {
  return _manager;
}

export function initDingTalkGatewayManager(
  logger: pino.Logger,
): DingTalkGatewayManager {
  _manager = new DingTalkGatewayManager(logger);
  return _manager;
}
