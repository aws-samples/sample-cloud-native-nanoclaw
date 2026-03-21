// ClawBot Cloud — Admin API Routes
// Manage users, quotas, and plans (requires clawbot-admins Cognito group)

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { config } from '../../config.js';
import {
  getUser,
  listAllUsers,
  listBots,
  updateUserQuota,
  updateUserPlan,
  createUserRecord,
  updateUserStatus,
  softDeleteUser,
  getPlanQuotas,
  savePlanQuotas,
} from '../../services/dynamo.js';

const cognitoClient = new CognitoIdentityProviderClient({ region: config.cognito.region });

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

const createUserSchema = z.object({
  email: z.string().email(),
  plan: z.enum(['free', 'pro', 'enterprise']).optional().default('free'),
});

const statusSchema = z.object({
  status: z.enum(['active', 'suspended']),
});

const userQuotaSchema = z.object({
  maxBots: z.number().int().min(0),
  maxGroupsPerBot: z.number().int().min(0),
  maxTasksPerBot: z.number().int().min(0),
  maxConcurrentAgents: z.number().int().min(0),
  maxMonthlyTokens: z.number().int().min(0),
});

const planQuotasSchema = z.object({
  free: userQuotaSchema,
  pro: userQuotaSchema,
  enterprise: userQuotaSchema,
});

export const adminRoutes: FastifyPluginAsync = async (app) => {
  // Admin-only guard
  app.addHook('onRequest', async (request, reply) => {
    if (!request.isAdmin) {
      return reply.status(403).send({ error: 'Admin access required' });
    }
  });

  // Get plan quotas (must be before /:userId to avoid param capture)
  app.get('/plans', async () => {
    return getPlanQuotas();
  });

  // Update plan quotas
  app.put('/plans', async (request) => {
    const quotas = planQuotasSchema.parse(request.body);
    await savePlanQuotas(quotas);
    return { ok: true };
  });

  // ── Create user (must be registered BEFORE /:userId routes) ───────────────
  app.post('/users', async (request, reply) => {
    const { email, plan } = createUserSchema.parse(request.body);
    const userPoolId = config.cognito.userPoolId;
    if (!userPoolId) {
      return reply.status(500).send({ error: 'Cognito User Pool not configured' });
    }

    // Create user in Cognito
    const cognitoResponse = await cognitoClient.send(
      new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: email,
        UserAttributes: [
          { Name: 'email', Value: email },
          { Name: 'email_verified', Value: 'true' },
        ],
        DesiredDeliveryMediums: ['EMAIL'],
      }),
    );

    const userId = cognitoResponse.User?.Attributes?.find(
      (a) => a.Name === 'sub',
    )?.Value;
    if (!userId) {
      return reply.status(500).send({ error: 'Failed to get user ID from Cognito' });
    }

    // Create user record in DynamoDB
    try {
      await createUserRecord(userId, email, plan);
    } catch (err) {
      request.log.error({ err, userId, email }, 'DDB write failed after Cognito user creation');
      return reply.status(500).send({ error: 'User created in auth but database write failed. Contact support.' });
    }

    return { ok: true, userId, email };
  });

  // List all users
  app.get('/', async () => {
    const users = await listAllUsers();
    const results = await Promise.all(
      users.map(async (u) => {
        const bots = await listBots(u.userId);
        const activeBots = bots.filter((b) => b.status !== 'deleted').length;
        return {
          userId: u.userId,
          email: u.email,
          displayName: u.displayName,
          plan: u.plan,
          status: u.status,
          quota: u.quota,
          usageMonth: u.usageMonth,
          usageTokens: u.usageTokens,
          usageInvocations: u.usageInvocations,
          botCount: activeBots,
          createdAt: u.createdAt,
          lastLogin: u.lastLogin,
        };
      }),
    );
    return results;
  });

  // Get single user
  app.get<{ Params: { userId: string } }>('/:userId', async (request, reply) => {
    const user = await getUser(request.params.userId);
    if (!user) {
      return reply.status(404).send({ error: 'User not found' });
    }
    const bots = await listBots(user.userId);
    const activeBots = bots.filter((b) => b.status !== 'deleted').length;
    return {
      userId: user.userId,
      email: user.email,
      displayName: user.displayName,
      plan: user.plan,
      status: user.status,
      quota: user.quota,
      usageMonth: user.usageMonth,
      usageTokens: user.usageTokens,
      usageInvocations: user.usageInvocations,
      botCount: activeBots,
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

  // ── Suspend / activate user ───────────────────────────────────────────────
  app.put<{ Params: { userId: string } }>('/:userId/status', async (request, reply) => {
    if (request.params.userId === request.userId) {
      return reply.status(400).send({ error: 'Cannot modify your own account status' });
    }
    const user = await getUser(request.params.userId);
    if (!user) {
      return reply.status(404).send({ error: 'User not found' });
    }
    const { status } = statusSchema.parse(request.body);
    const userPoolId = config.cognito.userPoolId;

    if (userPoolId) {
      if (status === 'suspended') {
        await cognitoClient.send(
          new AdminDisableUserCommand({ UserPoolId: userPoolId, Username: user.email }),
        );
      } else {
        await cognitoClient.send(
          new AdminEnableUserCommand({ UserPoolId: userPoolId, Username: user.email }),
        );
      }
    }

    try {
      await updateUserStatus(request.params.userId, status);
    } catch (err) {
      // Compensate: reverse Cognito change on DDB failure
      request.log.error({ err, userId: request.params.userId }, 'DDB status update failed after Cognito change');
      if (userPoolId) {
        const CompensateCmd = status === 'suspended' ? AdminEnableUserCommand : AdminDisableUserCommand;
        await cognitoClient.send(new CompensateCmd({ UserPoolId: userPoolId, Username: user.email })).catch(() => {});
      }
      return reply.status(500).send({ error: 'Failed to update user status' });
    }
    return { ok: true };
  });

  // ── Soft-delete user ──────────────────────────────────────────────────────
  app.delete<{ Params: { userId: string } }>('/:userId', async (request, reply) => {
    if (request.params.userId === request.userId) {
      return reply.status(400).send({ error: 'Cannot delete your own account' });
    }
    const user = await getUser(request.params.userId);
    if (!user) {
      return reply.status(404).send({ error: 'User not found' });
    }

    const userPoolId = config.cognito.userPoolId;
    if (userPoolId) {
      await cognitoClient.send(
        new AdminDisableUserCommand({ UserPoolId: userPoolId, Username: user.email }),
      );
    }

    try {
      await softDeleteUser(request.params.userId);
    } catch (err) {
      request.log.error({ err, userId: request.params.userId }, 'DDB soft-delete failed after Cognito disable');
      // Cognito is already disabled — log for manual remediation
      return reply.status(500).send({ error: 'User disabled in auth but database update failed' });
    }
    return { ok: true };
  });
};
