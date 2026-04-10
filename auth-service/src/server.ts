// auth-service/src/server.ts — Self-hosted OIDC-compatible auth service

import Fastify from 'fastify';
import { z } from 'zod';
import { ulid } from 'ulid';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { initKeys, signAccessToken, signRefreshToken, verifyAccessToken, verifyRefreshToken, getJwks } from './jwt.js';
import { hashPassword, verifyPassword } from './password.js';

const logLevel = process.env.LOG_LEVEL || 'info';

const PORT = Number(process.env.PORT) || 3001;
const REGION = process.env.AWS_REGION || 'us-east-1';
const STAGE = process.env.STAGE || 'dev';
const USERS_TABLE = process.env.USERS_TABLE || `nanoclawbot-${STAGE}-users`;
const ADMIN_SECRET = process.env.ADMIN_BOOTSTRAP_SECRET || '';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

// ── Schemas ──────────────────────────────────────────────────────────────

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  plan: z.enum(['free', 'pro', 'enterprise']).default('free'),
  isAdmin: z.boolean().default(false),
  forcePasswordChange: z.boolean().default(false),
});

const statusSchema = z.object({
  status: z.enum(['active', 'suspended']),
});

// ── DynamoDB helpers ─────────────────────────────────────────────────────

interface AuthUser {
  userId: string;
  email: string;
  passwordHash: string;
  status: string;
  plan: string;
  isAdmin: boolean;
  forcePasswordChange?: boolean;
}

async function getUserByEmail(email: string): Promise<AuthUser | null> {
  const res = await ddb.send(new ScanCommand({
    TableName: USERS_TABLE,
    FilterExpression: 'email = :email',
    ExpressionAttributeValues: { ':email': email },
  }));
  return (res.Items?.[0] as AuthUser) || null;
}

async function getUserById(userId: string): Promise<AuthUser | null> {
  const res = await ddb.send(new GetCommand({
    TableName: USERS_TABLE,
    Key: { userId },
  }));
  return (res.Item as AuthUser) || null;
}

// ── Fastify app ──────────────────────────────────────────────────────────

const app = Fastify({
  logger: {
    level: logLevel,
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
  },
});
const logger = app.log;

app.get('/auth/.well-known/jwks.json', async () => getJwks());

app.get('/auth/health', async () => ({ status: 'ok' }));

// ── Login ────────────────────────────────────────────────────────────────

app.post('/auth/login', async (request, reply) => {
  const { email, password } = loginSchema.parse(request.body);

  const user = await getUserByEmail(email);
  if (!user || !user.passwordHash) {
    return reply.status(401).send({ error: 'Invalid email or password' });
  }
  if (user.status === 'suspended' || user.status === 'deleted') {
    return reply.status(403).send({ error: `Account is ${user.status}` });
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    return reply.status(401).send({ error: 'Invalid email or password' });
  }

  if (user.forcePasswordChange) {
    return reply.send({
      challengeName: 'NEW_PASSWORD_REQUIRED',
      userId: user.userId,
    });
  }

  const groups = user.isAdmin ? ['clawbot-admins'] : [];
  const accessToken = await signAccessToken({ sub: user.userId, email, groups });
  const refreshToken = await signRefreshToken(user.userId);

  return { accessToken, refreshToken, userId: user.userId };
});

// ── Refresh ──────────────────────────────────────────────────────────────

app.post('/auth/refresh', async (request, reply) => {
  const { refreshToken } = refreshSchema.parse(request.body);

  try {
    const { sub } = await verifyRefreshToken(refreshToken);
    const user = await getUserById(sub);
    if (!user || user.status === 'suspended' || user.status === 'deleted') {
      return reply.status(403).send({ error: 'Account unavailable' });
    }

    const groups = user.isAdmin ? ['clawbot-admins'] : [];
    const accessToken = await signAccessToken({ sub: user.userId, email: user.email, groups });
    const newRefreshToken = await signRefreshToken(user.userId);

    return { accessToken, refreshToken: newRefreshToken };
  } catch {
    return reply.status(401).send({ error: 'Invalid or expired refresh token' });
  }
});

// ── Change Password ──────────────────────────────────────────────────────

