import { Asset, Keypair, Operation } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { VirtualClock } from '../lib/clock';
import { networkPassphrase } from '../lib/constants';
import { LogSink, Logger } from '../lib/log';
import { decodeLedgerHeader, encodeLedgerHeader } from '../ledger/header';
import { createGenesisLedger, type LedgerManager } from '../ledger/manager';
import { TestLedger, XLM } from '../ledger/testkit';
import type { LedgerSnapshot } from '../ledger/types';
import type { RequestBody, ResponseBody } from '../overlay/types';
import { CatchupError, catchUpFrom, checkpointAtOrBefore, fetchHeaderChain, type CatchupHost } from './catchup';
import { decideFork, findForkPoint } from './fork';

const PASS = networkPassphrase('catchup-test');

interface ChainLedger {
  seq: number;
  hash: string;
  headerXdr: string;
  txSetXdr: string;
}

interface Chain {
  ledgers: Map<number, ChainLedger>;
  snapshots: Map<number, string>;
  tip: { seq: number; hash: string };
}

/** A source chain of `n` ledgers (1 = genesis) with some payments; snapshots at checkpoints. */
function buildChain(n: number, opts: { seed?: string } = {}): Chain {
  const tl = new TestLedger(undefined, PASS);
  const g = tl.lm.lastClosed();
  const ledgers = new Map<number, ChainLedger>([[1, { seq: 1, hash: g.hash, headerXdr: g.headerXdr, txSetXdr: '' }]]);
  const snapshots = new Map<number, string>();
  const users = [Keypair.random(), Keypair.random()];
  for (let seq = 2; seq <= n; seq++) {
    let envs: string[] = [];
    if (seq === 2) {
      const r = tl.fund(users, 100n * XLM);
      record(r);
      continue;
    }
    if (seq % 3 === 0) {
      envs = [tl.tx(users[0], [Operation.payment({ destination: users[1].publicKey(), asset: Asset.native(), amount: `${seq % 7 + 1}` })])];
    }
    if (opts.seed && seq === 3) envs = [tl.tx(users[1], [Operation.bumpSequence({ bumpTo: '0' })], { memo: undefined })];
    record(tl.close(envs));
  }
  function record(r: ReturnType<TestLedger['close']>) {
    const seq = r.header.ledgerSeq;
    ledgers.set(seq, { seq, hash: r.hash, headerXdr: r.headerXdr, txSetXdr: r.txSet.xdr });
    if (seq % 64 === 0) snapshots.set(seq, JSON.stringify(tl.lm.snapshot()));
  }
  const tip = tl.lm.lastClosed();
  return { ledgers, snapshots, tip: { seq: tip.header.ledgerSeq, hash: tip.hash } };
}

type Tamper = (body: RequestBody, res: ResponseBody) => ResponseBody;

function answer(chain: Chain, body: RequestBody): ResponseBody | null {
  switch (body.kind) {
    case 'headers':
    case 'ledgers': {
      const items: { seq: number; headerXdr: string; txSetXdr: string }[] = [];
      for (let s = body.from; s <= Math.min(body.to, body.from + 63); s++) {
        const l = chain.ledgers.get(s);
        if (l) items.push({ seq: s, headerXdr: l.headerXdr, txSetXdr: l.txSetXdr });
      }
      return body.kind === 'headers'
        ? { kind: 'headers', items: items.map((i) => ({ seq: i.seq, headerXdr: i.headerXdr })) }
        : { kind: 'ledgers', items };
    }
    case 'snapshot': {
      let best = 0;
      for (const s of chain.snapshots.keys()) if (s <= body.atOrBefore && s > best) best = s;
      if (!best) return null;
      return { kind: 'snapshot', seq: best, data: chain.snapshots.get(best)! };
    }
    default:
      return null;
  }
}

