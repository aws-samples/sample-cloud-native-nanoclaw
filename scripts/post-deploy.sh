#!/usr/bin/env bash
# NanoClawBot Cloud — Post-Deploy: write runtime-discovered values to SSM
# Run after CDK deploy + AgentCore creation so the control-plane can
# resolve them at startup without hardcoding ARNs in CDK.
#
# Usage: CDK_STAGE=dev ./scripts/post-deploy.sh
set -euo pipefail

STAGE="${CDK_STAGE:-dev}"
REGION="${AWS_REGION:-us-west-2}"
PREFIX="nanoclawbot"
AGENTCORE_NAME="${PREFIX}_${STAGE}"
SSM_PREFIX="/${PREFIX}/${STAGE}"

log()  { echo "==> [$(date +%H:%M:%S)] $*"; }
fail() { echo "ERROR: $*" >&2; exit 1; }

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
log "Account: ${ACCOUNT_ID}  Region: ${REGION}  Stage: ${STAGE}"

# ── 1. Discover AgentCore runtime ARN ────────────────────────────────────────

log "Discovering AgentCore runtime: ${AGENTCORE_NAME}"
RUNTIMES=$(aws bedrock-agentcore-control list-agent-runtimes --region "$REGION" 2>/dev/null \
  || echo '{"agentRuntimes":[]}')

RUNTIME_ARN=$(echo "$RUNTIMES" | jq -r \
  --arg name "$AGENTCORE_NAME" \
  '.agentRuntimes[] | select(.agentRuntimeName == $name) | .agentRuntimeArn // empty')

if [ -z "$RUNTIME_ARN" ]; then
  fail "AgentCore runtime '${AGENTCORE_NAME}' not found. Create it first (see deploy.sh Steps 8-9)."
fi

RUNTIME_STATUS=$(echo "$RUNTIMES" | jq -r \
  --arg name "$AGENTCORE_NAME" \
  '.agentRuntimes[] | select(.agentRuntimeName == $name) | .status // "UNKNOWN"')

log "  ARN:    ${RUNTIME_ARN}"
log "  Status: ${RUNTIME_STATUS}"

if [ "$RUNTIME_STATUS" != "READY" ]; then
  log "  WARNING: runtime is not READY — control-plane invocations will fail until it is."
fi

# ── 2. Write to SSM Parameter Store ──────────────────────────────────────────

write_ssm() {
  local name="$1" value="$2" desc="$3"
  log "  Writing SSM ${name}"
  aws ssm put-parameter \
    --name "$name" \
    --value "$value" \
    --type String \
    --description "$desc" \
    --overwrite \
    --region "$REGION" >/dev/null
}

write_ssm "${SSM_PREFIX}/agentcore-runtime-arn" \
  "$RUNTIME_ARN" \
  "AgentCore runtime ARN for ${STAGE} environment"

# ── 3. Verify ────────────────────────────────────────────────────────────────

VERIFY=$(aws ssm get-parameter --name "${SSM_PREFIX}/agentcore-runtime-arn" \
  --region "$REGION" --query 'Parameter.Value' --output text 2>/dev/null || echo "")

if [ "$VERIFY" = "$RUNTIME_ARN" ]; then
  log "SSM parameters verified."
else
  fail "SSM verification failed — expected ${RUNTIME_ARN}, got ${VERIFY}"
fi

log ""
log "Done. Control-plane will pick up the new value on next restart."
log "  To restart now: aws ecs update-service --cluster ${PREFIX}-${STAGE} --force-new-deployment --region ${REGION}"
