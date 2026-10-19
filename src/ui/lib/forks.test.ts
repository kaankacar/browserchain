import { describe, expect, it } from 'vitest';
import type { ForkInfo, LedgerSummary, ValidatorView } from '../../node/api';
import { FORK_ALERT_MS, forkNotice, ROLLBACK_NOTICE_MS, STRANGER_FORK_FRESH_MS, strangerFork } from './forks';

const fork = (resolution: ForkInfo['resolution'], ts: number, extra: Partial<ForkInfo> = {}): ForkInfo => ({
  ts,
  atSeq: 5,
  ourHash: 'aa'.repeat(32),
  theirHash: 'bb'.repeat(32),
  peer: 'GPEER',
  resolution,
  rolledBackLedgers: resolution === 'rolled-back' ? 3 : 0,
  ...extra,
});
const ledger = (seq: number, hash: string) => ({ seq, hash }) as LedgerSummary;
// a synced, connected validator the node does not count as active (as when it is marked forked)
const validator = (extra: Partial<ValidatorView>) => ({ nodeId: 'GPEER', connected: true, synced: true, active: false, ...extra }) as ValidatorView;

describe('fork notice', () => {
  it('alerts while a manual-mode fork keeps being reported', () => {
    const f = fork('alert-only', 1_000);
    expect(forkNotice([f], [ledger(6, 'cc'), ledger(5, 'aa'.repeat(32))], 1_000 + 5_000)).toEqual({ kind: 'alert', fork: f });
    // ledgers older than the UI keeps: still an alert
    expect(forkNotice([f], [ledger(60, 'cc')], 1_000 + FORK_ALERT_MS)?.kind).toBe('alert');
    // no new report for a while: the fork is no longer current
    expect(forkNotice([f], [], 1_000 + FORK_ALERT_MS + 1)).toBeNull();
  });

  it('stops alerting once this node holds another ledger at the fork height (resync)', () => {
    const f = fork('alert-only', 1_000);
    expect(forkNotice([f], [ledger(5, 'bb'.repeat(32))], 2_000)).toBeNull();
  });

  it('reports a rollback for a minute, and nothing for a fork the peer resolves', () => {
    const r = fork('rolled-back', 1_000);
    expect(forkNotice([r], [], 1_000 + ROLLBACK_NOTICE_MS)).toEqual({ kind: 'rolled-back', fork: r });
    expect(forkNotice([r], [], 1_000 + ROLLBACK_NOTICE_MS + 1)).toBeNull();
    expect(forkNotice([fork('kept-ours', 1_000)], [], 1_500)).toBeNull();
    expect(forkNotice([], [], 0)).toBeNull();
  });

  it('looks at the newest report only', () => {
    // auto mode resolved the fork after the user switched from manual
    expect(forkNotice([fork('kept-ours', 9_000), fork('alert-only', 8_000)], [], 9_500)).toBeNull();
  });

  it('keeps alerting while the node keeps the peer out, long after the one report', () => {
    // The node checks again only when it can compare chains, never while the
    // peer is ahead: a fork with a peer that is ahead gets one report. The
    // node still marks the peer forked, so it does not count it as active.
    const f = fork('alert-only', 1_000);
    const ours = [ledger(9, '09'), ledger(8, '08'), ledger(5, 'aa'.repeat(32))];
    const later = 1_000 + FORK_ALERT_MS + 120_000;
    const live = (v: Partial<ValidatorView>, synced = true) => ({ validators: [validator(v)], synced });
    expect(forkNotice([f], ours, later, live({}))).toEqual({ kind: 'alert', fork: f });
    // the node counts the peer again: the fork is over
    expect(forkNotice([f], ours, later, live({ active: true }))).toBeNull();
    // the peer left, or is catching up
    expect(forkNotice([f], ours, later, live({ connected: false }))).toBeNull();
    expect(forkNotice([f], ours, later, live({ synced: false }))).toBeNull();
    // this node is catching up (after a resync)
    expect(forkNotice([f], ours, later, live({}, false))).toBeNull();
    // a resync replaced our side
    expect(forkNotice([f], [ledger(9, 'ee'), ledger(5, 'bb'.repeat(32))], later, live({}))).toBeNull();
  });
});

