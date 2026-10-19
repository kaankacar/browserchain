import { Asset, Keypair, Operation } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { ZERO_HASH } from '../lib/bytes';
import { VirtualClock } from '../lib/clock';
import { LEDGER_TARGET_CLOSE_MS, MAX_FRIENDBOT_TXS_IN_TX_SET, networkPassphrase } from '../lib/constants';
import { sha256 } from '../lib/hash';
import { LogSink, Logger } from '../lib/log';
import { seededRng } from '../lib/random';
import { friendbotKeypairs } from '../ledger/genesis';
import { createGenesisLedger, type LedgerManager } from '../ledger/manager';
import { TestLedger } from '../ledger/testkit';
import { tryDecodeTransaction } from '../ledger/tx';
import type { LedgerCloseResult } from '../ledger/types';
import { encodeStellarValue, makeSignedStellarValue } from '../ledger/value';
import {
  makeGetScpQuorumSetMessage,
  makeGetTxSetMessage,
  makeScpMessage,
  makeTransactionMessage,
  parseStellarMessage,
} from '../overlay/stellarMessage';
import type { PeerInfo } from '../overlay/types';
import type { Envelope } from '../scp/types';
import { envelopeToBase64, envelopeToXdr, hashQuorumSet, signEnvelope } from '../scp/xdr';
import { Herder } from './herder';
import { QuorumManager } from './quorumManager';
import type { CloseMeta, HerderNet } from './types';

const PASS = networkPassphrase('herder-test');
const key = (i: number) => Keypair.fromRawEd25519Seed(sha256(`herder-test-${i}`));

function peerInfo(kp: Keypair, lcl = { seq: 1, hash: ZERO_HASH }): PeerInfo {
  const nodeId = kp.publicKey();
  return {
    nodeId,
    name: nodeId.slice(0, 4),
    transports: ['memory'],
    ann: { nodeId, name: '', networkId: '0'.repeat(64), appVersion: 1, lcl, state: 'synced', validator: true, qsetHash: '', quorumMode: 'auto', ts: 1 },
    connectedAt: 0,
    lastSeen: 0,
    latencyMs: null,
  };
}

function setup(opts: { peers?: Keypair[]; validating?: boolean } = {}) {
  const clock = new VirtualClock(1_790_000_000_000);
  const self = key(0);
  let lm: LedgerManager = createGenesisLedger(PASS);
  const floods: string[] = [];
  const sends: { to: string; msg: string }[] = [];
  const closed: { result: LedgerCloseResult; meta: CloseMeta }[] = [];
  const behind: { slot: number; nodes: string[] }[] = [];
  const peers = (opts.peers ?? []).map((k) => peerInfo(k));
  const net: HerderNet = {
    floodStellar: (x) => floods.push(x),
    sendStellar: (to, msg) => sends.push({ to, msg }),
    request: () => Promise.reject(new Error('offline')),
    peers: () => peers,
  };
  const quorum = new QuorumManager({ selfId: self.publicKey(), selfName: 'self', clock, validating: opts.validating });
  const herder: Herder = new Herder({
    keypair: self,
    clock,
    logger: new Logger(new LogSink(clock, 'error'), 'h'),
    net,
    quorum,
    rng: seededRng(1),
    validating: opts.validating,
    host: {
      ledger: () => lm,
      ledgerClosed: (result, meta) => {
        closed.push({ result, meta });
        quorum.setLocalChain({ seq: result.header.ledgerSeq, hash: result.hash }, result.header.previousLedgerHash);
        herder.afterLedgerClosed(result, meta);
      },
      behind: (info) => behind.push(info),
      externalizedMismatch: () => undefined,
      nodeName: (id) => id.slice(0, 4),
    },
  });
  const kinds = () => floods.map((f) => parseStellarMessage(f).kind);
  return { clock, self, herder, quorum, floods, sends, closed, behind, kinds, peers, lm: () => lm, setLm: (x: LedgerManager) => (lm = x) };
}

function signedEnvelope(kp: Keypair, env: Envelope): Envelope {
  signEnvelope(env, kp, createGenesisLedger(PASS).networkId);
  return env;
}

