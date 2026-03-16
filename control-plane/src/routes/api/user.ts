// ClawBot Cloud — User API Routes
// Returns authenticated user profile and usage information

import type { FastifyPluginAsync } from 'fastify';
import { ensureUser } from '../../services/dynamo.js';

export const userRoutes: FastifyPluginAsync = async (app) => {
  app.get('/me', async (request) => {
    const user = await ensureUser(request.userId, request.userEmail);
    return {
      userId: user.userId,
      email: user.email,
      plan: user.plan,
      quota: user.quota,
      usage: {
        month: user.usageMonth,
        tokens: user.usageTokens,
        invocations: user.usageInvocations,
      },
      isAdmin: request.isAdmin,
    };
  });
};
