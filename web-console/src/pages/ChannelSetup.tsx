import { useState } from 'react';
import { useParams, useNavigate, Link, useSearchParams } from 'react-router-dom';
import { useTranslation, Trans } from 'react-i18next';
import {
  ArrowLeft, Send, Hash, MessageSquare, Bird,
  CheckCircle2, Clipboard,
} from 'lucide-react';
import { clsx } from 'clsx';
import { channels as channelsApi } from '../lib/api';

type ChannelType = 'telegram' | 'discord' | 'slack' | 'feishu';

interface FieldDef {
  name: string;
  label: string;
  placeholder: string;
  type?: string;
}

const channelFields: Record<ChannelType, FieldDef[]> = {
  telegram: [{ name: 'botToken', label: 'Bot Token', placeholder: '123456:ABC-DEF...' }],
  discord: [
    { name: 'botToken', label: 'Bot Token', placeholder: 'MTk...' },
    { name: 'publicKey', label: 'Public Key', placeholder: 'Ed25519 public key' },
  ],
  slack: [
    { name: 'botToken', label: 'Bot Token', placeholder: 'xoxb-...' },
    { name: 'signingSecret', label: 'Signing Secret', placeholder: '32-character hex string' },
  ],
  feishu: [
    { name: 'appId', label: 'App ID', placeholder: 'cli_xxxxxxxxxxxxxxxx' },
    { name: 'appSecret', label: 'App Secret', placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', type: 'password' },
    { name: 'encryptKey', label: 'Encrypt Key', placeholder: 'Encrypt Key from event subscription settings', type: 'password' },
    { name: 'verificationToken', label: 'Verification Token', placeholder: 'Verification Token from event subscription settings', type: 'password' },
    { name: 'domain', label: 'Domain', placeholder: 'feishu' },
  ],
};

function useChannelMeta(): Record<ChannelType, { icon: React.ReactNode; label: string; desc: string }> {
  const { t } = useTranslation();
  return {
    telegram: { icon: <Send size={20} />, label: t('channelSetup.telegram.label'), desc: t('channelSetup.telegram.desc') },
    discord: { icon: <Hash size={20} />, label: t('channelSetup.discord.label'), desc: t('channelSetup.discord.desc') },
    slack: { icon: <MessageSquare size={20} />, label: t('channelSetup.slack.label'), desc: t('channelSetup.slack.desc') },
    feishu: { icon: <Bird size={20} />, label: t('channelSetup.feishu.label'), desc: t('channelSetup.feishu.desc') },
  };
}

/* ── Reusable step number badge ────────────────────────────────────── */

function StepNum({ n, variant = 'guide' }: { n: number; variant?: 'guide' | 'success' }) {
  return (
    <span className={clsx(
      'flex-shrink-0 w-6 h-6 rounded-full text-white text-xs flex items-center justify-center font-bold',
      variant === 'success' ? 'bg-green-600' : 'bg-accent-500',
    )}>
      {n}
    </span>
  );
}

/* ── Reusable copy button ──────────────────────────────────────────── */

function CopyBtn({ text, variant = 'success' }: { text: string; variant?: 'guide' | 'success' }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={() => navigator.clipboard.writeText(text)}
      className={clsx(
        'flex-shrink-0 inline-flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-xs font-medium text-white transition-colors',
        variant === 'success'
          ? 'bg-green-600 hover:bg-green-700'
          : 'bg-accent-500 hover:bg-accent-600',
      )}
      title={t('common.copy')}
    >
      <Clipboard size={13} />
      {t('common.copy')}
    </button>
  );
}

/* ── Slack Guide ───────────────────────────────────────────────────── */

