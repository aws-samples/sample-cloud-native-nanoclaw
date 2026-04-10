#!/usr/bin/env bash
# NanoClawBot Cloud — Full Deployment Orchestrator
# Usage: ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=Pass123! ./scripts/deploy.sh
# Required: ADMIN_EMAIL, ADMIN_PASSWORD  Optional: CDK_STAGE (default: dev), AWS_REGION (default: us-west-2)
set -euo pipefail

STAGE="${CDK_STAGE:-dev}"
REGION="${AWS_REGION:-us-west-2}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX="nanoclawbot"
STACK_PREFIX="NanoClawBot-${STAGE}"

# Deploy mode: "agentcore" (default, uses Bedrock AgentCore) or "ecs" (China regions, pure ECS)
DEPLOY_MODE="${DEPLOY_MODE:-agentcore}"

# ECR repository names
ECR_CP_REPO="${PREFIX}-control-plane"
ECR_AGENT_REPO="${PREFIX}-agent"
ECR_AUTH_REPO="${PREFIX}-auth-service"

# AgentCore runtime name
AGENTCORE_NAME="${PREFIX}_${STAGE}"

# ── Helpers ──────────────────────────────────────────────────────────────────

log()  { echo "==> [$(date +%H:%M:%S)] $*"; }
fail() { echo "ERROR: $*" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required but not found in PATH"
}

get_stack_output() {
  local stack="$1" key="$2"
  aws cloudformation describe-stacks \
    --stack-name "$stack" \
    --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue" \
    --output text
}

# ── Step 1: Pre-flight checks ───────────────────────────────────────────────

log "Step 1: Pre-flight checks"
require_cmd aws
require_cmd docker
require_cmd node
require_cmd npx
require_cmd jq

if [ -z "${ADMIN_EMAIL:-}" ]; then
  fail "ADMIN_EMAIL is required. Usage: ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=YourPass123 ./scripts/deploy.sh"
fi
if [ -z "${ADMIN_PASSWORD:-}" ]; then
  fail "ADMIN_PASSWORD is required. Usage: ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=YourPass123 ./scripts/deploy.sh"
fi

if [ "$DEPLOY_MODE" != "agentcore" ] && [ "$DEPLOY_MODE" != "ecs" ]; then
  echo "ERROR: DEPLOY_MODE must be 'agentcore' or 'ecs', got '$DEPLOY_MODE'"
  exit 1
fi

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
log "  AWS Account: ${ACCOUNT_ID}"
log "  Region:      ${REGION}"
log "  Stage:       ${STAGE}"
log "  Deploy mode: $DEPLOY_MODE"
log "  Admin email: ${ADMIN_EMAIL}"

# ── Step 2: Install & build ─────────────────────────────────────────────────

log "Step 2: npm install && build all workspaces"
cd "$REPO_ROOT"
npm install
npm run build --workspaces

# ── Step 3: ECR login ───────────────────────────────────────────────────────

log "Step 3: ECR login"
# China regions (cn-*) use .amazonaws.com.cn domain
if [[ "$REGION" == cn-* ]]; then
  ECR_URI="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com.cn"
else
  ECR_URI="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
fi
aws ecr get-login-password --region "$REGION" | \
  docker login --username AWS --password-stdin "$ECR_URI"

# Ensure ECR repos exist
for repo in "$ECR_CP_REPO" "$ECR_AGENT_REPO"; do
  if ! aws ecr describe-repositories --repository-names "$repo" --region "$REGION" >/dev/null 2>&1; then
    log "  Creating ECR repository: $repo"
    aws ecr create-repository --repository-name "$repo" --region "$REGION" --image-scanning-configuration scanOnPush=true >/dev/null
  fi
done

# ── Step 4: Build & push control-plane image ────────────────────────────────

log "Step 4: Build & push control-plane Docker image"
docker build --platform linux/arm64 \
  -t "${ECR_URI}/${ECR_CP_REPO}:latest" \
  -f control-plane/Dockerfile .
docker push "${ECR_URI}/${ECR_CP_REPO}:latest"

# ── Step 5: Build & push agent-runtime image ────────────────────────────────

log "Step 5: Build & push agent-runtime Docker image"
docker build --platform linux/arm64 \
  -t "${ECR_URI}/${ECR_AGENT_REPO}:latest" \
  -f agent-runtime/Dockerfile .
docker push "${ECR_URI}/${ECR_AGENT_REPO}:latest"

