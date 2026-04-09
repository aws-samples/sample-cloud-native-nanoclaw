// auth-service/src/jwt.ts — RS256 JWT signing, verification, and JWKS endpoint

import { importPKCS8, importSPKI, exportJWK, SignJWT, jwtVerify } from 'jose';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  CreateSecretCommand,
  PutSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import crypto from 'node:crypto';

const ALG = 'RS256';
const KEY_ID = 'auth-key-1';

let privateKey: crypto.KeyObject | CryptoKey;
let publicKey: crypto.KeyObject | CryptoKey;
let jwksResponse: object;

export async function initKeys(region: string, stage: string): Promise<void> {
  const secretName = `nanoclawbot/${stage}/auth-signing-key`;
  const client = new SecretsManagerClient({ region });

  let pem: { privateKey: string; publicKey: string };

  try {
    const res = await client.send(
      new GetSecretValueCommand({ SecretId: secretName }),
    );
    pem = JSON.parse(res.SecretString!);
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ResourceNotFoundException') {
      const { privateKey: priv, publicKey: pub } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      pem = { privateKey: priv as string, publicKey: pub as string };
      try {
        await client.send(
          new CreateSecretCommand({
            Name: secretName,
            SecretString: JSON.stringify(pem),
            Description: 'RS256 signing key pair for self-hosted auth',
          }),
        );
      } catch (createErr: unknown) {
        if ((createErr as { name?: string }).name === 'ResourceAlreadyExistsException') {
          await client.send(
            new PutSecretValueCommand({
              SecretId: secretName,
              SecretString: JSON.stringify(pem),
            }),
          );
        } else {
          throw createErr;
        }
      }
    } else {
      throw err;
    }
  }

  privateKey = await importPKCS8(pem.privateKey, ALG);
  publicKey = await importSPKI(pem.publicKey, ALG);

  const jwk = await exportJWK(publicKey);
  jwksResponse = {
    keys: [{ ...jwk, kid: KEY_ID, alg: ALG, use: 'sig' }],
  };
}

export interface TokenClaims {
  sub: string;
  email: string;
  groups: string[];
}

export async function signAccessToken(claims: TokenClaims): Promise<string> {
  return new SignJWT({
    email: claims.email,
    'cognito:groups': claims.groups,
    token_use: 'access',
  })
    .setProtectedHeader({ alg: ALG, kid: KEY_ID })
    .setSubject(claims.sub)
    .setIssuer('clawbot-auth')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}

export async function signRefreshToken(sub: string): Promise<string> {
  return new SignJWT({ token_use: 'refresh' })
    .setProtectedHeader({ alg: ALG, kid: KEY_ID })
    .setSubject(sub)
    .setIssuer('clawbot-auth')
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(privateKey);
}

export async function verifyToken(token: string): Promise<TokenClaims> {
  const { payload } = await jwtVerify(token, publicKey, {
    issuer: 'clawbot-auth',
  });
  return {
    sub: payload.sub!,
    email: (payload as Record<string, unknown>).email as string,
    groups: ((payload as Record<string, unknown>)['cognito:groups'] as string[]) || [],
  };
}

export function getJwks(): object {
  return jwksResponse;
}
