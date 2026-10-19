// Responses larger than one message travel as numbered parts and are
// reassembled by the requester (bounded in size and time). The big-state test
// runs the real catch-up (src/history/catchup) of a fresh node from a source
// whose snapshot is larger than one overlay message.

import { Keypair, Operation } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { VirtualClock } from '../lib/clock';
import { APP_VERSION, networkPassphrase } from '../lib/constants';
import { sha256, sha256Hex } from '../lib/hash';
import { LogSink, Logger, nullLogger } from '../lib/log';
import { createGenesisLedger, type LedgerManager } from '../ledger/manager';
import { TestLedger } from '../ledger/testkit';
import { catchUpFrom, type CatchupHost } from '../history/catchup';
import { MemoryNetwork } from './memoryNetwork';
import { Overlay, OverlayRequestError, splitParts, type OverlayOptions } from './overlay';
import type { OverlayHandlers, RequestBody, ResponseBody, TransportKind, WireMessage } from './types';
import { MAX_MESSAGE_BYTES, signAnnouncement } from './wire';

const NETWORK_ID = sha256Hex('BrowserChain overlay chunking tests');

function keypair(i: number): Keypair {
  return Keypair.fromRawEd25519Seed(sha256(`overlay-chunking-node-${i}`));
}

interface Pair {
  clock: VirtualClock;
  net: MemoryNetwork;
  a: Overlay;
  b: Overlay;
  bId: string;
  /** Frames B sent (to count parts). */
  sentByB: WireMessage[];
  setHandler(fn: OverlayHandlers['onRequest']): void;
}

function pair(kind: TransportKind = 'memory', opts: Partial<OverlayOptions> = {}, optsA: Partial<OverlayOptions> = opts): Pair {
  const clock = new VirtualClock(1_790_000_000_000);
  const net = new MemoryNetwork({ clock, seed: 3, latencyMs: () => 10 });
  let handler: OverlayHandlers['onRequest'] = () => null;
  const ta = net.createTransport('a', { kind });
  const tb = net.createTransport('b', { kind });
  const sentByB: WireMessage[] = [];
  const send = tb.send.bind(tb);
  tb.send = (peer, msg) => {
    sentByB.push(msg);
    send(peer, msg);
  };
  const mk = (i: number, t: typeof ta, onRequest: OverlayHandlers['onRequest'], o: Partial<OverlayOptions>) =>
    new Overlay({
      keypair: keypair(i),
      networkId: NETWORK_ID,
      name: `n${i}`,
      clock,
      logger: new Logger(new LogSink(clock, 'debug'), `n${i}`),
      transports: [t],
      handlers: { onStellarMessage: () => undefined, onRequest },
      ...o,
    });
  const a = mk(0, ta, () => null, optsA);
  const b = mk(1, tb, (body, from) => handler(body, from), opts);
  return { clock, net, a, b, bId: keypair(1).publicKey(), sentByB, setHandler: (fn) => (handler = fn) };
}

/** Await a promise while the virtual clock runs. */
async function drive<T>(clock: VirtualClock, p: Promise<T>, maxMs = 120_000): Promise<T> {
  let settled = false;
  const tracked = p.finally(() => {
    settled = true;
  });
  tracked.catch(() => undefined);
  await clock.runUntil(() => settled, maxMs, 20);
  return tracked;
}

function bigSnapshotBody(bytes: number): ResponseBody {
  // JSON-ish text with quotes, so escaping makes the wire form bigger than the text.
  const unit = '{"k":"A:GABC","v":"1234567890"},';
  return { kind: 'snapshot', seq: 64, data: unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes) };
}

describe('Overlay: large responses', () => {
  it('a response larger than one message arrives in parts', async () => {
    const p = pair();
    p.a.start();
    p.b.start();
    await p.clock.advance(100);
    const body = bigSnapshotBody(MAX_MESSAGE_BYTES + 2_000_000);
    p.setHandler(() => body);
    const res = await drive(p.clock, p.a.request(p.bId, { kind: 'snapshot', atOrBefore: 64 }));
    expect(res).toEqual(body);
    const parts = p.sentByB.filter((m) => m.t === 'part');
    expect(parts.length).toBeGreaterThan(1);
    expect(p.a.stats().partsIn).toBe(parts.length);
  });
});

