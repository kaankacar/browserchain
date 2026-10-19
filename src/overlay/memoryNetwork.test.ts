import { afterEach, describe, expect, it, vi } from 'vitest';
import { VirtualClock } from '../lib/clock';
import { MemoryNetwork, type MemoryNetworkOptions, type MemoryTransport } from './memoryNetwork';
import type { WireMessage } from './types';

interface Rec {
  t: MemoryTransport;
  log: string[];
  msgs: { from: string; msg: WireMessage; at: number }[];
}

function setup(opts: Partial<MemoryNetworkOptions> = {}) {
  const clock = new VirtualClock(0);
  const net = new MemoryNetwork({ clock, seed: 7, ...opts });
  const recs = new Map<string, Rec>();
  const add = (id: string, start = true): Rec => {
    const t = net.createTransport(id);
    const rec: Rec = { t, log: [], msgs: [] };
    t.onPeerUp = (p) => rec.log.push(`up:${p}@${clock.now()}`);
    t.onPeerDown = (p) => rec.log.push(`down:${p}@${clock.now()}`);
    t.onMessage = (from, msg) => {
      rec.msgs.push({ from, msg, at: clock.now() });
      rec.log.push(`msg:${from}:${label(msg)}@${clock.now()}`);
    };
    recs.set(id, rec);
    if (start) t.start();
    return rec;
  };
  return { clock, net, add, recs };
}

function m(n: number | string): WireMessage {
  return { t: 'bye', nodeId: String(n) };
}

