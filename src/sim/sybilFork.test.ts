// Fork verdicts are not decided by identities that appeared after the fork
// (ARCHITECTURE 12.3). Review case: two new identities announced a longer
// branch forked after genesis and claimed a heavy weight. The weight clamp
// (their span x known validators) still let them win, and a healthy 3-node
// quorum replaced every ledger it had agreed on with theirs.
//
// Here the forged branch is valid: it replays, and its ledger 2 spends the
// friendbot channel sequence number that funded the victim on the honest
// chain, to fund the liars instead. Only the vouch of validators that this
// node saw as active members at or before the fork point counts.

import { Account, Keypair, Operation, TransactionBuilder } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { sha256 } from '../lib/hash';
import { Logger, LogSink } from '../lib/log';
import { friendbotKeypairs } from '../ledger/genesis';
import { createGenesisLedger } from '../ledger/manager';
import { makeSignedStellarValue } from '../ledger/value';
import { Overlay } from '../overlay/overlay';
import type { RequestBody, ResponseBody } from '../overlay/types';
import { Simulation } from './simulation';

/** The liars' branch ends at this ledger (a long span: the clamp allowed a large weight). */
const FAKE_LCL = 40;

/**
 * Three honest validators, then `identities` new ones that announce a valid
 * branch forked after genesis, serve it, and claim a huge branch weight.
 */
async function sybilBranch(seed: number, identities: number, lateJoiner = false) {
  const sim = new Simulation({ seed, latency: [10, 60] });
  const nodes = await sim.addNodes(['a', 'b', 'c'].map((name) => ({ name })));
  expect(await sim.waitForLedger(6, 60_000)).toBe(true);
  if (lateJoiner) {
    // g saw its first member long after the fork point: its first members vouch
    nodes.push(await sim.addNode({ name: 'g' }));
    expect(await sim.runUntil(() => nodes[3].state === 'synced' && nodes.every((n) => n.lcl >= 10), 60_000)).toBe(true);
  }
  const pass = nodes[0].node!.passphrase;
  const victim = Keypair.fromRawEd25519Seed(sha256(`sybil-fork|victim|${seed}`));
  expect((await nodes[0].node!.friendbot(victim.publicKey())).status).toBe('PENDING');
  expect(await sim.runUntil(() => nodes.every((n) => n.node!.ledger.getAccount(victim.publicKey()) !== undefined), 60_000)).toBe(true);
  const funded = nodes[0].node!.ledger.getAccount(victim.publicKey())!.balance;

  // the friendbot channel that funded the victim: the liars spend its sequence number again
  const [funding] = await nodes[0].storage.getTxsByAccount(victim.publicKey(), 1);
  const channel = friendbotKeypairs(pass).find((k) => k.publicKey() === funding.sourceAccount)!;
  expect(channel).toBeDefined();
  const evil = Keypair.fromRawEd25519Seed(sha256(`sybil-fork|evil|${seed}`));
  const steal = new TransactionBuilder(new Account(channel.publicKey(), '0'), { fee: '100', networkPassphrase: pass })
    .addOperation(Operation.createAccount({ destination: evil.publicKey(), startingBalance: '10000' }))
    .setTimeout(0)
    .build();
  steal.sign(channel);

  const keys = Array.from({ length: identities }, (_, i) => Keypair.fromRawEd25519Seed(sha256(`sybil-fork|liar|${seed}|${i}`)));
  const lm = createGenesisLedger(pass);
  const ledgers = new Map<number, { headerXdr: string; txSetXdr: string }>([[1, { headerXdr: lm.lastClosed().headerXdr, txSetXdr: '' }]]);
  while (lm.lastClosed().header.ledgerSeq < FAKE_LCL) {
    const prev = lm.lastClosed();
    const txSet = lm.makeTxSet(prev.hash, prev.header.ledgerSeq === 1 ? [steal.toEnvelope().toXdr('base64')] : []);
    const r = lm.closeLedger(txSet, makeSignedStellarValue(lm.networkId, keys[0], txSet.hash, prev.header.scpValue.closeTime + 1));
    if (prev.header.ledgerSeq === 1) expect(r.results.map((x) => x.resultCode)).toEqual(['txSUCCESS']);
    ledgers.set(r.header.ledgerSeq, { headerXdr: r.headerXdr, txSetXdr: txSet.xdr });
  }
  const target = { seq: FAKE_LCL, hash: lm.lastClosed().hash };
  const answer = (b: RequestBody): ResponseBody | null => {
    if (b.kind === 'branchWeight') return { kind: 'branchWeight', afterSeq: b.afterSeq, weight: 1_000_000, lcl: target };
    if (b.kind !== 'headers' && b.kind !== 'ledgers') return null;
    const items = [];
    for (let s = Math.max(1, b.from); s <= Math.min(b.to, b.from + 63, FAKE_LCL); s++) items.push({ seq: s, ...ledgers.get(s)! });
    return b.kind === 'headers'
      ? { kind: 'headers', items: items.map((i) => ({ seq: i.seq, headerXdr: i.headerXdr })) }
      : { kind: 'ledgers', items: items.filter((i) => i.seq > 1) };
  };
  const liars = keys.map(
    (kp, i) =>
      new Overlay({
        keypair: kp,
        networkId: nodes[0].node!.networkIdHex,
        name: `liar${i}`,
        clock: sim.clock,
        logger: new Logger(new LogSink(sim.clock, 'error'), `liar${i}`),
        transports: [sim.net.createTransport(`liar${i}`)],
        handlers: { onStellarMessage: () => false, onRequest: answer },
        announcement: { lcl: target, state: 'synced', validator: true, qsetHash: '', quorumMode: 'auto' },
      }),
  );
  const before = new Map(nodes[0].chain);
  for (const ov of liars) ov.start();
  const stop = async () => {
    for (const ov of liars) ov.stop();
    await sim.shutdown();
  };
  return { sim, nodes, victim, funded, evil, liars, keys, target, before, stop };
}