// ------------------------------------------------------------ catch-up with a big state

const PASS = networkPassphrase('chunking-test');

interface SourceChain {
  ledgers: Map<number, { seq: number; headerXdr: string; txSetXdr: string }>;
  snapshot: string;
  tip: { seq: number; hash: string };
  entries: number;
}

/**
 * Ledgers 1..64; ledger 2 funds 10 funders, ledgers 3..2+ceil(accounts/1000)
 * create `accounts` accounts; snapshot at 64.
 */
function bigChain(accounts: number): SourceChain {
  const tl = new TestLedger(undefined, PASS);
  const g = tl.lm.lastClosed();
  const ledgers = new Map<number, { seq: number; headerXdr: string; txSetXdr: string }>([
    [1, { seq: 1, headerXdr: g.headerXdr, txSetXdr: '' }],
  ]);
  // A friendbot channel may only sign one CreateAccount or Payment of
  // FRIENDBOT_AMOUNT: the channels fund 10 funders, which create the accounts.
  const funders = Array.from({ length: 10 }, (_, c) => Keypair.fromRawEd25519Seed(sha256(`chunking-funder-${c}`)));
  const f = tl.fund(funders);
  ledgers.set(f.header.ledgerSeq, { seq: f.header.ledgerSeq, headerXdr: f.headerXdr, txSetXdr: f.txSet.xdr });
  let made = 0;
  while (tl.ledgerSeq < 64) {
    const envs: string[] = [];
    for (let c = 0; c < 10 && made < accounts; c++) {
      const ops = [];
      for (let k = 0; k < 100 && made < accounts; k++, made++) {
        const dest = Keypair.fromRawEd25519Seed(sha256(`chunking-account-${made}`)).publicKey();
        ops.push(Operation.createAccount({ destination: dest, startingBalance: '2' }));
      }
      envs.push(tl.tx(funders[c], ops));
    }
    const r = tl.close(envs);
    expect(r.results.every((x) => x.successful)).toBe(true);
    ledgers.set(r.header.ledgerSeq, { seq: r.header.ledgerSeq, headerXdr: r.headerXdr, txSetXdr: r.txSet.xdr });
  }
  const tip = tl.lm.lastClosed();
  const snap = tl.lm.snapshot();
  return { ledgers, snapshot: JSON.stringify(snap), tip: { seq: tip.header.ledgerSeq, hash: tip.hash }, entries: snap.entries.length };
}

function serve(chain: SourceChain, body: RequestBody): ResponseBody | null {
  switch (body.kind) {
    case 'headers':
    case 'ledgers': {
      const items = [];
      for (let s = Math.max(1, body.from); s <= Math.min(body.to, chain.tip.seq, body.from + 63); s++) {
        const l = chain.ledgers.get(s)!;
        items.push(body.kind === 'headers' ? { seq: s, headerXdr: l.headerXdr } : { seq: s, headerXdr: l.headerXdr, txSetXdr: l.txSetXdr });
      }
      return body.kind === 'headers' ? { kind: 'headers', items: items as { seq: number; headerXdr: string }[] } : { kind: 'ledgers', items: items as { seq: number; headerXdr: string; txSetXdr: string }[] };
    }
    case 'snapshot':
      return body.atOrBefore >= 64 ? { kind: 'snapshot', seq: 64, data: chain.snapshot } : null;
    default:
      return null;
  }
}

describe('Catch-up from a peer whose snapshot is larger than one message', () => {
  it('a fresh node loads an 11k-entry snapshot through the overlay', async () => {
    const chain = bigChain(11_000);
    expect(chain.snapshot.length).toBeGreaterThan(MAX_MESSAGE_BYTES);
    const p = pair('webrtc');
    p.setHandler((body) => serve(chain, body));
    p.a.start();
    p.b.start();
    await p.clock.advance(200);
    expect(p.a.isConnected(p.bId)).toBe(true);

    let lm: LedgerManager = createGenesisLedger(PASS);
    const host: CatchupHost = {
      request: (id, body, t) => p.a.request(id, body, t),
      passphrase: PASS,
      logger: nullLogger(p.clock),
      ledger: () => lm,
      installSnapshot: async (next) => {
        lm = next;
      },
      replayed: () => undefined,
      requestTimeoutMs: 10_000,
    };
    const result = await drive(p.clock, catchUpFrom(host, p.bId, chain.tip));
    expect(result.snapshot).toBe(64);
    expect(lm.lastClosed().hash).toBe(chain.tip.hash);
    expect(lm.allEntries().length).toBe(chain.entries);
  }, 120_000);
});

