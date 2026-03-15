// ClawBot Cloud — API Route Registry
// Registers all REST API routes under /api with Cognito JWT auth middleware

import type { FastifyPluginAsync } from 'fastify';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { CognitoJwtVerifierSingleUserPool } from 'aws-jwt-verify/cognito-verifier';
import { config } from '../../config.js';
import { botsRoutes } from './bots.js';
import { channelsRoutes } from './channels.js';
import { groupsRoutes } from './groups.js';
import { tasksRoutes } from './tasks.js';
import { memoryRoutes } from './memory.js';
import { userRoutes } from './user.js';

// Extend Fastify request to include authenticated user info
declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
    userEmail: string;
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
      } catch {
        request.userId = 'dev-user';
        request.userEmail = 'dev@localhost';
      }
      return;
    }

    try {
      const payload = await verifier.verify(token);
      request.userId = payload.sub;
      request.userEmail = (payload as Record<string, unknown>).email as string || '';
    } catch (err) {
      request.log.warn({ err }, 'JWT verification failed');
      return reply.status(401).send({ error: 'Invalid or expired token' });
    }
  });

  // Register resource routes
  await app.register(botsRoutes, { prefix: '/bots' });
  await app.register(channelsRoutes, { prefix: '/bots/:botId/channels' });
  await app.register(groupsRoutes, { prefix: '/bots/:botId/groups' });
  await app.register(tasksRoutes, { prefix: '/bots/:botId/tasks' });
  await app.register(memoryRoutes);
  await app.register(userRoutes);
};
