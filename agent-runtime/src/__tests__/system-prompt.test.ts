import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildSystemPrompt, type SystemPromptOptions } from '../system-prompt.js';
import * as memoryModule from '../memory.js';

// Mock the memory module — tests should not touch filesystem
vi.mock('../memory.js', async (importOriginal) => {
  const actual = await importOriginal<typeof memoryModule>();
  return {
    ...actual,
    loadPersonaFile: vi.fn().mockResolvedValue(null),
    loadBootstrapFile: vi.fn().mockResolvedValue(null),
    loadUserFile: vi.fn().mockResolvedValue(null),
    loadMemoryLayers: vi.fn().mockResolvedValue({ layers: [], totalChars: 0 }),
  };
});

const baseOpts: SystemPromptOptions = {
  botId: 'bot-123',
  botName: 'TestBot',
  channelType: 'discord',
  groupJid: 'dc:456',
  isNewSession: false,
};

describe('buildSystemPrompt', () => {
  beforeEach(() => {
    vi.mocked(memoryModule.loadPersonaFile).mockResolvedValue(null);
    vi.mocked(memoryModule.loadBootstrapFile).mockResolvedValue(null);
    vi.mocked(memoryModule.loadUserFile).mockResolvedValue(null);
    vi.mocked(memoryModule.loadMemoryLayers).mockResolvedValue({ layers: [], totalChars: 0 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Section 1: Identity ─────────────────────────────────────────────

  it('always includes identity section with bot name', async () => {
    const result = await buildSystemPrompt(baseOpts);
    expect(result).toContain('# Identity');
    expect(result).toContain('You are TestBot');
  });

  // ── Section 2: Persona ──────────────────────────────────────────────

  it('includes PERSONA.md when available', async () => {
    vi.mocked(memoryModule.loadPersonaFile).mockResolvedValue('I am Luna, a friendly assistant.');

    const result = await buildSystemPrompt(baseOpts);
    expect(result).toContain('# Persona');
    expect(result).toContain('I am Luna, a friendly assistant.');
    expect(result).toContain('Embody this persona');
  });

  it('falls back to Bot.systemPrompt when no PERSONA.md', async () => {
    const result = await buildSystemPrompt({
      ...baseOpts,
      systemPrompt: 'You are a helpful coding assistant.',
    });
    expect(result).toContain('# Persona');
    expect(result).toContain('You are a helpful coding assistant.');
  });

  it('prefers PERSONA.md over Bot.systemPrompt', async () => {
    vi.mocked(memoryModule.loadPersonaFile).mockResolvedValue('Persona from file');

    const result = await buildSystemPrompt({
      ...baseOpts,
      systemPrompt: 'Prompt from bot record',
    });
    expect(result).toContain('Persona from file');
    expect(result).not.toContain('Prompt from bot record');
  });

  it('skips persona section when neither PERSONA.md nor systemPrompt', async () => {
    const result = await buildSystemPrompt(baseOpts);
    expect(result).not.toContain('# Persona');
  });

  // ── Section 3: Bootstrap ────────────────────────────────────────────

  it('includes BOOTSTRAP.md for new sessions', async () => {
    vi.mocked(memoryModule.loadBootstrapFile).mockResolvedValue('Greet the user and introduce yourself.');

    const result = await buildSystemPrompt({ ...baseOpts, isNewSession: true });
    expect(result).toContain('# First Session Instructions');
    expect(result).toContain('Greet the user');
  });

  it('skips BOOTSTRAP.md for resumed sessions', async () => {
    vi.mocked(memoryModule.loadBootstrapFile).mockResolvedValue('Should not appear');

    const result = await buildSystemPrompt({ ...baseOpts, isNewSession: false });
    expect(result).not.toContain('First Session Instructions');
    expect(result).not.toContain('Should not appear');
  });

  it('skips bootstrap section when file does not exist even for new session', async () => {
    const result = await buildSystemPrompt({ ...baseOpts, isNewSession: true });
    expect(result).not.toContain('First Session Instructions');
  });

  // ── Section 4: Channel Guidance ─────────────────────────────────────

  it('includes Discord guidance for discord channel', async () => {
    const result = await buildSystemPrompt({ ...baseOpts, channelType: 'discord' });
    expect(result).toContain('# Channel: Discord');
    expect(result).toContain('standard Markdown');
  });

  it('includes Slack guidance for slack channel', async () => {
    const result = await buildSystemPrompt({ ...baseOpts, channelType: 'slack' });
    expect(result).toContain('# Channel: Slack');
    expect(result).toContain('mrkdwn');
  });

  it('includes Telegram guidance for telegram channel', async () => {
    const result = await buildSystemPrompt({ ...baseOpts, channelType: 'telegram' });
    expect(result).toContain('# Channel: Telegram');
    expect(result).toContain('MarkdownV2');
  });

  it('includes WhatsApp guidance for whatsapp channel', async () => {
    const result = await buildSystemPrompt({ ...baseOpts, channelType: 'whatsapp' });
    expect(result).toContain('# Channel: WhatsApp');
  });

  // ── Section 5: Reply Guidelines ─────────────────────────────────────

  it('always includes reply guidelines', async () => {
    const result = await buildSystemPrompt(baseOpts);
    expect(result).toContain('# Reply Guidelines');
    expect(result).toContain('concise');
  });

  it('adds scheduled task note when isScheduledTask', async () => {
    const result = await buildSystemPrompt({ ...baseOpts, isScheduledTask: true });
    expect(result).toContain('automated scheduled task');
  });

  it('omits scheduled task note for normal messages', async () => {
    const result = await buildSystemPrompt(baseOpts);
    expect(result).not.toContain('scheduled task');
  });

  // ── Section 6: User Context ─────────────────────────────────────────

  it('includes USER.md when available', async () => {
    vi.mocked(memoryModule.loadUserFile).mockResolvedValue('Alice is a product manager.');

    const result = await buildSystemPrompt(baseOpts);
    expect(result).toContain('# About Your Users');
    expect(result).toContain('Alice is a product manager.');
  });

  it('skips user context when no USER.md', async () => {
    const result = await buildSystemPrompt(baseOpts);
    expect(result).not.toContain('# About Your Users');
  });

  // ── Section 7: Memory ───────────────────────────────────────────────

  it('includes memory layers when available', async () => {
    vi.mocked(memoryModule.loadMemoryLayers).mockResolvedValue({
      layers: [
        { label: '# Shared Memory', content: 'shared stuff' },
        { label: '# Group Memory', content: 'group stuff' },
      ],
      totalChars: 23,
    });

    const result = await buildSystemPrompt(baseOpts);
    expect(result).toContain('# Shared Memory');
    expect(result).toContain('shared stuff');
    expect(result).toContain('# Group Memory');
    expect(result).toContain('group stuff');
  });

  it('skips memory section when no layers', async () => {
    const result = await buildSystemPrompt(baseOpts);
    expect(result).not.toContain('# Shared Memory');
    expect(result).not.toContain('# Bot Memory');
    expect(result).not.toContain('# Group Memory');
  });

  // ── Section 8: Runtime ──────────────────────────────────────────────

  it('always includes runtime metadata', async () => {
    const result = await buildSystemPrompt(baseOpts);
    expect(result).toContain('Runtime: bot=bot-123');
    expect(result).toContain('name=TestBot');
    expect(result).toContain('channel=discord');
    expect(result).toContain('group=dc:456');
  });

  // ── Section ordering ────────────────────────────────────────────────

  it('sections appear in correct order', async () => {
    vi.mocked(memoryModule.loadPersonaFile).mockResolvedValue('persona content');
    vi.mocked(memoryModule.loadBootstrapFile).mockResolvedValue('bootstrap content');
    vi.mocked(memoryModule.loadUserFile).mockResolvedValue('user content');
    vi.mocked(memoryModule.loadMemoryLayers).mockResolvedValue({
      layers: [{ label: '# Shared Memory', content: 'memory content' }],
      totalChars: 14,
    });

    const result = await buildSystemPrompt({ ...baseOpts, isNewSession: true });

    const identityIdx = result.indexOf('# Identity');
    const personaIdx = result.indexOf('# Persona');
    const bootstrapIdx = result.indexOf('# First Session');
    const channelIdx = result.indexOf('# Channel:');
    const replyIdx = result.indexOf('# Reply Guidelines');
    const userIdx = result.indexOf('# About Your Users');
    const memoryIdx = result.indexOf('# Shared Memory');
    const runtimeIdx = result.indexOf('Runtime:');

    expect(identityIdx).toBeLessThan(personaIdx);
    expect(personaIdx).toBeLessThan(bootstrapIdx);
    expect(bootstrapIdx).toBeLessThan(channelIdx);
    expect(channelIdx).toBeLessThan(replyIdx);
    expect(replyIdx).toBeLessThan(userIdx);
    expect(userIdx).toBeLessThan(memoryIdx);
    expect(memoryIdx).toBeLessThan(runtimeIdx);
  });

  // ── Separator ───────────────────────────────────────────────────────

  it('separates sections with --- dividers', async () => {
    const result = await buildSystemPrompt(baseOpts);
    expect(result).toContain('\n\n---\n\n');
  });
});