describe('Overlay: large-response budget', () => {
  it('limits how many bytes of large responses one peer can make us build and send', async () => {
    const p = pair();
    p.a.start();
    p.b.start();
    await p.clock.advance(100);
    const body = bigSnapshotBody(MAX_MESSAGE_BYTES + 2_000_000);
    let built = 0;
    p.setHandler(() => {
      built++;
      return body;
    });
    // 40 back-to-back requests for a 6 MB response: 240 MB of work if nothing limits it
    const outcomes: string[] = [];
    for (let i = 0; i < 40; i++) {
      const r = await drive(
        p.clock,
        p.a.request(p.bId, { kind: 'snapshot', atOrBefore: 64 }).then(
          () => 'ok',
          (e: Error) => (/busy/.test(e.message) ? 'busy' : e.message),
        ),
      );
      outcomes.push(r);
    }
    const ok = outcomes.filter((o) => o === 'ok').length;
    expect(outcomes.every((o) => o === 'ok' || o === 'busy')).toBe(true);
    // the burst allows about 64 MB, then about 4 MB per second
    expect(ok).toBeGreaterThanOrEqual(8);
    expect(ok).toBeLessThanOrEqual(14);
    expect(p.b.stats().bytesOut).toBeLessThan(15 * (MAX_MESSAGE_BYTES + 2_200_000));
    expect(built).toBe(40);
    // after a pause the peer gets large responses again
    await p.clock.advance(60_000);
    await expect(drive(p.clock, p.a.request(p.bId, { kind: 'snapshot', atOrBefore: 64 }))).resolves.toEqual(body);
  });
});

/** Overlay A plus a raw endpoint 'r' (bound to A as node 9) that answers by hand. */
async function rawResponder(optsA: Partial<OverlayOptions> = {}) {
  const clock = new VirtualClock(1_790_000_000_000);
  const net = new MemoryNetwork({ clock, seed: 5, latencyMs: () => 10 });
  const a = new Overlay({
    keypair: keypair(0),
    networkId: NETWORK_ID,
    name: 'n0',
    clock,
    logger: nullLogger(clock),
    transports: [net.createTransport('a')],
    handlers: { onStellarMessage: () => undefined, onRequest: () => null },
    ...optsA,
  });
  a.start();
  const r = net.createTransport('r');
  const reqs: Extract<WireMessage, { t: 'req' }>[] = [];
  r.onMessage = (_from, msg) => {
    if (msg.t === 'req') reqs.push(msg);
  };
  r.start();
  await clock.advance(50);
  const kp = keypair(9);
  const ann = {
    nodeId: kp.publicKey(),
    name: 'raw',
    networkId: NETWORK_ID,
    appVersion: APP_VERSION,
    lcl: { seq: 1, hash: '00'.repeat(32) },
    state: 'synced' as const,
    validator: true,
    qsetHash: '',
    quorumMode: 'auto' as const,
    ts: clock.now(),
  };
  r.send('a', { t: 'hello', ann, sig: signAnnouncement(kp, ann), nonce: '00'.repeat(16) });
  await clock.advance(50);
  expect(a.isConnected(kp.publicKey())).toBe(true);
  /** Keep the link alive like a real peer: a fresh signed status every 2 s until the returned stop() is called. */
  const keepAlive = (): (() => void) => {
    let on = true;
    const beat = (): void => {
      if (!on) return;
      const st = { ...ann, ts: clock.now() };
      r.send('a', { t: 'status', ann: st, sig: signAnnouncement(kp, st) });
      clock.setTimeout(beat, 2000);
    };
    beat();
    return () => {
      on = false;
    };
  };
  return { clock, net, a, r, reqs, id: kp.publicKey(), keepAlive };
}

/** Parts of a body's JSON, as a responder would send them. */
function partsOf(id: string, body: ResponseBody, n: number): Extract<WireMessage, { t: 'part' }>[] {
  const text = JSON.stringify(body);
  const size = Math.ceil(text.length / n);
  return splitParts(text, size).map((data, index, all) => ({ t: 'part', id, index, total: all.length, data }));
}