function makeHost(chain: Chain, start: LedgerManager = createGenesisLedger(PASS), tamper?: Tamper) {
  const clock = new VirtualClock();
  const state = { lm: start, replayed: [] as number[], installed: [] as number[], requests: [] as string[] };
  const host: CatchupHost = {
    request: async (_id, body) => {
      state.requests.push(`${body.kind}`);
      const res = answer(chain, body);
      if (!res) throw Object.assign(new Error('no data'), { code: 'no-data' });
      return tamper ? tamper(body, structuredClone(res)) : res;
    },
    passphrase: PASS,
    logger: new Logger(new LogSink(clock, 'error'), 'catchup'),
    ledger: () => state.lm,
    installSnapshot: async (lm, _data) => {
      state.lm = lm;
      state.installed.push(lm.lastClosed().header.ledgerSeq);
    },
    replayed: (r) => state.replayed.push(r.header.ledgerSeq),
  };
  return { host, state };
}

async function expectCatchupError(p: Promise<unknown>, code: string, msg?: RegExp): Promise<void> {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(CatchupError);
  expect((err as CatchupError).code).toBe(code);
  if (msg) expect((err as CatchupError).message).toMatch(msg);
}

/** Change one header's fee pool (a well-formed but different header). */
function tamperHeader(b64: string): string {
  const h = decodeLedgerHeader(b64);
  h.feePool += 1n;
  return encodeLedgerHeader(h);
}

describe('catch-up by replay', () => {
  const chain = buildChain(20);

  it('replays the source chain to the target and verifies every ledger', async () => {
    const { host, state } = makeHost(chain);
    const res = await catchUpFrom(host, 'peer', chain.tip);
    expect(res).toMatchObject({ from: 1, to: 20, replayed: 19, snapshot: null });
    expect(state.replayed).toEqual(Array.from({ length: 19 }, (_, i) => i + 2));
    expect(state.lm.lastClosed().hash).toBe(chain.tip.hash);
    // already there: nothing to do
    expect((await catchUpFrom(host, 'peer', chain.tip)).replayed).toBe(0);
  });

  it('continues from a local LCL on the same chain', async () => {
    const { host, state } = makeHost(chain);
    await catchUpFrom(host, 'peer', { seq: 9, hash: chain.ledgers.get(9)!.hash });
    expect(state.lm.lastClosed().header.ledgerSeq).toBe(9);
    const res = await catchUpFrom(host, 'peer', chain.tip);
    expect(res.replayed).toBe(11);
    expect(state.lm.lastClosed().hash).toBe(chain.tip.hash);
  });

  it('rejects a tampered header in the ledgers answer before applying it', async () => {
    const { host, state } = makeHost(chain, undefined, (body, res) => {
      if (res.kind === 'ledgers') for (const i of res.items) if (i.seq === 12) i.headerXdr = tamperHeader(i.headerXdr);
      return res;
    });
    await expectCatchupError(catchUpFrom(host, 'peer', chain.tip), 'bad-source', /header 12 does not match/);
    expect(state.lm.lastClosed().header.ledgerSeq).toBe(11);
    expect(state.lm.lastClosed().hash).toBe(chain.ledgers.get(11)!.hash);
  });

  it('rejects a tampered header chain before applying anything', async () => {
    const { host, state } = makeHost(chain, undefined, (body, res) => {
      if (res.kind === 'headers') for (const i of res.items) if (i.seq === 7) i.headerXdr = tamperHeader(i.headerXdr);
      return res;
    });
    await expectCatchupError(catchUpFrom(host, 'peer', chain.tip), 'bad-source', /does not link/);
    expect(state.replayed).toEqual([]);
    expect(state.lm.lastClosed().header.ledgerSeq).toBe(1);
  });

  it('rejects a tx set that does not match the header', async () => {
    const swapped = chain.ledgers.get(9)!.txSetXdr;
    const { host, state } = makeHost(chain, undefined, (body, res) => {
      if (res.kind === 'ledgers') for (const i of res.items) if (i.seq === 6) i.txSetXdr = swapped;
      return res;
    });
    await expectCatchupError(catchUpFrom(host, 'peer', chain.tip), 'bad-source', /tx set of ledger 6/);
    expect(state.lm.lastClosed().header.ledgerSeq).toBe(5);
    const garbage = makeHost(chain, undefined, (body, res) => {
      if (res.kind === 'ledgers') for (const i of res.items) if (i.seq === 4) i.txSetXdr = 'AAAA';
      return res;
    });
    await expectCatchupError(catchUpFrom(garbage.host, 'peer', chain.tip), 'bad-source', /malformed/);
  });

  it('rejects a consistent chain that does not end at the target', async () => {
    const other = buildChain(20, { seed: 'x' });
    const { host, state } = makeHost(other);
    await expectCatchupError(catchUpFrom(host, 'peer', chain.tip), 'bad-source', /does not end at the target/);
    expect(state.replayed).toEqual([]);
  });

  it('reports a fork when our LCL is not on the source chain', async () => {
    const other = buildChain(20, { seed: 'y' });
    const ours = makeHost(other);
    await catchUpFrom(ours.host, 'peer', { seq: 5, hash: other.ledgers.get(5)!.hash });
    const { host } = makeHost(chain, ours.state.lm);
    await expectCatchupError(catchUpFrom(host, 'peer', chain.tip), 'fork');
    // same seq, other hash
    await expectCatchupError(catchUpFrom(host, 'peer', { seq: 5, hash: chain.ledgers.get(5)!.hash }), 'fork');
  });

  it('reports missing data', async () => {
    const holes: Chain = { ...chain, ledgers: new Map([...chain.ledgers].filter(([s]) => s !== 15)) };
    const { host, state } = makeHost(holes);
    await expectCatchupError(catchUpFrom(host, 'peer', chain.tip), 'no-data', /header 15/);
    expect(state.replayed).toEqual([]);
  });

  it('fetchHeaderChain checks seq numbers and links', async () => {
    const { host } = makeHost(chain, undefined, (body, res) => {
      if (res.kind === 'headers') for (const i of res.items) if (i.seq === 3) i.headerXdr = chain.ledgers.get(4)!.headerXdr;
      return res;
    });
    await expectCatchupError(
      fetchHeaderChain(host, 'peer', 2, 5, chain.ledgers.get(1)!.hash, chain.ledgers.get(5)!.hash),
      'bad-source',
      /claims seq 4/,
    );
  });
});

