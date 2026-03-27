// ClawBot Cloud — Bots API Routes
// CRUD operations for bot management

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ulid } from 'ulid';
import {
  createBot,
  getBot,
  getSkill,
  getProvider,
  getUser,
  listBots,
  listSkills,
  updateBot,
  deleteBot,
} from '../../services/dynamo.js';
import { botCache } from '../../services/cache.js';
import type { Bot, CreateBotRequest, UpdateBotRequest } from '@clawbot/shared';

const createBotSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  systemPrompt: z.string().max(10000).optional(),
  triggerPattern: z.string().max(200).optional(),
  providerId: z.string().min(1).max(100).optional(),
  modelId: z.string().min(1).max(200).optional(),
});

const updateBotSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  systemPrompt: z.string().max(10000).optional(),
  triggerPattern: z.string().max(200).optional(),
  providerId: z.string().min(1).max(100).optional(),
  modelId: z.string().min(1).max(200).optional(),
  status: z.enum(['active', 'paused', 'deleted']).optional(),
  toolWhitelist: z.object({
    mcpToolsEnabled: z.boolean(),
    skillsEnabled: z.boolean(),
    allowedMcpTools: z.array(z.string().max(100)).max(50),
    allowedSkills: z.array(z.string().max(100)).max(50),
  }).optional(),
});

const validTransitions: Record<string, string[]> = {
  created: ['active', 'deleted'],
  active: ['paused', 'deleted'],
  paused: ['active', 'deleted'],
};

