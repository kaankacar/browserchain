import { describe, expect, it } from 'vitest';
import * as ledger from './index';
import { applyDexOperation, checkDexOperationValid } from './dex';

describe('ledger module entry point', () => {
  it('exports the public API', () => {
    for (const name of [
      'createGenesisLedger',
      'loadLedgerFromSnapshot',
      'friendbotKeypairs',
      'friendbotChannelIds',
      'channelPolicyAllows',
      'isDexOperation',
      'hasDexOperations',
      'rootKeypair',
      'encodeStellarValue',
      'decodeStellarValue',
      'signStellarValue',
      'verifyStellarValueSignature',
      'stellarValueSignaturePayload',
      'encodeLedgerHeader',
      'decodeLedgerHeader',
      'hashLedgerHeader',
      'makeTxSet',
      'decodeTxSet',
      'computeStateHash',
      'serializeEntry',
      'deserializeEntry',
      'canonicalJson',
      'summarizeOperations',
      'extractMemo',
      'touchedAccounts',
      'describeTransaction',
      'getAvailableBalance',
      'getMaxAmountReceive',
      'minBalance',
      'addBalance',
    ]) {
      expect(typeof (ledger as Record<string, unknown>)[name], name).toBe('function');
    }
    const lm = ledger.createGenesisLedger('entry point test');
    expect(lm.lastClosed().header.ledgerSeq).toBe(1);
  });

  it('DEX entry points exist', () => {
    expect(typeof applyDexOperation).toBe('function');
    expect(typeof checkDexOperationValid).toBe('function');
  });
});
