// validateValue does the cheap close-time checks before the signature check
// (about 0.6 ms per value in JS): values with a close time that cannot pass
// must not cost a signature verification.

import { Keypair } from '@stellar/stellar-sdk/base';
import { describe, expect, it, vi } from 'vitest';
import { VirtualClock } from '../lib/clock';
import { MAX_TIME_SLIP_SECONDS } from '../lib/constants';
import { LogSink, Logger } from '../lib/log';
import { createGenesisLedger } from '../ledger/manager';
import { encodeStellarValue, makeSignedStellarValue } from '../ledger/value';
import { ValidationLevel } from '../scp/types';
import type { CachedTxSet } from './pendingEnvelopes';
import { HerderSCPDriver } from './scpDriver';
import { txSetStats } from './values';

const sigChecks = vi.hoisted(() => ({ n: 0 }));

vi.mock('./values', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./values')>();
  return {
    ...mod,
    verifyValueSignature: (...args: Parameters<typeof mod.verifyValueSignature>) => {
      sigChecks.n++;
      return mod.verifyValueSignature(...args);
    },
  };
});

function setup() {
  const lm = createGenesisLedger('scp driver order test');
  const lcl = lm.lastClosed();
  const nowSec = lcl.header.scpValue.closeTime + 1000;
  const clock = new VirtualClock(nowSec * 1000);
  const node = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(3));
  const txSet = lm.makeTxSet(lcl.hash, []);
  const cached: CachedTxSet = { info: txSet, slot: 2, stats: txSetStats(txSet, lm.networkId) };
  const driver = new HerderSCPDriver({
    keypair: node,
    networkId: lm.networkId,
    clock,
    logger: new Logger(new LogSink(clock, 'error'), 'test'),
    ledger: () => lm,
    getQSet: () => null,
    getTxSet: (h) => (h === txSet.hash ? cached : undefined),
    emitEnvelope: () => undefined,
    valueExternalized: () => undefined,
    progress: () => undefined,
    nodeName: () => 'n',
  });
  const value = (closeTime: number) => encodeStellarValue(makeSignedStellarValue(lm.networkId, node, txSet.hash, closeTime));
  return { driver, value, slot: lcl.header.ledgerSeq + 1, lclClose: lcl.header.scpValue.closeTime, nowSec };
}

describe('HerderSCPDriver.validateValue check order', () => {
  it('rejects a close time at or before the LCL without a signature check', () => {
    const { driver, value, slot, lclClose } = setup();
    const v = value(lclClose);
    sigChecks.n = 0;
    expect(driver.validateValue(slot, v, true)).toBe(ValidationLevel.Invalid);
    expect(driver.validateValue(slot, v, false)).toBe(ValidationLevel.Invalid);
    // a future slot whose value does not close after our LCL
    expect(driver.validateValue(slot + 3, v, true)).toBe(ValidationLevel.Invalid);
    expect(sigChecks.n).toBe(0);
  });

  it('rejects a nominated close time beyond the slip window without a signature check', () => {
    const { driver, value, slot, nowSec } = setup();
    const v = value(nowSec + MAX_TIME_SLIP_SECONDS + 1);
    sigChecks.n = 0;
    expect(driver.validateValue(slot, v, true)).toBe(ValidationLevel.Invalid);
    expect(sigChecks.n).toBe(0);
  });

  it('still checks the signature of a value with a good close time', () => {
    const { driver, value, slot, nowSec } = setup();
    const v = value(nowSec);
    sigChecks.n = 0;
    expect(driver.validateValue(slot, v, true)).toBe(ValidationLevel.FullyValidated);
    expect(sigChecks.n).toBe(1);
    // outside the nomination, a far close time is only checked against the LCL (ballot values)
    sigChecks.n = 0;
    expect(driver.validateValue(slot, value(nowSec + MAX_TIME_SLIP_SECONDS + 1), false)).toBe(ValidationLevel.FullyValidated);
    expect(sigChecks.n).toBe(1);
    // other slots: MaybeValid after the signature check
    sigChecks.n = 0;
    expect(driver.validateValue(slot + 3, v, true)).toBe(ValidationLevel.MaybeValid);
    expect(sigChecks.n).toBe(1);
  });
});