app.post('/auth/change-password', async (request, reply) => {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Missing authorization' });
  }

  let claims;
  try {
    claims = await verifyAccessToken(authHeader.substring(7));
  } catch {
    return reply.status(401).send({ error: 'Invalid token' });
  }

  const body = request.body as Record<string, unknown>;

  if (body.userId && body.newPassword) {
    // Force-change flow: verify user actually has forcePasswordChange flag
    const currentUser = await getUserById(claims.sub);
    if (!currentUser?.forcePasswordChange) {
      return reply.status(400).send({ error: 'Password change not required. Use currentPassword flow.' });
    }
    const { newPassword } = z.object({ userId: z.string(), newPassword: z.string().min(8) }).parse(body);
    const hash = await hashPassword(newPassword);

    await ddb.send(new UpdateCommand({
      TableName: USERS_TABLE,
      Key: { userId: claims.sub },
      UpdateExpression: 'SET passwordHash = :ph REMOVE forcePasswordChange',
      ExpressionAttributeValues: { ':ph': hash },
    }));

    const user = await getUserById(claims.sub);
    const groups = user?.isAdmin ? ['clawbot-admins'] : [];
    const accessToken = await signAccessToken({ sub: claims.sub, email: claims.email, groups });
    const refreshTokenNew = await signRefreshToken(claims.sub);
    return { accessToken, refreshToken: refreshTokenNew };
  }

  const { currentPassword, newPassword } = changePasswordSchema.parse(body);
  const user = await getUserById(claims.sub);
  if (!user) return reply.status(404).send({ error: 'User not found' });

  const valid = await verifyPassword(currentPassword, user.passwordHash);
  if (!valid) return reply.status(401).send({ error: 'Current password is incorrect' });

  const hash = await hashPassword(newPassword);
  await ddb.send(new UpdateCommand({
    TableName: USERS_TABLE,
    Key: { userId: claims.sub },
    UpdateExpression: 'SET passwordHash = :ph',
    ExpressionAttributeValues: { ':ph': hash },
  }));

  return { ok: true };
});

// ── Force Change Password (unauthenticated — for NEW_PASSWORD_REQUIRED flow)

app.post('/auth/force-change-password', async (request, reply) => {
  const { email, currentPassword, newPassword } = z.object({
    email: z.string().email(),
    currentPassword: z.string().min(1),
    newPassword: z.string().min(8),
  }).parse(request.body);

  const user = await getUserByEmail(email);
  if (!user || !user.passwordHash) {
    return reply.status(401).send({ error: 'Invalid credentials' });
  }
  if (!user.forcePasswordChange) {
    return reply.status(400).send({ error: 'Password change not required' });
  }

  const valid = await verifyPassword(currentPassword, user.passwordHash);
  if (!valid) {
    return reply.status(401).send({ error: 'Invalid credentials' });
  }

  const hash = await hashPassword(newPassword);
  await ddb.send(new UpdateCommand({
    TableName: USERS_TABLE,
    Key: { userId: user.userId },
    UpdateExpression: 'SET passwordHash = :ph REMOVE forcePasswordChange',
    ExpressionAttributeValues: { ':ph': hash },
  }));

  const groups = user.isAdmin ? ['clawbot-admins'] : [];
  const accessToken = await signAccessToken({ sub: user.userId, email, groups });
  const refreshToken = await signRefreshToken(user.userId);

  return { accessToken, refreshToken, userId: user.userId };
});

// ── Admin endpoints ──────────────────────────────────────────────────────

app.register(async (admin) => {
  admin.addHook('onRequest', async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Missing authorization' });
    }
    try {
      const claims = await verifyAccessToken(authHeader.substring(7));
      if (!claims.groups.includes('clawbot-admins')) {
        return reply.status(403).send({ error: 'Admin access required' });
      }
    } catch {
      const bootstrapSecret = request.headers['x-bootstrap-secret'];
      if (!ADMIN_SECRET || bootstrapSecret !== ADMIN_SECRET) {
        return reply.status(401).send({ error: 'Invalid token' });
      }
    }
  });

  admin.post('/users', async (request, reply) => {
    const { email, password, plan, isAdmin, forcePasswordChange } = createUserSchema.parse(request.body);

    const existing = await getUserByEmail(email);
    if (existing) {
      return reply.status(409).send({ error: 'User already exists' });
    }

    const userId = ulid();
    const passwordHash = await hashPassword(password);

    const item: Record<string, unknown> = {
      userId,
      email,
      passwordHash,
      plan,
      status: 'active',
      isAdmin,
      createdAt: new Date().toISOString(),
      botCount: 0,
    };
    if (forcePasswordChange) {
      item.forcePasswordChange = true;
    }

    await ddb.send(new PutCommand({
      TableName: USERS_TABLE,
      Item: item,
    }));

    return reply.status(201).send({ ok: true, userId, email });
  });

  admin.put('/users/:userId/status', async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const { status } = statusSchema.parse(request.body);

    const user = await getUserById(userId);
    if (!user) return reply.status(404).send({ error: 'User not found' });

    await ddb.send(new UpdateCommand({
      TableName: USERS_TABLE,
      Key: { userId },
      UpdateExpression: 'SET #s = :status',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':status': status },
    }));

    return { ok: true };
  });
}, { prefix: '/admin' });

// ── Startup ──────────────────────────────────────────────────────────────

async function start() {
  await initKeys(REGION, STAGE);
  await app.listen({ port: PORT, host: '0.0.0.0' });
  logger.info({ port: PORT }, 'Auth service started');
}

start().catch((err) => {
  logger.fatal(err, 'Failed to start auth service');
  process.exit(1);
});
