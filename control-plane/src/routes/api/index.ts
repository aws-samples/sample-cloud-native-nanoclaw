// ClawBot Cloud — API Route Registry
// Registers all REST API routes under /api with JWT auth middleware
// Supports Cognito (agentcore mode) and generic JWKS (ecs mode)

import type { FastifyPluginAsync } from 'fastify';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { CognitoJwtVerifierSingleUserPool } from 'aws-jwt-verify/cognito-verifier';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config } from '../../config.js';
import { getUser } from '../../services/dynamo.js';
import { botsRoutes } from './bots.js';
import { channelsRoutes } from './channels.js';
import { groupsRoutes } from './groups.js';
import { tasksRoutes } from './tasks.js';
import { memoryRoutes } from './memory.js';
import { userRoutes } from './user.js';
import { adminRoutes } from './admin.js';
import { filesRoutes } from './files.js';
import { providersRoutes } from './providers.js';
import { proxyRulesRoutes } from './proxy-rules.js';

// Extend Fastify request to include authenticated user info
declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
    userEmail: string;
    isAdmin: boolean;
    /** Raw request body string, stored before JSON parsing for webhook signature verification */
    rawBody?: string;
  }
}

// ── JWT Verifier abstraction ─────────────────────────────────────────────

interface JwtClaims {
  sub: string;
  email: string;
  groups: string[];
}

interface JwtVerifierAdapter {
  verify(token: string): Promise<JwtClaims>;
}

type SinglePoolVerifier = CognitoJwtVerifierSingleUserPool<{
  userPoolId: string;
  tokenUse: 'access';
  clientId: string;
}>;

class CognitoVerifierAdapter implements JwtVerifierAdapter {
  private verifier: SinglePoolVerifier;
  constructor(userPoolId: string, clientId: string) {
    this.verifier = CognitoJwtVerifier.create({
      userPoolId,
      tokenUse: 'access',
      clientId,
    });
  }
  async verify(token: string): Promise<JwtClaims> {
    const payload = await this.verifier.verify(token);
    return {
      sub: payload.sub,
      email: (payload as Record<string, unknown>).email as string || '',
      groups: ((payload as Record<string, unknown>)['cognito:groups'] as string[]) || [],
    };
  }
}

class JwksVerifierAdapter implements JwtVerifierAdapter {
  private jwks: ReturnType<typeof createRemoteJWKSet>;
  constructor(jwksUrl: string) {
    this.jwks = createRemoteJWKSet(new URL(jwksUrl));
  }
  async verify(token: string): Promise<JwtClaims> {
    const { payload } = await jwtVerify(token, this.jwks);
    return {
      sub: payload.sub!,
      email: (payload as Record<string, unknown>).email as string || '',
      groups: ((payload as Record<string, unknown>)['cognito:groups'] as string[]) || [],
    };
  }
}

function createVerifier(): JwtVerifierAdapter | null {
  if (config.agentMode === 'ecs') {
    if (!config.auth.jwksUrl) return null;
    return new JwksVerifierAdapter(config.auth.jwksUrl);
  }
  if (!config.cognito.userPoolId || !config.cognito.clientId) return null;
  return new CognitoVerifierAdapter(config.cognito.userPoolId, config.cognito.clientId);
}

// ── Route Plugin ─────────────────────────────────────────────────────────

export const apiRoutes: FastifyPluginAsync = async (app) => {
  const verifier = createVerifier();

  if (!verifier) {
    const mode = config.agentMode;
    app.log.warn(`JWT verifier not configured for mode=${mode} — all API requests will return 503`);
  }

  // Auth middleware — verify JWT and extract user info
  app.addHook('onRequest', async (request, reply) => {
    if (!verifier) {
      return reply.status(503).send({ error: 'Authentication service not configured' });
    }

    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Missing or invalid Authorization header' });
    }

    const token = authHeader.substring(7);

    try {
      const claims = await verifier.verify(token);
      request.userId = claims.sub;
      request.userEmail = claims.email;
      request.isAdmin = claims.groups.includes('clawbot-admins');
    } catch (err) {
      request.log.warn({ err }, 'JWT verification failed');
      return reply.status(401).send({ error: 'Invalid or expired token' });
    }

    // Check user status — suspended or deleted users are forbidden
    const user = await getUser(request.userId);
    if (user && (user.status === 'suspended' || user.status === 'deleted')) {
      return reply.status(403).send({ error: 'Account is ' + user.status });
    }
  });

  // Register resource routes
  await app.register(botsRoutes, { prefix: '/bots' });
  await app.register(channelsRoutes, { prefix: '/bots/:botId/channels' });
  await app.register(groupsRoutes, { prefix: '/bots/:botId/groups' });
  await app.register(tasksRoutes, { prefix: '/bots/:botId/tasks' });
  await app.register(filesRoutes, { prefix: '/bots/:botId/files' });
  await app.register(memoryRoutes);
  await app.register(userRoutes);
  await app.register(providersRoutes, { prefix: '/providers' });
  await app.register(proxyRulesRoutes, { prefix: '/proxy-rules' });
  await app.register(adminRoutes, { prefix: '/admin' });
};
