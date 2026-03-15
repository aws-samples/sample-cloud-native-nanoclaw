// ClawBot Cloud — Groups API Routes
// Read-only operations for group management (groups are auto-created on first message)

import type { FastifyPluginAsync } from 'fastify';
import {
  getBot,
  listGroups,
  getGroup,
  updateGroup,
  getRecentMessages,
} from '../../services/dynamo.js';

export const groupsRoutes: FastifyPluginAsync = async (app) => {
  // List groups for a bot
  app.get<{ Params: { botId: string } }>('/', async (request, reply) => {
    const { botId } = request.params;

    // Verify bot ownership
    const bot = await getBot(request.userId, botId);
    if (!bot || bot.status === 'deleted') {
      return reply.status(404).send({ error: 'Bot not found' });
    }

    const groups = await listGroups(botId);
    return groups;
  });

  // Update a group's settings
  app.put<{ Params: { botId: string; groupJid: string } }>(
    '/:groupJid',
    async (request, reply) => {
      const { botId, groupJid } = request.params;

      // Verify bot ownership
      const bot = await getBot(request.userId, botId);
      if (!bot || bot.status === 'deleted') {
        return reply.status(404).send({ error: 'Bot not found' });
      }

      const decodedJid = decodeURIComponent(groupJid);
      const group = await getGroup(botId, decodedJid);
      if (!group) {
        return reply.status(404).send({ error: 'Group not found' });
      }

      const body = request.body as { name?: string; requiresTrigger?: boolean };
      await updateGroup(botId, decodedJid, {
        name: body.name,
        requiresTrigger: body.requiresTrigger,
      });

      const updated = await getGroup(botId, decodedJid);
      return updated;
    },
  );

  // Get recent messages for a group
  app.get<{ Params: { botId: string; groupJid: string }; Querystring: { limit?: string } }>(
    '/:groupJid/messages',
    async (request, reply) => {
      const { botId, groupJid } = request.params;
      const limit = Math.min(Number(request.query.limit) || 50, 200);

      // Verify bot ownership
      const bot = await getBot(request.userId, botId);
      if (!bot || bot.status === 'deleted') {
        return reply.status(404).send({ error: 'Bot not found' });
      }

      const messages = await getRecentMessages(
        botId,
        decodeURIComponent(groupJid),
        limit,
      );

      return messages;
    },
  );
};