describe('Herder as a solo validator', () => {
  it('nominates when synced, externalizes alone and schedules the next ledger', async () => {
    const t = setup();
    t.herder.start();
    t.herder.setSynced(true);
    await t.clock.advance(999);
    expect(t.closed.length).toBe(0);
    await t.clock.advance(10);
    expect(t.closed.length).toBe(1);
    expect(t.closed[0].meta).toEqual({ source: 'consensus', externalizedBy: 1 });
    expect(t.closed[0].result.header.ledgerSeq).toBe(2);
    expect(t.kinds()).toContain('txSet');
    expect(t.kinds()).toContain('scpMessage');
    await t.clock.advance(LEDGER_TARGET_CLOSE_MS);
    expect(t.closed.length).toBe(2);
    expect(t.closed[1].result.header.scpValue.closeTime).toBeGreaterThan(t.closed[0].result.header.scpValue.closeTime);
    expect(t.herder.slotExternalized(2)).not.toBeNull();
    t.herder.stop();
  });

  it('includes queued transactions and reports their status', async () => {
    const t = setup();
    const statuses: string[] = [];
    t.herder.events.on('txStatus', (e) => statuses.push(`${e.status}:${e.resultCode ?? ''}`));
    const tl = new TestLedger(t.lm(), PASS);
    const channel = friendbotKeypairs(PASS)[0];
    const env = tl.tx(channel, [Operation.payment({ destination: tl.root.publicKey(), asset: Asset.native(), amount: '10000' })]); // channel policy: FRIENDBOT_AMOUNT only
    const r = t.herder.submitTransaction(env);
    expect(r.status).toBe('PENDING');
    expect(t.kinds()).toEqual(['transaction']);
    expect(t.herder.submitTransaction(env).status).toBe('DUPLICATE');
    const bad = t.herder.submitTransaction(tl.tx(channel, [Operation.payment({ destination: tl.root.publicKey(), asset: Asset.native(), amount: '10000' })], { seqOffset: 5n }));
    expect(bad).toMatchObject({ status: 'ERROR', errorResultCode: 'txBAD_SEQ' });
    t.herder.setSynced(true);
    await t.clock.advance(1100);
    expect(t.closed[0].result.results.map((x) => x.hash)).toEqual([r.hash]);
    expect(statuses).toEqual(['pending:', 'applied:txSUCCESS']);
    expect(t.herder.txQueue.size()).toBe(0);
  });

  it('closes a ledger that SCP externalized while it was paused, once synced again', async () => {
    // Review: a catch-up that started right after SCP externalized LCL+1,
    // before the deferred close ran, dropped the close. Synced again, the
    // trigger saw the slot externalized and did nothing: a lone validator
    // stopped for good.
    const t = setup();
    t.herder.start();
    let paused = false;
    t.herder.events.on('externalized', () => {
      if (paused) return;
      paused = true;
      t.herder.setSynced(false);
    });
    t.herder.setSynced(true);
    await t.clock.advance(1_100);
    expect(paused).toBe(true);
    expect(t.closed.length).toBe(0);
    t.herder.setSynced(true);
    await t.clock.advance(10);
    expect(t.closed.map((c) => c.result.header.ledgerSeq)).toEqual([2]);
    expect(t.closed[0].meta.source).toBe('consensus');
    await t.clock.advance(LEDGER_TARGET_CLOSE_MS + 100);
    expect(t.closed.map((c) => c.result.header.ledgerSeq)).toEqual([2, 3]);
    t.herder.stop();
  });

  it('does not nominate while not synced or when watching', async () => {
    const t = setup({ validating: false });
    t.herder.start();
    t.herder.setSynced(true);
    await t.clock.advance(20_000);
    expect(t.closed.length).toBe(0);
    expect(t.herder.scheduledTrigger()).toBeNull();
    t.herder.setValidating(true);
    await t.clock.advance(100);
    expect(t.closed.length).toBe(1);
    t.herder.setSynced(false);
    await t.clock.advance(20_000);
    expect(t.closed.length).toBe(1);
  });
});

