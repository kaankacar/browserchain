// Friendbot under a starvation attack (ARCHITECTURE 7.5, 10.2, 10.3). The
// channel keys are public: an attacker signs valid channel transactions and
// keeps the 16-slot friendbot lane full every ledger, with low envelope
// hashes that win the lane's deterministic rule. Two defences: transactions
// from peers hold at most 4 of a channel's 16 queue slots (the rest is kept
// for this node's own requests), and when a node builds its tx set, its own
// friendbot transactions come first in the lane. So a node's queued
// friendbot requests are in every ledger whose tx set that node built.

import { Account, Keypair, Operation, TransactionBuilder } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { MAX_FRIENDBOT_TXS_IN_TX_SET } from '../lib/constants';
import { sha256 } from '../lib/hash';
import { Logger, LogSink } from '../lib/log';
import { usesChannel } from '../ledger/channelPolicy';
import { friendbotChannelIds, friendbotKeypairs } from '../ledger/genesis';
import { decodeLedgerHeader } from '../ledger/header';
import { tryDecodeTransaction } from '../ledger/tx';
import { Overlay } from '../overlay/overlay';
import { makeTransactionMessage } from '../overlay/stellarMessage';
import { Simulation, type SimNode } from './simulation';

/**
 * After every new ledger, sign CreateAccounts on every channel for its next
 * 4 sequence numbers (the most a peer may queue per channel), keeping the
 * lower envelope hash of two tries, and flood them.
 */
function laneAttacker(sim: Simulation, view: SimNode): { ov: Overlay; floods: () => number } {
  const node = view.node!;
  const pass = node.passphrase;
  const channels = friendbotKeypairs(pass);
  let lastLcl = 0;
  let n = 0;
  let sent = 0;
  const sign = (ch: Keypair, seq: bigint): string => {
    const dest = Keypair.fromRawEd25519Seed(sha256(`lane-attack|dest|${n++}`)).publicKey();
    const tx = new TransactionBuilder(new Account(ch.publicKey(), (seq - 1n).toString()), { fee: '100', networkPassphrase: pass })
      .addOperation(Operation.createAccount({ destination: dest, startingBalance: '10000' }))
      .setTimeout(0)
      .build();
    tx.sign(ch);
    return tx.toEnvelope().toXdr('base64');
  };
  const flood = (ov: Overlay) => {
    const lm = view.node!.ledger;
    for (const ch of channels) {
      const acc = lm.getAccount(ch.publicKey());
      if (!acc) continue;
      for (let i = 1n; i <= 4n; i++) {
        const tries = [sign(ch, acc.seqNum + i), sign(ch, acc.seqNum + i)];
        const hash = (env: string) => tryDecodeTransaction(env, lm.networkId)!.fullHashHex;
        ov.floodStellar(makeTransactionMessage(hash(tries[0]) < hash(tries[1]) ? tries[0] : tries[1]));
        sent++;
      }
    }
  };
  const lcl = node.ledger.lastClosed();
  const ov: Overlay = new Overlay({
    keypair: Keypair.fromRawEd25519Seed(sha256('lane-attack|key')),
    networkId: node.networkIdHex,
    name: 'attacker',
    clock: sim.clock,
    logger: new Logger(new LogSink(sim.clock, 'error'), 'attacker'),
    transports: [sim.net.createTransport('attacker')],
    handlers: {
      onStellarMessage: () => false,
      onRequest: () => null,
      onPeerStatus: (p) => {
        if (p.ann.lcl.seq <= lastLcl) return;
        lastLcl = p.ann.lcl.seq;
        // after the new ledger is closed everywhere (statuses go out when it closes)
        sim.clock.setTimeout(() => flood(ov), 50);
      },
    },
    announcement: { lcl: { seq: lcl.header.ledgerSeq, hash: lcl.hash }, state: 'synced', validator: false, qsetHash: '', quorumMode: 'auto' },
  });
  ov.start();
  return { ov, floods: () => sent };
}

/**
 * The first ledger that `n` closed by consensus with a tx set it built itself
 * (it signed the StellarValue), and whose slot it nominated after `t`: its
 * previous ledger closed after `t`, and the trigger comes after that.
 */
function firstOwnLedgerAfter(n: SimNode, t: number): number | null {
  const closes = n.consensusCloses();
  for (const c of closes) {
    const prev = closes.find((x) => x.seq === c.seq - 1);
    if (!prev || prev.at < t) continue;
    const l = n.node!.chain.recentLedger(c.seq);
    if (l && l.hash === c.hash && decodeLedgerHeader(l.headerXdr).scpValue.signature?.nodeId === n.nodeId) return c.seq;
  }
  return null;
}

describe('simulation: friendbot under a lane starvation attack', () => {
  it("a node's own friendbot requests are in every ledger whose tx set it built", async () => {
    const sim = new Simulation({ seed: 901, latency: [10, 60] });
    const [a, b, c] = await sim.addNodes(['a', 'b', 'c'].map((name) => ({ name })));
    expect(await sim.waitForLedger(4, 60_000)).toBe(true);
    const attack = laneAttacker(sim, a);
    // let the attacker fill every channel's peer slots first
    await sim.run(12_000);
    const requests: { user: string; at: number }[] = [];
    for (let i = 0; i < 4; i++) {
      await sim.run(2_500 + i * 1_300);
      const user = Keypair.fromRawEd25519Seed(sha256(`lane-attack|user|${i}`)).publicKey();
      const r = await a.node!.friendbot(user);
      expect(r.status, `${r.errorResultCode} ${r.errorDetail}`).toBe('PENDING');
      requests.push({ user, at: sim.clock.now() });
      await sim.run(9_000);
    }
    // for each request: the first ledger built from a's own tx set after it holds it (or an earlier one did)
    for (const req of requests) {
      expect(await sim.runUntil(() => firstOwnLedgerAfter(a, req.at) !== null, 120_000)).toBe(true);
      const L = firstOwnLedgerAfter(a, req.at)!;
      await a.node!.chain.flush();
      const [funding] = await a.storage.getTxsByAccount(req.user, 1);
      expect(funding, `request for ${req.user.slice(0, 8)} funded`).toBeDefined();
      expect(funding.ledgerSeq, `request at ${req.at}: funded by ledger ${funding.ledgerSeq}, a built ledger ${L}`).toBeLessThanOrEqual(L);
    }
    // the attack was real: the lane was full in most ledgers, mostly with the attacker's txs
    const channels = friendbotChannelIds(a.node!.passphrase);
    const recent = await a.storage.getLedgers(a.lcl - 15, a.lcl);
    let full = 0;
    for (const l of recent) {
      const txSet = a.node!.ledger.decodeTxSet(l.txSetXdr);
      const lane = txSet.txs.filter((env) => usesChannel(tryDecodeTransaction(env, a.node!.ledger.networkId)!, channels)).length;
      if (lane === MAX_FRIENDBOT_TXS_IN_TX_SET) full++;
    }
    expect(full, 'ledgers with a full friendbot lane').toBeGreaterThanOrEqual(12);
    expect(attack.floods()).toBeGreaterThan(500);
    expect(sim.historyConflicts([a, b, c])).toEqual([]);
    attack.ov.stop();
    await sim.shutdown();
  });
});
