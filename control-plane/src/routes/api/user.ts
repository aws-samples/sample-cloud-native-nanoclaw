// ClawBot Cloud — User API Routes
// Returns authenticated user profile and usage information

import type { FastifyPluginAsync } from 'fastify';
import { getUser } from '../../services/dynamo.js';

export const userRoutes: FastifyPluginAsync = async (app) => {
  app.get('/me', async (request) => {
    const user = await getUser(request.userId);
    if (!user) return { userId: request.userId, email: request.userEmail };
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
    };
  });
};
