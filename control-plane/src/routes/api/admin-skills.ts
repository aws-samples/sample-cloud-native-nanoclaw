/**
 * Admin Skills Routes — CRUD for global platform-level Claude Code skills.
 * All routes require isAdmin. Registered under /api/admin/skills.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  getSkill,
  listSkills,
  updateSkill,
  deleteSkill as deleteSkillRecord,
} from '../../services/dynamo.js';
import {
  installFromZip,
  installFromGit,
  deleteSkillFiles,
} from '../../services/skills.js';

const gitInstallSchema = z.object({
  url: z.string().url().refine((u) => u.startsWith('https://'), { message: 'Only HTTPS URLs are supported' }),
  path: z.string().max(500).optional(),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(''),
  version: z.string().max(50).default('1.0.0'),
});

const updateSkillSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  version: z.string().max(50).optional(),
}).refine((obj) => Object.values(obj).some((v) => v !== undefined), {
  message: 'At least one field is required',
});

export const adminSkillsRoutes: FastifyPluginAsync = async (app) => {
  // Admin guard is inherited from parent admin plugin

  // GET / — List all skills (optional ?status=active|disabled)
  app.get<{ Querystring: { status?: string } }>(
    '/',
    async (request) => {
      const status = request.query.status;
      if (status && status !== 'active' && status !== 'disabled') {
        return { skills: await listSkills() };
      }
      return { skills: await listSkills(status || undefined) };
    },
  );

  // POST /upload — Upload skill from zip (multipart form)
  app.post('/upload', async (request, reply) => {
    const data = await request.file();
    if (!data) {
      return reply.status(400).send({ error: 'No file uploaded' });
    }

    const buffer = await data.toBuffer();
    const fields = data.fields as Record<string, { value?: string }>;
    const name = fields.name?.value;
    const description = fields.description?.value || '';
    const version = fields.version?.value || '1.0.0';

    if (!name) {
      return reply.status(400).send({ error: 'name field is required' });
    }

    try {
      const skill = await installFromZip(buffer, name, description, version, request.userId);
      return reply.status(201).send(skill);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      request.log.error({ err }, 'Skill zip upload failed');
      return reply.status(400).send({ error: msg });
    }
  });

  // POST /git — Install skill from git repo
  app.post('/git', async (request, reply) => {
    const body = gitInstallSchema.parse(request.body);

    try {
      const skill = await installFromGit(
        body.url,
        body.path,
        body.name,
        body.description,
        body.version,
        request.userId,
      );
      return reply.status(201).send(skill);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      request.log.error({ err }, 'Skill git install failed');
      return reply.status(400).send({ error: msg });
    }
  });

  // GET /:skillId — Get skill detail
  app.get<{ Params: { skillId: string } }>(
    '/:skillId',
    async (request, reply) => {
      const skill = await getSkill(request.params.skillId);
      if (!skill) {
        return reply.status(404).send({ error: 'Skill not found' });
      }
      return skill;
    },
  );

  // PUT /:skillId — Update skill metadata
  app.put<{ Params: { skillId: string } }>(
    '/:skillId',
    async (request, reply) => {
      const updates = updateSkillSchema.parse(request.body);
      const existing = await getSkill(request.params.skillId);
      if (!existing) {
        return reply.status(404).send({ error: 'Skill not found' });
      }

      await updateSkill(request.params.skillId, updates);
      const updated = await getSkill(request.params.skillId);
      return updated;
    },
  );

  // DELETE /:skillId — Delete skill (S3 + DDB)
  app.delete<{ Params: { skillId: string } }>(
    '/:skillId',
    async (request, reply) => {
      const existing = await getSkill(request.params.skillId);
      if (!existing) {
        return reply.status(404).send({ error: 'Skill not found' });
      }

      await deleteSkillFiles(existing.s3Prefixes);
      await deleteSkillRecord(request.params.skillId);
      // Note: bots with this skillId in their skills[] array retain the stale reference.
      // The agent-runtime's downloadDirectory gracefully handles missing S3 prefixes (no-op).
      // Cascade cleanup can be added later if the skills table grows large.
      return reply.status(204).send();
    },
  );
};