# ── Step 5b: Build & push auth-service image (ECS mode only) ───────────────
if [ "$DEPLOY_MODE" = "ecs" ]; then
  log "Step 5b: Building auth-service image"
  aws ecr describe-repositories --repository-names "$ECR_AUTH_REPO" --region "$REGION" 2>/dev/null || \
    aws ecr create-repository --repository-name "$ECR_AUTH_REPO" --region "$REGION" --image-scanning-configuration scanOnPush=true
  docker build --platform linux/arm64 -t "${ECR_URI}/${ECR_AUTH_REPO}:latest" -f auth-service/Dockerfile .
  docker push "${ECR_URI}/${ECR_AUTH_REPO}:latest"
fi

# ── Step 6: CDK deploy ──────────────────────────────────────────────────────

log "Step 6: CDK deploy all stacks"
cd "$REPO_ROOT/infra"
# Ensure CDK uses the same region as this script (deploy.sh defaults to us-west-2,
# but app.ts falls back to us-east-1 — mismatch causes CannotPullContainerError
# when ECR images are in a different region than the ECS service).
CDK_DEFAULT_REGION="$REGION" CDK_DEFAULT_ACCOUNT="$ACCOUNT_ID" \
npx cdk deploy --all --require-approval never \
  --context stage="$STAGE" \
  --context mode="$DEPLOY_MODE" \
  --outputs-file cdk-outputs.json
cd "$REPO_ROOT"

# ── Step 7: Read stack outputs ───────────────────────────────────────────────

log "Step 7: Reading CDK stack outputs"
CDK_OUTPUTS="$REPO_ROOT/infra/cdk-outputs.json"

COGNITO_USER_POOL_ID=$(jq -r ".\"${STACK_PREFIX}-Auth\".UserPoolId // empty" "$CDK_OUTPUTS")
COGNITO_CLIENT_ID=$(jq -r ".\"${STACK_PREFIX}-Auth\".UserPoolClientId // empty" "$CDK_OUTPUTS")
ALB_DNS=$(jq -r ".\"${STACK_PREFIX}-ControlPlane\".AlbDnsName // empty" "$CDK_OUTPUTS")
CDN_DOMAIN=$(jq -r ".\"${STACK_PREFIX}-Frontend\".DistributionDomainName // empty" "$CDK_OUTPUTS")
WEBSITE_BUCKET=$(jq -r ".\"${STACK_PREFIX}-Frontend\".WebsiteBucketName // empty" "$CDK_OUTPUTS")
AGENT_BASE_ROLE_ARN=$(jq -r ".\"${STACK_PREFIX}-Agent\".AgentBaseRoleArn // empty" "$CDK_OUTPUTS")

DATA_BUCKET=$(aws cloudformation describe-stacks \
  --stack-name "${STACK_PREFIX}-Foundation" \
  --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='DataBucketName'].OutputValue" \
  --output text 2>/dev/null || echo "")

log "  Cognito Pool:    ${COGNITO_USER_POOL_ID}"
log "  ALB DNS:         ${ALB_DNS}"
log "  CDN Domain:      ${CDN_DOMAIN}"
log "  Website Bucket:  ${WEBSITE_BUCKET}"
log "  Agent Role ARN:  ${AGENT_BASE_ROLE_ARN}"

# ── Step 8: Register AgentCore runtime ───────────────────────────────────────

AGENTCORE_RUNTIME_ARN=""
if [ "$DEPLOY_MODE" = "agentcore" ]; then

log "Step 8: Register AgentCore runtime"

# Read ECS env vars needed by agent-runtime from the control-plane stack
SCOPED_ROLE_ARN=$(get_stack_output "${STACK_PREFIX}-Agent" "AgentScopedRoleArn" 2>/dev/null || echo "")
SCHEDULER_ROLE_ARN=$(get_stack_output "${STACK_PREFIX}-Agent" "SchedulerRoleArn" 2>/dev/null || echo "")
MESSAGE_QUEUE_URL=$(aws cloudformation describe-stacks \
  --stack-name "${STACK_PREFIX}-Foundation" \
  --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='MessageQueueUrl'].OutputValue" \
  --output text 2>/dev/null || echo "")
REPLY_QUEUE_URL=$(aws cloudformation describe-stacks \
  --stack-name "${STACK_PREFIX}-Foundation" \
  --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='ReplyQueueUrl'].OutputValue" \
  --output text 2>/dev/null || echo "")