export const botsRoutes: FastifyPluginAsync = async (app) => {
  // List all bots for the authenticated user
  app.get('/', async (request) => {
    const bots = await listBots(request.userId);
    // Filter out soft-deleted bots
    return bots.filter((b) => b.status !== 'deleted');
  });

  // Create a new bot
  app.post('/', async (request, reply) => {
    const body = createBotSchema.parse(request.body as CreateBotRequest);

    // Quota check: ensure user hasn't exceeded max bots
    const user = await getUser(request.userId);
    if (user) {
      const allBots = await listBots(request.userId);
      const activeBots = allBots.filter((b) => b.status !== 'deleted');
      if (activeBots.length >= user.quota.maxBots) {
        return reply.status(403).send({ error: 'Bot limit reached. Upgrade your plan to create more bots.' });
      }
    }

    // Validate provider and modelId if specified
    if (body.providerId) {
      const provider = await getProvider(body.providerId);
      if (!provider) {
        return reply.status(400).send({ error: 'Provider not found' });
      }
      if (body.modelId && !provider.modelIds.includes(body.modelId)) {
        return reply.status(400).send({ error: 'Model ID not available for this provider' });
      }
    }

    const now = new Date().toISOString();

    const bot: Bot = {
      userId: request.userId,
      botId: ulid(),
      name: body.name,
      description: body.description,
      systemPrompt: body.systemPrompt,
      triggerPattern: body.triggerPattern || `@${body.name}`,
      providerId: body.providerId,
      modelId: body.modelId,
      status: 'created',
      createdAt: now,
      updatedAt: now,
    };

    await createBot(bot);
    return reply.status(201).send(bot);
  });

  // Available tools catalog (for whitelist UI)
  app.get('/available-tools', async () => {
    return {
      mcpTools: [
        { name: 'send_message', description: 'Send a message to the channel' },
        { name: 'send_file', description: 'Send a file to the channel' },
        { name: 'schedule_task', description: 'Schedule a recurring task' },
        { name: 'list_tasks', description: 'List scheduled tasks' },
        { name: 'pause_task', description: 'Pause a scheduled task' },
        { name: 'resume_task', description: 'Resume a paused task' },
        { name: 'cancel_task', description: 'Cancel a scheduled task' },
        { name: 'update_task', description: 'Update a scheduled task' },
      ],
      skills: [
        { name: 'agent-browser', description: 'Browser automation' },
        { name: 'docx', description: 'Word document creation' },
        { name: 'find-skills', description: 'Discover available skills' },
        { name: 'pdf', description: 'PDF manipulation' },
        { name: 'pptx', description: 'PowerPoint creation' },
        { name: 'skill-creator', description: 'Create new skills' },
        { name: 'skill-development', description: 'Skill development tools' },
        { name: 'xlsx', description: 'Excel spreadsheet creation' },
      ],
    };
  });

  // Get a specific bot
  app.get<{ Params: { botId: string } }>('/:botId', async (request, reply) => {
    const { botId } = request.params;
    const bot = await getBot(request.userId, botId);
    if (!bot || bot.status === 'deleted') {
      return reply.status(404).send({ error: 'Bot not found' });
    }
    return bot;
  });

  // Update a bot
  app.put<{ Params: { botId: string } }>(
    '/:botId',
    async (request, reply) => {
      const { botId } = request.params;
      const updates = updateBotSchema.parse(request.body as UpdateBotRequest);

      // Verify bot exists and belongs to user
      const existing = await getBot(request.userId, botId);
      if (!existing || existing.status === 'deleted') {
        return reply.status(404).send({ error: 'Bot not found' });
      }

      // Validate state transition
      if (updates.status) {
        const allowed = validTransitions[existing.status];
        if (!allowed || !allowed.includes(updates.status)) {
          return reply.status(400).send({
            error: `Invalid status transition from '${existing.status}' to '${updates.status}'`,
          });
        }
      }

      // Validate provider and modelId exist
      if (updates.providerId) {
        const provider = await getProvider(updates.providerId);
        if (!provider) {
          return reply.status(400).send({ error: 'Provider not found' });
        }
        if (updates.modelId && !provider.modelIds.includes(updates.modelId)) {
          return reply.status(400).send({ error: 'Model ID not available for this provider' });
        }
      }

      await updateBot(request.userId, botId, updates);
      botCache.delete(botId); // Invalidate so dispatcher picks up changes immediately
      const updated = await getBot(request.userId, botId);
      return updated;
    },
  );

  // Delete a bot (soft delete)
  app.delete<{ Params: { botId: string } }>(
    '/:botId',
    async (request, reply) => {
      const { botId } = request.params;

      const existing = await getBot(request.userId, botId);
      if (!existing || existing.status === 'deleted') {
        return reply.status(404).send({ error: 'Bot not found' });
      }

      await deleteBot(request.userId, botId);
      return reply.status(204).send();
    },
  );

  // GET /:botId/skills — List available skills with enabled state for this bot
  app.get<{ Params: { botId: string } }>(
    '/:botId/skills',
    async (request, reply) => {
      const bot = await getBot(request.userId, request.params.botId);
      if (!bot || bot.status === 'deleted') {
        return reply.status(404).send({ error: 'Bot not found' });
      }

      const allSkills = await listSkills('active');
      const enabledSet = new Set(bot.skills || []);

      return {
        skills: allSkills.map((skill) => ({
          ...skill,
          enabled: enabledSet.has(skill.skillId),
        })),
      };
    },
  );

  // PUT /:botId/skills — Update enabled skills for this bot
  app.put<{ Params: { botId: string } }>(
    '/:botId/skills',
    async (request, reply) => {
      const { skills } = z.object({
        skills: z.array(z.string().min(1)).max(50),
      }).parse(request.body);

      const bot = await getBot(request.userId, request.params.botId);
      if (!bot || bot.status === 'deleted') {
        return reply.status(404).send({ error: 'Bot not found' });
      }

      // Validate all skillIds exist and are active (concurrent lookups)
      const resolved = await Promise.all(skills.map((id) => getSkill(id)));
      for (let i = 0; i < resolved.length; i++) {
        if (!resolved[i] || resolved[i]!.status !== 'active') {
          return reply.status(400).send({ error: `Skill ${skills[i]} not found or not active` });
        }
      }

      await updateBot(request.userId, request.params.botId, { skills });
      botCache.delete(request.params.botId);
      return { ok: true, skills };
    },
  );
};
