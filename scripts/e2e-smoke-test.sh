#!/usr/bin/env bash
# E2E Smoke Tests for NanoClawBot Cloud
# Uses agent-browser for browser-based tests + curl for API tests
set -uo pipefail

CDN_URL="https://dg4fxqnuko3dz.cloudfront.net"
ALB_URL="http://nanoclawbot-dev-alb-475691176.us-west-2.elb.amazonaws.com"

PASSED=0
FAILED=0
TESTS=()

pass() { PASSED=$((PASSED + 1)); TESTS+=("PASS: $1"); echo "  ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); TESTS+=("FAIL: $1 — $2"); echo "  ✗ $1 — $2"; }

echo "========================================="
echo " NanoClawBot E2E Smoke Tests"
echo "========================================="
echo ""

# ── Test Suite 1: API Health ──────────────────────────────────────────────────
echo "--- API Health Tests ---"

# T1.1: ALB health endpoint returns 200
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${ALB_URL}/health")
if [ "$HTTP_CODE" = "200" ]; then pass "ALB /health returns 200"; else fail "ALB /health returns 200" "got $HTTP_CODE"; fi

# T1.2: Health response has correct JSON shape
HEALTH_BODY=$(curl -s "${ALB_URL}/health")
if echo "$HEALTH_BODY" | jq -e '.status == "ok" and .uptime and .timestamp' >/dev/null 2>&1; then
  pass "Health response has {status, uptime, timestamp}"
else
  fail "Health response JSON shape" "got: $HEALTH_BODY"
fi

# T1.3: API requires auth (401 on protected endpoint)
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${ALB_URL}/api/bots")
if [ "$HTTP_CODE" = "401" ]; then pass "GET /api/bots returns 401 without auth"; else fail "GET /api/bots auth guard" "got $HTTP_CODE"; fi

# T1.4: GET /api/me requires auth
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${ALB_URL}/api/me")
if [ "$HTTP_CODE" = "401" ]; then pass "GET /api/me returns 401 without auth"; else fail "GET /api/me auth guard" "got $HTTP_CODE"; fi

# T1.5: Webhook endpoint exists (not 404) — telegram
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${ALB_URL}/webhook/telegram/fake-bot-id" -H "Content-Type: application/json" -d '{}')
if [ "$HTTP_CODE" != "404" ]; then pass "POST /webhook/telegram/:botId is routed (HTTP $HTTP_CODE)"; else fail "Webhook telegram route" "got 404"; fi

# T1.6: Webhook endpoint exists — discord
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${ALB_URL}/webhook/discord/fake-bot-id" -H "Content-Type: application/json" -d '{}')
if [ "$HTTP_CODE" != "404" ]; then pass "POST /webhook/discord/:botId is routed (HTTP $HTTP_CODE)"; else fail "Webhook discord route" "got 404"; fi

# T1.7: Webhook endpoint exists — slack
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${ALB_URL}/webhook/slack/fake-bot-id" -H "Content-Type: application/json" -d '{}')
if [ "$HTTP_CODE" != "404" ]; then pass "POST /webhook/slack/:botId is routed (HTTP $HTTP_CODE)"; else fail "Webhook slack route" "got 404"; fi

echo ""

# ── Test Suite 2: CloudFront / SPA Serving ────────────────────────────────────
echo "--- CloudFront / SPA Tests ---"

# T2.1: CDN serves index.html at root
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${CDN_URL}")
if [ "$HTTP_CODE" = "200" ]; then pass "CloudFront root returns 200"; else fail "CloudFront root" "got $HTTP_CODE"; fi

# T2.2: SPA has correct title
BODY=$(curl -s "${CDN_URL}")
if echo "$BODY" | grep -q "ClawBot Cloud"; then pass "SPA title contains 'ClawBot Cloud'"; else fail "SPA title" "missing 'ClawBot Cloud'"; fi

# T2.3: SPA includes JS bundle
if echo "$BODY" | grep -q '/assets/index-'; then pass "SPA includes JS bundle"; else fail "SPA JS bundle" "missing /assets/index-*"; fi

# T2.4: SPA includes CSS bundle
if echo "$BODY" | grep -q '/assets/index-.*\.css'; then pass "SPA includes CSS bundle"; else fail "SPA CSS bundle" "missing CSS"; fi

# T2.5: SPA fallback — non-existent path returns index.html (not 404)
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${CDN_URL}/nonexistent/path")
if [ "$HTTP_CODE" = "200" ]; then pass "SPA fallback: /nonexistent/path returns 200"; else fail "SPA fallback" "got $HTTP_CODE"; fi

# T2.6: JS bundle loads successfully
JS_URL=$(echo "$BODY" | grep -oP '/assets/index-[^"]+\.js')
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${CDN_URL}${JS_URL}")
if [ "$HTTP_CODE" = "200" ]; then pass "JS bundle loads (HTTP 200)"; else fail "JS bundle load" "got $HTTP_CODE for $JS_URL"; fi

echo ""

# ── Test Suite 3: Browser Tests (agent-browser) ──────────────────────────────
echo "--- Browser Tests (agent-browser) ---"

# Close any stale sessions
agent-browser close 2>/dev/null || true

echo ""
echo "========================================="
echo " Results: ${PASSED} passed, ${FAILED} failed"
echo "========================================="
for t in "${TESTS[@]}"; do echo "  $t"; done

exit $FAILED
