// End to end with real nodes: an attacker in the WebRTC room collects the
// hellos and statuses that validators B and C send it, replays them to A on
// its own link, and then says bye in their names. Without replay protection A
// drops B and C (a bye takes them out of A's auto quorum at once), closes
// ledgers alone and forks from B and C. With per-link nonces the replayed
// frames bind nothing and the byes are ignored.
//
// An active relay goes further: it asks B for a fresh hello that covers A's
// nonce for the relay's own link and forwards it. Hellos sign the id of the
// secure channel they were made for (WebRTC: both DTLS certificate
// fingerprints; here the memory link), so the relayed hello does not bind.
// Before that, the relay bound its links as the other validators, became each
// one's preferred link and dropped all consensus traffic: no ledger closed.

import { Keypair } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { VirtualClock } from '../lib/clock';
import { sha256 } from '../lib/hash';
import { LogSink } from '../lib/log';
import { Node } from '../node/node';
import { MemoryStorage } from '../storage/memoryStorage';
import { MemoryNetwork } from './memoryNetwork';
import type { NodeAnnouncement, WireMessage } from './types';

function secret(i: number): string {
  return Keypair.fromRawEd25519Seed(sha256(`replay-attack-node-${i}`)).secret();
}

async function threeValidators(seed: number) {
  const clock = new VirtualClock();
  const net = new MemoryNetwork({ clock, seed, latencyMs: () => 20 });
  const nodes = ['a', 'b', 'c'].map(
    (name, i) =>
      new Node({
        transports: [net.createTransport(name, { kind: 'webrtc' })],
        storage: new MemoryStorage(),
        clock,
        networkName: 'replay-attack',
        name,
        secret: secret(i),
        logSink: new LogSink(clock, 'warn'),
      }),
  );
  for (const n of nodes) await n.start();
  const lcl = (n: Node) => n.ledger.lastClosed().header.ledgerSeq;
  expect(await clock.runUntil(() => nodes.every((n) => n.state === 'synced' && lcl(n) >= 4), 120_000)).toBe(true);
  return { clock, net, nodes, lcl };
}

async function expectOneChain(nodes: Node[], lcl: (n: Node) => number, after: number): Promise<void> {
  const top = Math.min(...nodes.map(lcl));
  expect(top).toBeGreaterThan(after + 4);
  for (let seq = 2; seq <= top; seq++) {
    const hashes = await Promise.all(nodes.map((n) => n.chain.hashAtAsync(seq)));
    expect(new Set(hashes).size, `ledger ${seq}: ${hashes.map((h) => h?.slice(0, 8)).join(' ')}`).toBe(1);
  }
}

/** Node id the overlay of `n` binds its link to transport peer `tpeer` to (white-box; transport 0). */
function linkNode(n: Node, tpeer: string): string | null {
  const ov = n.overlay as unknown as { links: Map<string, { nodeId: string | null }> };
  return ov.links.get(`0:${tpeer}`)?.nodeId ?? null;
}