describe('Herder envelope intake', () => {
  it('drops bad signatures, own envelopes and slots out of range; buffers future slots', () => {
    const peer = key(1);
    const t = setup({ peers: [peer] });
    t.herder.setSynced(true);
    const lm = t.lm();
    const ts = lm.makeTxSet(lm.lastClosed().hash, []);
    const v = encodeStellarValue(makeSignedStellarValue(lm.networkId, peer, ts.hash, 1_790_000_001));
    const nom = (slot: number, kp = peer): Envelope =>
      signedEnvelope(kp, {
        statement: { nodeId: kp.publicKey(), slotIndex: slot, pledges: { type: 'nominate', quorumSetHash: hashQuorumSet({ threshold: 1, validators: [kp.publicKey()], innerSets: [] }), votes: [v], accepted: [] } },
        signature: '',
      });
    const events: string[] = [];
    t.herder.events.on('envelope', (e) => events.push(`${e.direction}:${e.slot}`));
    const good = nom(2);
    const forged = { ...good, signature: nom(3).signature };
    expect(t.herder.receiveEnvelope(forged, envelopeToBase64(forged), peer.publicKey())).toBe(false);
    expect(t.herder.receiveEnvelope(nom(2, t.self), envelopeToBase64(nom(2, t.self)), peer.publicKey())).toBe(false);
    expect(t.herder.receiveEnvelope(nom(500), envelopeToBase64(nom(500)), peer.publicKey())).toBe(false);
    expect(events).toEqual([]);
    expect(t.herder.receiveEnvelope(good, envelopeToBase64(good), peer.publicKey())).toBe(true);
    expect(t.herder.receiveEnvelope(good, envelopeToBase64(good), peer.publicKey())).toBe(false);
    expect(events).toEqual(['in:2']);
    // its tx set and quorum set are unknown: fetched from the sender
    const asked = t.sends.map((s) => parseStellarMessage(s.msg).kind);
    expect(asked).toContain('getScpQuorumset');
    expect(asked).toContain('getTxSet');
    const future = nom(5);
    expect(t.herder.receiveEnvelope(future, envelopeToBase64(future), peer.publicKey())).toBe(true);
    expect(t.herder.onStellarMessage(makeScpMessage(envelopeToXdr(nom(6))), t.peers[0])).toBe(true);
    expect(t.quorum.get(peer.publicKey())?.lastSlot).toBe(6);
  });

  it('ignores nominations whose values build on another ledger', () => {
    const peer = key(2);
    const t = setup({ peers: [peer] });
    t.herder.setSynced(true);
    const lm = t.lm();
    const other = lm.makeTxSet('ab'.repeat(32), []);
    t.herder.pending.addTxSet(other, { force: true, slot: 2 });
    const qs = { threshold: 1, validators: [peer.publicKey()], innerSets: [] };
    t.herder.pending.addQSet(qs);
    const v = encodeStellarValue(makeSignedStellarValue(lm.networkId, peer, other.hash, 1_790_000_001));
    const env = signedEnvelope(peer, {
      statement: { nodeId: peer.publicKey(), slotIndex: 2, pledges: { type: 'nominate', quorumSetHash: hashQuorumSet(qs), votes: [v], accepted: [] } },
      signature: '',
    });
    expect(t.herder.receiveEnvelope(env, envelopeToBase64(env), peer.publicKey())).toBe(true);
    expect(t.herder.scp.getSlotInfo(2)?.latestStatements ?? []).toEqual([]);
    // the same nomination on our ledger is fed to SCP
    const mine = lm.makeTxSet(lm.lastClosed().hash, []);
    t.herder.pending.addTxSet(mine);
    const v2 = encodeStellarValue(makeSignedStellarValue(lm.networkId, peer, mine.hash, 1_790_000_002));
    const env2 = signedEnvelope(peer, {
      statement: { nodeId: peer.publicKey(), slotIndex: 2, pledges: { type: 'nominate', quorumSetHash: hashQuorumSet(qs), votes: [v2], accepted: [] } },
      signature: '',
    });
    expect(t.herder.receiveEnvelope(env2, envelopeToBase64(env2), peer.publicKey())).toBe(true);
    expect(t.herder.scp.getSlotInfo(2)?.latestStatements.map((s) => s.nodeId)).toEqual([peer.publicKey()]);
  });

  it('reports being behind when several validators work on later slots', () => {
    const p1 = key(3);
    const p2 = key(4);
    const t = setup({ peers: [p1, p2] });
    t.herder.setSynced(true);
    const lm = t.lm();
    const ts = lm.makeTxSet(ZERO_HASH, []);
    t.herder.pending.addTxSet(ts, { force: true, slot: 9 });
    for (const kp of [p1, p2]) {
      const qs = { threshold: 1, validators: [kp.publicKey()], innerSets: [] };
      t.herder.pending.addQSet(qs);
      const v = encodeStellarValue(makeSignedStellarValue(lm.networkId, kp, ts.hash, 1_790_000_100));
      const env = signedEnvelope(kp, {
        statement: { nodeId: kp.publicKey(), slotIndex: 9, pledges: { type: 'nominate', quorumSetHash: hashQuorumSet(qs), votes: [v], accepted: [] } },
        signature: '',
      });
      t.herder.receiveEnvelope(env, envelopeToBase64(env), kp.publicKey());
    }
    expect(t.behind.length).toBe(1);
    expect(t.behind[0].slot).toBe(9);
    expect(t.behind[0].nodes.sort()).toEqual([p1.publicKey(), p2.publicKey()].sort());
    expect(t.herder.pending.bufferedSlots()).toEqual([9]);
  });
});