TASKS_TABLE="${PREFIX}-${STAGE}-tasks"
SQS_MESSAGES_ARN=$(aws cloudformation describe-stacks \
  --stack-name "${STACK_PREFIX}-Foundation" \
  --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='MessageQueueArn'].OutputValue" \
  --output text 2>/dev/null || echo "")

# Resolve image digest for deterministic deploys
IMAGE_TAG="${ECR_URI}/${ECR_AGENT_REPO}:latest"
IMAGE_DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' "$IMAGE_TAG" 2>/dev/null \
  | sed 's/.*@//' || echo "")
if [ -n "$IMAGE_DIGEST" ]; then
  CONTAINER_URI="${ECR_URI}/${ECR_AGENT_REPO}@${IMAGE_DIGEST}"
else
  CONTAINER_URI="$IMAGE_TAG"
fi
log "  Container URI: ${CONTAINER_URI}"

ARTIFACT_JSON=$(jq -n --arg uri "$CONTAINER_URI" \
  '{"containerConfiguration":{"containerUri":$uri}}')

ENV_VARS_JSON=$(jq -n \
  --arg region "$REGION" \
  --arg scoped "$SCOPED_ROLE_ARN" \
  --arg bucket "$DATA_BUCKET" \
  --arg reply "$REPLY_QUEUE_URL" \
  --arg tasks "$TASKS_TABLE" \
  --arg scheduler "$SCHEDULER_ROLE_ARN" \
  --arg sqsarn "$SQS_MESSAGES_ARN" \
  '{AWS_REGION:$region,CLAUDE_CODE_USE_BEDROCK:"1",SCOPED_ROLE_ARN:$scoped,SESSION_BUCKET:$bucket,SQS_REPLIES_URL:$reply,TABLE_TASKS:$tasks,SCHEDULER_ROLE_ARN:$scheduler,SQS_MESSAGES_ARN:$sqsarn}')

# Check if runtime already exists
EXISTING_RUNTIME_ARN=""
EXISTING_RUNTIMES=$(aws bedrock-agentcore-control list-agent-runtimes --region "$REGION" 2>/dev/null || echo '{"agentRuntimes":[]}')
EXISTING_RUNTIME_ARN=$(echo "$EXISTING_RUNTIMES" | jq -r ".agentRuntimes[] | select(.agentRuntimeName==\"${AGENTCORE_NAME}\") | .agentRuntimeArn // empty" 2>/dev/null || echo "")

if [ -n "$EXISTING_RUNTIME_ARN" ]; then
  log "  AgentCore runtime exists, updating: ${EXISTING_RUNTIME_ARN}"
  AGENTCORE_RUNTIME_ARN="$EXISTING_RUNTIME_ARN"
  AGENTCORE_ID=$(echo "$AGENTCORE_RUNTIME_ARN" | awk -F'/' '{print $NF}')

  UPDATE_RESULT=$(aws bedrock-agentcore-control update-agent-runtime \
    --agent-runtime-id "$AGENTCORE_ID" \
    --agent-runtime-artifact "$ARTIFACT_JSON" \
    --role-arn "$AGENT_BASE_ROLE_ARN" \
    --network-configuration '{"networkMode":"PUBLIC"}' \
    --environment-variables "$ENV_VARS_JSON" \
    --region "$REGION" 2>&1) || fail "Failed to update AgentCore runtime: $UPDATE_RESULT"

  NEW_VERSION=$(echo "$UPDATE_RESULT" | jq -r '.agentRuntimeVersion // "unknown"')
  log "  Updated to version: ${NEW_VERSION}"
else
  log "  Creating AgentCore runtime: ${AGENTCORE_NAME}"

  CREATE_RESULT=$(aws bedrock-agentcore-control create-agent-runtime \
    --agent-runtime-name "$AGENTCORE_NAME" \
    --agent-runtime-artifact "$ARTIFACT_JSON" \
    --role-arn "$AGENT_BASE_ROLE_ARN" \
    --network-configuration '{"networkMode":"PUBLIC"}' \
    --environment-variables "$ENV_VARS_JSON" \
    --region "$REGION" 2>&1)

  AGENTCORE_RUNTIME_ARN=$(echo "$CREATE_RESULT" | jq -r '.agentRuntimeArn // empty')
  if [ -z "$AGENTCORE_RUNTIME_ARN" ]; then
    fail "Failed to create AgentCore runtime: $CREATE_RESULT"
  fi
  log "  Created: ${AGENTCORE_RUNTIME_ARN}"