describe('catch-up from a snapshot', () => {
  const chain = buildChain(70);

  it('loads the checkpoint snapshot, checks it links to the target, replays the rest', async () => {
    expect(checkpointAtOrBefore(70)).toBe(64);
    expect([...chain.snapshots.keys()]).toEqual([64]);
    const { host, state } = makeHost(chain);
    const res = await catchUpFrom(host, 'peer', chain.tip);
    expect(res).toMatchObject({ snapshot: 64, replayed: 6 });
    expect(state.installed).toEqual([64]);
    expect(state.replayed).toEqual([65, 66, 67, 68, 69, 70]);
    expect(state.lm.lastClosed().hash).toBe(chain.tip.hash);
  });

  it('rejects a tampered snapshot (state does not match the header)', async () => {
    const { host, state } = makeHost(chain, undefined, (body, res) => {
      if (res.kind === 'snapshot') {
        const snap = JSON.parse(res.data) as LedgerSnapshot;
        const acct = snap.entries.find((e) => (e as { kind: string }).kind === 'account') as { balance: string };
        acct.balance = (BigInt(acct.balance) + 1n).toString();
        res.data = JSON.stringify(snap);
      }
      return res;
    });
    await expectCatchupError(catchUpFrom(host, 'peer', chain.tip), 'bad-source', /snapshot 64 does not verify/);
    expect(state.installed).toEqual([]);
    expect(state.lm.lastClosed().header.ledgerSeq).toBe(1);
  });

  it('rejects a snapshot that does not lead to the target', async () => {
    const other = buildChain(70, { seed: 'z' });
    const mixed: Chain = { ...chain, snapshots: other.snapshots };
    const { host, state } = makeHost(mixed);
    // the snapshot must sit on our own chain: the header chain from our LCL up
    // to the snapshot does not end at the snapshot's hash, so it is rejected
    await expectCatchupError(catchUpFrom(host, 'peer', chain.tip), 'bad-source', /does not (link|end at the target)/);
    expect(state.installed).toEqual([]);
  });

  it('uses a source that holds no ledgers between genesis and its snapshot', async () => {
    // a source that itself joined from snapshot 64: genesis, the snapshot, 65..70
    const born: Chain = { ...chain, ledgers: new Map([...chain.ledgers].filter(([s]) => s === 1 || s > 64)) };
    const fresh = makeHost(born);
    const res = await catchUpFrom(fresh.host, 'peer', chain.tip);
    expect(res).toMatchObject({ snapshot: 64, replayed: 6 });
    expect(fresh.state.lm.lastClosed().hash).toBe(chain.tip.hash);
    // a node at ledger 10 of the same chain: the source lacks ledger 10, the snapshot still serves
    const start = makeHost(chain);
    await catchUpFrom(start.host, 'peer', { seq: 10, hash: chain.ledgers.get(10)!.hash }, { allowSnapshot: false });
    const behind = makeHost(born, start.state.lm);
    expect((await catchUpFrom(behind.host, 'peer', chain.tip)).snapshot).toBe(64);
    expect(behind.state.lm.lastClosed().hash).toBe(chain.tip.hash);
  });

  it('falls back to replay when the snapshot is not ahead of us', async () => {
    const start = makeHost(chain);
    await catchUpFrom(start.host, 'peer', { seq: 66, hash: chain.ledgers.get(66)!.hash }, { allowSnapshot: false });
    const { host, state } = makeHost(chain, start.state.lm);
    const res = await catchUpFrom(host, 'peer', chain.tip);
    expect(res.snapshot).toBeNull();
    expect(state.replayed).toEqual([67, 68, 69, 70]);
  });
});

