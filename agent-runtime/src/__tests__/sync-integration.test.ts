import { describe, it, expect, beforeEach } from 'vitest';
import { SyncState } from '../sync-state.js';

/**
 * Pure function mirroring the sync path selection logic from agent.ts.
 *
 * Two paths only:
 *   full        — first request on a fresh microVM/task (syncState uninitialized)
 *   incremental — subsequent request on the same microVM/task
 *
 * `forceNewSession` does NOT affect sync path anymore — it only flips the
 * Claude Agent SDK's `continue` flag in runAgentQuery. The microVM/task is
 * 1:1 bound to (botId, groupJid), so no cross-session cleanup is needed.
 */
function selectPath(syncState: SyncState): 'full' | 'incremental' {
  return syncState.initialized ? 'incremental' : 'full';
}

describe('sync path selection', () => {
  let state: SyncState;

  beforeEach(() => {
    state = new SyncState();
  });

  it('full sync on first request (uninitialized)', () => {
    expect(state.initialized).toBe(false);
    expect(selectPath(state)).toBe('full');
  });

  it('incremental sync on subsequent request', () => {
    state.initialized = true;
    expect(selectPath(state)).toBe('incremental');
  });
});