describe('an active relay against real validators (auto quorum)', () => {
  it("cannot bind its link at A as B by relaying B's fresh hello", async () => {
    const { clock, net, nodes, lcl } = await threeValidators(22);
    const [a, b, c] = nodes;
    // Mallory relays: she asks B (and C) to cover A's nonce for her link with A,
    // forwards the covering hello to A, then says bye in B's name.
    const ids: Record<string, string> = { b: b.nodeId, c: c.nodeId };
    let fromA: Extract<WireMessage, { t: 'hello' }> | null = null;
    const covering: Record<string, Extract<WireMessage, { t: 'hello' }> | undefined> = {};
    const statuses: Record<string, WireMessage | undefined> = {};
    let relayed = 0;
    let bound = 0;
    // every time A loses B or C while the attack runs
    const drops: string[] = [];
    a.events.on('peers', (e) => {
      for (const id of [b.nodeId, c.nodeId]) if (!e.peers.some((p) => p.nodeId === id)) drops.push(id === b.nodeId ? 'b' : 'c');
    });
    const m = net.createTransport('mallory', { kind: 'webrtc' });
    m.onMessage = (from, msg) => {
      if (from === 'a' && msg.t === 'hello') fromA = msg;
      if (from !== 'a' && msg.t === 'hello' && msg.peerNonce !== undefined) covering[from] = msg;
      if (from !== 'a' && msg.t === 'status') statuses[from] = msg;
    };
    m.start();
    await clock.advance(3000);
    const attackFrom = lcl(a);
    const mismatchesBefore = a.overlay.stats().channelMismatches;
    for (let t = 0; t < 40; t++) {
      const victim = t % 2 === 0 ? 'b' : 'c';
      const h = fromA as Extract<WireMessage, { t: 'hello' }> | null;
      const cov = covering[victim];
      if (h && cov && cov.peerNonce === h.nonce) {
        m.send('a', cov);
        relayed++;
        await clock.advance(50);
        if (linkNode(a, 'mallory') === ids[victim]) bound++;
        m.send('a', { t: 'bye', nodeId: ids[victim] });
        covering[victim] = undefined;
      }
      // a status makes A renew its nonce for our link and send it in a hello
      const st = statuses[victim];
      if (st) m.send('a', st);
      await clock.advance(400);
      const h2 = fromA as Extract<WireMessage, { t: 'hello' }> | null;
      if (h2) m.send(t % 2 === 0 ? 'c' : 'b', { t: 'hello', ann: h2.ann, sig: h2.sig, nonce: h2.nonce });
      await clock.advance(600);
    }
    // B and C did make hellos that cover A's nonce for Mallory's link...
    expect(relayed).toBeGreaterThan(5);
    // ...but they were made for their channels with Mallory, not hers with A
    expect(bound).toBe(0);
    expect(a.overlay.stats().channelMismatches - mismatchesBefore).toBe(relayed);
    // so her byes never disconnect B or C at A, and nobody forks
    expect(drops).toEqual([]);
    expect(a.getPeers().map((p) => p.nodeId).sort()).toEqual([b.nodeId, c.nodeId].sort());
    await expectOneChain(nodes, lcl, attackFrom);
    for (const n of nodes) await n.stop();
  }, 120_000);

  it('two relays between three validators cannot take over their links and stop consensus', async () => {
    const { clock, net, nodes, lcl } = await threeValidators(33);
    const names = ['a', 'b', 'c'];
    // Relay k wants its link at X bound as imp[k][X]: together they cover all six directions.
    const imp: Record<string, string>[] = [
      { a: 'b', b: 'c', c: 'a' },
      { a: 'c', b: 'a', c: 'b' },
    ];
    let attacking = true;
    const relays = imp.map((map, k) => {
      const t = net.createTransport(`m${k}`, { kind: 'webrtc' });
      const nonceOf: Record<string, string> = {};
      const annOf: Record<string, { ann: NodeAnnouncement; sig: string }> = {};
      const stale: Record<string, WireMessage> = {};
      const pending: Record<string, boolean> = {};
      let forwarded = 0;
      const askCover = (x: string): void => {
        const ann = annOf[map[map[x]]] ?? annOf[x];
        if (ann) t.send(map[x], { t: 'hello', ann: ann.ann, sig: ann.sig, nonce: nonceOf[x] });
      };
      t.onMessage = (from, msg) => {
        // everything but hellos and statuses is dropped
        if (msg.t !== 'hello' && msg.t !== 'status') return;
        if (msg.t === 'status' || msg.peerNonce === undefined) {
          annOf[from] ??= { ann: msg.ann, sig: msg.sig };
          stale[from] ??= { t: 'status', ann: msg.ann, sig: msg.sig };
        }
        if (msg.t !== 'hello') return;
        if (nonceOf[from] !== msg.nonce) {
          nonceOf[from] = msg.nonce;
          pending[from] = false;
          askCover(from);
        }
        if (msg.peerNonce === undefined) return;
        // a hello from Y that covers X's nonce for its link with us: forward it to X
        for (const [x, y] of Object.entries(map)) {
          if (y === from && nonceOf[x] === msg.peerNonce && !pending[x]) {
            t.send(x, msg);
            pending[x] = true;
            forwarded++;
          }
        }
      };
      t.start();
      // a stale status every 5 ms would make a bound relay link each node's freshest (preferred) link
      const refresh = (): void => {
        if (!attacking) return;
        for (const x of names) {
          const s = stale[map[x]];
          if (s && linkNode(nodes[names.indexOf(x)], `m${k}`) !== null) t.send(x, s);
        }
        clock.setTimeout(refresh, 5);
      };
      clock.setTimeout(refresh, 5);
      return { id: `m${k}`, forwarded: () => forwarded };
    });
    await clock.advance(5000);
    const before = nodes.map(lcl);
    await clock.advance(60_000);
    attacking = false;
    // the relays forwarded covering hellos, but no node bound a relay link
    for (const r of relays) expect(r.forwarded()).toBeGreaterThan(0);
    for (const n of nodes) for (const r of relays) expect(linkNode(n, r.id)).toBeNull();
    // and consensus went on: about one ledger per 5 s
    expect(Math.min(...nodes.map(lcl))).toBeGreaterThan(Math.max(...before) + 5);
    await expectOneChain(nodes, lcl, Math.max(...before));
    for (const n of nodes) await n.stop();
  }, 120_000);
});

