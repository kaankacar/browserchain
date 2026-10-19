import { describe, expect, it } from 'vitest';
import type { NodeStatus, SyncState } from '../../node/api';
import { blockedReason, inSync, selfState } from './catchup';

const status = (state: SyncState, catchup: NodeStatus['catchup'] = null) => ({ state, catchup }) as NodeStatus;
const blocked = { target: 40, current: 31, source: null, blocked: 'no usable catch-up source' };

describe('blocked catch-up', () => {
  it('reads the reason the node gives', () => {
    expect(blockedReason(status('catching-up', blocked))).toBe('no usable catch-up source');
    expect(blockedReason(status('catching-up', { target: 40, current: 31, source: 'GSRC' }))).toBeNull();
    expect(blockedReason(status('synced'))).toBeNull();
    expect(blockedReason(null)).toBeNull();
  });

  it('shows a blocked node as blocked, never as synced', () => {
    expect(selfState(status('catching-up', blocked))).toBe('blocked');
    for (const state of ['synced', 'stalled'] as const) expect(selfState(status(state, blocked))).toBe('blocked');
    // an empty reason still means blocked
    expect(selfState(status('catching-up', { ...blocked, blocked: '' }))).toBe('blocked');
  });

  it('keeps the other states as the node reports them', () => {
    for (const state of ['booting', 'catching-up', 'synced', 'stalled', 'stopped'] as const) expect(selfState(status(state))).toBe(state);
    // a stopped or restarting node is not waiting for a catch-up any more
    expect(selfState(status('stopped', blocked))).toBe('stopped');
    expect(selfState(status('booting', blocked))).toBe('booting');
    expect(selfState(null)).toBe('booting');
  });

  it('counts only a voting node on its own chain as in sync', () => {
    expect(inSync(selfState(status('synced')))).toBe(true);
    expect(inSync(selfState(status('stalled')))).toBe(true);
    expect(inSync(selfState(status('synced', blocked)))).toBe(false);
    for (const state of ['booting', 'catching-up', 'stopped'] as const) expect(inSync(state)).toBe(false);
  });
});
