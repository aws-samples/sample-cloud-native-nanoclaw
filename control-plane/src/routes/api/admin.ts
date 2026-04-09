// NanoClaw on Cloud — Admin API Routes
// Manage users, quotas, plans, and model providers (requires clawbot-admins Cognito group)

import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ulid } from 'ulid';
import type {
  CognitoIdentityProviderClient as CognitoClientType,
} from '@aws-sdk/client-cognito-identity-provider';
import { config } from '../../config.js';
import {
  getUser,
  listAllUsers,
  updateUserQuota,
  updateUserPlan,
  createUserRecord,
  updateUserStatus,
  softDeleteUser,
  getPlanQuotas,
  savePlanQuotas,
  getProvider,
  listProviders,
  putProvider,
  updateProvider as updateProviderDb,
  deleteProvider as deleteProviderDb,
  clearDefaultProvider,
} from '../../services/dynamo.js';
import { putProviderApiKey, deleteProviderApiKey } from '../../services/secrets.js';
import type { ProviderType } from '@clawbot/shared';

let cognitoClient: CognitoClientType | null = null;

async function getCognitoClient(): Promise<CognitoClientType> {
  if (!cognitoClient) {
    const { CognitoIdentityProviderClient } = await import(
      '@aws-sdk/client-cognito-identity-provider'
    );
    cognitoClient = new CognitoIdentityProviderClient({ region: config.cognito.region });
  }
  return cognitoClient;
}

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

const providerCreateSchema = z.object({
  providerName: z.string().min(1).max(100),
  providerType: z.enum(['bedrock', 'anthropic-compatible-api']),
  baseUrl: z.string().url().max(500).optional(),
  apiKey: z.string().min(1).max(2000).optional(),
  modelIds: z.array(z.string().min(1).max(200)).min(1),
  isDefault: z.boolean().optional().default(false),
});