fi

# ── Step 9: Wait for AgentCore READY ─────────────────────────────────────────

log "Step 9: Waiting for AgentCore runtime to be READY"
AGENTCORE_ID=$(echo "$AGENTCORE_RUNTIME_ARN" | awk -F'/' '{print $NF}')

for i in $(seq 1 60); do
  STATUS=$(aws bedrock-agentcore-control get-agent-runtime \
    --agent-runtime-id "$AGENTCORE_ID" \
    --region "$REGION" \
    --query 'status' --output text 2>/dev/null || echo "UNKNOWN")
  if [ "$STATUS" = "READY" ]; then
    log "  AgentCore runtime is READY"
    break
  fi
  if [ "$STATUS" = "FAILED" ]; then
    fail "AgentCore runtime entered FAILED state"
  fi
  log "  Status: ${STATUS} (attempt ${i}/60, waiting 10s...)"
  sleep 10
done

if [ "$STATUS" != "READY" ]; then
  fail "AgentCore runtime did not reach READY state within 10 minutes"
fi

# ── Step 9b: Stop warm sessions (force cold start with new image) ─────────────

log "Step 9b: Stopping warm AgentCore sessions"
SESSIONS_TABLE="${PREFIX}-${STAGE}-sessions"
ACTIVE_SESSIONS=$(aws dynamodb scan --table-name "$SESSIONS_TABLE" --region "$REGION" \
  --projection-expression "agentcoreSessionId" \
  --filter-expression "#s = :v" \
  --expression-attribute-names '{"#s":"status"}' \
  --expression-attribute-values '{":v":{"S":"active"}}' \
  --query 'Items[].agentcoreSessionId.S' --output json 2>/dev/null || echo '[]')

STOPPED=0
for sid in $(echo "$ACTIVE_SESSIONS" | jq -r '.[]'); do
  aws bedrock-agentcore stop-runtime-session \
    --runtime-session-id "$sid" \
    --agent-runtime-arn "$AGENTCORE_RUNTIME_ARN" \
    --region "$REGION" >/dev/null 2>&1 && STOPPED=$((STOPPED+1)) || true
done
log "  Stopped ${STOPPED} warm session(s)"

fi  # end DEPLOY_MODE=agentcore (Steps 8, 9, 9b)

# ── Step 10: Update ECS task with AGENTCORE_RUNTIME_ARN (agentcore mode only)

if [ "$DEPLOY_MODE" = "agentcore" ]; then
log "Step 10: Updating ECS task environment with AgentCore runtime ARN"
ECS_CLUSTER="${PREFIX}-${STAGE}"
NEW_TASK_DEF_ARN=""
ECS_SERVICE=$(aws ecs list-services --cluster "$ECS_CLUSTER" --region "$REGION" \
  --query 'serviceArns[0]' --output text 2>/dev/null || echo "")

