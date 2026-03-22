# Model Providers Configuration Refactor

**Date:** 2026-03-21
**Status:** Approved

## Summary

Refactor "Anthropic API Configuration" into admin-managed "Model Providers Configuration". Admins configure global providers (name, type, credentials, model IDs). Regular users select from admin-configured providers and models per bot — no self-service API key management.

## Data Model

### New `providers` DynamoDB Table

```
Table: nanoclawbot-{stage}-providers
Partition Key: providerId (string, ULID)
Billing: PAY_PER_REQUEST
PointInTimeRecovery: true
RemovalPolicy: RETAIN
```

Item shape:

```typescript
{
  providerId: string                              // ULID
  providerName: string                            // e.g. "Anthropic Direct", "Bedrock US-West"
  providerType: "bedrock" | "anthropic-compatible-api"
  baseUrl?: string                                // For anthropic-compatible-api
  hasApiKey: boolean                              // True if secret stored (never expose key)
  modelIds: string[]                              // Admin-configured available models
  isDefault: boolean                              // At most one provider is default
  createdAt: string
  updatedAt: string
}
```

API key stored in Secrets Manager: `nanoclawbot/{stage}/providers/{providerId}/api-key`

Note: Bedrock providers don't require an API key — the agent runtime has IAM roles.

### Bot Schema Update

```diff
- modelProvider?: "bedrock" | "anthropic-api"
- model?: string
+ providerId?: string    // References a provider
+ modelId?: string       // One of provider's modelIds
```

### User Schema Update

```diff
- anthropicBaseUrl?: string   // Removed — no longer per-user
```

## Model ID Presets

Presets by provider type (admin can add custom IDs on top):

- **Bedrock:** `global.anthropic.claude-sonnet-4-6`, `global.anthropic.claude-opus-4-6-v1`
- **Anthropic Compatible API:** `claude-sonnet-4-6`, `claude-opus-4-6`

## Backend API

### New Admin Routes (admin-only auth)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/providers` | List all providers |
| POST | `/api/admin/providers` | Create provider |
| PUT | `/api/admin/providers/:id` | Update provider |
| DELETE | `/api/admin/providers/:id` | Delete (fail if bots reference it) |

### New Public Route (any authenticated user)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/providers` | List providers (public view: no secrets) |

### Routes to Remove

- `GET /api/me/provider`
- `PUT /api/me/provider`

### Bot Update Validation

```diff
- if modelProvider === 'anthropic-api': check user has API key
+ if providerId is set: check providerId exists in providers table
+ if modelId is set: check modelId is in that provider's modelIds list
```

### Dispatcher Change

`resolveProviderCredentials()` rewritten to:
1. Fetch provider config from DynamoDB by `bot.providerId`
2. Fetch provider's API key from Secrets Manager by `providerId`
3. Return `{ providerType, apiKey?, baseUrl? }`

## Frontend

### Admin: Model Providers Management

Replace AnthropicTab in Settings with a provider management panel:

- Table listing providers (name, type, model count, default badge, has-key status)
- "Add Provider" form:
  - Provider Name (text)
  - Provider Type (dropdown: Bedrock / Anthropic Compatible API)
  - Base URL (conditional: only for `anthropic-compatible-api`)
  - API Key (conditional: only for `anthropic-compatible-api`; optional for `bedrock`)
  - Model IDs: preset checkboxes + "Add custom" input
  - "Set as default" toggle
- Edit/Delete per row (delete blocked if bots reference it)

### Regular User: Settings Page

Remove AnthropicTab entirely. Only CredentialsTab (proxy rules) remains.

### Bot Overview: Model Selection

Replace radio buttons + custom input with two dropdowns:

1. **Provider dropdown** — lists all providers by name (pre-selects default or current)
2. **Model dropdown** — lists modelIds for selected provider (resets on provider change)

No custom input allowed. If no providers configured, show: "No model providers available. Contact your administrator."

## CDK Infrastructure

```typescript
const providersTable = new dynamodb.Table(this, 'ProvidersTable', {
  tableName: `nanoclawbot-${stage}-providers`,
  partitionKey: { name: 'providerId', type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  removalPolicy: cdk.RemovalPolicy.RETAIN,
  pointInTimeRecovery: true,
});
```

No GSI needed — provider count is small (< 10), full Scan for listing is fine.

## Code Changes Summary

### Remove

- `control-plane/src/routes/api/user.ts` — `GET/PUT /me/provider` routes
- `control-plane/src/services/dynamo.ts` — `updateUserProvider()`
- `control-plane/src/services/secrets.ts` — `getAnthropicApiKey`, `putAnthropicApiKey`, `deleteAnthropicApiKey`
- `shared/src/types.ts` — `anthropicBaseUrl` from User, `modelProvider`/`model` from Bot
- `web-console/src/pages/Settings.tsx` — AnthropicTab component
- `web-console/src/pages/BotDetail.tsx` — Radio button model selection + custom input
- `web-console/src/lib/api.ts` — `user.getProvider`/`user.updateProvider`

### Add

- `infra/lib/foundation-stack.ts` — `providers` DynamoDB table
- `control-plane/src/services/dynamo.ts` — Provider CRUD functions
- `control-plane/src/services/secrets.ts` — Provider-scoped API key functions (`getProviderApiKey`, `putProviderApiKey`, `deleteProviderApiKey`)
- `control-plane/src/routes/api/admin.ts` — Provider admin CRUD routes
- `control-plane/src/routes/api/providers.ts` — Public provider list route
- `control-plane/src/sqs/dispatcher.ts` — Rewrite `resolveProviderCredentials` to use providers table

### Modify

- `control-plane/src/routes/api/bots.ts` — Validation against providers table
- `web-console/src/pages/BotDetail.tsx` — Two-dropdown model selection
- `web-console/src/lib/api.ts` — Add `providers.list()` and `admin.providers.*` methods