describe('Overlay: part reassembly bounds', () => {
  it('the responder refuses a response above its cap', async () => {
    const p = pair('memory', { maxResponseBytes: 6 * 1024 * 1024 });
    p.a.start();
    p.b.start();
    await p.clock.advance(100);
    p.setHandler(() => bigSnapshotBody(8 * 1024 * 1024));
    const err = await drive(p.clock, p.a.request(p.bId, { kind: 'snapshot', atOrBefore: 64 }).catch((e: OverlayRequestError) => e));
    expect(err).toBeInstanceOf(OverlayRequestError);
    expect((err as OverlayRequestError).code).toBe('remote-error');
    expect((err as Error).message).toMatch(/too large/);
  });

  it('the requester stops reassembling past its own cap', async () => {
    const p = pair('memory', {}, { maxResponseBytes: 6 * 1024 * 1024 });
    p.a.start();
    p.b.start();
    await p.clock.advance(100);
    p.setHandler(() => bigSnapshotBody(8 * 1024 * 1024));
    const err = await drive(p.clock, p.a.request(p.bId, { kind: 'snapshot', atOrBefore: 64 }).catch((e: OverlayRequestError) => e));
    expect((err as OverlayRequestError).code).toBe('bad-response');
    expect((err as Error).message).toMatch(/larger than/);
  });

  it('ignores duplicates, rejects parts that disagree on the count, and counts strays', async () => {
    const { clock, a, r, reqs, id } = await rawResponder();
    const body: ResponseBody = { kind: 'scpState', envelopes: ['e1', 'e2', 'e3'] };
    const p1 = a.request(id, { kind: 'scpState', fromSlot: 1 });
    await clock.advance(20);
    const parts = partsOf(reqs[0].id, body, 3);
    r.send('a', parts[0]);
    r.send('a', parts[0]);
    r.send('a', parts[2]);
    r.send('a', parts[1]);
    await clock.advance(50);
    await expect(p1).resolves.toEqual(body);
    // a part after completion is a stray
    r.send('a', parts[1]);
    await clock.advance(50);
    expect(a.stats().unexpectedResponses).toBe(1);

    const p2 = a.request(id, { kind: 'scpState', fromSlot: 1 }).catch((e: OverlayRequestError) => `${e.code}: ${e.message}`);
    await clock.advance(20);
    const q = partsOf(reqs[1].id, body, 3);
    r.send('a', q[0]);
    r.send('a', { ...q[1], total: 4 });
    await clock.advance(50);
    expect(await p2).toMatch(/^bad-response: .*disagree/);

    const p3 = a.request(id, { kind: 'scpState', fromSlot: 1 }).catch((e: OverlayRequestError) => `${e.code}: ${e.message}`);
    await clock.advance(20);
    const garbled = partsOf(reqs[2].id, body, 2);
    garbled[1] = { ...garbled[1], data: '}}}' };
    for (const g of garbled) r.send('a', g);
    await clock.advance(50);
    expect(await p3).toMatch(/^bad-response: .*JSON/);
  });

  it('each part restarts the request timer; a stalled response times out', async () => {
    // small parts here: a part buys time only for the data it brings (about one timeout per partChars)
    const { clock, a, r, reqs, id } = await rawResponder({ partChars: 64 });
    const body: ResponseBody = { kind: 'scpState', envelopes: ['x'.repeat(100), 'y'.repeat(100)] };
    const slow = a.request(id, { kind: 'scpState', fromSlot: 1 }, 1000);
    await clock.advance(20);
    const parts = partsOf(reqs[0].id, body, 4);
    for (const part of parts) {
      await clock.advance(900);
      r.send('a', part);
    }
    await clock.advance(50);
    await expect(slow).resolves.toEqual(body);

    const stalled = a.request(id, { kind: 'scpState', fromSlot: 1 }, 1000).catch((e: OverlayRequestError) => e.message);
    await clock.advance(20);
    const q = partsOf(reqs[1].id, body, 4);
    r.send('a', q[0]);
    r.send('a', q[1]);
    await clock.advance(1500);
    expect(await stalled).toMatch(/timed out after 1000 ms \(2 of 4 parts\)/);
  });

  it('answers to our own requests pass a tight rate limit', async () => {
    const p = pair('memory', {}, { rateLimit: { messagesPerSecond: 1, burst: 2 } });
    p.a.start();
    p.b.start();
    await p.clock.advance(100);
    const body = bigSnapshotBody(MAX_MESSAGE_BYTES + 2_000_000);
    p.setHandler(() => body);
    await expect(drive(p.clock, p.a.request(p.bId, { kind: 'snapshot', atOrBefore: 64 }))).resolves.toEqual(body);
    expect(p.a.stats().rateLimited).toBe(0);
  });

  it('keeps surrogate pairs whole across part boundaries', async () => {
    const text = '😀'.repeat(10);
    for (let size = 1; size <= 5; size++) {
      const parts = splitParts(text, Math.max(2, size));
      expect(parts.join('')).toBe(text);
      for (const part of parts) expect(/[\ud800-\udbff]$/.test(part)).toBe(false);
    }
    const p = pair('memory', { maxMessageBytes: 2000 });
    p.a.start();
    p.b.start();
    await p.clock.advance(100);
    const body: ResponseBody = { kind: 'snapshot', seq: 1, data: '😀é"\\'.repeat(800) };
    p.setHandler(() => body);
    await expect(drive(p.clock, p.a.request(p.bId, { kind: 'snapshot', atOrBefore: 1 }))).resolves.toEqual(body);
  });
});