const providerUpdateSchema = z.object({
  providerName: z.string().min(1).max(100).optional(),
  providerType: z.enum(['bedrock', 'anthropic-compatible-api']).optional(),
  baseUrl: z.string().url().max(500).optional().nullable(),
  apiKey: z.string().min(1).max(2000).optional(),
  modelIds: z.array(z.string().min(1).max(200)).min(1).optional(),
  isDefault: z.boolean().optional(),
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

    if (config.agentMode === 'ecs') {
      const authEndpoint = config.auth.endpoint;
      if (!authEndpoint) {
        return reply.status(500).send({ error: 'Auth service endpoint not configured' });
      }
      const authHeader = request.headers.authorization || '';
      const res = await fetch(`${authEndpoint}/admin/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: authHeader },
        body: JSON.stringify({ email, password: crypto.randomUUID().slice(0, 16) + 'A1!', plan }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return reply.status(res.status).send(body);
      }
      const result = await res.json() as { userId: string; email: string };
      return { ok: true, userId: result.userId, email: result.email };
    }

    // AgentCore mode: Cognito
    const userPoolId = config.cognito.userPoolId;
    if (!userPoolId) {
      return reply.status(500).send({ error: 'Cognito User Pool not configured' });
    }
    const client = await getCognitoClient();
    const { AdminCreateUserCommand } = await import('@aws-sdk/client-cognito-identity-provider');
    const cognitoResponse = await client.send(
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

    try {
      await createUserRecord(userId, email, plan);
    } catch (err) {
      request.log.error({ err, userId, email }, 'DDB write failed after Cognito user creation');
      return reply.status(500).send({ error: 'User created in auth but database write failed. Contact support.' });
    }

    return { ok: true, userId, email };
  });

  // List all users — PERF-C1: uses denormalized botCount instead of N+1 listBots()
  app.get('/', async () => {
    const users = await listAllUsers();
    return users.map((u) => ({
      userId: u.userId,
      email: u.email,
      displayName: u.displayName,
      plan: u.plan,
      status: u.status,
      quota: u.quota,
      usageMonth: u.usageMonth,
      usageTokens: u.usageTokens,
      usageInvocations: u.usageInvocations,
      botCount: u.botCount ?? 0,
      createdAt: u.createdAt,
      lastLogin: u.lastLogin,
    }));
  });

  // Get single user — PERF-C1: uses denormalized botCount
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
      status: user.status,
      quota: user.quota,
      usageMonth: user.usageMonth,
      usageTokens: user.usageTokens,
      usageInvocations: user.usageInvocations,
      botCount: user.botCount ?? 0,
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

    if (config.agentMode === 'agentcore' && userPoolId) {
      const client = await getCognitoClient();
      const { AdminDisableUserCommand, AdminEnableUserCommand } = await import(
        '@aws-sdk/client-cognito-identity-provider'
      );
      if (status === 'suspended') {
        await client.send(
          new AdminDisableUserCommand({ UserPoolId: userPoolId, Username: user.email }),
        );
      } else {
        await client.send(
          new AdminEnableUserCommand({ UserPoolId: userPoolId, Username: user.email }),
        );
      }
    }

    try {
      await updateUserStatus(request.params.userId, status);
    } catch (err) {
      // Compensate: reverse Cognito change on DDB failure
      request.log.error({ err, userId: request.params.userId }, 'DDB status update failed after Cognito change');
      if (config.agentMode === 'agentcore' && userPoolId) {
        const client = await getCognitoClient();
        const { AdminDisableUserCommand, AdminEnableUserCommand } = await import(
          '@aws-sdk/client-cognito-identity-provider'
        );
        const CompensateCmd = status === 'suspended' ? AdminEnableUserCommand : AdminDisableUserCommand;
        await client.send(new CompensateCmd({ UserPoolId: userPoolId, Username: user.email })).catch(() => {});
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
    if (config.agentMode === 'agentcore' && userPoolId) {
      const client = await getCognitoClient();
      const { AdminDisableUserCommand } = await import(
        '@aws-sdk/client-cognito-identity-provider'
      );
      await client.send(
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

  // ── Provider CRUD ───────────────────────────────────────────────────────

  // List all providers
  app.get('/providers', async () => {
    return listProviders();
  });

  // Create a provider
  app.post('/providers', async (request, reply) => {
    const body = providerCreateSchema.parse(request.body);
    const now = new Date().toISOString();
    const providerId = ulid();

    // If this provider is the new default, clear existing default first
    if (body.isDefault) {
      await clearDefaultProvider();
    }

    // Store API key in Secrets Manager if provided
    if (body.apiKey) {
      await putProviderApiKey(providerId, body.apiKey);
    }

    await putProvider({
      providerId,
      providerName: body.providerName,
      providerType: body.providerType as ProviderType,
      baseUrl: body.baseUrl,
      hasApiKey: !!body.apiKey,
      modelIds: body.modelIds,
      isDefault: body.isDefault,
      createdAt: now,
      updatedAt: now,
    });

    const created = await getProvider(providerId);
    return reply.status(201).send(created);
  });

  // Update a provider
  app.put<{ Params: { providerId: string } }>('/providers/:providerId', async (request, reply) => {
    const { providerId } = request.params;
    const existing = await getProvider(providerId);
    if (!existing) {
      return reply.status(404).send({ error: 'Provider not found' });
    }

    const body = providerUpdateSchema.parse(request.body);
    const now = new Date().toISOString();

    // If setting as default, clear existing default first
    if (body.isDefault) {
      await clearDefaultProvider();
    }

    // Update API key in Secrets Manager if provided
    if (body.apiKey) {
      await putProviderApiKey(providerId, body.apiKey);
    }

    await updateProviderDb(providerId, {
      ...(body.providerName !== undefined && { providerName: body.providerName }),
      ...(body.providerType !== undefined && { providerType: body.providerType as ProviderType }),
      ...(body.baseUrl !== undefined && { baseUrl: body.baseUrl === null ? '' : body.baseUrl }),
      ...(body.apiKey !== undefined && { hasApiKey: true }),
      ...(body.modelIds !== undefined && { modelIds: body.modelIds }),
      ...(body.isDefault !== undefined && { isDefault: body.isDefault }),
      updatedAt: now,
    });

    const updated = await getProvider(providerId);
    return updated;
  });

  // Delete a provider
  app.delete<{ Params: { providerId: string } }>('/providers/:providerId', async (request, reply) => {
    const { providerId } = request.params;
    const existing = await getProvider(providerId);
    if (!existing) {
      return reply.status(404).send({ error: 'Provider not found' });
    }

    // Delete API key from Secrets Manager
    await deleteProviderApiKey(providerId);
    await deleteProviderDb(providerId);
    return reply.status(204).send();
  });

  // Register skills sub-routes (inherits admin guard)
  const { adminSkillsRoutes } = await import('./admin-skills.js');
  await app.register(adminSkillsRoutes, { prefix: '/skills' });

  // Register MCP server sub-routes (inherits admin guard)
  const { adminMcpRoutes } = await import('./admin-mcp.js');
  await app.register(adminMcpRoutes, { prefix: '/mcp-servers' });
};