describe('stranger fork alert', () => {
  // auto mode kept our chain only because the validators on the other branch
  // were unknown before the fork; the node re-reports it at most every 10 s
  const stranger = (ts: number, extra: Partial<ForkInfo> = {}) => fork('kept-ours', ts, { unknownValidators: 3, ...extra });
  const inSync = { inSync: true, resyncAt: null };

  it('alerts while reports keep coming, with the newest report', () => {
    const reports = [stranger(21_000, { peer: 'GTHEM2' }), stranger(11_000), stranger(1_000)];
    expect(strangerFork(reports, [], 25_000, inSync)).toBe(reports[0]);
    expect(strangerFork(reports, [ledger(5, 'aa'.repeat(32))], 21_000 + STRANGER_FORK_FRESH_MS, inSync)).toBe(reports[0]);
    // the reports stopped: the other group left or the fork is over
    expect(strangerFork(reports, [], 21_000 + STRANGER_FORK_FRESH_MS + 1, inSync)).toBeNull();
    // the window spans more than one missed re-report
    expect(STRANGER_FORK_FRESH_MS).toBeGreaterThanOrEqual(3 * 10_000);
  });

  it('ignores forks kept for other reasons', () => {
    expect(strangerFork([fork('kept-ours', 1_000)], [], 2_000, inSync)).toBeNull();
    expect(strangerFork([stranger(1_000, { unknownValidators: 0 })], [], 2_000, inSync)).toBeNull();
    expect(strangerFork([fork('rolled-back', 1_000, { unknownValidators: 3 })], [], 2_000, inSync)).toBeNull();
    expect(strangerFork([fork('alert-only', 1_000)], [], 2_000, inSync)).toBeNull();
    // a newer report of another kind does not hide it
    const s = stranger(1_000);
    expect(strangerFork([fork('rolled-back', 2_000, { peer: 'GOTHER' }), s], [], 3_000, inSync)).toBe(s);
  });

  it('shows nothing while this node is not in sync (booting, catching up, blocked)', () => {
    expect(strangerFork([stranger(1_000)], [], 2_000, { inSync: false, resyncAt: null })).toBeNull();
  });

  it('drops reports from before a resync this UI started, but not newer ones', () => {
    const old = stranger(1_000);
    expect(strangerFork([old], [], 6_000, { inSync: true, resyncAt: 5_000 })).toBeNull();
    // the node is in sync again and still sees the other group on another chain
    const again = stranger(9_000);
    expect(strangerFork([again, old], [], 10_000, { inSync: true, resyncAt: 5_000 })).toBe(again);
  });

  it('stops once this node holds another ledger at the fork height', () => {
    expect(strangerFork([stranger(1_000)], [ledger(5, 'bb'.repeat(32))], 2_000, inSync)).toBeNull();
  });

  it('keeps alerting when the report could not name our ledger at the fork height yet', () => {
    // Strangers that lack the ledgers to compare (V-4): the node reports the
    // ledger after its LCL before it closed it (ourHash ''). Review case: once
    // the node closed that ledger, the alert went away until the next report.
    const early = stranger(1_000, { ourHash: '', theirHash: '' });
    expect(strangerFork([early], [ledger(5, 'cc'.repeat(32))], 6_000, inSync)).toBe(early);
  });

  it('does not hide the other fork notices, unless it is about the same peer', () => {
    // a rollback against known validators, then re-reports about strangers
    const r = fork('rolled-back', 1_000);
    expect(forkNotice([stranger(5_000, { peer: 'GTHEM' }), r], [], 6_000)).toEqual({ kind: 'rolled-back', fork: r });
    // a manual-mode report the node replaced with a stranger verdict for that peer
    // (the user switched to auto mode)
    const a = fork('alert-only', 1_000);
    expect(forkNotice([stranger(5_000, { peer: 'GTHEM' }), a], [], 6_000)?.kind).toBe('alert');
    expect(forkNotice([stranger(5_000), a], [], 6_000)).toBeNull();
  });
});
