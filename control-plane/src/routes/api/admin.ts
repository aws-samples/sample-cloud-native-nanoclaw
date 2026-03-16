// ClawBot Cloud — Admin API Routes
// Manage users, quotas, and plans (requires clawbot-admins Cognito group)

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getUser, listAllUsers, updateUserQuota, updateUserPlan } from '../../services/dynamo.js';

const quotaSchema = z.object({
  maxBots: z.number().int().min(0).optional(),
  maxGroupsPerBot: z.number().int().min(0).optional(),
  maxTasksPerBot: z.number().int().min(0).optional(),
  maxConcurrentAgents: z.number().int().min(0).optional(),
  maxMonthlyTokens: z.number().int().min(0).optional(),
}).refine((obj) => Object.values(obj).some((v) => v !== undefined), {
  message: 'At least one quota field is required',
});

const planSchema = z.object({
  plan: z.enum(['free', 'pro', 'enterprise']),
});

export const adminRoutes: FastifyPluginAsync = async (app) => {
  // Admin-only guard
  app.addHook('onRequest', async (request, reply) => {
    if (!request.isAdmin) {
      return reply.status(403).send({ error: 'Admin access required' });
    }
  });

  // List all users
  app.get('/', async () => {
    const users = await listAllUsers();
    return users.map((u) => ({
      userId: u.userId,
      email: u.email,
      displayName: u.displayName,
      plan: u.plan,
      quota: u.quota,
      usageMonth: u.usageMonth,
      usageTokens: u.usageTokens,
      usageInvocations: u.usageInvocations,
      activeAgents: u.activeAgents,
      createdAt: u.createdAt,
      lastLogin: u.lastLogin,
    }));
  });

  // Get single user
  app.get<{ Params: { userId: string } }>('/:userId', async (request, reply) => {
    const user = await getUser(request.params.userId);
    if (!user) {
      return reply.status(404).send({ error: 'User not found' });
    }
    return {
      userId: user.userId,
      email: user.email,
      displayName: user.displayName,
      plan: user.plan,
      quota: user.quota,
      usageMonth: user.usageMonth,
      usageTokens: user.usageTokens,
      usageInvocations: user.usageInvocations,
      activeAgents: user.activeAgents,
      createdAt: user.createdAt,
      lastLogin: user.lastLogin,
    };
  });

  // Update user quota
  app.put<{ Params: { userId: string } }>('/:userId/quota', async (request, reply) => {
    const user = await getUser(request.params.userId);
    if (!user) {
      return reply.status(404).send({ error: 'User not found' });
    }
    const quota = quotaSchema.parse(request.body);
    await updateUserQuota(request.params.userId, quota);
    return { ok: true };
  });

  // Update user plan
  app.put<{ Params: { userId: string } }>('/:userId/plan', async (request, reply) => {
    const user = await getUser(request.params.userId);
    if (!user) {
      return reply.status(404).send({ error: 'User not found' });
    }
    const { plan } = planSchema.parse(request.body);
    await updateUserPlan(request.params.userId, plan);
    return { ok: true };
  });
};