describe('Herder answers', () => {
  it('serves tx sets, quorum sets and SCP state, with DONT_HAVE for unknown items', async () => {
    const peer = key(5);
    const t = setup({ peers: [peer] });
    t.herder.start();
    t.herder.setSynced(true);
    await t.clock.advance(1100);
    const from = t.peers[0];
    const txSetHash = t.closed[0].result.txSet.hash;
    t.herder.onStellarMessage(makeGetTxSetMessage(txSetHash), from);
    t.herder.onStellarMessage(makeGetTxSetMessage('11'.repeat(32)), from);
    t.herder.onStellarMessage(makeGetScpQuorumSetMessage(t.herder.scp.getLocalQuorumSetHash()), from);
    t.herder.onStellarMessage(makeGetScpQuorumSetMessage('22'.repeat(32)), from);
    const replies = t.sends.filter((s) => s.to === peer.publicKey()).map((s) => parseStellarMessage(s.msg));
    expect(replies.map((r) => r.kind)).toEqual(['txSet', 'dontHave', 'scpQuorumset', 'dontHave']);
    const state = t.herder.answerScpState(2);
    expect(state.length).toBeGreaterThan(0);
    expect(t.herder.answerScpState(3)).toEqual([]);
    // a new peer gets our latest envelopes directly
    const before = t.sends.length;
    t.herder.onPeerConnected(from);
    expect(t.sends.length).toBeGreaterThan(before);
    t.herder.stop();
  });

  it('re-floods its latest envelopes every 2 s while synced', async () => {
    const t = setup();
    t.herder.start();
    t.herder.setSynced(true);
    await t.clock.advance(1100);
    const n = t.floods.length;
    await t.clock.advance(2000);
    expect(t.floods.length).toBeGreaterThan(n);
    t.herder.stop();
    const m = t.floods.length;
    await t.clock.advance(10_000);
    expect(t.floods.length).toBe(m);
  });

  it('lets an emit interceptor take over flooding', async () => {
    const t = setup();
    const seen: string[] = [];
    const h = new Herder({
      keypair: key(9),
      clock: t.clock,
      logger: new Logger(new LogSink(t.clock, 'error'), 'x'),
      net: { floodStellar: () => seen.push('flood'), sendStellar: () => undefined, request: () => Promise.reject(new Error()), peers: () => [] },
      quorum: new QuorumManager({ selfId: key(9).publicKey(), selfName: 'x', clock: t.clock }),
      rng: seededRng(2),
      host: { ledger: () => t.lm(), ledgerClosed: () => undefined, behind: () => undefined, externalizedMismatch: () => undefined, nodeName: () => '' },
      emitInterceptor: (env) => {
        seen.push(env.statement.pledges.type);
        return true;
      },
    });
    h.setSynced(true);
    await t.clock.advance(1100);
    expect(seen[0]).toBe('flood'); // the tx set
    expect(seen.slice(1)).toContain('nominate');
    expect(seen.slice(1).every((s) => s !== 'flood')).toBe(true);
  });
});

