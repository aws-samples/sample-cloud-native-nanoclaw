# Tool & Skill Whitelist — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add per-bot tool/skill whitelist that controls which MCP tools and Skills the agent can use, with web console management UI.

**Architecture:** Data flows DynamoDB Bot record → Dispatcher → InvocationPayload → agent-runtime PreToolUse hook. Web console provides a "Tools" tab on BotDetail page for management. Whitelist defaults to OFF (all tools allowed).

**Tech Stack:** TypeScript, Fastify, Zod, React 19, Tailwind CSS, Claude Agent SDK hooks, Pino logging

**Design doc:** `docs/plans/2026-03-23-tool-whitelist-design.md`

---

### Task 1: Add ToolWhitelistConfig type and extend Bot + InvocationPayload

**Files:**
- Modify: `shared/src/types.ts:85-107` (Bot interface)
- Modify: `shared/src/types.ts:240-265` (InvocationPayload interface)
- Modify: `shared/src/types.ts:359-367` (UpdateBotRequest interface)

**Step 1: Add ToolWhitelistConfig interface**

Add after line 107 (after `BotContainerConfig`):

```typescript
export interface ToolWhitelistConfig {
  enabled: boolean;
  allowedMcpTools: string[];
  allowedSkills: string[];
}
```

**Step 2: Add `toolWhitelist` to Bot interface**

In `Bot` (line 85–102), add before `createdAt`:

```typescript
  toolWhitelist?: ToolWhitelistConfig;
```

**Step 3: Add `toolWhitelist` to InvocationPayload**

In `InvocationPayload` (line 240–265), add after `proxyRules`:

```typescript
  /** Per-bot tool/skill whitelist config */
  toolWhitelist?: ToolWhitelistConfig;
```

**Step 4: Add `toolWhitelist` to UpdateBotRequest**

In `UpdateBotRequest` (line 359–367), add:

```typescript
  toolWhitelist?: ToolWhitelistConfig;
```

**Step 5: Build shared to verify**

Run: `npm run build -w shared`
Expected: Clean build, no errors

**Step 6: Commit**

```bash
git add shared/src/types.ts
git commit -m "feat(shared): add ToolWhitelistConfig type to Bot and InvocationPayload"
```

---

### Task 2: Update control-plane API — bot update schema + available-tools endpoint

**Files:**
- Modify: `control-plane/src/routes/api/bots.ts:28-36` (updateBotSchema)
- Modify: `control-plane/src/routes/api/bots.ts:44` (botsRoutes — add new route)
- Modify: `control-plane/src/services/dynamo.ts:441-452` (allowedFields in updateBot)

**Step 1: Extend updateBotSchema in bots.ts**

In `control-plane/src/routes/api/bots.ts`, add `toolWhitelist` to `updateBotSchema` (after line 35):

```typescript
const updateBotSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  systemPrompt: z.string().max(10000).optional(),
  triggerPattern: z.string().max(200).optional(),
  providerId: z.string().min(1).max(100).optional(),
  modelId: z.string().min(1).max(200).optional(),
  status: z.enum(['active', 'paused', 'deleted']).optional(),
  toolWhitelist: z.object({
    enabled: z.boolean(),
    allowedMcpTools: z.array(z.string().max(100)).max(50),
    allowedSkills: z.array(z.string().max(100)).max(50),
  }).optional(),
});
```

**Step 2: Add `toolWhitelist` to allowedFields in dynamo.ts**

In `control-plane/src/services/dynamo.ts:441-452`, add `'toolWhitelist'` to the `allowedFields` array:

```typescript
  const allowedFields = [
    'name',
    'description',
    'systemPrompt',
    'triggerPattern',
    'providerId',
    'modelId',
    'model',
    'modelProvider',
    'status',
    'containerConfig',
    'toolWhitelist',
  ] as const;
```

**Step 3: Add GET /api/bots/available-tools endpoint**

In `control-plane/src/routes/api/bots.ts`, add a new route inside `botsRoutes` (before the `/:botId` GET route to avoid route conflicts — add after the `POST /` handler, around line 95):