function SlackGuide({ botId, step }: { botId: string; step: 'before' | 'after' }) {
  const { t } = useTranslation();
  const webhookUrl = `${window.location.origin}/webhook/slack/${botId}`;

  if (step === 'before') {
    return (
      <div className="border border-slate-200 rounded-xl bg-white p-5 space-y-4 text-sm">
        <h3 className="font-semibold text-slate-900 text-base">{t('channelSetup.slack.guideTitle')}</h3>

        <div className="space-y-3">
          <div className="flex gap-3">
            <StepNum n={1} />
            <div>
              <p className="font-medium text-slate-900">{t('channelSetup.slack.step1title')}</p>
              <p className="text-slate-600 mt-0.5">
                <Trans i18nKey="channelSetup.slack.step1desc">
                  Go to <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer" className="underline font-medium text-accent-600 hover:text-accent-700">api.slack.com/apps</a> → <strong>Create New App</strong> → <strong>From scratch</strong> → name it and select your workspace.
                </Trans>
              </p>
            </div>
          </div>

          <div className="flex gap-3">
            <StepNum n={2} />
            <div>
              <p className="font-medium text-slate-900">{t('channelSetup.slack.step2title')}</p>
              <p className="text-slate-600 mt-0.5">
                <Trans i18nKey="channelSetup.slack.step2desc">
                  Left menu → <strong>OAuth & Permissions</strong> → scroll to <strong>Bot Token Scopes</strong> → add:
                </Trans>
              </p>
              <ul className="mt-1 ml-4 list-disc text-slate-600 space-y-0.5">
                <li><Trans i18nKey="channelSetup.slack.step2scope1"><code className="bg-slate-100 px-1 rounded text-slate-800">chat:write</code> — Send messages</Trans></li>
                <li><Trans i18nKey="channelSetup.slack.step2scope2"><code className="bg-slate-100 px-1 rounded text-slate-800">channels:history</code> — Read public channel messages</Trans></li>
                <li><Trans i18nKey="channelSetup.slack.step2scope3"><code className="bg-slate-100 px-1 rounded text-slate-800">groups:history</code> — Read private channel messages</Trans></li>
                <li><Trans i18nKey="channelSetup.slack.step2scope4"><code className="bg-slate-100 px-1 rounded text-slate-800">im:history</code> — Read direct messages</Trans></li>
                <li><Trans i18nKey="channelSetup.slack.step2scope5"><code className="bg-slate-100 px-1 rounded text-slate-800">im:read</code> — Access DM conversations</Trans></li>
                <li><Trans i18nKey="channelSetup.slack.step2scope6"><code className="bg-slate-100 px-1 rounded text-slate-800">im:write</code> — Send direct messages</Trans></li>
                <li><Trans i18nKey="channelSetup.slack.step2scope7"><code className="bg-slate-100 px-1 rounded text-slate-800">files:read</code> — Read file attachments sent by users</Trans></li>
                <li><Trans i18nKey="channelSetup.slack.step2scope8"><code className="bg-slate-100 px-1 rounded text-slate-800">files:write</code> — Send file attachments in responses</Trans></li>
              </ul>
              <p className="text-slate-500 mt-1 text-xs">
                <Trans i18nKey="channelSetup.slack.step2scopeNote">
                  The <code className="bg-slate-100 px-1 rounded text-slate-700">files:read</code> and <code className="bg-slate-100 px-1 rounded text-slate-700">files:write</code> scopes are needed for sending and receiving file attachments.
                </Trans>
              </p>
            </div>
          </div>

          <div className="flex gap-3">
            <StepNum n={3} />
            <div>
              <p className="font-medium text-slate-900">{t('channelSetup.slack.step3title')}</p>
              <p className="text-slate-600 mt-0.5">
                <Trans i18nKey="channelSetup.slack.step3desc">
                  Left menu → <strong>App Home</strong> → scroll to <strong>Show Tabs</strong>:
                </Trans>
              </p>
              <ul className="mt-1 ml-4 list-disc text-slate-600 space-y-0.5">
                <li><Trans i18nKey="channelSetup.slack.step3item1">Toggle <strong>Messages Tab</strong> to ON</Trans></li>
                <li><Trans i18nKey="channelSetup.slack.step3item2">Check <strong>"Allow users to send Slash commands and messages from the messages tab"</strong></Trans></li>
              </ul>
              <p className="text-slate-500 mt-1 text-xs">{t('channelSetup.slack.step3note')}</p>
            </div>
          </div>

          <div className="flex gap-3">
            <StepNum n={4} />
            <div>
              <p className="font-medium text-slate-900">{t('channelSetup.slack.step4title')}</p>
              <p className="text-slate-600 mt-0.5">
                <Trans i18nKey="channelSetup.slack.step4desc">
                  Left menu → <strong>OAuth & Permissions</strong> → click <strong>Install to Workspace</strong> → Authorize.
                </Trans>
              </p>
            </div>
          </div>

          <div className="flex gap-3">
            <StepNum n={5} />
            <div>
              <p className="font-medium text-slate-900">{t('channelSetup.slack.step5title')}</p>
              <p className="text-slate-600 mt-0.5">
                <Trans i18nKey="channelSetup.slack.step5desc">
                  After installing, copy the <strong>Bot User OAuth Token</strong> (starts with <code className="bg-slate-100 px-1 rounded text-slate-800">xoxb-</code>). Paste it below.
                </Trans>
              </p>
            </div>
          </div>

          <div className="flex gap-3">
            <StepNum n={6} />
            <div>
              <p className="font-medium text-slate-900">{t('channelSetup.slack.step6title')}</p>
              <p className="text-slate-600 mt-0.5">
                <Trans i18nKey="channelSetup.slack.step6desc">
                  Left menu → <strong>Basic Information</strong> → scroll to <strong>App Credentials</strong> → click <strong>Show</strong> next to <strong>Signing Secret</strong>. Paste it below.
                </Trans>
              </p>
            </div>
          </div>
        </div>

        <div className="border-t border-slate-200 pt-3 mt-3">
          <p className="text-slate-700 font-medium">{t('channelSetup.slack.fillBoth')}</p>
        </div>
      </div>
    );
  }

  // step === 'after'
  return (
    <div className="border border-green-300 bg-green-50 rounded-xl p-5 space-y-4 text-sm">
      <div className="flex items-center gap-2">
        <CheckCircle2 size={20} className="text-green-600" />
        <h3 className="font-semibold text-green-900 text-base">{t('channelSetup.slack.connectedTitle')}</h3>
      </div>

      <p className="text-green-800">{t('channelSetup.slack.connectedDesc')}</p>

      <div className="space-y-3">
        <div className="flex gap-3">
          <StepNum n={7} variant="success" />
          <div>
            <p className="font-medium text-green-900">{t('channelSetup.slack.afterStep1title')}</p>
            <p className="text-green-700 mt-0.5">
              <Trans i18nKey="channelSetup.slack.afterStep1desc">
                In your Slack App settings → left menu → <strong>Event Subscriptions</strong> → toggle <strong>Enable Events</strong> to ON.
              </Trans>
            </p>
          </div>
        </div>

        <div className="flex gap-3">
          <StepNum n={8} variant="success" />
          <div>
            <p className="font-medium text-green-900">{t('channelSetup.slack.afterStep2title')}</p>
            <p className="text-green-700 mt-0.5">
              <Trans i18nKey="channelSetup.slack.afterStep2desc">
                Paste this URL into the <strong>Request URL</strong> field:
              </Trans>
            </p>
            <div className="mt-1.5 flex items-center gap-2">
              <code className="flex-1 bg-white border border-green-300 rounded-lg px-3 py-2 text-xs font-mono text-green-900 break-all select-all">
                {webhookUrl}
              </code>
              <CopyBtn text={webhookUrl} variant="success" />
            </div>
            <p className="text-green-600 mt-1 text-xs">{t('channelSetup.slack.afterStep2verify')}</p>
          </div>
        </div>

        <div className="flex gap-3">
          <StepNum n={9} variant="success" />
          <div>
            <p className="font-medium text-green-900">{t('channelSetup.slack.afterStep3title')}</p>
            <p className="text-green-700 mt-0.5">
              <Trans i18nKey="channelSetup.slack.afterStep3desc">
                Below the Request URL, expand <strong>Subscribe to bot events</strong> → click <strong>Add Bot User Event</strong> → add:
              </Trans>
            </p>
            <ul className="mt-1 ml-4 list-disc text-green-700 space-y-0.5">
              <li><code className="bg-green-100 px-1 rounded">message.channels</code></li>
              <li><code className="bg-green-100 px-1 rounded">message.groups</code></li>
              <li><code className="bg-green-100 px-1 rounded">message.im</code></li>
            </ul>
          </div>
        </div>

        <div className="flex gap-3">
          <StepNum n={10} variant="success" />
          <div>
            <p className="font-medium text-green-900">{t('channelSetup.slack.afterStep4title')}</p>
            <p className="text-green-700 mt-0.5">
              <Trans i18nKey="channelSetup.slack.afterStep4desc">
                Click <strong>Save Changes</strong>. Then go to <strong>OAuth & Permissions</strong> → <strong>Reinstall to Workspace</strong> (required after adding scopes or event subscriptions). Finally, invite the bot to a channel: type <code className="bg-green-100 px-1 rounded">/invite @YourBotName</code>
              </Trans>
            </p>
          </div>
        </div>
      </div>

      <div className="border-t border-green-200 pt-3 mt-3">
        <p className="text-green-800">
          <Trans i18nKey="channelSetup.slack.afterDone">
            Once done, send a message mentioning your bot (e.g., <code className="bg-green-100 px-1 rounded">@BotName hello</code>) and it will respond!
          </Trans>
        </p>
      </div>
    </div>
  );
}