describe('fork verdicts count only validators known before the fork point', () => {
  for (const [seed, identities] of [
    [641, 2],
    [1, 2],
    [2, 2],
    [3, 4],
  ] as const) {
    it(`${identities} new identities with a longer, valid branch forked after genesis do not make a 3-node quorum roll back (seed ${seed})`, async () => {
      const { sim, nodes, victim, funded, evil, keys, before, stop } = await sybilBranch(seed, identities);
      const h0 = Math.max(...before.keys());
      await sim.run(90_000);
      for (const n of nodes) {
        expect(
          n.forks.filter((f) => f.resolution === 'rolled-back').map((f) => `${f.atSeq}:${f.rolledBackLedgers}`),
          `${n.name} rollbacks`,
        ).toEqual([]);
        for (let s = 2; s <= h0; s++) expect(n.chain.get(s), `${n.name} ledger ${s}`).toBe(before.get(s));
        expect(n.node!.ledger.getAccount(evil.publicKey()), `${n.name} liars' account`).toBeUndefined();
        expect(n.node!.ledger.getAccount(victim.publicKey())?.balance, `${n.name} victim balance`).toBe(funded);
      }
      // the fork was seen and decided for the quorum
      const liarIds = new Set(keys.map((k) => k.publicKey()));
      expect(nodes.some((n) => n.forks.some((f) => liarIds.has(f.peer) && f.resolution === 'kept-ours'))).toBe(true);
      // the quorum went on as one chain
      expect(Math.min(...nodes.map((n) => n.lcl))).toBeGreaterThanOrEqual(h0 + 10);
      expect(sim.conflicts(nodes)).toEqual([]);
      await stop();
    });
  }

  it('a validator that joined after the fork point is not moved either: the members it saw first vouch for its chain', async () => {
    const { sim, nodes, victim, funded, evil, before, stop } = await sybilBranch(4, 6, true);
    const g = nodes[3];
    expect(g.node!.quorum.earliestMemberSince()).toBeGreaterThan(1);
    const h0 = Math.max(...before.keys());
    await sim.run(90_000);
    for (const n of nodes) {
      expect(n.forks.filter((f) => f.resolution === 'rolled-back'), `${n.name} rollbacks`).toEqual([]);
      for (let s = 2; s <= h0; s++) expect(n.chain.get(s), `${n.name} ledger ${s}`).toBe(before.get(s));
      expect(n.node!.ledger.getAccount(evil.publicKey()), `${n.name} liars' account`).toBeUndefined();
      expect(n.node!.ledger.getAccount(victim.publicKey())?.balance, `${n.name} victim balance`).toBe(funded);
    }
    expect(g.forks.some((f) => f.resolution === 'kept-ours')).toBe(true);
    expect(sim.conflicts(nodes)).toEqual([]);
    await stop();
  });
});