```typescript
  // Available tools catalog (for whitelist UI)
  app.get('/available-tools', async () => {
    return {
      mcpTools: [
        { name: 'send_message', description: 'Send a message to the channel' },
        { name: 'send_file', description: 'Send a file to the channel' },
        { name: 'schedule_task', description: 'Schedule a recurring task' },
        { name: 'list_tasks', description: 'List scheduled tasks' },
        { name: 'pause_task', description: 'Pause a scheduled task' },
        { name: 'resume_task', description: 'Resume a paused task' },
        { name: 'cancel_task', description: 'Cancel a scheduled task' },
        { name: 'update_task', description: 'Update a scheduled task' },
      ],
      skills: [
        { name: 'agent-browser', description: 'Browser automation' },
        { name: 'docx', description: 'Word document creation' },
        { name: 'find-skills', description: 'Discover available skills' },
        { name: 'pdf', description: 'PDF manipulation' },
        { name: 'pptx', description: 'PowerPoint creation' },
        { name: 'skill-creator', description: 'Create new skills' },
        { name: 'skill-development', description: 'Skill development tools' },
        { name: 'xlsx', description: 'Excel spreadsheet creation' },
      ],
    };
  });
```

**Step 4: Build control-plane to verify**

Run: `npm run build -w control-plane`
Expected: Clean build

**Step 5: Commit**

```bash
git add control-plane/src/routes/api/bots.ts control-plane/src/services/dynamo.ts
git commit -m "feat(control-plane): add toolWhitelist to bot update + available-tools endpoint"
```

---

### Task 3: Pass toolWhitelist through dispatcher to InvocationPayload

**Files:**
- Modify: `control-plane/src/sqs/dispatcher.ts:344-368` (dispatchMessage invocation payload)
- Modify: `control-plane/src/sqs/dispatcher.ts:516-539` (dispatchTask invocation payload)

**Step 1: Add toolWhitelist to message dispatch payload**

In `dispatchMessage` (around line 344–368), add `toolWhitelist` to the `invocationPayload` object. Add after the `proxyRules` spread (line 367):

```typescript
      ...(bot.toolWhitelist && { toolWhitelist: bot.toolWhitelist }),
```

**Step 2: Add toolWhitelist to task dispatch payload**

In `dispatchTask` (around line 516–539), add the same line after the `proxyRules` spread (line 538):

```typescript
      ...(bot.toolWhitelist && { toolWhitelist: bot.toolWhitelist }),
```

**Step 3: Build and typecheck**

Run: `npm run build -w control-plane`
Expected: Clean build

**Step 4: Run existing tests**