function TelegramGuide() {
  const { t } = useTranslation();
  return (
    <div className="border border-slate-200 rounded-xl bg-white p-5 text-sm space-y-3">
      <h3 className="font-semibold text-slate-900">{t('channelSetup.telegram.guideTitle')}</h3>
      <ol className="space-y-2.5">
        <li className="flex gap-3">
          <StepNum n={1} />
          <span className="text-slate-600">
            <Trans i18nKey="channelSetup.telegram.step1">
              Open Telegram and message <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" className="underline font-medium text-accent-600 hover:text-accent-700">@BotFather</a>
            </Trans>
          </span>
        </li>
        <li className="flex gap-3">
          <StepNum n={2} />
          <span className="text-slate-600">
            <Trans i18nKey="channelSetup.telegram.step2">
              Send <code className="bg-slate-100 px-1 rounded text-slate-800">/newbot</code> and follow the prompts
            </Trans>
          </span>
        </li>
        <li className="flex gap-3">
          <StepNum n={3} />
          <span className="text-slate-600">
            <Trans i18nKey="channelSetup.telegram.step3">
              Copy the token (looks like <code className="bg-slate-100 px-1 rounded text-slate-800">123456:ABC-DEF...</code>)
            </Trans>
          </span>
        </li>
      </ol>
      <p className="text-slate-500 text-xs mt-2">{t('channelSetup.telegram.autoWebhook')}</p>
    </div>
  );
}

