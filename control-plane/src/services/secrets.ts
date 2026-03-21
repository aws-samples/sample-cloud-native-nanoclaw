import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
  CreateSecretCommand,
  DeleteSecretCommand,
} from '@aws-sdk/client-secrets-manager';
import { config } from '../config.js';

const client = new SecretsManagerClient({ region: config.region });

function anthropicKeySecretId(userId: string): string {
  return `nanoclawbot/${config.stage}/${userId}/anthropic-api-key`;
}

export async function getAnthropicApiKey(userId: string): Promise<string | null> {
  try {
    const result = await client.send(
      new GetSecretValueCommand({ SecretId: anthropicKeySecretId(userId) }),
    );
    return result.SecretString ?? null;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'ResourceNotFoundException') {
      return null;
    }
    throw err;
  }
}

// ── Provider API Keys ───────────────────────────────────────────────────

function providerKeySecretId(providerId: string): string {
  return `nanoclawbot/${config.stage}/providers/${providerId}/api-key`;
}

export async function getProviderApiKey(providerId: string): Promise<string | null> {
  try {
    const result = await client.send(
      new GetSecretValueCommand({ SecretId: providerKeySecretId(providerId) }),
    );
    return result.SecretString ?? null;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'ResourceNotFoundException') {
      return null;
    }
    throw err;
  }
}

export async function putProviderApiKey(providerId: string, apiKey: string): Promise<void> {
  const secretId = providerKeySecretId(providerId);
  try {
    await client.send(
      new PutSecretValueCommand({ SecretId: secretId, SecretString: apiKey }),
    );
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'ResourceNotFoundException') {
      await client.send(
        new CreateSecretCommand({ Name: secretId, SecretString: apiKey }),
      );
    } else {
      throw err;
    }
  }
}

export async function deleteProviderApiKey(providerId: string): Promise<void> {
  try {
    await client.send(
      new DeleteSecretCommand({
        SecretId: providerKeySecretId(providerId),
        ForceDeleteWithoutRecovery: true,
      }),
    );
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'ResourceNotFoundException') {
      return;
    }
    throw err;
  }
}

// ── Proxy Rules ─────────────────────────────────────────────────────────

export interface StoredProxyRule {
  id: string;
  name: string;
  prefix: string;
  target: string;
  authType: 'bearer' | 'api-key' | 'basic';
  headerName?: string;
  value: string; // secret — only returned internally, never to API clients
}

function proxyRulesSecretId(userId: string): string {
  return `nanoclawbot/${config.stage}/${userId}/proxy-rules`;
}

export async function getProxyRules(userId: string): Promise<StoredProxyRule[]> {
  try {
    const result = await client.send(
      new GetSecretValueCommand({ SecretId: proxyRulesSecretId(userId) }),
    );
    return JSON.parse(result.SecretString || '[]') as StoredProxyRule[];
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'ResourceNotFoundException') {
      return [];
    }
    throw err;
  }
}

export async function putProxyRules(userId: string, rules: StoredProxyRule[]): Promise<void> {
  const secretId = proxyRulesSecretId(userId);
  const value = JSON.stringify(rules);
  try {
    await client.send(
      new PutSecretValueCommand({ SecretId: secretId, SecretString: value }),
    );
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'ResourceNotFoundException') {
      await client.send(
        new CreateSecretCommand({ Name: secretId, SecretString: value }),
      );
    } else {
      throw err;
    }
  }
}
