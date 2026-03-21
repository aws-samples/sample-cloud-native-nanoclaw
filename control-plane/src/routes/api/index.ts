// ClawBot Cloud — API Route Registry
// Registers all REST API routes under /api with Cognito JWT auth middleware

import type { FastifyPluginAsync } from 'fastify';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { CognitoJwtVerifierSingleUserPool } from 'aws-jwt-verify/cognito-verifier';
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

type SinglePoolVerifier = CognitoJwtVerifierSingleUserPool<{
  userPoolId: string;
  tokenUse: 'access';
  clientId: string;
}>;

export const apiRoutes: FastifyPluginAsync = async (app) => {
  // Set up Cognito JWT verification
  let verifier: SinglePoolVerifier | null = null;
  if (config.cognito.userPoolId && config.cognito.clientId) {
    verifier = CognitoJwtVerifier.create({
      userPoolId: config.cognito.userPoolId,
      tokenUse: 'access',
      clientId: config.cognito.clientId,
    });
  }

  // Auth middleware — verify JWT and extract user info
  app.addHook('onRequest', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Missing or invalid Authorization header' });
    }

    const token = authHeader.substring(7);

    if (!verifier) {
      // Dev mode: skip verification, extract user from token payload
      try {
        const payload = JSON.parse(
          Buffer.from(token.split('.')[1], 'base64').toString(),
        );
        request.userId = payload.sub || 'dev-user';
        request.userEmail = payload.email || 'dev@localhost';
        const groups = (payload['cognito:groups'] as string[]) || [];
        request.isAdmin = groups.includes('clawbot-admins');
      } catch {
        request.userId = 'dev-user';
        request.userEmail = 'dev@localhost';
        request.isAdmin = false;
      }
    } else {
      try {
        const payload = await verifier.verify(token);
        request.userId = payload.sub;
        request.userEmail = (payload as Record<string, unknown>).email as string || '';
        const groups = ((payload as Record<string, unknown>)['cognito:groups'] as string[]) || [];
        request.isAdmin = groups.includes('clawbot-admins');
      } catch (err) {
        request.log.warn({ err }, 'JWT verification failed');
        return reply.status(401).send({ error: 'Invalid or expired token' });
      }
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