Run: `npm test -w control-plane`
Expected: All existing tests pass (dispatcher tests don't test this path specifically)

**Step 5: Commit**

```bash
git add control-plane/src/sqs/dispatcher.ts
git commit -m "feat(control-plane): pass toolWhitelist from bot config to InvocationPayload"
```

---

### Task 4: Add PreToolUse hook in agent-runtime

**Files:**
- Modify: `agent-runtime/src/agent.ts:396-398` (hooks config in runAgentQuery)

**Step 1: Add PreToolUse hook alongside existing PreCompact hook**

In `agent-runtime/src/agent.ts`, replace the hooks block (lines 396–398):

```typescript
        hooks: {
          PreCompact: [{ hooks: [createPreCompactHook(params.botName)] }],
        },
```

with:

```typescript
        hooks: {
          ...(payload.toolWhitelist?.enabled && {
            PreToolUse: [{
              hooks: [createToolWhitelistHook(payload, logger)],
            }],
          }),
          PreCompact: [{ hooks: [createPreCompactHook(params.botName)] }],
        },
```

**Step 2: Add the createToolWhitelistHook function**

Add before the `createPreCompactHook` function (around line 513):

```typescript
// ---------------------------------------------------------------------------
// Tool whitelist hook — deny tools/skills not in the bot's whitelist
// ---------------------------------------------------------------------------

function createToolWhitelistHook(
  payload: InvocationPayload,
  logger: pino.Logger,
): HookCallback {
  return async (input, _toolUseId, _context) => {
    const hookInput = input as { tool_name?: string; tool_input?: Record<string, unknown> };
    const toolName = hookInput.tool_name || '';
    const toolInput = hookInput.tool_input || {};
    const whitelist = payload.toolWhitelist!;

    // Check Skill tool — inspect the skill name inside tool_input
    if (toolName === 'Skill') {
      const requestedSkill = (toolInput.skill as string) || '';
      if (!whitelist.allowedSkills.includes(requestedSkill)) {
        logger.warn({
          event: 'tool_access_denied',
          botId: payload.botId,
          userId: payload.userId,
          toolType: 'skill',
          requestedTool: requestedSkill,
          allowedTools: whitelist.allowedSkills,
        }, `Skill access denied: ${requestedSkill}`);
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `Skill "${requestedSkill}" is not allowed for this bot. Allowed: ${whitelist.allowedSkills.join(', ') || 'none'}`,
          },
        };
      }
    }

    // Check MCP tools — format is "mcp__nanoclawbot__<toolName>"
    if (toolName.startsWith('mcp__nanoclawbot__')) {
      const mcpToolName = toolName.replace('mcp__nanoclawbot__', '');
      if (!whitelist.allowedMcpTools.includes(mcpToolName)) {
        logger.warn({
          event: 'tool_access_denied',
          botId: payload.botId,
          userId: payload.userId,
          toolType: 'mcp_tool',
          requestedTool: mcpToolName,
          allowedTools: whitelist.allowedMcpTools,
        }, `MCP tool access denied: ${mcpToolName}`);
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `Tool "${mcpToolName}" is not allowed for this bot. Allowed: ${whitelist.allowedMcpTools.join(', ') || 'none'}`,
          },
        };
      }
    }

    return {};
  };
}
```

**Step 3: Build agent-runtime to verify**

Run: `npm run build -w agent-runtime`
Expected: Clean build

**Step 4: Commit**

```bash
git add agent-runtime/src/agent.ts
git commit -m "feat(agent-runtime): add PreToolUse hook for tool/skill whitelist enforcement"
```

---

### Task 5: Add "Tools" tab to web console BotDetail

**Files:**
- Modify: `web-console/src/lib/api.ts` (add ToolWhitelistConfig type + available-tools API)
- Modify: `web-console/src/pages/BotDetail.tsx` (add ToolsTab component + wire into tabs)
- Modify: `web-console/src/locales/en.json` (add i18n keys)
- Modify: `web-console/src/locales/zh.json` (add i18n keys)

**Step 1: Add types and API function in api.ts**

In `web-console/src/lib/api.ts`, add the `ToolWhitelistConfig` type after the `Bot` interface (around line 46):

```typescript
export interface ToolWhitelistConfig {
  enabled: boolean;
  allowedMcpTools: string[];
  allowedSkills: string[];
}

export interface AvailableTools {
  mcpTools: Array<{ name: string; description: string }>;
  skills: Array<{ name: string; description: string }>;
}
```

Add `toolWhitelist` to the `Bot` interface:

```typescript
export interface Bot {
  botId: string;
  name: string;
  description?: string;
  status: string;
  triggerPattern: string;
  providerId?: string;
  modelId?: string;
  /** @deprecated */
  model?: string;
  /** @deprecated */
  modelProvider?: 'bedrock' | 'anthropic-api';
  toolWhitelist?: ToolWhitelistConfig;
  createdAt: string;
}
```

Add the `availableTools` API call to the `bots` object:

```typescript
export const bots = {
  list: () => request<Bot[]>('/bots'),
  get: (botId: string) => request<Bot>(`/bots/${botId}`),
  create: (data: CreateBotRequest) => request<Bot>('/bots', { method: 'POST', body: JSON.stringify(data) }),
  update: (botId: string, data: Partial<Bot>) => request<Bot>(`/bots/${botId}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (botId: string) => request<void>(`/bots/${botId}`, { method: 'DELETE' }),
  availableTools: () => request<AvailableTools>('/bots/available-tools'),
};
```

**Step 2: Add i18n keys in en.json**

In `web-console/src/locales/en.json`, add `"tools"` to `botDetail.tabs`:

```json
"tabs": {
  "overview": "Overview",
  "channels": "Channels",
  "conversations": "Conversations",
  "tasks": "Tasks",
  "memory": "Memory",
  "files": "Files",
  "tools": "Tools",
  "settings": "Settings"
}
```

Add a `"tools"` section under `"botDetail"`:

```json
"tools": {
  "title": "Tool Whitelist",
  "description": "Control which tools and skills this bot can use. When disabled, all tools are available.",
  "enabled": "Whitelist Enabled",
  "disabled": "Whitelist Disabled (all tools allowed)",
  "mcpTools": "MCP Tools",
  "skills": "Skills",
  "customSkills": "Custom Skills",
  "customSkillPlaceholder": "Enter skill name...",
  "add": "Add",
  "save": "Save Changes",
  "saving": "Saving...",
  "saved": "Tool whitelist saved",
  "error": "Failed to save tool whitelist"
}
```

**Step 3: Add i18n keys in zh.json**

In `web-console/src/locales/zh.json`, add matching keys:

`botDetail.tabs`:

```json
"tools": "工具"
```

`botDetail.tools`:

```json
"tools": {
  "title": "工具白名单",
  "description": "控制此机器人可以使用哪些工具和技能。关闭时所有工具均可用。",
  "enabled": "白名单已启用",
  "disabled": "白名单已关闭（所有工具可用）",
  "mcpTools": "MCP 工具",
  "skills": "技能",
  "customSkills": "自定义技能",
  "customSkillPlaceholder": "输入技能名称...",
  "add": "添加",
  "save": "保存更改",
  "saving": "保存中...",
  "saved": "工具白名单已保存",
  "error": "保存工具白名单失败"
}
```

**Step 4: Add ToolsTab component in BotDetail.tsx**

In `web-console/src/pages/BotDetail.tsx`:

4a. Add `Shield` to lucide-react imports (line 8):

```typescript
import {
  LayoutDashboard, Radio, MessageSquare, Clock, Brain,
  FolderOpen, Settings as SettingsIcon, Plus, Trash2, ExternalLink,
  Play, Pause, Save, AlertTriangle, Shield,
} from 'lucide-react';
```

4b. Add `AvailableTools` and `ToolWhitelistConfig` to api imports (line 17):

```typescript
import {
  bots as botsApi, channels as channelsApi, groups as groupsApi,
  tasks as tasksApi, memory as memoryApi,
  providers as providersApi,
  Bot, ChannelConfig, Group, ScheduledTask,
  type ProviderPublic,
  type AvailableTools, type ToolWhitelistConfig,
} from '../lib/api';
```

4c. Add `tools` to `tabIcons` (line 23, before `settings`):

```typescript
const tabIcons: Record<string, React.ReactNode> = {
  overview: <LayoutDashboard size={16} />,
  channels: <Radio size={16} />,
  conversations: <MessageSquare size={16} />,
  tasks: <Clock size={16} />,
  memory: <Brain size={16} />,
  files: <FolderOpen size={16} />,
  tools: <Shield size={16} />,
  settings: <SettingsIcon size={16} />,
};
```

4d. Add ToolsTab component (insert before `SettingsTab`, around line 631):

```typescript
/* ── Tools tab ────────────────────────────────────────────────────── */