function label(msg: WireMessage): string {
  return msg.t === 'bye' ? msg.nodeId : msg.t;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MemoryNetwork', () => {
  it('reports peers up through the clock, not synchronously', async () => {
    const { clock, add } = setup();
    const a = add('a');
    const b = add('b');
    expect(a.log).toEqual([]);
    expect(a.t.peers()).toEqual([]);
    await clock.advance(0);
    expect(a.log).toEqual(['up:b@0']);
    expect(b.log).toEqual(['up:a@0']);
    expect(a.t.peers()).toEqual(['b']);
  });

  it('delivers by latency across links', async () => {
    const lat: Record<string, number> = { 'a>c': 50, 'b>c': 10 };
    const { clock, add } = setup({ latencyMs: (from, to) => lat[`${from}>${to}`] ?? 1 });
    const a = add('a');
    const b = add('b');
    const c = add('c');
    await clock.advance(0);
    a.t.send('c', m('from-a'));
    b.t.send('c', m('from-b'));
    await clock.advance(100);
    expect(c.msgs.map((x) => [x.from, label(x.msg), x.at])).toEqual([
      ['b', 'from-b', 10],
      ['a', 'from-a', 50],
    ]);
  });

  it('keeps per-link FIFO order by default', async () => {
    const lats = [30, 20, 10];
    let i = 0;
    const { clock, add } = setup({ latencyMs: () => lats[i++ % 3] });
    const a = add('a');
    const b = add('b');
    await clock.advance(0);
    for (const n of [1, 2, 3]) a.t.send('b', m(n));
    await clock.advance(100);
    expect(b.msgs.map((x) => [label(x.msg), x.at])).toEqual([
      ['1', 30],
      ['2', 30],
      ['3', 30],
    ]);
  });

  it('can reorder when fifo is off', async () => {
    const lats = [30, 20, 10];
    let i = 0;
    const { clock, add } = setup({ fifo: false, latencyMs: () => lats[i++ % 3] });
    const a = add('a');
    const b = add('b');
    await clock.advance(0);
    for (const n of [1, 2, 3]) a.t.send('b', m(n));
    await clock.advance(100);
    expect(b.msgs.map((x) => label(x.msg))).toEqual(['3', '2', '1']);
  });

  it('deep-copies messages on send', async () => {
    const { clock, add } = setup({ latencyMs: () => 5 });
    const a = add('a');
    const b = add('b');
    const c = add('c');
    await clock.advance(0);
    const msg = { t: 'res', id: 'x', body: { kind: 'scpState', envelopes: ['e1'] } } as WireMessage;
    a.t.broadcast(msg);
    (msg as { body: { envelopes: string[] } }).body.envelopes.push('mutated');
    await clock.advance(10);
    const gotB = b.msgs[0].msg as { body: { envelopes: string[] } };
    const gotC = c.msgs[0].msg as { body: { envelopes: string[] } };
    expect(gotB.body.envelopes).toEqual(['e1']);
    expect(gotC.body.envelopes).toEqual(['e1']);
    expect(gotB).not.toBe(gotC);
  });

  it('drops everything at drop rate 1 and about half at 0.5', async () => {
    const one = setup({ dropRate: 1 });
    const a = one.add('a');
    const b = one.add('b');
    await one.clock.advance(0);
    for (let i = 0; i < 20; i++) a.t.send('b', m(i));
    await one.clock.advance(100);
    expect(b.msgs).toEqual([]);
    expect(one.net.stats().dropped).toBe(20);
    expect(one.net.stats().sent).toBe(20);

    const half = setup({ dropRate: 0.5, seed: 99 });
    const x = half.add('x');
    const y = half.add('y');
    await half.clock.advance(0);
    for (let i = 0; i < 400; i++) x.t.send('y', m(i));
    await half.clock.advance(100);
    expect(y.msgs.length).toBeGreaterThan(140);
    expect(y.msgs.length).toBeLessThan(260);
    expect(half.net.stats().delivered + half.net.stats().dropped).toBe(400);
  });

  it('is reproducible for a given seed', async () => {
    const run = async (seed: number) => {
      const s = setup({ seed, dropRate: 0.3 });
      const nodes = ['a', 'b', 'c', 'd'].map((id) => s.add(id));
      await s.clock.advance(0);
      for (let i = 0; i < 50; i++) nodes[i % 4].t.broadcast(m(i));
      await s.clock.advance(1000);
      return nodes.map((n) => n.log.join(','));
    };
    expect(await run(5)).toEqual(await run(5));
    expect(await run(5)).not.toEqual(await run(6));
  });

  it('partitions split groups and lose in-flight messages', async () => {
    const { clock, net, add } = setup({ latencyMs: () => 50 });
    const a = add('a');
    const b = add('b');
    const c = add('c');
    await clock.advance(0);
    a.t.send('c', m('crossing'));
    a.t.send('b', m('same-side'));
    await clock.advance(10);
    net.partition([['a', 'b'], ['c']]);
    expect(net.isLinked('a', 'c')).toBe(false);
    expect(net.isLinked('a', 'b')).toBe(true);
    await clock.advance(0);
    expect(c.log).toContain('down:a@10');
    expect(c.log).toContain('down:b@10');
    expect(a.t.peers()).toEqual(['b']);
    a.t.send('c', m('after-cut'));
    net.heal();
    await clock.advance(0);
    expect(c.t.peers().sort()).toEqual(['a', 'b']);
    await clock.advance(100);
    // Only the message on the uncut link arrived.
    expect(c.msgs).toEqual([]);
    expect(b.msgs.map((x) => label(x.msg))).toEqual(['same-side']);
    a.t.send('c', m('after-heal'));
    await clock.advance(100);
    expect(c.msgs.map((x) => label(x.msg))).toEqual(['after-heal']);
  });

  it('puts unlisted endpoints in one extra group', async () => {
    const { clock, net, add } = setup();
    add('a');
    add('b');
    add('c');
    await clock.advance(0);
    net.partition([['a']]);
    await clock.advance(0);
    expect(net.isLinked('b', 'c')).toBe(true);
    expect(net.isLinked('a', 'b')).toBe(false);
    expect(net.isLinked('a', 'c')).toBe(false);
  });

  it('disconnect and reconnect one endpoint', async () => {
    const { clock, net, add } = setup({ latencyMs: () => 20 });
    const a = add('a');
    const b = add('b');
    const c = add('c');
    await clock.advance(0);
    a.t.send('b', m('in-flight'));
    net.disconnect('b');
    await clock.advance(0);
    expect(b.t.peers()).toEqual([]);
    expect(a.t.peers()).toEqual(['c']);
    expect(c.log).toEqual(['up:a@0', 'up:b@0', 'down:b@0']);
    await clock.advance(50);
    expect(b.msgs).toEqual([]);
    net.reconnect('b');
    await clock.advance(0);
    expect(b.t.peers().sort()).toEqual(['a', 'c']);
    expect(a.log.filter((l) => l.startsWith('up:b'))).toHaveLength(2);
  });

  it('stop is graceful: sent messages arrive, then the peer goes down', async () => {
    const { clock, add } = setup({ latencyMs: () => 20 });
    const a = add('a');
    const b = add('b');
    await clock.advance(0);
    a.t.send('b', m('last-words'));
    b.t.send('a', m('too-late'));
    a.t.stop();
    expect(a.t.peers()).toEqual([]);
    await clock.advance(50);
    expect(b.log).toEqual(['up:a@0', 'msg:a:last-words@20', 'down:a@20']);
    expect(a.msgs).toEqual([]);
  });

  it('a restarted endpoint looks like a fresh connection', async () => {
    const { clock, add } = setup({ latencyMs: () => 20 });
    const a = add('a');
    const b = add('b');
    await clock.advance(0);
    a.t.send('b', m('old'));
    a.t.stop();
    a.t.start();
    await clock.advance(50);
    expect(b.log).toEqual(['up:a@0', 'down:a@0', 'up:a@0']);
    // The message of the old session belongs to a closed connection.
    expect(b.msgs).toEqual([]);
    expect(a.t.peers()).toEqual(['b']);
  });

  it('does not deliver to unknown peers or stopped transports', async () => {
    const { clock, net, add } = setup();
    const a = add('a');
    const b = add('b', false);
    await clock.advance(0);
    a.t.send('b', m(1));
    a.t.send('zzz', m(2));
    await clock.advance(100);
    expect(b.msgs).toEqual([]);
    expect(net.stats().perNode.a.dropped).toBe(2);
  });

  it('counts messages and bytes', async () => {
    const { clock, net, add } = setup({ latencyMs: () => 1 });
    const a = add('a');
    add('b');
    add('c');
    await clock.advance(0);
    const msg = m('x');
    const size = JSON.stringify(msg).length;
    a.t.broadcast(msg);
    await clock.advance(10);
    const st = net.stats();
    expect(st.sent).toBe(2);
    expect(st.delivered).toBe(2);
    expect(st.bytesSent).toBe(2 * size);
    expect(st.bytesDelivered).toBe(2 * size);
    expect(st.perNode.a.sent).toBe(2);
    expect(st.perNode.b.received).toBe(1);
    expect(st.peerUps).toBe(6);
    net.resetStats();
    expect(net.stats().sent).toBe(0);
    expect(net.stats().perNode.a.sent).toBe(0);
  });

  it('survives throwing callbacks', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { clock, net, add } = setup({ latencyMs: () => 1 });
    const a = add('a');
    const b = add('b');
    b.t.onMessage = () => {
      throw new Error('boom');
    };
    await clock.advance(0);
    a.t.send('b', m(1));
    a.t.send('b', m(2));
    await clock.advance(10);
    expect(net.stats().callbackErrors).toBe(2);
    expect(net.stats().delivered).toBe(2);
    expect(err).toHaveBeenCalled();
  });

  it('removeTransport frees the id', async () => {
    const { clock, net, add, recs } = setup();
    const a = add('a');
    add('b');
    await clock.advance(0);
    net.removeTransport('b');
    await clock.advance(0);
    expect(a.t.peers()).toEqual([]);
    expect(net.ids()).toEqual(['a']);
    recs.delete('b');
    const b2 = add('b');
    await clock.advance(0);
    expect(b2.t.peers()).toEqual(['a']);
    expect(() => net.createTransport('a')).toThrow(/duplicate/);
  });

  it('rejects messages that are not JSON-safe', async () => {
    const { clock, add } = setup();
    const a = add('a');
    add('b');
    await clock.advance(0);
    expect(() => a.t.send('b', { t: 'bye', nodeId: 1n } as unknown as WireMessage)).toThrow();
  });
});
