#!/usr/bin/env bash
# NanoClawBot Cloud — Teardown Script
# Usage: CDK_STAGE=dev ./scripts/destroy.sh
set -euo pipefail

STAGE="${CDK_STAGE:-dev}"
REGION="${AWS_REGION:-us-west-2}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX="nanoclawbot"
STACK_PREFIX="NanoClawBot-${STAGE}"
AGENTCORE_NAME="${PREFIX}_${STAGE}"

log()  { echo "==> [$(date +%H:%M:%S)] $*"; }
fail() { echo "ERROR: $*" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required but not found in PATH"
}

require_cmd aws
require_cmd jq
require_cmd npx

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
log "Teardown: Stage=${STAGE} Account=${ACCOUNT_ID} Region=${REGION}"

# ── Step 1: Delete AgentCore runtime ─────────────────────────────────────────

log "Step 1: Delete AgentCore runtime"
EXISTING_RUNTIMES=$(aws bedrock-agentcore-control list-agent-runtimes --region "$REGION" 2>/dev/null || echo '{"agentRuntimeSummaries":[]}')
AGENTCORE_ID=$(echo "$EXISTING_RUNTIMES" | jq -r ".agentRuntimeSummaries[] | select(.agentRuntimeName==\"${AGENTCORE_NAME}\") | .agentRuntimeId // empty" 2>/dev/null || echo "")

if [ -n "$AGENTCORE_ID" ]; then
  log "  Deleting AgentCore runtime: ${AGENTCORE_ID}"
  aws bedrock-agentcore-control delete-agent-runtime \
    --agent-runtime-id "$AGENTCORE_ID" \
    --region "$REGION" 2>/dev/null || log "  WARN: delete-agent-runtime call failed (may already be deleted)"

  # Wait for deletion
  for i in $(seq 1 30); do
    STATUS=$(aws bedrock-agentcore-control get-agent-runtime \
      --agent-runtime-id "$AGENTCORE_ID" \
      --region "$REGION" \
      --query 'status' --output text 2>/dev/null || echo "DELETED")
    if [ "$STATUS" = "DELETED" ]; then
      break
    fi
    log "  Status: ${STATUS} (waiting...)"
    sleep 5
  done
  log "  AgentCore runtime deleted"
else
  log "  No AgentCore runtime found with name ${AGENTCORE_NAME}"
fi

# ── Step 2: CDK destroy ─────────────────────────────────────────────────────

log "Step 2: CDK destroy all stacks"
cd "$REPO_ROOT/infra"
npx cdk destroy --all --force \
  --context stage="$STAGE"
cd "$REPO_ROOT"

# ── Step 3: Clean ECR repositories ──────────────────────────────────────────

log "Step 3: Clean ECR repositories"
for repo in "${PREFIX}-control-plane" "${PREFIX}-agent"; do
  if aws ecr describe-repositories --repository-names "$repo" --region "$REGION" >/dev/null 2>&1; then
    log "  Deleting all images in ${repo}"
    IMAGE_IDS=$(aws ecr list-images --repository-name "$repo" --region "$REGION" \
      --query 'imageIds[*]' --output json 2>/dev/null)
    if [ "$IMAGE_IDS" != "[]" ] && [ -n "$IMAGE_IDS" ]; then
      aws ecr batch-delete-image --repository-name "$repo" \
        --image-ids "$IMAGE_IDS" --region "$REGION" >/dev/null 2>/dev/null || true
    fi
    log "  Deleting repository ${repo}"
    aws ecr delete-repository --repository-name "$repo" \
      --region "$REGION" --force >/dev/null 2>/dev/null || true
  else
    log "  Repository ${repo} not found, skipping"
  fi
done

# ── Done ─────────────────────────────────────────────────────────────────────

log ""
log "Teardown complete for stage: ${STAGE}"