if [ -n "$ECS_SERVICE" ] && [ "$ECS_SERVICE" != "None" ]; then
  # Get current task definition
  TASK_DEF_ARN=$(aws ecs describe-services --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE" \
    --region "$REGION" --query 'services[0].taskDefinition' --output text)
  TASK_DEF=$(aws ecs describe-task-definition --task-definition "$TASK_DEF_ARN" --region "$REGION")

  # Extract container definitions and add/update AGENTCORE_RUNTIME_ARN
  UPDATED_CONTAINERS=$(echo "$TASK_DEF" | jq \
    --arg arn "$AGENTCORE_RUNTIME_ARN" \
    '.taskDefinition.containerDefinitions | map(
      .environment = (.environment // [] | map(select(.name != "AGENTCORE_RUNTIME_ARN")))
        + [{"name": "AGENTCORE_RUNTIME_ARN", "value": $arn}]
    )')

  # Register new task definition revision
  NEW_TASK_DEF=$(echo "$TASK_DEF" | jq '{
    family: .taskDefinition.family,
    taskRoleArn: .taskDefinition.taskRoleArn,
    executionRoleArn: .taskDefinition.executionRoleArn,
    networkMode: .taskDefinition.networkMode,
    requiresCompatibilities: .taskDefinition.requiresCompatibilities,
    cpu: .taskDefinition.cpu,
    memory: .taskDefinition.memory,
    runtimePlatform: .taskDefinition.runtimePlatform
  }' | jq --argjson containers "$UPDATED_CONTAINERS" '. + {containerDefinitions: $containers}')

  TASK_DEF_TMP=$(mktemp)
  echo "$NEW_TASK_DEF" > "$TASK_DEF_TMP"
  NEW_TASK_DEF_ARN=$(aws ecs register-task-definition \
    --cli-input-json "file://${TASK_DEF_TMP}" \
    --region "$REGION" --query 'taskDefinition.taskDefinitionArn' --output text)
  rm -f "$TASK_DEF_TMP"

  log "  New task definition: ${NEW_TASK_DEF_ARN}"
else
  log "  WARN: No ECS service found in cluster ${ECS_CLUSTER}, skipping task update"
fi

# ── Step 11: Force new ECS deployment ────────────────────────────────────────

log "Step 11: Force new ECS deployment"
if [ -n "$ECS_SERVICE" ] && [ "$ECS_SERVICE" != "None" ]; then
  aws ecs update-service --cluster "$ECS_CLUSTER" --service "$ECS_SERVICE" \
    --task-definition "$NEW_TASK_DEF_ARN" \
    --force-new-deployment \
    --region "$REGION" >/dev/null
  log "  ECS deployment triggered"
else
  log "  WARN: Skipping — no ECS service found"
fi

fi  # end DEPLOY_MODE=agentcore (Steps 10-11)

# ── Step 12: Build web-console with Cognito config ───────────────────────────

log "Step 12: Build web-console"
cd "$REPO_ROOT"

# Write auth config for the web-console build
if [ "$DEPLOY_MODE" = "ecs" ]; then
  export VITE_AUTH_MODE="oidc"
  export VITE_AUTH_ENDPOINT="https://${CDN_DOMAIN}"
  export VITE_API_URL="https://${CDN_DOMAIN}"
else
  export VITE_AUTH_MODE="cognito"
  export VITE_COGNITO_USER_POOL_ID="$COGNITO_USER_POOL_ID"
  export VITE_COGNITO_CLIENT_ID="$COGNITO_CLIENT_ID"
  export VITE_COGNITO_REGION="$REGION"
  export VITE_API_URL="https://${CDN_DOMAIN}"
fi

npm run build -w web-console

# ── Step 13: Deploy web-console to S3 ────────────────────────────────────────

log "Step 13: Sync web-console to S3"
if [ -n "$WEBSITE_BUCKET" ] && [ "$WEBSITE_BUCKET" != "None" ]; then
  aws s3 sync web-console/dist/ "s3://${WEBSITE_BUCKET}/" \
    --delete --region "$REGION"
  log "  Uploaded to s3://${WEBSITE_BUCKET}/"
else
  fail "Website bucket not found in stack outputs"
fi

# ── Step 14: CloudFront invalidation ─────────────────────────────────────────

log "Step 14: CloudFront invalidation"
DISTRIBUTION_ID=$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?contains(DomainName,'${CDN_DOMAIN}')].Id" \
  --output text 2>/dev/null || echo "")

if [ -n "$DISTRIBUTION_ID" ] && [ "$DISTRIBUTION_ID" != "None" ]; then
  aws cloudfront create-invalidation \
    --distribution-id "$DISTRIBUTION_ID" \
    --paths "/*" >/dev/null
  log "  Invalidation created for distribution ${DISTRIBUTION_ID}"
else
  log "  WARN: Could not find CloudFront distribution, skipping invalidation"
fi

# ── Step 15: Smoke test ──────────────────────────────────────────────────────

log "Step 15: Smoke test"
HEALTH_URL="https://${CDN_DOMAIN}/health"
log "  Testing: ${HEALTH_URL}"

HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$HEALTH_URL" 2>/dev/null || echo "000")
if [ "$HTTP_STATUS" = "200" ]; then
  log "  Health check passed (HTTP 200)"
else
  log "  WARN: Health check returned HTTP ${HTTP_STATUS} (may need time for ECS deployment)"
fi

# ── Step 16: Seed default admin account ──────────────────────────────────────

log "Step 16: Seed default admin account"
USERS_TABLE="${PREFIX}-${STAGE}-users"

if [ "$DEPLOY_MODE" = "ecs" ]; then
  log "  Seeding admin directly in DynamoDB (ECS mode)..."
  # Generate bcrypt hash and ULID via Node.js one-liner
  ADMIN_SEED=$(node -e "
    import bcrypt from 'bcrypt';
    const hash = await bcrypt.hash(process.argv[1], 10);
    const t = Date.now() - 1469918176385;
    const id = (t.toString(36).padStart(10,'0') + Array.from({length:16},()=>'0123456789abcdefghjkmnpqrstvwxyz'[Math.random()*32|0]).join('')).toUpperCase();
    console.log(JSON.stringify({ userId: id, passwordHash: hash }));
  " "$ADMIN_PASSWORD")
  ADMIN_USER_ID=$(echo "$ADMIN_SEED" | jq -r '.userId')
  ADMIN_HASH=$(echo "$ADMIN_SEED" | jq -r '.passwordHash')

  # Check if admin already exists by email (scan — only runs once during deploy)
  EXISTING=$(aws dynamodb scan --table-name "$USERS_TABLE" --region "$REGION" \
    --filter-expression "email = :e" \
    --expression-attribute-values "{\":e\":{\"S\":\"$ADMIN_EMAIL\"}}" \
    --select COUNT --query 'Count' --output text 2>/dev/null || echo "0")

  if [ "$EXISTING" = "0" ]; then
    NOWISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    MONTH="$(date -u +%Y-%m)"
    aws dynamodb put-item --table-name "$USERS_TABLE" --region "$REGION" --item "$(cat <<ITEM
{
  "userId": {"S": "$ADMIN_USER_ID"},
  "email": {"S": "$ADMIN_EMAIL"},
  "passwordHash": {"S": "$ADMIN_HASH"},
  "displayName": {"S": "${ADMIN_EMAIL%%@*}"},
  "plan": {"S": "enterprise"},
  "status": {"S": "active"},
  "isAdmin": {"BOOL": true},
  "quota": {"M": {
    "maxBots": {"N": "100"},
    "maxGroupsPerBot": {"N": "100"},
    "maxTasksPerBot": {"N": "100"},
    "maxConcurrentAgents": {"N": "20"},
    "maxMonthlyTokens": {"N": "1000000000"}
  }},
  "usageMonth": {"S": "$MONTH"},
  "usageTokens": {"N": "0"},
  "usageInvocations": {"N": "0"},
  "activeAgents": {"N": "0"},
  "botCount": {"N": "0"},
  "createdAt": {"S": "$NOWISO"},
  "lastLogin": {"S": "$NOWISO"}
}
ITEM
)"
    log "  Admin user created: $ADMIN_EMAIL ($ADMIN_USER_ID)"
  else
    log "  Admin user already exists: $ADMIN_EMAIL"
  fi
else
  # Cognito admin seeding (agentcore mode)
  # Check if admin already exists in Cognito
  EXISTING_ADMIN=$(aws cognito-idp admin-get-user \
    --user-pool-id "$COGNITO_USER_POOL_ID" \
    --username "$ADMIN_EMAIL" \
    --region "$REGION" 2>/dev/null || echo "")

  # Ensure clawbot-admins group exists (idempotent)
  aws cognito-idp create-group \
    --user-pool-id "$COGNITO_USER_POOL_ID" \
    --group-name "clawbot-admins" \
    --description "NanoClaw admin users" \
    --region "$REGION" 2>/dev/null || true

  if [ -n "$EXISTING_ADMIN" ]; then
    log "  Admin user already exists: ${ADMIN_EMAIL} — ensuring admin group membership"
    aws cognito-idp admin-add-user-to-group \
      --user-pool-id "$COGNITO_USER_POOL_ID" \
      --username "$ADMIN_EMAIL" \
      --group-name "clawbot-admins" \
      --region "$REGION" 2>/dev/null || true
  else
    log "  Creating admin user: ${ADMIN_EMAIL}"

    # Create user in Cognito (suppress welcome email with MessageAction)
    CREATE_ADMIN_RESULT=$(aws cognito-idp admin-create-user \
      --user-pool-id "$COGNITO_USER_POOL_ID" \
      --username "$ADMIN_EMAIL" \
      --user-attributes Name=email,Value="$ADMIN_EMAIL" Name=email_verified,Value=true \
      --message-action SUPPRESS \
      --region "$REGION" 2>&1) || fail "Failed to create admin user: $CREATE_ADMIN_RESULT"

    # Extract the Cognito sub (userId)
    ADMIN_USER_ID=$(echo "$CREATE_ADMIN_RESULT" | jq -r '.User.Attributes[] | select(.Name=="sub") | .Value')
    if [ -z "$ADMIN_USER_ID" ]; then
      fail "Failed to extract user ID from Cognito response"
    fi

    # Set permanent password (skips FORCE_CHANGE_PASSWORD state)
    aws cognito-idp admin-set-user-password \
      --user-pool-id "$COGNITO_USER_POOL_ID" \
      --username "$ADMIN_EMAIL" \
      --password "$ADMIN_PASSWORD" \
      --permanent \
      --region "$REGION" || fail "Failed to set admin password"

    # Create matching DynamoDB user record
    NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
    USAGE_MONTH=$(date -u +%Y-%m)
    aws dynamodb put-item \
      --table-name "$USERS_TABLE" \
      --region "$REGION" \
      --condition-expression "attribute_not_exists(userId)" \
      --item "$(jq -n \
        --arg uid "$ADMIN_USER_ID" \
        --arg email "$ADMIN_EMAIL" \
        --arg now "$NOW" \
        --arg month "$USAGE_MONTH" \
        '{
          userId:           {S: $uid},
          email:            {S: $email},
          displayName:      {S: "admin"},
          plan:             {S: "enterprise"},
          status:           {S: "active"},
          quota:            {M: {maxBots: {N: "50"}, maxGroupsPerBot: {N: "100"}, maxTasksPerBot: {N: "200"}, maxConcurrentAgents: {N: "20"}, maxMonthlyTokens: {N: "1000000000"}}},
          usageMonth:       {S: $month},
          usageTokens:      {N: "0"},
          usageInvocations: {N: "0"},
          activeAgents:     {N: "0"},
          createdAt:        {S: $now},
          lastLogin:        {S: $now}
        }')" 2>/dev/null || log "  WARN: DynamoDB record may already exist"

    # Add admin to clawbot-admins group
    aws cognito-idp admin-add-user-to-group \
      --user-pool-id "$COGNITO_USER_POOL_ID" \
      --username "$ADMIN_EMAIL" \
      --group-name "clawbot-admins" \
      --region "$REGION" || log "  WARN: Failed to add admin to group"

    log "  Admin user created: ${ADMIN_EMAIL} (userId: ${ADMIN_USER_ID})"
  fi
