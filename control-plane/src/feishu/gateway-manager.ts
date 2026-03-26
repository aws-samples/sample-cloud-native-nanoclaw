// Feishu Gateway Manager
// Manages Lark WSClient connections for all Feishu-connected bots.
// Similar to Discord adapter's Gateway lifecycle but uses the Lark SDK's
// built-in WebSocket client which handles reconnection automatically.

import * as lark from '@larksuiteoapi/node-sdk';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import type pino from 'pino';
import type { ChannelConfig } from '@clawbot/shared';
import { config } from '../config.js';
import { getChannelsByType } from '../services/dynamo.js';
import { handleFeishuMessage } from './message-handler.js';
import type { FeishuImMessageEvent } from './message-handler.js';
import type { FeishuDomain } from '../channels/feishu.js';

// ── Clients ──────────────────────────────────────────────────────────────────

const secretsMgr = new SecretsManagerClient({ region: config.region });

// ── Types ────────────────────────────────────────────────────────────────────

interface FeishuBotConnection {
  channel: ChannelConfig;
  wsClient: lark.WSClient;
  appId: string;
  appSecret: string;
  botOpenId: string;
  domain: FeishuDomain;
}

// ── FeishuGatewayManager ─────────────────────────────────────────────────────

export class FeishuGatewayManager {
  private logger: pino.Logger;
  private connections = new Map<string, FeishuBotConnection>();
  private stopped = false;

  constructor(parentLogger: pino.Logger) {
    this.logger = parentLogger.child({ component: 'feishu-gateway' });
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.stopped = false;

    const feishuChannels = await this.discoverFeishuChannels();
    if (feishuChannels.length === 0) {
      this.logger.info('No Feishu channels configured, gateway idle');
      return;
    }

    this.logger.info(
      { channelCount: feishuChannels.length },
      'Starting Feishu WSClient connections',
    );

    for (const ch of feishuChannels) {
      try {
        await this.connectBot(ch);
      } catch (err) {
        this.logger.error(
          { err, botId: ch.botId },
          'Failed to start Feishu WSClient',
        );
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;

    for (const [botId, conn] of this.connections) {
      try {
        // WSClient does not have a public close/stop method — just drop the reference.
        // The SDK handles cleanup internally when the process exits.
        this.logger.info({ botId }, 'Feishu WSClient connection removed');
      } catch (err) {
        this.logger.error({ err, botId }, 'Error stopping Feishu WSClient');
      }
    }

    this.connections.clear();
    this.logger.info('All Feishu WSClient connections stopped');
  }

  /**
   * Dynamically add a new bot connection (called when a new feishu channel is created).
   */
  async addBot(botId: string): Promise<void> {
    if (this.stopped) return;
    if (this.connections.has(botId)) {
      this.logger.info({ botId }, 'Feishu bot already connected, skipping');
      return;
    }

    const channels = await this.discoverFeishuChannels();
    const ch = channels.find(c => c.botId === botId);
    if (!ch) {
      this.logger.warn({ botId }, 'No Feishu channel found for bot');
      return;
    }

    try {
      await this.connectBot(ch);
      this.logger.info({ botId }, 'Feishu WSClient added dynamically');
    } catch (err) {
      this.logger.error({ err, botId }, 'Failed to add Feishu WSClient');
    }
  }

  /**
   * Remove a bot connection (called when a feishu channel is deleted).
   */
  removeBot(botId: string): void {
    const conn = this.connections.get(botId);
    if (!conn) return;

    this.connections.delete(botId);
    this.logger.info({ botId }, 'Feishu WSClient removed');
  }

  /**
   * Check if the manager has any active connections.
   */
  get isActive(): boolean {
    return this.connections.size > 0;
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private async connectBot(ch: ChannelConfig): Promise<void> {
    const creds = await this.loadCredentials(ch.credentialSecretArn);
    const appId = creds.appId;
    const appSecret = creds.appSecret;
    const botOpenId = creds.botOpenId || '';
    const domain = (creds.domain as FeishuDomain) || 'feishu';

    if (!appId || !appSecret) {
      this.logger.warn(
        { botId: ch.botId },
        'Missing appId or appSecret in Feishu credentials, skipping',
      );
      return;
    }

    const wsClient = new lark.WSClient({
      appId,
      appSecret,
      domain: domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.info,
    });

    const botId = ch.botId;
    const logger = this.logger;

    wsClient.start({
      eventDispatcher: new lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data: unknown) => {
          try {
            const event = data as FeishuImMessageEvent;
            await handleFeishuMessage({
              event,
              botId,
              botOpenId,
              appId,
              appSecret,
              domain,
              logger,
            });
          } catch (err) {
            logger.error(
              { err, botId },
              'Error handling Feishu message from WSClient',
            );
          }
        },
      }),
    });

    this.connections.set(botId, {
      channel: ch,
      wsClient,
      appId,
      appSecret,
      botOpenId,
      domain,
    });

    this.logger.info(
      { botId, domain },
      'Feishu WSClient connected',
    );
  }

  // PERF-C2: Use GSI query instead of full table scan
  private async discoverFeishuChannels(): Promise<ChannelConfig[]> {
    return getChannelsByType('feishu');
  }

  private async loadCredentials(
    secretArn: string,
  ): Promise<Record<string, string>> {
    const res = await secretsMgr.send(
      new GetSecretValueCommand({ SecretId: secretArn }),
    );
    return JSON.parse(res.SecretString || '{}');
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

let _manager: FeishuGatewayManager | null = null;

export function getFeishuGatewayManager(): FeishuGatewayManager | null {
  return _manager;
}

export function initFeishuGatewayManager(logger: pino.Logger): FeishuGatewayManager {
  _manager = new FeishuGatewayManager(logger);
  return _manager;
}