describe('forks', () => {
  it('decideFork: weight first, close weights by the first ledger hash', () => {
    const lcl = { seq: 10, hash: 'b'.repeat(64) };
    const other = { seq: 9, hash: 'a'.repeat(64) };
    expect(decideFork({ weight: 30, lcl, first: 'f' }, { weight: 10, lcl: other, first: 'e' })).toBe('ours');
    expect(decideFork({ weight: 10, lcl, first: 'e' }, { weight: 30, lcl: other, first: 'f' })).toBe('theirs');
    // within the tolerance: the lower first hash wins on both sides
    expect(decideFork({ weight: 20, lcl, first: '2' }, { weight: 22, lcl: other, first: '1' })).toBe('theirs');
    expect(decideFork({ weight: 22, lcl: other, first: '1' }, { weight: 20, lcl, first: '2' })).toBe('ours');
    // unknown first hashes: higher LCL seq, then lower LCL hash
    expect(decideFork({ weight: 5, lcl, first: '' }, { weight: 5, lcl: other, first: '' })).toBe('ours');
    expect(decideFork({ weight: 5, lcl: { seq: 9, hash: 'c'.repeat(64) }, first: '' }, { weight: 5, lcl: other, first: '' })).toBe('theirs');
  });

  it('findForkPoint walks back to the last common ledger', async () => {
    const a = buildChain(90);
    // b shares ledgers 1..2 with a only if built from the same funding tx: build a branch by replaying a's first ledgers
    const branch: Chain = { ledgers: new Map(), snapshots: new Map(), tip: a.tip };
    for (const [s, l] of a.ledgers) if (s <= 75) branch.ledgers.set(s, l);
    const fake = buildChain(90, { seed: 'q' });
    for (const [s, l] of fake.ledgers) if (s > 75) branch.ledgers.set(s, { ...l, hash: `${l.hash.slice(0, 60)}0000` });
    const { host } = makeHost(branch);
    const ours = (s: number) => Promise.resolve(a.ledgers.get(s)?.hash);
    const fp = await findForkPoint(host, 'peer', 90, ours);
    expect(fp?.forkPoint).toBe(75);
    expect(fp?.ourNext).toBe(a.ledgers.get(76)!.hash);
    expect(fp?.theirNext).not.toBe(a.ledgers.get(76)!.hash);
    // no common ledger within the depth limit
    expect(await findForkPoint(host, 'peer', 90, () => Promise.resolve('x'), 30)).toBeNull();
  });
});
