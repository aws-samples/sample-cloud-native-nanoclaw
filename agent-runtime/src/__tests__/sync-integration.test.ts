import { describe, it, expect, beforeEach } from 'vitest';
import { SyncState } from '../sync-state.js';

/**
 * Pure function mirroring the sync path selection logic from agent.ts (lines 218-222).
 *
 * Path A — full download (first request, session switch, or no previous session)
 * Path B — incremental sync (same session continuation)
 * Path C — forced new session (same session key but forceNewSession=true)
 */
function selectPath(
  syncState: SyncState,
  currentSessionKey: string | undefined,
  newSessionKey: string,
  forceNewSession: boolean,
): 'A' | 'B' | 'C' {
  if (forceNewSession) return 'C';
  const isSessionContinuation = syncState.initialized
    && currentSessionKey === newSessionKey
    && !forceNewSession;
  if (isSessionContinuation) return 'B';
  return 'A';
}

describe('sync path selection', () => {
  let state: SyncState;

  beforeEach(() => {
    state = new SyncState();
  });

  // ── Path A ────────────────────────────────────────────────────

  it('Path A: first request (uninitialized)', () => {
    expect(state.initialized).toBe(false);
    const path = selectPath(state, undefined, 'bot1#g1', false);
    expect(path).toBe('A');
  });

  it('Path A: session switch to different key', () => {
    state.initialized = true;
    const path = selectPath(state, 'bot1#g1', 'bot2#g2', false);
    expect(path).toBe('A');
  });

  it('Path A: initialized but no previous session key', () => {
    state.initialized = true;
    const path = selectPath(state, undefined, 'bot1#g1', false);
    expect(path).toBe('A');
  });

  // ── Path B ────────────────────────────────────────────────────

  it('Path B: same session continuation', () => {
    state.initialized = true;
    const path = selectPath(state, 'bot1#g1', 'bot1#g1', false);
    expect(path).toBe('B');
  });

  // ── Path C ────────────────────────────────────────────────────

  it('Path C: forceNewSession on same session key', () => {
    state.initialized = true;
    const path = selectPath(state, 'bot1#g1', 'bot1#g1', true);
    expect(path).toBe('C');
  });

  it('Path C: forceNewSession overrides session continuation', () => {
    state.initialized = true;
    // All conditions for Path B hold except forceNewSession is true
    const pathWithoutForce = selectPath(state, 'bot1#g1', 'bot1#g1', false);
    expect(pathWithoutForce).toBe('B');

    const pathWithForce = selectPath(state, 'bot1#g1', 'bot1#g1', true);
    expect(pathWithForce).toBe('C');
  });
});
