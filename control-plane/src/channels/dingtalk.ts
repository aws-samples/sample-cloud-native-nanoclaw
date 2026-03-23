// NanoClaw on Cloud — DingTalk API Client
// Wraps DingTalk Open API (v1.0) for sending messages and verifying credentials
// Uses native fetch (raw HTTP calls), following the same pattern as feishu.ts and slack.ts.

const DINGTALK_API = 'https://api.dingtalk.com';

// ── Token Cache ───────────────────────────────────────────────────────────

interface CachedToken {
  token: string;
  expiresAt: number; // Date.now() ms
}

const tokenCache = new Map<string, CachedToken>();
const pendingTokenRequests = new Map<string, Promise<string>>();
const TOKEN_SAFETY_MARGIN_MS = 5 * 60 * 1000; // refresh 5 min before expiry

/**
 * Obtain a DingTalk v1.0 access token via OAuth2.
 * POST /v1.0/oauth2/accessToken
 *
 * Token is cached in-memory and refreshed 5 minutes before expiry.
 * Concurrent requests for the same clientId are deduplicated.
 */
export async function getAccessToken(clientId: string, clientSecret: string): Promise<string> {
  const cached = tokenCache.get(clientId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  // Deduplicate concurrent requests for the same clientId
  const pending = pendingTokenRequests.get(clientId);
  if (pending) return pending;

  const promise = fetchAccessToken(clientId, clientSecret).finally(() => {
    pendingTokenRequests.delete(clientId);
  });
  pendingTokenRequests.set(clientId, promise);
  return promise;
}

async function fetchAccessToken(clientId: string, clientSecret: string): Promise<string> {
  const url = `${DINGTALK_API}/v1.0/oauth2/accessToken`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appKey: clientId, appSecret: clientSecret }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `DingTalk getAccessToken failed: ${resp.status} ${resp.statusText} — ${body}`,
    );
  }

  const data = (await resp.json()) as {
    accessToken?: string;
    expireIn?: number; // seconds
  };
  if (!data.accessToken) {
    throw new Error(`DingTalk getAccessToken error: no accessToken in response`);
  }

  const expireSec = data.expireIn ?? 7200; // default 2 hours
  tokenCache.set(clientId, {
    token: data.accessToken,
    expiresAt: Date.now() + expireSec * 1000 - TOKEN_SAFETY_MARGIN_MS,
  });

  return data.accessToken;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Verify DingTalk app credentials by obtaining an access token.
 * DingTalk has no direct "get bot info" API — a successful token exchange
 * is sufficient to confirm the credentials are valid.
 */
export async function verifyCredentials(
  clientId: string,
  clientSecret: string,
): Promise<{ robotId: string; robotName: string }> {
  await getAccessToken(clientId, clientSecret);
  return { robotId: clientId, robotName: 'DingTalk Bot' };
}

/**
 * Send a plain text message to a 1:1 conversation.
 * POST /v1.0/robot/oToMessages/batchSend
 * Requires userIds (not openConversationId).
 */
export async function sendMessage(
  accessToken: string,
  userIds: string[],
  text: string,
  robotCode: string,
): Promise<void> {
  const url = `${DINGTALK_API}/v1.0/robot/oToMessages/batchSend`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'x-acs-dingtalk-access-token': accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      robotCode,
      userIds,
      msgParam: JSON.stringify({ content: text }),
      msgKey: 'sampleText',
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `DingTalk sendMessage failed: ${resp.status} ${resp.statusText} — ${body}`,
    );
  }
}

/**
 * Send a markdown message to a 1:1 conversation.
 * POST /v1.0/robot/oToMessages/batchSend
 * Requires userIds (not openConversationId).
 */
export async function sendMarkdownMessage(
  accessToken: string,
  userIds: string[],
  title: string,
  text: string,
  robotCode: string,
): Promise<void> {
  const url = `${DINGTALK_API}/v1.0/robot/oToMessages/batchSend`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'x-acs-dingtalk-access-token': accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      robotCode,
      userIds,
      msgParam: JSON.stringify({ title, text }),
      msgKey: 'sampleMarkdown',
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `DingTalk sendMarkdownMessage failed: ${resp.status} ${resp.statusText} — ${body}`,
    );
  }
}

/**
 * Reply with plain text to a group conversation.
 * POST /v1.0/robot/groupMessages/send
 */
export async function replyGroupMessage(
  accessToken: string,
  openConversationId: string,
  text: string,
  robotCode: string,
): Promise<void> {
  const url = `${DINGTALK_API}/v1.0/robot/groupMessages/send`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'x-acs-dingtalk-access-token': accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      robotCode,
      msgParam: JSON.stringify({ content: text }),
      msgKey: 'sampleText',
      openConversationId,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `DingTalk replyGroupMessage failed: ${resp.status} ${resp.statusText} — ${body}`,
    );
  }
}

/**
 * Reply with markdown to a group conversation.
 * POST /v1.0/robot/groupMessages/send
 */
export async function replyGroupMarkdownMessage(
  accessToken: string,
  openConversationId: string,
  title: string,
  text: string,
  robotCode: string,
): Promise<void> {
  const url = `${DINGTALK_API}/v1.0/robot/groupMessages/send`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'x-acs-dingtalk-access-token': accessToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      robotCode,
      msgParam: JSON.stringify({ title, text }),
      msgKey: 'sampleMarkdown',
      openConversationId,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `DingTalk replyGroupMarkdownMessage failed: ${resp.status} ${resp.statusText} — ${body}`,
    );
  }
}
