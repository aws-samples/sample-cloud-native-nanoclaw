// ClawBot Cloud — Telegram Bot API Client
// Wraps Telegram's HTTP Bot API for sending messages and managing webhooks

const TELEGRAM_API = 'https://api.telegram.org';

export async function sendMessage(
  botToken: string,
  chatId: string,
  text: string,
): Promise<void> {
  const url = `${TELEGRAM_API}/bot${botToken}/sendMessage`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `Telegram sendMessage failed: ${resp.status} ${resp.statusText} — ${body}`,
    );
  }
}

export async function setWebhook(
  botToken: string,
  webhookUrl: string,
  secretToken: string,
): Promise<void> {
  const url = `${TELEGRAM_API}/bot${botToken}/setWebhook`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: secretToken,
      allowed_updates: ['message', 'edited_message'],
      drop_pending_updates: false,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `Telegram setWebhook failed: ${resp.status} ${resp.statusText} — ${body}`,
    );
  }
}

export async function getMe(
  botToken: string,
): Promise<{ id: number; username: string }> {
  const url = `${TELEGRAM_API}/bot${botToken}/getMe`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Telegram getMe failed: ${resp.status}`);
  }
  const data = (await resp.json()) as {
    ok: boolean;
    result: { id: number; username: string };
  };
  if (!data.ok) {
    throw new Error('Telegram getMe returned ok=false');
  }
  return data.result;
}

export async function getFile(
  botToken: string,
  fileId: string,
): Promise<{ filePath: string }> {
  const url = `${TELEGRAM_API}/bot${botToken}/getFile`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
  });
  if (!resp.ok) {
    throw new Error(`Telegram getFile failed: ${resp.status}`);
  }
  const data = (await resp.json()) as {
    ok: boolean;
    result: { file_path: string };
  };
  if (!data.ok) {
    throw new Error('Telegram getFile returned ok=false');
  }
  return { filePath: data.result.file_path };
}

export async function deleteWebhook(botToken: string): Promise<void> {
  const url = `${TELEGRAM_API}/bot${botToken}/deleteWebhook`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ drop_pending_updates: false }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `Telegram deleteWebhook failed: ${resp.status} ${resp.statusText} — ${body}`,
    );
  }
}