describe('Herder friendbot lane', () => {
  /**
   * Channel txs of this node and of an attacker. The channel keys are
   * public: the attacker signs valid CreateAccounts on every channel and
   * picks the ones with the lowest envelope hashes, so it wins the lane's
   * deterministic rule (the lowest hashes among the account heads).
   */
  function laneAttack(t: ReturnType<typeof setup>) {
    const lm = t.lm();
    const tl = new TestLedger(lm, PASS);
    const channels = friendbotKeypairs(PASS);
    const fullHash = (env: string) => tryDecodeTransaction(env, lm.networkId)!.fullHashHex;
    let n = 0;
    const create = (ch: Keypair, seqOffset: bigint, ok: (hash: string) => boolean): string => {
      for (;;) {
        const dest = Keypair.fromRawEd25519Seed(sha256(`lane-dest-${n++}`)).publicKey();
        const env = tl.tx(ch, [Operation.createAccount({ destination: dest, startingBalance: '10000' })], { seqOffset });
        if (ok(fullHash(env))) return env;
      }
    };
    // ours: a request on channel 1 (its head), and one on channel 0 behind 4 attacker txs there
    const own1 = create(channels[1], 0n, (h) => h >= 'e0');
    const lowest = (h: string) => h < 'c0';
    const attack0 = [0n, 1n, 2n, 3n].map((i) => create(channels[0], i, lowest));
    const own0 = create(channels[0], 4n, (h) => h >= 'e0');
    // 4 txs on each of channels 2..15: 56 heads and followers below every hash of ours
    const attack = channels.slice(2).flatMap((ch) => [0n, 1n, 2n, 3n].map((i) => create(ch, i, lowest)));
    const relay = (env: string) => t.herder.onStellarMessage(makeTransactionMessage(env), t.peers[0]);
    return { own: [own0, own1], attack0, attack, relay, fullHash };
  }

  it('puts its own friendbot txs first in the lane when it builds its tx set, then the lowest hashes', async () => {
    const t = setup({ peers: [key(11)] });
    const { own, attack0, attack, relay, fullHash } = laneAttack(t);
    for (const env of [...attack0, ...attack]) expect(relay(env)).toBe(true);
    const ownHashes = own.map((env) => t.herder.submitTransaction(env)).map((r) => {
      expect(r.status).toBe('PENDING');
      return r.hash;
    });
    t.herder.start();
    t.herder.setSynced(true);
    await t.clock.advance(1_100);
    expect(t.closed.length).toBe(1);
    const applied = t.closed[0].result.results;
    const appliedHashes = applied.map((r) => r.hash);
    // the lane is full, and both of our requests are in it, with the 4 txs ours needs on channel 0
    expect(applied.length).toBe(MAX_FRIENDBOT_TXS_IN_TX_SET);
    for (const h of ownHashes) expect(appliedHashes).toContain(h);
    const byEnvelope = new Set(applied.map((r) => r.envelopeXdr));
    for (const env of attack0) expect(byEnvelope.has(env)).toBe(true);
    expect(applied.every((r) => r.successful)).toBe(true);
    // the other 10 slots follow the deterministic rule: account heads, lowest envelope hash first
    const rest = attack.filter((env) => byEnvelope.has(env));
    expect(rest.length).toBe(MAX_FRIENDBOT_TXS_IN_TX_SET - 6);
    const firstOfEachChannel = (envs: string[]) => envs.filter((_, i) => i % 4 === 0);
    const lowestHeads = firstOfEachChannel(attack)
      .map((env) => fullHash(env))
      .sort()
      .slice(0, 1);
    expect(rest.map(fullHash)).toContain(lowestHeads[0]);
    t.herder.stop();
  });

  it('without its own friendbot txs it builds the same tx set as before (lowest hashes)', async () => {
    const t = setup({ peers: [key(12)] });
    const { attack0, attack, relay } = laneAttack(t);
    for (const env of [...attack0, ...attack]) relay(env);
    const lm = t.lm();
    const expected = lm.trimInvalid(t.herder.txQueue.envelopes(), Math.floor(t.clock.now() / 1000) + 1).valid;
    t.herder.start();
    t.herder.setSynced(true);
    await t.clock.advance(1_100);
    expect(t.closed.length).toBe(1);
    expect(t.closed[0].result.results.map((r) => r.envelopeXdr).sort()).toEqual([...expected].sort());
    t.herder.stop();
  });
});

describe('Herder quorum policy', () => {
  it('removes a departed validator from the quorum set right after its bye', async () => {
    const peer = key(6);
    const t = setup({ peers: [peer] });
    const reasons: string[] = [];
    t.herder.events.on('quorum', (e) => reasons.push(e.reason));
    t.quorum.noteStatus(t.peers[0]);
    t.herder.start();
    t.herder.setSynced(true);
    expect(t.herder.scp.getLocalQuorumSet().validators.length).toBe(2);
    t.quorum.noteDisconnected(peer.publicKey(), true);
    expect(t.herder.checkDepartures()).toBe(true);
    expect(t.herder.scp.getLocalQuorumSet()).toEqual({ threshold: 1, validators: [t.self.publicKey()], innerSets: [] });
    expect(reasons[reasons.length - 1]).toMatch(/departure/);
    await t.clock.advance(1100);
    expect(t.closed.length).toBe(1);
    t.herder.stop();
  });

  it('waits for a stalled slot before removing a silent validator', async () => {
    const peer = key(7);
    const t = setup({ peers: [peer] });
    t.quorum.noteStatus(t.peers[0]);
    t.herder.start();
    t.herder.setSynced(true);
    await t.clock.advance(1100);
    // nominated, but the peer never answers: no ledger
    expect(t.closed.length).toBe(0);
    // still active (heard within VALIDATOR_ACTIVE_MS): nothing changes
    expect(t.herder.checkDepartures()).toBe(false);
    await t.clock.advance(9_000);
    // silent for 9 s and the slot is stuck: it leaves the quorum set, the slot completes
    await t.clock.advance(2_000);
    expect(t.herder.scp.getLocalQuorumSet().validators).toEqual([t.self.publicKey()]);
    expect(t.closed.length).toBeGreaterThanOrEqual(1);
    t.herder.stop();
  });
});
