// ClawBot Cloud — Channel Router
// Maps channel type to the appropriate client for outbound messages

import * as telegram from './telegram.js';
import * as discord from './discord.js';
import * as slack from './slack.js';
import * as whatsapp from './whatsapp.js';
import * as feishu from './feishu.js';
import * as dingtalk from './dingtalk.js';
import type { ChannelType } from '@clawbot/shared';

export async function sendChannelMessage(
  channelType: ChannelType,
  credentials: Record<string, string>,
  chatId: string,
  text: string,
): Promise<void> {
  switch (channelType) {
    case 'telegram':
      return telegram.sendMessage(credentials.botToken, chatId, text);
    case 'discord':
      return discord.sendMessage(credentials.botToken, chatId, text);
    case 'slack':
      return slack.sendMessage(credentials.botToken, chatId, text);
    case 'whatsapp':
      return whatsapp.sendMessage(credentials.accessToken, credentials.phoneNumberId, chatId, text);
    case 'feishu':
      return feishu.sendFeishuMessage(credentials.appId, credentials.appSecret, chatId, text, (credentials.domain as feishu.FeishuDomain) || 'feishu');
    case 'dingtalk':
      throw new Error('DingTalk messages must be sent via DingTalkAdapter.sendReply(), not sendChannelMessage()');

    default:
      throw new Error(`Unsupported channel type: ${channelType}`);
  }
}

export async function verifyChannelCredentials(
  channelType: ChannelType,
  credentials: Record<string, string>,
): Promise<Record<string, string>> {
  switch (channelType) {
    case 'telegram': {
      const me = await telegram.getMe(credentials.botToken);
      return { botId: String(me.id), username: me.username };
    }
    case 'discord': {
      const me = await discord.verifyCredentials(credentials.botToken);
      return { applicationId: me.id, username: me.username };
    }
    case 'slack': {
      const auth = await slack.authTest(credentials.botToken);
      return {
        botUserId: auth.userId,
        teamId: auth.teamId,
        slackBotId: auth.botId,
      };
    }
    case 'whatsapp': {
      const info = await whatsapp.verifyCredentials(
        credentials.accessToken,
        credentials.phoneNumberId,
      );
      return { phoneNumber: info.phoneNumber };
    }
    case 'feishu': {
      const botInfo = await feishu.verifyFeishuCredentials(
        credentials.appId,
        credentials.appSecret,
        (credentials.domain as feishu.FeishuDomain) || 'feishu',
      );
      return { botOpenId: botInfo.botOpenId, botName: botInfo.botName };
    }
    case 'dingtalk': {
      const result = await dingtalk.verifyCredentials(credentials.clientId, credentials.clientSecret);
      return { robotId: result.robotId, robotName: result.robotName };
    }
    default:
      throw new Error(`Unsupported channel type: ${channelType}`);
  }
}
