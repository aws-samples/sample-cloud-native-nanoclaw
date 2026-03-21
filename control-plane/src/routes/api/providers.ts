// NanoClaw on Cloud — Public Provider List Route
// Read-only list of configured model providers (any authenticated user)

import type { FastifyPluginAsync } from 'fastify';
import { listProviders } from '../../services/dynamo.js';

export const providersRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async () => {
    const providers = await listProviders();
    return providers.map((p) => ({
      providerId: p.providerId,
      providerName: p.providerName,
      providerType: p.providerType,
      modelIds: p.modelIds,
      isDefault: p.isDefault,
    }));
  });
};
