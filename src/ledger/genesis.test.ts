import { Keypair } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { ZERO_HASH } from '../lib/bytes';
import {
  BASE_FEE,
  BASE_RESERVE,
  FRIENDBOT_CHANNELS,
  FRIENDBOT_CHANNEL_BALANCE,
  MAX_TX_SET_SIZE,
  PROTOCOL_VERSION,
  TOTAL_COINS,
  networkPassphrase,
} from '../lib/constants';
import { sha256 } from '../lib/hash';
import { computeStateHash } from './entries';
import { friendbotChannelIds, friendbotKeypairs, genesisEntries, genesisHeader, rootKeypair } from './genesis';
import { decodeLedgerHeader, encodeLedgerHeader, hashLedgerHeader } from './header';
import { createGenesisLedger } from './manager';

const PASS = networkPassphrase();

describe('genesis', () => {
  it('is deterministic: two nodes build the same genesis header hash', () => {
    const a = createGenesisLedger(PASS);
    const b = createGenesisLedger(PASS);
    expect(a.lastClosed().hash).toBe(b.lastClosed().hash);
    expect(a.lastClosed().headerXdr).toBe(b.lastClosed().headerXdr);
    expect(a.stateHash()).toBe(b.stateHash());
  });

  it('header hash is stable across codec round trips', () => {
    const lm = createGenesisLedger(PASS);
    const { header, hash, headerXdr } = lm.lastClosed();
    expect(hashLedgerHeader(header)).toBe(hash);
    const decoded = decodeLedgerHeader(headerXdr);
    expect(decoded).toEqual(header);
    expect(encodeLedgerHeader(decoded)).toBe(headerXdr);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs between networks', () => {
    const a = createGenesisLedger(networkPassphrase('a'));
    const b = createGenesisLedger(networkPassphrase('b'));
    expect(a.lastClosed().hash).not.toBe(b.lastClosed().hash);
  });

  it('has the documented header fields', () => {
    const h = genesisHeader(PASS);
    expect(h.ledgerVersion).toBe(PROTOCOL_VERSION);
    expect(h.ledgerSeq).toBe(1);
    expect(h.previousLedgerHash).toBe(ZERO_HASH);
    expect(h.scpValue).toEqual({ txSetHash: ZERO_HASH, closeTime: 0, upgrades: [], signature: null });
    expect(h.txSetResultHash).toBe(ZERO_HASH);
    expect(h.totalCoins).toBe(TOTAL_COINS);
    expect(h.feePool).toBe(0n);
    expect(h.inflationSeq).toBe(0);
    expect(h.idPool).toBe(0n);
    expect(h.baseFee).toBe(BASE_FEE);
    expect(h.baseReserve).toBe(BASE_RESERVE);
    expect(h.maxTxSetSize).toBe(MAX_TX_SET_SIZE);
    expect(h.skipList).toEqual([ZERO_HASH, ZERO_HASH, ZERO_HASH, ZERO_HASH]);
    expect(h.bucketListHash).toBe(computeStateHash(genesisEntries(PASS)));
  });

  it('creates the root (locked: master weight 0) and friendbot accounts', () => {
    const lm = createGenesisLedger(PASS);
    const root = lm.getAccount(rootKeypair(PASS).publicKey())!;
    expect(root.balance).toBe(TOTAL_COINS - BigInt(FRIENDBOT_CHANNELS) * FRIENDBOT_CHANNEL_BALANCE);
    expect(root.seqNum).toBe(0n);
    expect(root.thresholds).toEqual({ master: 0, low: 0, med: 0, high: 0 });
    expect(root.signers).toEqual([]);
    expect(root.lastModifiedLedgerSeq).toBe(1);
    const bots = friendbotKeypairs(PASS);
    expect(bots).toHaveLength(FRIENDBOT_CHANNELS);
    expect([...friendbotChannelIds(PASS)]).toEqual(bots.map((k) => k.publicKey()));
    for (let i = 0; i < bots.length; i++) {
      const expected = Keypair.fromRawEd25519Seed(sha256(`${PASS}|friendbot|${i}`));
      expect(bots[i].publicKey()).toBe(expected.publicKey());
      const acc = lm.getAccount(bots[i].publicKey())!;
      expect(acc.balance).toBe(FRIENDBOT_CHANNEL_BALANCE);
      expect(acc.seqNum).toBe(0n);
      expect(acc.thresholds).toEqual({ master: 1, low: 0, med: 0, high: 0 });
    }
    expect(lm.entryCount()).toBe(1 + FRIENDBOT_CHANNELS);
    const total = lm.allEntries().reduce((s, e) => s + (e.kind === 'account' ? e.balance : 0n), 0n);
    expect(total).toBe(TOTAL_COINS);
  });

  it('the unlockRoot test option differs only in the root master weight', () => {
    const locked = genesisEntries(PASS);
    const open = genesisEntries(PASS, { unlockRoot: true });
    expect(open[0].thresholds).toEqual({ master: 1, low: 0, med: 0, high: 0 });
    expect(open.slice(1)).toEqual(locked.slice(1));
    expect({ ...open[0], thresholds: locked[0].thresholds }).toEqual(locked[0]);
    expect(genesisHeader(PASS, { unlockRoot: true }).bucketListHash).toBe(computeStateHash(open));
    expect(createGenesisLedger(PASS, { unlockRoot: true }).lastClosed().hash).not.toBe(createGenesisLedger(PASS).lastClosed().hash);
  });
});