fi

# ── Step 17: Write runtime values to SSM (post-deploy) ──────────────────────

if [ "$DEPLOY_MODE" = "agentcore" ]; then
  log "Step 17: Write runtime values to SSM Parameter Store"
  SSM_PREFIX="/${PREFIX}/${STAGE}"

  aws ssm put-parameter \
    --name "${SSM_PREFIX}/agentcore-runtime-arn" \
    --value "$AGENTCORE_RUNTIME_ARN" \
    --type String \
    --description "AgentCore runtime ARN for ${STAGE} environment" \
    --overwrite \
    --region "$REGION" >/dev/null

  # Verify
  SSM_VERIFY=$(aws ssm get-parameter \
    --name "${SSM_PREFIX}/agentcore-runtime-arn" \
    --region "$REGION" \
    --query 'Parameter.Value' --output text 2>/dev/null || echo "")

  if [ "$SSM_VERIFY" = "$AGENTCORE_RUNTIME_ARN" ]; then
    log "  SSM ${SSM_PREFIX}/agentcore-runtime-arn verified"
  else
    log "  WARN: SSM verification failed — expected ${AGENTCORE_RUNTIME_ARN}, got ${SSM_VERIFY}"
  fi
else
  log "Step 17: Skipped (SSM AgentCore ARN not needed in ECS mode)"
fi

# ── Done ─────────────────────────────────────────────────────────────────────

log ""
log "Deployment complete!"
log "  Stage:        ${STAGE}"
log "  Deploy mode:  ${DEPLOY_MODE}"
log "  Console:      https://${CDN_DOMAIN}"
log "  API:          https://${CDN_DOMAIN}/api"
log "  Health:       https://${CDN_DOMAIN}/health"
if [ "$DEPLOY_MODE" = "agentcore" ]; then
  log "  AgentCore:    ${AGENTCORE_RUNTIME_ARN}"
fi
log ""
log "  ┌─ Admin Credentials ────────────────────┐"
log "  │  Email:    ${ADMIN_EMAIL}"
log "  │  Password: ${ADMIN_PASSWORD}"
log "  └─────────────────────────────────────────┘"