function DiscordGuide({ botId, step }: { botId: string; step: 'before' | 'after' }) {
  const { t } = useTranslation();
  const webhookUrl = `${window.location.origin}/webhook/discord/${botId}`;

  if (step === 'before') {
    return (
      <div className="border border-slate-200 rounded-xl bg-white p-5 space-y-4 text-sm">
        <h3 className="font-semibold text-slate-900 text-base">{t('channelSetup.discord.guideTitle')}</h3>

        <div className="space-y-3">
          <div className="flex gap-3">
            <StepNum n={1} />
            <div>
              <p className="font-medium text-slate-900">{t('channelSetup.discord.step1title')}</p>
              <p className="text-slate-600 mt-0.5">
                <Trans i18nKey="channelSetup.discord.step1desc">
                  Go to <a href="https://discord.com/developers/applications" target="_blank" rel="noopener noreferrer" className="underline font-medium text-accent-600 hover:text-accent-700">Discord Developer Portal</a> → <strong>New Application</strong> → give it a name → <strong>Create</strong>.
                </Trans>
              </p>
            </div>
          </div>

          <div className="flex gap-3">
            <StepNum n={2} />
            <div>
              <p className="font-medium text-slate-900">{t('channelSetup.discord.step2title')}</p>
              <p className="text-slate-600 mt-0.5">
                <Trans i18nKey="channelSetup.discord.step2desc">
                  Left menu → <strong>Bot</strong> → click <strong>Reset Token</strong> → copy it immediately (you can only see it once).
                </Trans>
              </p>
            </div>
          </div>

          <div className="flex gap-3">
            <StepNum n={3} />
            <div>
              <p className="font-medium text-slate-900">{t('channelSetup.discord.step3title')}</p>
              <p className="text-slate-600 mt-0.5">
                <Trans i18nKey="channelSetup.discord.step3desc">
                  On the same <strong>Bot</strong> page, scroll to <strong>Privileged Gateway Intents</strong> and enable:
                </Trans>
              </p>
              <ul className="mt-1 ml-4 list-disc text-slate-600 space-y-0.5">
                <li><Trans i18nKey="channelSetup.discord.step3intent1"><code className="bg-slate-100 px-1 rounded text-slate-800">Message Content Intent</code> — required to read message text</Trans></li>
                <li><Trans i18nKey="channelSetup.discord.step3intent2"><code className="bg-slate-100 px-1 rounded text-slate-800">Server Members Intent</code> — optional, for member display names</Trans></li>
              </ul>
            </div>
          </div>

          <div className="flex gap-3">
            <StepNum n={4} />
            <div>
              <p className="font-medium text-slate-900">{t('channelSetup.discord.step4title')}</p>
              <p className="text-slate-600 mt-0.5">
                <Trans i18nKey="channelSetup.discord.step4desc">
                  Left menu → <strong>General Information</strong> → copy the <strong>Public Key</strong> (64-character hex string).
                </Trans>
              </p>
            </div>
          </div>

          <div className="flex gap-3">
            <StepNum n={5} />
            <div>
              <p className="font-medium text-slate-900">{t('channelSetup.discord.step5title')}</p>
              <p className="text-slate-600 mt-0.5">
                <Trans i18nKey="channelSetup.discord.step5desc">
                  Left menu → <strong>OAuth2</strong> → <strong>URL Generator</strong>:
                </Trans>
              </p>
              <ul className="mt-1 ml-4 list-disc text-slate-600 space-y-0.5">
                <li><Trans i18nKey="channelSetup.discord.step5scopes">Scopes: select <code className="bg-slate-100 px-1 rounded text-slate-800">bot</code> and <code className="bg-slate-100 px-1 rounded text-slate-800">applications.commands</code></Trans></li>
                <li>{t('channelSetup.discord.step5permsTitle')}
                  <ul className="mt-0.5 ml-4 list-[circle] text-slate-600 space-y-0.5">
                    <li><Trans i18nKey="channelSetup.discord.step5perm1"><code className="bg-slate-100 px-1 rounded text-slate-800">Send Messages</code></Trans></li>
                    <li><Trans i18nKey="channelSetup.discord.step5perm2"><code className="bg-slate-100 px-1 rounded text-slate-800">Send Messages in Threads</code></Trans></li>
                    <li><Trans i18nKey="channelSetup.discord.step5perm3"><code className="bg-slate-100 px-1 rounded text-slate-800">Embed Links</code> — for rich reply formatting</Trans></li>
                    <li><Trans i18nKey="channelSetup.discord.step5perm4"><code className="bg-slate-100 px-1 rounded text-slate-800">Read Message History</code></Trans></li>
                    <li><Trans i18nKey="channelSetup.discord.step5perm5"><code className="bg-slate-100 px-1 rounded text-slate-800">View Channels</code></Trans></li>
                    <li><Trans i18nKey="channelSetup.discord.step5perm6"><code className="bg-slate-100 px-1 rounded text-slate-800">Attach Files</code> — for sending file attachments</Trans></li>
                    <li><Trans i18nKey="channelSetup.discord.step5perm7"><code className="bg-slate-100 px-1 rounded text-slate-800">Use Slash Commands</code></Trans></li>
                  </ul>
                </li>
              </ul>
              <p className="text-slate-600 mt-1">
                <Trans i18nKey="channelSetup.discord.step5final">
                  Copy the generated URL → open in browser → select your server → <strong>Authorize</strong>.
                </Trans>
              </p>
            </div>
          </div>
        </div>

        <div className="border-t border-slate-200 pt-3 mt-3">
          <p className="text-slate-700 font-medium">{t('channelSetup.discord.fillFields')}</p>
        </div>
      </div>
    );
  }

  // step === 'after'
  return (
    <div className="border border-green-300 bg-green-50 rounded-xl p-5 space-y-4 text-sm">
      <div className="flex items-center gap-2">
        <CheckCircle2 size={20} className="text-green-600" />
        <h3 className="font-semibold text-green-900 text-base">{t('channelSetup.discord.connectedTitle')}</h3>
      </div>

      <p className="text-green-800">{t('channelSetup.discord.connectedDesc')}</p>

      <div className="space-y-3">
        <div className="flex gap-3">
          <StepNum n={6} variant="success" />
          <div>
            <p className="font-medium text-green-900">{t('channelSetup.discord.afterStep1title')}</p>
            <p className="text-green-700 mt-0.5">
              <Trans i18nKey="channelSetup.discord.afterStep1desc">
                In Discord Developer Portal → your app → <strong>General Information</strong> → paste this into <strong>Interactions Endpoint URL</strong>:
              </Trans>
            </p>
            <div className="mt-1.5 flex items-center gap-2">
              <code className="flex-1 bg-white border border-green-300 rounded-lg px-3 py-2 text-xs font-mono text-green-900 break-all select-all">
                {webhookUrl}
              </code>
              <CopyBtn text={webhookUrl} variant="success" />
            </div>
            <p className="text-green-600 mt-1 text-xs">{t('channelSetup.discord.afterStep1verify')}</p>
          </div>
        </div>

        <div className="flex gap-3">
          <StepNum n={7} variant="success" />
          <div>
            <p className="font-medium text-green-900">{t('channelSetup.discord.afterStep2title')}</p>
            <p className="text-green-700 mt-0.5">
              <Trans i18nKey="channelSetup.discord.afterStep2desc">
                To use the bot in <strong>private channels</strong>, you must add it explicitly:
              </Trans>
            </p>
            <ul className="mt-1 ml-4 list-disc text-green-700 space-y-0.5">
              <li><Trans i18nKey="channelSetup.discord.afterStep2item1">Open the private channel → click the channel name (gear icon) → <strong>Permissions</strong></Trans></li>
              <li><Trans i18nKey="channelSetup.discord.afterStep2item2">Click <strong>+</strong> to add members/roles → search for your bot name</Trans></li>
              <li><Trans i18nKey="channelSetup.discord.afterStep2item3">Ensure <strong>View Channel</strong>, <strong>Send Messages</strong>, and <strong>Read Message History</strong> are enabled</Trans></li>
            </ul>
            <p className="text-green-600 mt-1 text-xs">{t('channelSetup.discord.afterStep2note')}</p>
          </div>
        </div>

        <div className="flex gap-3">
          <StepNum n={8} variant="success" />
          <div>
            <p className="font-medium text-green-900">{t('channelSetup.discord.afterStep3title')}</p>
            <p className="text-green-700 mt-0.5">
              {t('channelSetup.discord.afterStep3desc')}
            </p>
            <ul className="mt-1 ml-4 list-disc text-green-700 space-y-0.5">
              <li><Trans i18nKey="channelSetup.discord.afterStep3method1"><strong>@mention</strong> — type <code className="bg-green-100 px-1 rounded">@YourBotName hello</code> in any channel</Trans></li>
              <li><Trans i18nKey="channelSetup.discord.afterStep3method2"><strong>Slash commands</strong> — type <code className="bg-green-100 px-1 rounded">/ask</code> to send a private question, <code className="bg-green-100 px-1 rounded">/status</code> for bot info, <code className="bg-green-100 px-1 rounded">/help</code> for usage guide</Trans></li>
              <li><Trans i18nKey="channelSetup.discord.afterStep3method3"><strong>Direct messages</strong> — DM the bot directly for private conversations</Trans></li>
            </ul>
            <p className="text-green-600 mt-1 text-xs">{t('channelSetup.discord.afterStep3note')}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function FeishuGuide({ step }: { step: 'before' | 'after' }) {
  const { t } = useTranslation();

  if (step === 'before') {
    return (
      <div className="border border-slate-200 rounded-xl bg-white p-5 space-y-4 text-sm">
        <h3 className="font-semibold text-slate-900 text-base">{t('channelSetup.feishu.guideTitle')}</h3>

        <div className="space-y-3">
          <div className="flex gap-3">
            <StepNum n={1} />
            <div>
              <p className="font-medium text-slate-900">{t('channelSetup.feishu.step1title')}</p>
              <p className="text-slate-600 mt-0.5">
                <Trans i18nKey="channelSetup.feishu.step1desc">
                  打开 <a href="https://open.feishu.cn" target="_blank" rel="noopener noreferrer" className="underline font-medium text-accent-600 hover:text-accent-700">飞书开放平台 (open.feishu.cn)</a> → <strong>创建自建应用</strong>
                </Trans>
              </p>
            </div>
          </div>

          <div className="flex gap-3">
            <StepNum n={2} />
            <div>
              <p className="font-medium text-slate-900">{t('channelSetup.feishu.step2title')}</p>
              <p className="text-slate-600 mt-0.5">
                <Trans i18nKey="channelSetup.feishu.step2desc">
                  在应用的 <strong>凭证与基础信息</strong> 页面获取 App ID 和 App Secret
                </Trans>
              </p>
            </div>
          </div>

          <div className="flex gap-3">
            <StepNum n={3} />
            <div>
              <p className="font-medium text-slate-900">{t('channelSetup.feishu.step3title')}</p>
              <p className="text-slate-600 mt-0.5">
                <Trans i18nKey="channelSetup.feishu.step3desc">
                  在「<strong>事件与回调</strong>」中获取 Encrypt Key 和 Verification Token
                </Trans>
              </p>
            </div>
          </div>

          <div className="flex gap-3">
            <StepNum n={4} />
            <div>
              <p className="font-medium text-slate-900">{t('channelSetup.feishu.step4title')}</p>
              <p className="text-slate-600 mt-0.5">
                <Trans i18nKey="channelSetup.feishu.step4desc">
                  在「<strong>权限管理</strong>」中申请以下权限：
                </Trans>
              </p>
              <p className="mt-1 text-slate-500 text-xs">{t('channelSetup.feishu.step4batchImport')}</p>
              <details className="mt-2 mb-2">
                <summary className="cursor-pointer text-accent-600 text-xs font-medium hover:text-accent-700">{t('channelSetup.feishu.step4expandJson')}</summary>
                <div className="mt-1.5 relative">
                  <pre className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs text-slate-800 overflow-x-auto max-h-48 overflow-y-auto font-mono leading-relaxed">{`{
  "scopes": {
    "tenant": [
      "aily:file:read",
      "aily:file:write",
      "application:application.app_message_stats.overview:readonly",
      "application:application:self_manage",
      "application:bot.menu:write",
      "cardkit:card:read",
      "cardkit:card:write",
      "contact:user.employee_id:readonly",
      "corehr:file:download",
      "docs:doc",
      "docs:doc:readonly",
      "docx:document",
      "docx:document:readonly",
      "docx:document.block:convert",
      "drive:drive",
      "drive:drive:readonly",
      "docs:permission.member:create",
      "event:ip_list",
      "im:chat.access_event.bot_p2p_chat:read",
      "im:chat.members:bot_access",
      "im:message",
      "im:message.group_at_msg:readonly",
      "im:message.group_msg",
      "im:message.p2p_msg:readonly",
      "im:message:readonly",
      "im:message:send_as_bot",
      "im:resource",
      "wiki:wiki",
      "wiki:wiki:readonly"
    ],
    "user": [
      "aily:file:read",
      "aily:file:write",
      "im:chat.access_event.bot_p2p_chat:read"
    ]
  }
}`}</pre>
                  <button
                    type="button"
                    onClick={() => navigator.clipboard.writeText(JSON.stringify({"scopes":{"tenant":["aily:file:read","aily:file:write","application:application.app_message_stats.overview:readonly","application:application:self_manage","application:bot.menu:write","cardkit:card:read","cardkit:card:write","contact:user.employee_id:readonly","corehr:file:download","docs:doc","docs:doc:readonly","docx:document","docx:document:readonly","docx:document.block:convert","drive:drive","drive:drive:readonly","docs:permission.member:create","event:ip_list","im:chat.access_event.bot_p2p_chat:read","im:chat.members:bot_access","im:message","im:message.group_at_msg:readonly","im:message.group_msg","im:message.p2p_msg:readonly","im:message:readonly","im:message:send_as_bot","im:resource","wiki:wiki","wiki:wiki:readonly"],"user":["aily:file:read","aily:file:write","im:chat.access_event.bot_p2p_chat:read"]}}, null, 2))}
                    className="absolute top-2 right-2 inline-flex items-center gap-1 px-2 py-1 bg-accent-500 text-white rounded-lg text-xs hover:bg-accent-600 transition-colors"
                  >
                    <Clipboard size={12} />
                    {t('common.copy')}
                  </button>
                </div>
              </details>
              <p className="mt-2 mb-0.5 font-medium text-slate-700 text-xs">{t('channelSetup.feishu.step4msgRequired')}</p>
              <ul className="ml-4 list-disc text-slate-600 space-y-0.5">
                <li><Trans i18nKey="channelSetup.feishu.step4imMessage"><code className="bg-slate-100 px-1 rounded text-slate-800">im:message</code> — 获取与发送消息</Trans></li>
                <li><Trans i18nKey="channelSetup.feishu.step4imSendAsBot"><code className="bg-slate-100 px-1 rounded text-slate-800">im:message:send_as_bot</code> — 以机器人身份发送消息</Trans></li>
                <li><Trans i18nKey="channelSetup.feishu.step4imReadonly"><code className="bg-slate-100 px-1 rounded text-slate-800">im:message:readonly</code> — 读取消息内容</Trans></li>
                <li><Trans i18nKey="channelSetup.feishu.step4imP2p"><code className="bg-slate-100 px-1 rounded text-slate-800">im:message.p2p_msg:readonly</code> — 读取私聊消息</Trans></li>
                <li><Trans i18nKey="channelSetup.feishu.step4imGroupAt"><code className="bg-slate-100 px-1 rounded text-slate-800">im:message.group_at_msg:readonly</code> — 读取群聊 @机器人 消息</Trans></li>
                <li><Trans i18nKey="channelSetup.feishu.step4imGroupMsg"><code className="bg-slate-100 px-1 rounded text-slate-800">im:message.group_msg</code> — <span className="text-amber-600 font-medium">获取群聊中所有消息（敏感权限，需审批）</span></Trans></li>
                <li><Trans i18nKey="channelSetup.feishu.step4imResource"><code className="bg-slate-100 px-1 rounded text-slate-800">im:resource</code> — 读取消息中的资源文件</Trans></li>
                <li><Trans i18nKey="channelSetup.feishu.step4imChatMembers"><code className="bg-slate-100 px-1 rounded text-slate-800">im:chat.members:bot_access</code> — 获取群成员信息</Trans></li>
                <li><Trans i18nKey="channelSetup.feishu.step4imChatAccess"><code className="bg-slate-100 px-1 rounded text-slate-800">im:chat.access_event.bot_p2p_chat:read</code> — 接收私聊事件</Trans></li>
              </ul>
              <p className="mt-2 mb-0.5 font-medium text-slate-700 text-xs">{t('channelSetup.feishu.step4cardUser')}</p>
              <ul className="ml-4 list-disc text-slate-600 space-y-0.5">
                <li><Trans i18nKey="channelSetup.feishu.step4cardRead"><code className="bg-slate-100 px-1 rounded text-slate-800">cardkit:card:read</code> — 读取卡片消息</Trans></li>
                <li><Trans i18nKey="channelSetup.feishu.step4cardWrite"><code className="bg-slate-100 px-1 rounded text-slate-800">cardkit:card:write</code> — 发送卡片消息</Trans></li>
                <li><Trans i18nKey="channelSetup.feishu.step4contactUser"><code className="bg-slate-100 px-1 rounded text-slate-800">contact:user.employee_id:readonly</code> — 读取用户信息</Trans></li>
                <li><Trans i18nKey="channelSetup.feishu.step4botMenu"><code className="bg-slate-100 px-1 rounded text-slate-800">application:bot.menu:write</code> — 管理机器人菜单</Trans></li>
              </ul>
              <p className="mt-2 mb-0.5 font-medium text-slate-700 text-xs">{t('channelSetup.feishu.step4docsTitle')}</p>
              <ul className="ml-4 list-disc text-slate-600 space-y-0.5">
                <li><code className="bg-slate-100 px-1 rounded text-slate-800">docs:doc</code></li>
                <li><code className="bg-slate-100 px-1 rounded text-slate-800">docs:doc:readonly</code></li>
                <li><code className="bg-slate-100 px-1 rounded text-slate-800">docx:document</code></li>
                <li><code className="bg-slate-100 px-1 rounded text-slate-800">docx:document:readonly</code></li>
                <li><code className="bg-slate-100 px-1 rounded text-slate-800">docx:document.block:convert</code></li>
                <li><code className="bg-slate-100 px-1 rounded text-slate-800">wiki:wiki</code></li>
                <li><code className="bg-slate-100 px-1 rounded text-slate-800">wiki:wiki:readonly</code></li>
              </ul>
              <p className="mt-2 mb-0.5 font-medium text-slate-700 text-xs">{t('channelSetup.feishu.step4driveTitle')}</p>
              <ul className="ml-4 list-disc text-slate-600 space-y-0.5">
                <li><code className="bg-slate-100 px-1 rounded text-slate-800">drive:drive</code></li>
                <li><code className="bg-slate-100 px-1 rounded text-slate-800">drive:drive:readonly</code></li>
                <li><code className="bg-slate-100 px-1 rounded text-slate-800">docs:permission.member:create</code></li>
              </ul>
            </div>
          </div>

          <div className="flex gap-3">
            <StepNum n={5} />
            <div>
              <p className="font-medium text-slate-900">{t('channelSetup.feishu.step5title')}</p>
              <p className="text-slate-600 mt-0.5">
                {t('channelSetup.feishu.step5desc')}
              </p>
            </div>
          </div>
        </div>

        <div className="border-t border-slate-200 pt-3 mt-3">
          <p className="text-slate-700 font-medium">{t('channelSetup.feishu.fillCredentials')}</p>
        </div>
      </div>
    );
  }

  // step === 'after'
  return (
    <div className="border border-green-300 bg-green-50 rounded-xl p-5 space-y-4 text-sm">
      <div className="flex items-center gap-2">
        <CheckCircle2 size={20} className="text-green-600" />
        <h3 className="font-semibold text-green-900 text-base">{t('channelSetup.feishu.connectedTitle')}</h3>
      </div>

      <p className="text-green-800">{t('channelSetup.feishu.connectedDesc')}</p>

      <p className="text-green-800">{t('channelSetup.feishu.connectedConfirm')}</p>

      <div className="space-y-3">
        <div className="flex gap-3">
          <StepNum n={1} variant="success" />
          <div>
            <p className="font-medium text-green-900">{t('channelSetup.feishu.afterStep1title')}</p>
            <p className="text-green-700 mt-0.5">
              <Trans i18nKey="channelSetup.feishu.afterStep1desc">
                在「<strong>事件与回调</strong>」的事件订阅设置中，选择「<strong>使用长连接接收事件</strong>」方式
              </Trans>
            </p>
          </div>
        </div>

        <div className="flex gap-3">
          <StepNum n={2} variant="success" />
          <div>
            <p className="font-medium text-green-900">{t('channelSetup.feishu.afterStep2title')}</p>
            <p className="text-green-700 mt-0.5">
              <Trans i18nKey="channelSetup.feishu.afterStep2desc">
                添加事件：<code className="bg-green-100 px-1 rounded">im.message.receive_v1</code>（接收消息）
              </Trans>
            </p>
          </div>
        </div>

        <div className="flex gap-3">
          <StepNum n={3} variant="success" />
          <div>
            <p className="font-medium text-green-900">{t('channelSetup.feishu.afterStep3title')}</p>
            <p className="text-green-700 mt-0.5">
              <Trans i18nKey="channelSetup.feishu.afterStep3desc">
                在「<strong>应用能力</strong>」中启用「<strong>机器人</strong>」能力
              </Trans>
            </p>
          </div>
        </div>

        <div className="flex gap-3">
          <StepNum n={4} variant="success" />
          <div>
            <p className="font-medium text-green-900">{t('channelSetup.feishu.afterStep4title')}</p>
            <p className="text-green-700 mt-0.5">
              {t('channelSetup.feishu.afterStep4desc')}
            </p>
          </div>
        </div>

        <div className="flex gap-3">
          <StepNum n={5} variant="success" />
          <div>
            <p className="font-medium text-green-900">{t('channelSetup.feishu.afterStep5title')}</p>
            <p className="text-green-700 mt-0.5">
              {t('channelSetup.feishu.afterStep5desc')}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ChannelSetup() {
  const { t } = useTranslation();
  const channelMeta = useChannelMeta();
  const { botId } = useParams<{ botId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const resumeType = searchParams.get('resume') as ChannelType | null;
  const [channelType, setChannelType] = useState<ChannelType | ''>(resumeType || '');
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(!!resumeType);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!channelType) return;
    setLoading(true);
    setError('');
    try {
      await channelsApi.create(botId!, { channelType, credentials });
      setConnected(true);
      // For Telegram, auto-redirect (webhook is auto-registered)
      if (channelType === 'telegram') {
        navigate(`/bots/${botId}`);
      }
      // For Slack/Discord, show post-connect instructions
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // After successful connection — show post-connect guide for Slack
  if (connected && channelType === 'slack') {
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <Link to={`/bots/${botId}`} className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 transition-colors">
          <ArrowLeft size={16} />
          {t('common.backToBot')}
        </Link>
        <h1 className="text-2xl font-semibold text-slate-900">{t('channelSetup.addChannel')}</h1>
        <SlackGuide botId={botId!} step="after" />
        <button
          onClick={() => navigate(`/bots/${botId}`)}
          className="w-full rounded-lg bg-accent-500 text-white px-4 py-2.5 text-sm font-medium hover:bg-accent-600 transition-colors"
        >
          {t('channelSetup.doneBackToBot')}
        </button>
      </div>
    );
  }

  if (connected && channelType === 'discord') {
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <Link to={`/bots/${botId}`} className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 transition-colors">
          <ArrowLeft size={16} />
          {t('common.backToBot')}
        </Link>
        <h1 className="text-2xl font-semibold text-slate-900">{t('channelSetup.addChannel')}</h1>
        <DiscordGuide botId={botId!} step="after" />
        <button
          onClick={() => navigate(`/bots/${botId}`)}
          className="w-full rounded-lg bg-accent-500 text-white px-4 py-2.5 text-sm font-medium hover:bg-accent-600 transition-colors"
        >
          {t('channelSetup.doneBackToBot')}
        </button>
      </div>
    );
  }

  if (connected && channelType === 'feishu') {
    return (
      <div className="max-w-2xl mx-auto space-y-6">
        <Link to={`/bots/${botId}`} className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 transition-colors">
          <ArrowLeft size={16} />
          {t('common.backToBot')}
        </Link>
        <h1 className="text-2xl font-semibold text-slate-900">{t('channelSetup.addChannel')}</h1>
        <FeishuGuide step="after" />
        <button
          onClick={() => navigate(`/bots/${botId}`)}
          className="w-full rounded-lg bg-accent-500 text-white px-4 py-2.5 text-sm font-medium hover:bg-accent-600 transition-colors"
        >
          {t('channelSetup.doneBackToBot')}
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto">
      <Link to={`/bots/${botId}`} className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 transition-colors mb-4">
        <ArrowLeft size={16} />
        {t('common.backToBot')}
      </Link>
      <h1 className="text-2xl font-semibold text-slate-900 mb-6">{t('channelSetup.addChannel')}</h1>

      <form onSubmit={handleSubmit} className="space-y-6">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
            {error}
          </div>
        )}

        <div className="bg-white border border-slate-200 p-6 rounded-xl">
          <label className="block text-sm font-medium text-slate-700 mb-3">{t('channelSetup.channelType')}</label>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {(['telegram', 'discord', 'slack', 'feishu'] as ChannelType[]).map((type) => {
              const meta = channelMeta[type];
              const selected = channelType === type;
              return (
                <button key={type} type="button"
                  onClick={() => { setChannelType(type); setCredentials(type === 'feishu' ? { domain: 'feishu' } : {}); setError(''); setConnected(false); }}
                  className={clsx(
                    'flex flex-col items-center gap-1.5 p-4 rounded-xl border-2 text-center transition-all',
                    selected
                      ? 'border-accent-500 bg-accent-50 ring-2 ring-accent-500/20'
                      : 'border-slate-200 hover:border-slate-300 bg-white',
                  )}>
                  <span className={clsx(
                    'w-10 h-10 rounded-lg flex items-center justify-center',
                    selected ? 'bg-accent-100 text-accent-600' : 'bg-slate-100 text-slate-500',
                  )}>
                    {meta.icon}
                  </span>
                  <span className={clsx(
                    'text-sm font-medium',
                    selected ? 'text-accent-700' : 'text-slate-700',
                  )}>
                    {meta.label}
                  </span>
                  <span className="text-[11px] text-slate-400 leading-tight">{meta.desc}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Channel-specific setup guide */}
        {channelType === 'slack' && <SlackGuide botId={botId!} step="before" />}
        {channelType === 'telegram' && <TelegramGuide />}
        {channelType === 'discord' && <DiscordGuide botId={botId!} step="before" />}
        {channelType === 'feishu' && <FeishuGuide step="before" />}

        {/* Credential fields */}
        {channelType && (
          <div className="bg-white border border-slate-200 p-6 rounded-xl space-y-4">
            <h2 className="text-sm font-semibold text-slate-900">{t('channelSetup.enterCredentials')}</h2>
            {channelFields[channelType].map((field) => (
              <div key={field.name}>
                <label className="block text-sm font-medium text-slate-700 mb-1">{field.label}</label>
                {channelType === 'feishu' && field.name === 'domain' ? (
                  <select
                    value={credentials.domain || 'feishu'}
                    onChange={e => setCredentials(prev => ({ ...prev, domain: e.target.value }))}
                    className="block w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none transition-colors"
                  >
                    <option value="feishu">{t('channelSetup.feishu.feishuDomain')}</option>
                    <option value="lark">{t('channelSetup.feishu.larkDomain')}</option>
                  </select>
                ) : (
                  <input type={field.type || 'text'} required placeholder={field.placeholder}
                    value={credentials[field.name] || ''}
                    onChange={e => setCredentials(prev => ({ ...prev, [field.name]: e.target.value }))}
                    className="block w-full rounded-lg border border-slate-300 px-3 py-2.5 font-mono text-sm focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none transition-colors" />
                )}
              </div>
            ))}

            <div className="flex gap-3 pt-2">
              <button type="submit" disabled={!channelType || loading}
                className="flex-1 rounded-lg bg-accent-500 text-white px-4 py-2.5 text-sm font-medium hover:bg-accent-600 disabled:opacity-50 transition-colors">
                {loading ? t('common.connecting') : t('channelSetup.connectChannel')}
              </button>
              <button type="button" onClick={() => navigate(`/bots/${botId}`)}
                className="rounded-lg border border-slate-300 text-slate-700 px-4 py-2.5 text-sm font-medium hover:bg-slate-50 transition-colors">
                {t('common.cancel')}
              </button>
            </div>
          </div>
        )}
      </form>
    </div>
  );
}
