import { afterEach, describe, expect, it } from 'vitest';
import { TrysteroHost, type TrysteroActionLike, type TrysteroRoomLike } from '../overlay/trysteroHost';
import type { WireMessage } from '../overlay/types';
import {
  BridgePort,
  IDENTITY_SLOTS,
  claimIdentitySlot,
  parseBootParams,
  requestPersistence,
  slotLockName,
  type LockManagerLike,
  type StorageManagerLike,
} from './boot';

/** navigator.locks for one origin: exclusive locks, ifAvailable, held while the callback's promise runs. */
class FakeLocks implements LockManagerLike {
  readonly held = new Set<string>();
  requests = 0;

  async request(name: string, options: { ifAvailable: boolean }, callback: (lock: unknown) => unknown): Promise<unknown> {
    this.requests++;
    if (this.held.has(name)) {
      if (!options.ifAvailable) throw new Error('this fake only supports ifAvailable');
      return callback(null);
    }
    this.held.add(name);
    try {
      return await callback({ name, mode: 'exclusive' });
    } finally {
      this.held.delete(name);
    }
  }
}

describe('parseBootParams', () => {
  it('reads network, fresh, transport and name with defaults', () => {
    expect(parseBootParams('')).toEqual({ network: 'main', fresh: false, transport: 'both' });
    expect(parseBootParams('?network=devnet&fresh=1&transport=broadcast&name=%20alice%20')).toEqual({
      network: 'devnet',
      fresh: true,
      transport: 'broadcast',
      name: 'alice',
    });
    expect(parseBootParams('?transport=WEBRTC&fresh=true').transport).toBe('webrtc');
    expect(parseBootParams('?transport=pigeon&fresh=0')).toMatchObject({ transport: 'both', fresh: false });
    expect(parseBootParams('?network=%20%20').network).toBe('main');
    expect(parseBootParams(`?network=${'n'.repeat(100)}`).network).toHaveLength(64);
    expect(parseBootParams('?mock=1')).toEqual({ network: 'main', fresh: false, transport: 'both' });
  });
});

describe('claimIdentitySlot', () => {
  it('gives each tab the first free slot and keeps it until released', async () => {
    const locks = new FakeLocks();
    const a = await claimIdentitySlot(locks, 'main');
    const b = await claimIdentitySlot(locks, 'main');
    const c = await claimIdentitySlot(locks, 'main');
    expect([a?.slot, b?.slot, c?.slot]).toEqual([0, 1, 2]);
    expect([...locks.held].sort()).toEqual([slotLockName('main', 0), slotLockName('main', 1), slotLockName('main', 2)]);
    // the tab with slot 1 closes: the next tab gets slot 1 (and its stored identity)
    b!.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(locks.held.has(slotLockName('main', 1))).toBe(false);
    expect((await claimIdentitySlot(locks, 'main'))?.slot).toBe(1);
    // another network has its own slots
    expect((await claimIdentitySlot(locks, 'devnet'))?.slot).toBe(0);
    expect(slotLockName('main', 7)).toBe('browserchain:main:slot:7');
  });

  it('returns null when every slot is taken, and passes errors on', async () => {
    const locks = new FakeLocks();
    for (let i = 0; i < IDENTITY_SLOTS; i++) expect((await claimIdentitySlot(locks, 'main'))?.slot).toBe(i);
    locks.requests = 0;
    expect(await claimIdentitySlot(locks, 'main')).toBeNull();
    expect(locks.requests).toBe(IDENTITY_SLOTS);
    expect(await claimIdentitySlot(locks, 'main', 0)).toBeNull();
    const broken: LockManagerLike = { request: () => Promise.reject(new DOMException('denied', 'SecurityError')) };
    await expect(claimIdentitySlot(broken, 'main')).rejects.toThrow('denied');
  });
});

describe('BridgePort', () => {
  const ports: MessagePort[] = [];
  afterEach(() => {
    for (const p of ports.splice(0)) p.close();
  });

  it('relays both ways and lets the page send our bye to WebRTC peers itself', async () => {
    const { port1, port2 } = new MessageChannel();
    ports.push(port1, port2);
    const sent: { data: WireMessage; target: string | string[] | null | undefined }[] = [];
    const action: TrysteroActionLike = {
      send: (data, opts) => {
        sent.push({ data, target: opts?.target });
      },
      onMessage: null,
    };
    let left = 0;
    const room: TrysteroRoomLike = {
      makeAction: () => action,
      onPeerJoin: null,
      onPeerLeave: null,
      leave: () => {
        left++;
      },
    };
    const bridge = new BridgePort(port1);
    const host = new TrysteroHost({ networkId: 'ab'.repeat(32), port: bridge, joinRoom: () => room });
    host.start();
    const toWorker: unknown[] = [];
    port2.addEventListener('message', (ev) => toWorker.push(ev.data));
    port2.start();
    room.onPeerJoin!('peer-1');
    // worker -> page -> peers
    port2.postMessage({ type: 'broadcast', msg: { t: 'status' } });
    for (let i = 0; i < 50 && sent.length === 0; i++) await new Promise((r) => setTimeout(r, 2));
    expect(sent).toEqual([{ data: { t: 'status' }, target: undefined }]);
    for (let i = 0; i < 50 && toWorker.length === 0; i++) await new Promise((r) => setTimeout(r, 2));
    expect(toWorker).toEqual([{ type: 'up', peer: 'peer-1' }]);
    // pagehide: the page sends the bye at once, then leaves the room
    bridge.inject({ type: 'broadcast', msg: { t: 'bye', nodeId: 'GSELF' } });
    expect(sent[1]).toEqual({ data: { t: 'bye', nodeId: 'GSELF' }, target: undefined });
    await host.stop();
    expect(left).toBe(1);
    // after stop the host no longer listens
    bridge.inject({ type: 'broadcast', msg: { t: 'bye', nodeId: 'GSELF' } });
    expect(sent).toHaveLength(2);
  });
});

describe('requestPersistence', () => {
  function logger() {
    const lines: string[] = [];
    return { lines, log: { info: (m: string) => lines.push(`info ${m}`), warn: (m: string) => lines.push(`warn ${m}`) } };
  }
  const estimate = async () => ({ usage: 3 * 1024 * 1024, quota: 2048 * 1024 * 1024 });

  it('logs every outcome with the storage estimate', async () => {
    const cases: [StorageManagerLike | undefined, string, string][] = [
      [{ persisted: async () => true, persist: async () => true, estimate }, 'already-persisted', 'info'],
      [{ persisted: async () => false, persist: async () => true, estimate }, 'granted', 'info'],
      [{ persisted: async () => false, persist: async () => false, estimate }, 'denied', 'warn'],
      [{ persist: async () => Promise.reject(new Error('no')) }, 'failed', 'warn'],
      [{}, 'unsupported', 'warn'],
      [undefined, 'unsupported', 'warn'],
    ];
    for (const [storage, result, level] of cases) {
      const { lines, log } = logger();
      expect(await requestPersistence(storage, log)).toBe(result);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(new RegExp(`^${level} BrowserChain: persistent storage ${result}`));
      if (storage?.estimate) expect(lines[0]).toContain('using 3 MB of 2048 MB');
    }
  });
});
