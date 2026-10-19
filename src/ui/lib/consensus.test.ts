import { describe, expect, it } from 'vitest';
import type { ScpNodeStateView, ScpSlotView, ValueView } from '../../node/api';
import { nominationLabel, slotIdle, slotProgress } from './consensus';

const value: ValueView = { id: 'abcd1234', txSetHash: '00'.repeat(32), closeTime: 100, txCount: 0, proposer: null };

function slot(round: number, statements: ScpNodeStateView['statement'][], extra: Partial<ScpSlotView> = {}): ScpSlotView {
  return {
    slot: 12,
    phase: 'NOMINATE',
    nomination: { round, votes: [], accepted: [], candidates: [], leaders: [] },
    ballot: null,
    prepared: null,
    preparedPrime: null,
    high: null,
    commit: null,
    heardFromQuorum: false,
    nodes: statements.map((statement, i) => ({ nodeId: `G${i}`, name: `node-${i}`, statement, ballotCounter: null, summary: '' })),
    externalized: null,
    startedAt: 0,
    externalizedAt: null,
    ...extra,
  };
}

const validator = { state: 'synced' as const, isValidator: true };
const watcher = { state: 'synced' as const, isValidator: false };

describe('consensus wording', () => {
  it('waits for the trigger while nobody has a statement', () => {
    expect(slotIdle(null)).toBe(true);
    expect(slotIdle(slot(0, []))).toBe(true);
    expect(slotIdle(slot(0, ['none', 'none']))).toBe(true);
    expect(slotProgress(slot(0, ['none']), validator)).toBe('Waiting for the next ledger trigger');
    expect(slotProgress(null, validator)).toBe('Waiting for the first nomination');
    expect(slotProgress(null, { state: 'catching-up', isValidator: true })).toBe('Joins after the node is in sync');
  });

  it('never shows round 0: peers nominate before this node does', () => {
    // a peer's NOMINATE arrived; this node's own nomination has not started
    const s = slot(0, ['nominate']);
    expect(slotIdle(s)).toBe(false);
    expect(slotProgress(s, validator)).toBe('Waiting for this node to nominate');
    expect(nominationLabel(s, true)).toBe('not nominating yet');
    expect(slotProgress(s, validator)).not.toMatch(/round 0/i);
  });

  it('shows the round and ballot once this node nominates', () => {
    expect(slotProgress(slot(1, ['nominate']), validator)).toBe('Round 1');
    const balloting = slot(2, ['prepare', 'prepare'], { phase: 'PREPARE', ballot: { counter: 3, value } });
    expect(slotProgress(balloting, validator)).toBe('Round 2 · ballot 3');
    expect(nominationLabel(balloting, true)).toBe('round 2');
    const inf = slot(1, ['externalize'], { phase: 'EXTERNALIZE', ballot: { counter: 0xffffffff, value }, externalized: value });
    expect(slotProgress(inf, validator)).toBe('Round 1 · ballot ∞');
  });

  it('a validator that joined the ballot without nominating shows only the ballot', () => {
    const s = slot(0, ['prepare', 'confirm'], { phase: 'PREPARE', ballot: { counter: 1, value } });
    expect(slotProgress(s, validator)).toBe('Ballot 1');
    expect(nominationLabel({ ...s, externalized: value }, true)).toBe('did not nominate');
  });

  it('a watcher never nominates: it says so instead of round 0', () => {
    const s = slot(0, ['prepare'], { phase: 'PREPARE', ballot: { counter: 2, value } });
    expect(slotProgress(s, watcher)).toBe('Watching, not voting · ballot 2');
    expect(slotProgress(slot(0, ['nominate']), watcher)).toBe('Watching, not voting');
    expect(nominationLabel(s, false)).toBe('watching, not voting');
  });
});