describe('Overlay: a responder that drips tiny parts', () => {
  // Before the deadline below, 255 one-character parts sent every 9.9 s held
  // one request with a 10 s timeout open for 42 minutes.
  it('cannot hold a request open: only data buys time', async () => {
    const { clock, a, r, reqs, id, keepAlive } = await rawResponder();
    const stop = keepAlive();
    const t0 = clock.now();
    let outcome: string | null = null;
    let at = 0;
    a.request(id, { kind: 'snapshot', atOrBefore: 64 }, 10_000).then(
      () => (outcome = 'ok'),
      (e: OverlayRequestError) => {
        outcome = `${e.code}: ${e.message}`;
        at = clock.now();
      },
    );
    await clock.advance(20);
    for (let i = 0; i < 255 && outcome === null; i++) {
      await clock.advance(9_900);
      r.send('a', { t: 'part', id: reqs[0].id, index: i, total: 256, data: 'x' });
    }
    stop();
    expect(outcome).toMatch(/^timeout: .*\(2 of 256 parts\)/);
    // two timeouts (the parts brought almost no data)
    expect(at - t0).toBeLessThan(20_100);
    expect(a.isConnected(id)).toBe(true);
  });

  it('a catch-up from a dripping source fails within seconds, so another source can be tried', async () => {
    const { clock, a, r, reqs, id, keepAlive } = await rawResponder();
    const stop = keepAlive();
    // every request is answered with one tiny part of 256, then another just before each timeout
    let answered = 0;
    const drip = (): void => {
      for (const q of reqs.slice(answered)) r.send('a', { t: 'part', id: q.id, index: 0, total: 256, data: '{' });
      answered = reqs.length;
      for (const q of reqs) r.send('a', { t: 'part', id: q.id, index: Math.floor(clock.now() / 9_900) % 255 + 1, total: 256, data: ' ' });
      clock.setTimeout(drip, 9_900);
    };
    clock.setTimeout(drip, 100);
    const host: CatchupHost = {
      request: (nid, body, t) => a.request(nid, body, t),
      passphrase: PASS,
      logger: nullLogger(clock),
      ledger: () => createGenesisLedger(PASS),
      installSnapshot: async () => undefined,
      replayed: () => undefined,
      requestTimeoutMs: 10_000,
    };
    const t0 = clock.now();
    const res = await drive(
      clock,
      catchUpFrom(host, id, { seq: 100, hash: 'ab'.repeat(32) }).then(
        () => 'caught up',
        (e: Error & { code?: string }) => `${e.code}: ${e.message}`,
      ),
      3_600_000,
    );
    stop();
    expect(res).toMatch(/^network: \w+ request failed: .*timed out after 10000 ms \(\d+ of 256 parts\)/);
    expect(clock.now() - t0).toBeLessThan(30_000);
  });
});