describe('hello replay against real validators (auto quorum)', () => {
  it('cannot cut a validator off its peers or make it fork', async () => {
    const clock = new VirtualClock();
    const net = new MemoryNetwork({ clock, seed: 21, latencyMs: () => 20 });
    const names = ['a', 'b', 'c'];
    const nodes = names.map(
      (name, i) =>
        new Node({
          transports: [net.createTransport(name, { kind: 'webrtc' })],
          storage: new MemoryStorage(),
          clock,
          networkName: 'replay-attack',
          name,
          secret: secret(i),
          logSink: new LogSink(clock, 'warn'),
        }),
    );
    const [a, b, c] = nodes;
    for (const n of nodes) await n.start();
    const lcl = (n: Node) => n.ledger.lastClosed().header.ledgerSeq;
    expect(await clock.runUntil(() => nodes.every((n) => n.state === 'synced' && lcl(n) >= 4), 120_000)).toBe(true);

    // Mallory joins the room. B and C greet her like any new peer.
    const latest = new Map<string, Map<string, WireMessage>>();
    const m = net.createTransport('mallory', { kind: 'webrtc' });
    m.onMessage = (from, msg) => {
      if (from === 'a' || (msg.t !== 'hello' && msg.t !== 'status')) return;
      const byType = latest.get(from) ?? new Map<string, WireMessage>();
      byType.set(msg.t, msg);
      latest.set(from, byType);
    };
    m.start();
    await clock.advance(3000);
    expect(latest.get('b')?.has('hello')).toBe(true);
    expect(latest.get('c')?.has('hello')).toBe(true);

    // For 40 s she replays their latest hello and status to A, then says bye in their names.
    const attackFrom = lcl(a);
    for (let t = 0; t < 40; t++) {
      for (const [who, node] of [
        ['b', b],
        ['c', c],
      ] as const) {
        for (const msg of latest.get(who)!.values()) m.send('a', msg);
        m.send('a', { t: 'bye', nodeId: node.nodeId });
      }
      await clock.advance(1000);
    }

    // A still has B and C, closed ledgers during the attack, and agrees with them on every one.
    expect(a.getPeers().map((p) => p.nodeId).sort()).toEqual([b.nodeId, c.nodeId].sort());
    const top = Math.min(...nodes.map(lcl));
    expect(top).toBeGreaterThan(attackFrom + 4);
    for (let seq = 2; seq <= top; seq++) {
      const hashes = await Promise.all(nodes.map((n) => n.chain.hashAtAsync(seq)));
      expect(new Set(hashes).size, `ledger ${seq}: ${hashes.map((h) => h?.slice(0, 8)).join(' ')}`).toBe(1);
    }
    for (const n of nodes) await n.stop();
  }, 120_000);
});