function ToolsTab({
  bot, botId, loadData,
}: {
  bot: Bot;
  botId: string;
  loadData: () => void;
}) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(bot.toolWhitelist?.enabled ?? false);
  const [allowedMcpTools, setAllowedMcpTools] = useState<string[]>(bot.toolWhitelist?.allowedMcpTools ?? []);
  const [allowedSkills, setAllowedSkills] = useState<string[]>(bot.toolWhitelist?.allowedSkills ?? []);
  const [customSkill, setCustomSkill] = useState('');
  const [catalog, setCatalog] = useState<AvailableTools | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<'saved' | 'error' | null>(null);

  useEffect(() => {
    botsApi.availableTools().then(setCatalog).catch(console.error);
  }, []);

  // Sync local state when bot prop changes
  useEffect(() => {
    setEnabled(bot.toolWhitelist?.enabled ?? false);
    setAllowedMcpTools(bot.toolWhitelist?.allowedMcpTools ?? []);
    setAllowedSkills(bot.toolWhitelist?.allowedSkills ?? []);
  }, [bot.toolWhitelist]);

  function toggleMcpTool(name: string) {
    setAllowedMcpTools(prev =>
      prev.includes(name) ? prev.filter(t => t !== name) : [...prev, name]
    );
  }

  function toggleSkill(name: string) {
    setAllowedSkills(prev =>
      prev.includes(name) ? prev.filter(s => s !== name) : [...prev, name]
    );
  }

  function addCustomSkill() {
    const trimmed = customSkill.trim();
    if (trimmed && !allowedSkills.includes(trimmed)) {
      setAllowedSkills(prev => [...prev, trimmed]);
      setCustomSkill('');
    }
  }

  // Determine which skills are from the catalog vs custom-added
  const catalogSkillNames = catalog?.skills.map(s => s.name) ?? [];
  const customSkills = allowedSkills.filter(s => !catalogSkillNames.includes(s));

  async function saveWhitelist() {
    setSaving(true);
    setStatus(null);
    try {
      const toolWhitelist: ToolWhitelistConfig = {
        enabled,
        allowedMcpTools: enabled ? allowedMcpTools : [],
        allowedSkills: enabled ? allowedSkills : [],
      };
      await botsApi.update(botId, { toolWhitelist } as Partial<Bot>);
      setStatus('saved');
      setTimeout(() => setStatus(null), 3000);
      loadData();
    } catch {
      setStatus('error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Enable/disable toggle */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-slate-900">{t('botDetail.tools.title')}</h2>
            <p className="text-sm text-slate-500 mt-1">{t('botDetail.tools.description')}</p>
          </div>
          <button
            onClick={() => setEnabled(!enabled)}
            className={clsx(
              'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
              enabled ? 'bg-accent-500' : 'bg-slate-300',
            )}
          >
            <span
              className={clsx(
                'inline-block h-4 w-4 rounded-full bg-white transition-transform',
                enabled ? 'translate-x-6' : 'translate-x-1',
              )}
            />
          </button>
        </div>
        <p className="text-sm mt-2 font-medium">
          {enabled
            ? <span className="text-accent-600">{t('botDetail.tools.enabled')}</span>
            : <span className="text-slate-400">{t('botDetail.tools.disabled')}</span>
          }
        </p>
      </div>

      {/* MCP Tools */}
      <div className={clsx('bg-white rounded-xl shadow-sm border border-slate-200 p-5', !enabled && 'opacity-50 pointer-events-none')}>
        <h3 className="text-sm font-semibold text-slate-900 mb-3">{t('botDetail.tools.mcpTools')}</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {catalog?.mcpTools.map(tool => (
            <label key={tool.name} className="flex items-center gap-2 cursor-pointer" title={tool.description}>
              <input
                type="checkbox"
                checked={allowedMcpTools.includes(tool.name)}
                onChange={() => toggleMcpTool(tool.name)}
                className="rounded border-slate-300 text-accent-500 focus:ring-accent-500"
              />
              <span className="text-sm text-slate-700 font-mono">{tool.name}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Skills */}
      <div className={clsx('bg-white rounded-xl shadow-sm border border-slate-200 p-5', !enabled && 'opacity-50 pointer-events-none')}>
        <h3 className="text-sm font-semibold text-slate-900 mb-3">{t('botDetail.tools.skills')}</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {catalog?.skills.map(skill => (
            <label key={skill.name} className="flex items-center gap-2 cursor-pointer" title={skill.description}>
              <input
                type="checkbox"
                checked={allowedSkills.includes(skill.name)}
                onChange={() => toggleSkill(skill.name)}
                className="rounded border-slate-300 text-accent-500 focus:ring-accent-500"
              />
              <span className="text-sm text-slate-700 font-mono">{skill.name}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Custom skills */}
      <div className={clsx('bg-white rounded-xl shadow-sm border border-slate-200 p-5', !enabled && 'opacity-50 pointer-events-none')}>
        <h3 className="text-sm font-semibold text-slate-900 mb-3">{t('botDetail.tools.customSkills')}</h3>
        <div className="flex gap-2 mb-3">
          <input
            value={customSkill}
            onChange={e => setCustomSkill(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCustomSkill(); } }}
            placeholder={t('botDetail.tools.customSkillPlaceholder')}
            className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono focus:border-accent-500 focus:ring-2 focus:ring-accent-500/20 focus:outline-none"
          />
          <button
            onClick={addCustomSkill}
            disabled={!customSkill.trim()}
            className="rounded-lg bg-slate-100 text-slate-700 px-4 py-2 text-sm font-medium hover:bg-slate-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {t('botDetail.tools.add')}
          </button>
        </div>
        {customSkills.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {customSkills.map(name => (
              <span
                key={name}
                className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-slate-100 text-sm font-mono text-slate-700"
              >
                {name}
                <button
                  onClick={() => setAllowedSkills(prev => prev.filter(s => s !== name))}
                  className="text-slate-400 hover:text-red-500 transition-colors"
                >
                  &times;
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Save button */}
      <div className="flex items-center gap-3">
        <button
          onClick={saveWhitelist}
          disabled={saving}
          className="inline-flex items-center gap-1.5 rounded-lg bg-accent-500 text-white px-5 py-2.5 text-sm font-medium hover:bg-accent-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Save size={16} /> {saving ? t('botDetail.tools.saving') : t('botDetail.tools.save')}
        </button>
        {status === 'saved' && <span className="text-sm text-emerald-600">{t('botDetail.tools.saved')}</span>}
        {status === 'error' && <span className="text-sm text-red-600">{t('botDetail.tools.error')}</span>}
      </div>
    </div>
  );
}
```

**Step 5: Wire ToolsTab into the tab content area**

In `BotDetail.tsx`, add the tools tab rendering after the files tab (around line 870):

```typescript
        {activeTab === 'tools' && (
          <ToolsTab bot={bot} botId={botId!} loadData={loadData} />
        )}
```

**Step 6: Build web-console to verify**

Run: `npm run build -w web-console`
Expected: Clean build

**Step 7: Commit**

```bash
git add web-console/src/lib/api.ts web-console/src/pages/BotDetail.tsx web-console/src/locales/en.json web-console/src/locales/zh.json
git commit -m "feat(web-console): add Tools tab with whitelist management UI"
```

---

### Task 6: Build all packages and verify

**Step 1: Full workspace build**

Run: `npm run build --workspaces`
Expected: All 5 packages build cleanly

**Step 2: Run control-plane tests**

Run: `npm test -w control-plane`
Expected: All tests pass

**Step 3: Final commit if any fixes needed**

---

### Task 7: Update CLAUDE.md and design doc

**Files:**
- Modify: `CLAUDE.md` — add `toolWhitelist` to Bot description in Architecture section
- Modify: `docs/plans/2026-03-23-tool-whitelist-design.md` — mark as Implemented

**Step 1: Update CLAUDE.md**

In the Data layer section or Architecture section, note that Bot now includes optional `toolWhitelist` config. No need to add a full section — just ensure the field is mentioned where Bot fields are described.

**Step 2: Mark design doc as Implemented**

Change `**Status:** Approved` to `**Status:** Implemented` in the design doc.

**Step 3: Commit**

```bash
git add CLAUDE.md docs/plans/2026-03-23-tool-whitelist-design.md
git commit -m "docs: mark tool whitelist design as implemented, update CLAUDE.md"
```
