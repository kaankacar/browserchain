// LedgerManager: the ILedgerManager implementation (docs/ARCHITECTURE.md 7).

import { xdr } from '@stellar/stellar-sdk/base';
import { compareBytes, toBase64 } from '../lib/bytes';
import { MAX_DEX_OPS_IN_TX_SET, MAX_FRIENDBOT_TXS_IN_TX_SET } from '../lib/constants';
import { sha256Hex, networkIdOf } from '../lib/hash';
import { applyTransaction, chargeFee } from './apply';
import { minBalance as minBalanceFor } from './balances';
import { channelCreatedAccounts, usesChannel } from './channelPolicy';
import { extractMemo, summarizeOperations, touchedAccounts } from './describe';
import { hasDexOperations } from './dex';
import { cloneEntry, deserializeEntry, serializeEntry } from './entries';
import { friendbotChannelIds, genesisEntries, genesisHeader, type GenesisOptions } from './genesis';
import { decodeLedgerHeader, encodeLedgerHeader, hashLedgerHeader } from './header';
import { accountKey, keyKind } from './keys';
import { txResultToXdr, type TxCode } from './results';
import { LedgerRoot, cloneHeader, type LedgerTxn } from './state';
import { decodeTransaction, tryDecodeTransaction, type DecodedTx } from './tx';
import { computeTxSetHash, decodeTxSet as decodeTxSetXdr, isCanonicalOrder, makeTxSet as makeTxSetXdr, sortForApply } from './txset';
import type {
  AccountEntry,
  Asset,
  ClaimableBalanceEntry,
  DataEntry,
  Hash,
  ILedgerManager,
  LedgerCloseResult,
  LedgerEntry,
  LedgerHeader,
  LedgerKey,
  LedgerSnapshot,
  OfferEntry,
  StellarValueInfo,
  TrustLineEntry,
  TxApplyResult,
  TxCheckOptions,
  TxCheckResult,
  TxSetInfo,
} from './types';
import { checkTransactionValid, type TxValidity } from './validate';

function byKey(a: { k: string }, b: { k: string }): number {
  return a.k < b.k ? -1 : a.k > b.k ? 1 : 0;
}

/** Fee rate order for surge pricing: higher fee per operation first, then lower envelope hash. */
function betterFeeRate(a: DecodedTx, b: DecodedTx): boolean {
  const l = a.fee * BigInt(Math.max(1, b.ops.length));
  const r = b.fee * BigInt(Math.max(1, a.ops.length));
  if (l !== r) return l > r;
  return compareBytes(a.fullHash, b.fullHash) < 0;
}

export class LedgerManager implements ILedgerManager {
  readonly networkPassphrase: string;
  readonly networkId: Uint8Array;
  private readonly root: LedgerRoot;
  /** Friendbot channel account ids (channel policy). */
  private readonly channels: ReadonlySet<string>;
  private lcl: { header: LedgerHeader; hash: Hash; headerXdr: string };

  /** Use createGenesisLedger or loadLedgerFromSnapshot. */
  constructor(networkPassphrase: string, root: LedgerRoot, header: LedgerHeader) {
    this.networkPassphrase = networkPassphrase;
    this.networkId = networkIdOf(networkPassphrase);
    this.channels = friendbotChannelIds(networkPassphrase);
    this.root = root;
    const headerXdr = encodeLedgerHeader(header);
    this.lcl = { header: cloneHeader(header), hash: hashLedgerHeader(header), headerXdr };
  }

  // ------------------------------------------------------------ queries

  lastClosed(): { header: LedgerHeader; hash: Hash; headerXdr: string } {
    return { header: cloneHeader(this.lcl.header), hash: this.lcl.hash, headerXdr: this.lcl.headerXdr };
  }

  getEntry(key: LedgerKey): LedgerEntry | undefined {
    const e = this.root.get(key);
    return e ? cloneEntry(e as LedgerEntry) : undefined;
  }

  getAccount(accountId: string): AccountEntry | undefined {
    return this.getEntry(accountKey(accountId)) as AccountEntry | undefined;
  }

  private owned<T extends LedgerEntry>(accountId: string, kind: LedgerEntry['kind']): T[] {
    const out: T[] = [];
    for (const k of this.root.ownedKeys(accountId)) {
      if (keyKind(k) !== kind) continue;
      const e = this.root.get(k);
      if (e) out.push(cloneEntry(e as T));
    }
    return out;
  }

  getTrustLines(accountId: string): TrustLineEntry[] {
    return this.owned<TrustLineEntry>(accountId, 'trustline')
      .map((e) => ({ k: `${e.asset.code}:${e.asset.issuer}`, e }))
      .sort(byKey)
      .map((x) => x.e);
  }

  getOffersByAccount(accountId: string): OfferEntry[] {
    return this.owned<OfferEntry>(accountId, 'offer').sort((a, b) =>
      a.offerId < b.offerId ? -1 : a.offerId > b.offerId ? 1 : 0,
    );
  }

  getDataEntries(accountId: string): DataEntry[] {
    return this.owned<DataEntry>(accountId, 'data')
      .map((e) => ({ k: e.name, e }))
      .sort(byKey)
      .map((x) => x.e);
  }

  getClaimableBalances(filter: { claimant?: string; sponsor?: string }): ClaimableBalanceEntry[] {
    const out: ClaimableBalanceEntry[] = [];
    for (const k of this.root.claimableBalanceKeys()) {
      const e = this.root.get(k) as ClaimableBalanceEntry | undefined;
      if (!e) continue;
      if (filter.sponsor && e.sponsor !== filter.sponsor) continue;
      if (filter.claimant && !e.claimants.some((c) => c.destination === filter.claimant)) continue;
      out.push(cloneEntry(e));
    }
    return out.sort((a, b) => (a.balanceId < b.balanceId ? -1 : a.balanceId > b.balanceId ? 1 : 0));
  }

  getOrderBook(selling: Asset, buying: Asset, limit = 100): OfferEntry[] {
    return this.root
      .sortedBook(selling, buying)
      .slice(0, Math.max(0, limit))
      .map((o) => cloneEntry(o as OfferEntry));
  }

  allEntries(): LedgerEntry[] {
    return [...this.root.keys()].sort().map((k) => cloneEntry(this.root.get(k) as LedgerEntry));
  }

  entryCount(): number {
    return this.root.size();
  }

  minBalance(account: AccountEntry): bigint {
    return minBalanceFor(this.lcl.header, account);
  }

  // ------------------------------------------------------------ transactions

  checkValid(envelopeXdr: string, opts: TxCheckOptions = {}): TxCheckResult {
    const tx = tryDecodeTransaction(envelopeXdr, this.networkId);
    if (!tx) {
      return { ok: false, hash: '', sourceAccount: '', seqNum: 0n, fee: 0n, opCount: 0, code: 'txMALFORMED', detail: 'cannot decode the transaction envelope' };
    }
    const base = { hash: tx.hashHex, sourceAccount: tx.sourceId, seqNum: tx.seqNum, fee: tx.fee, opCount: tx.ops.length };
    const v = this.validate(tx, opts.closeTime ?? this.lcl.header.scpValue.closeTime, opts);
    return v.ok ? { ok: true, ...base } : { ok: false, ...base, code: v.code, detail: v.detail };
  }

  /** checkValid on a decoded transaction against the LCL state. */
  private validate(
    tx: DecodedTx,
    closeTime: number,
    opts: { seqNumOverride?: bigint; pendingFees?: bigint; ledgerSeq?: number; chainCreates?: ReadonlySet<string> },
  ): TxValidity {
    const ledgerSeq = opts.ledgerSeq ?? this.lcl.header.ledgerSeq + 1;
    let ltx: LedgerTxn | undefined;
    try {
      ltx = this.root.begin(this.lcl.header, ledgerSeq);
      return checkTransactionValid(tx, {
        ltx,
        ledgerSeq,
        closeTime: BigInt(closeTime),
        applying: false,
        seqNumOverride: opts.seqNumOverride,
        pendingFees: opts.pendingFees,
        friendbotChannels: this.channels,
        chainCreates: opts.chainCreates,
      });
    } catch (err) {
      return { ok: false, code: 'txINTERNAL_ERROR', detail: String(err) };
    } finally {
      ltx?.rollback();
    }
  }

  makeTxSet(previousLedgerHash: Hash, envelopes: string[]): TxSetInfo {
    return makeTxSetXdr(previousLedgerHash, envelopes);
  }

  decodeTxSet(xdrB64: string): TxSetInfo {
    return decodeTxSetXdr(xdrB64);
  }

  /**
   * Validate the transactions of each source account as a chain against the
   * LCL state: the first uses the account's sequence number, the next ones
   * the previous transaction's, fees add up, and accounts created by earlier
   * channel CreateAccounts count for the channel destination rule. Returns
   * per-envelope validity (null = valid) for the given decoded transactions,
   * grouped by account.
   */
  private validateChains(
    txs: DecodedTx[],
    closeTime: number,
    tieBreakByFee: boolean,
  ): Map<DecodedTx, TxValidity | null> {
    const out = new Map<DecodedTx, TxValidity | null>();
    const groups = new Map<string, DecodedTx[]>();
    for (const tx of txs) {
      let g = groups.get(tx.sourceId);
      if (!g) {
        g = [];
        groups.set(tx.sourceId, g);
      }
      g.push(tx);
    }
    for (const g of groups.values()) {
      g.sort((a, b) => {
        if (a.seqNum !== b.seqNum) return a.seqNum < b.seqNum ? -1 : 1;
        if (tieBreakByFee && a.fee !== b.fee) return a.fee > b.fee ? -1 : 1;
        return compareBytes(a.fullHash, b.fullHash);
      });
      let prevSeq: bigint | undefined;
      let pending = 0n;
      let broken: TxValidity | null = null;
      const created = new Set<string>();
      for (const tx of g) {
        if (broken) {
          out.set(tx, { ok: false, code: 'txBAD_SEQ', detail: 'an earlier transaction of the account is invalid' });
          continue;
        }
        if (tieBreakByFee && prevSeq !== undefined && tx.seqNum === prevSeq) {
          out.set(tx, { ok: false, code: 'txBAD_SEQ', detail: 'duplicate sequence number' });
          continue;
        }
        const v = this.validate(tx, closeTime, { seqNumOverride: prevSeq, pendingFees: pending, chainCreates: created });
        if (!v.ok) {
          out.set(tx, v);
          broken = v;
          continue;
        }
        out.set(tx, null);
        prevSeq = tx.seqNum;
        pending += tx.fee;
        for (const id of channelCreatedAccounts(tx, this.channels)) created.add(id);
      }
    }
    return out;
  }

  checkTxSetValid(txSet: TxSetInfo, closeTime: number): { valid: boolean; reason?: string } {
    const lcl = this.lcl;
    if (txSet.previousLedgerHash !== lcl.hash) return { valid: false, reason: 'previous ledger hash mismatch' };
    const txs: DecodedTx[] = [];
    for (const env of txSet.txs) {
      const tx = tryDecodeTransaction(env, this.networkId);
      if (!tx) return { valid: false, reason: 'undecodable transaction' };
      txs.push(tx);
    }
    if (computeTxSetHash(txSet.previousLedgerHash, txs.map((t) => t.envelopeBytes)) !== txSet.hash) {
      return { valid: false, reason: 'tx set hash mismatch' };
    }
    if (!isCanonicalOrder(txs.map((t) => t.fullHash))) {
      return { valid: false, reason: 'transactions not in canonical order or duplicated' };
    }
    const ops = txs.reduce((n, t) => n + t.ops.length, 0);
    if (ops > lcl.header.maxTxSetSize) return { valid: false, reason: `too many operations (${ops})` };
    const dexOps = txs.reduce((n, t) => (hasDexOperations(t) ? n + t.ops.length : n), 0);
    if (dexOps > MAX_DEX_OPS_IN_TX_SET) return { valid: false, reason: `too many DEX operations (${dexOps})` };
    const channelTxs = txs.reduce((n, t) => (usesChannel(t, this.channels) ? n + 1 : n), 0);
    if (channelTxs > MAX_FRIENDBOT_TXS_IN_TX_SET) {
      return { valid: false, reason: `too many friendbot channel transactions (${channelTxs})` };
    }
    const validity = this.validateChains(txs, closeTime, false);
    for (const tx of txs) {
      const v = validity.get(tx);
      if (v) return { valid: false, reason: `transaction ${tx.hashHex} invalid: ${v.code}${v.detail ? ` (${v.detail})` : ''}` };
    }
    return { valid: true };
  }

  trimInvalid(envelopes: string[], closeTime: number): { valid: string[]; invalid: string[] } {
    const invalid = new Set<number>();
    const decoded: { index: number; tx: DecodedTx }[] = [];
    const seen = new Set<string>();
    envelopes.forEach((env, index) => {
      const tx = tryDecodeTransaction(env, this.networkId);
      if (!tx) {
        invalid.add(index);
        return;
      }
      // Exact duplicates are ignored (only the first copy is considered).
      if (seen.has(tx.fullHashHex)) return;
      seen.add(tx.fullHashHex);
      decoded.push({ index, tx });
    });
    const indexOf = new Map<DecodedTx, number>(decoded.map((d) => [d.tx, d.index]));
    const validity = this.validateChains(
      decoded.map((d) => d.tx),
      closeTime,
      true,
    );

    // Accepted chains per account, in sequence order.
    const queues = new Map<string, DecodedTx[]>();
    for (const { tx } of decoded) {
      if (validity.get(tx)) {
        invalid.add(indexOf.get(tx)!);
        continue;
      }
      let q = queues.get(tx.sourceId);
      if (!q) {
        q = [];
        queues.set(tx.sourceId, q);
      }
      q.push(tx);
    }
    for (const q of queues.values()) q.sort((a, b) => (a.seqNum < b.seqNum ? -1 : a.seqNum > b.seqNum ? 1 : 0));

    // Surge pricing (legacy surgePricingFilter): take the best fee rate head
    // transaction while operations fit; an account whose head does not fit is
    // dropped. A transaction with a DEX operation must also fit the DEX lane
    // (stellar-core DexLimitingLaneConfig): MAX_DEX_OPS_IN_TX_SET operations.
    // A transaction that uses a friendbot channel must fit the friendbot lane:
    // MAX_FRIENDBOT_TXS_IN_TX_SET transactions. They all bid the base fee for
    // one operation (channel policy), so the lane takes the lowest envelope
    // hashes among the account heads, and sequence chains stay intact.
    const accepted = new Set<number>();
    let opsLeft = this.lcl.header.maxTxSetSize;
    let dexOpsLeft = MAX_DEX_OPS_IN_TX_SET;
    let channelTxsLeft = MAX_FRIENDBOT_TXS_IN_TX_SET;
    const live = [...queues.values()].map((txs) => ({ txs, pos: 0 }));
    while (opsLeft > 0 && live.length > 0) {
      let best = 0;
      for (let i = 1; i < live.length; i++) {
        if (betterFeeRate(live[i].txs[live[i].pos], live[best].txs[live[best].pos])) best = i;
      }
      const q = live[best];
      const head = q.txs[q.pos];
      const n = Math.max(1, head.ops.length);
      const dex = hasDexOperations(head);
      const channel = usesChannel(head, this.channels);
      if (n <= opsLeft && (!dex || n <= dexOpsLeft) && (!channel || channelTxsLeft > 0)) {
        accepted.add(indexOf.get(head)!);
        opsLeft -= n;
        if (dex) dexOpsLeft -= n;
        if (channel) channelTxsLeft--;
        q.pos++;
        if (q.pos >= q.txs.length) live.splice(best, 1);
      } else {
        live.splice(best, 1);
      }
    }

    return {
      valid: envelopes.filter((_, i) => accepted.has(i)),
      invalid: envelopes.filter((_, i) => invalid.has(i)),
    };
  }

  closeLedger(txSet: TxSetInfo, value: StellarValueInfo): LedgerCloseResult {
    const lcl = this.lcl;
    if (txSet.previousLedgerHash !== lcl.hash) throw new Error('tx set does not build on the last closed ledger');
    if (value.txSetHash !== txSet.hash) throw new Error('value does not match the tx set hash');
    if (value.upgrades.length > 0) throw new Error('ledger upgrades are not supported');

    const txs = txSet.txs.map((env) => decodeTransaction(env, this.networkId));
    if (computeTxSetHash(txSet.previousLedgerHash, txs.map((t) => t.envelopeBytes)) !== txSet.hash) {
      throw new Error('tx set hash mismatch');
    }

    const ledgerSeq = lcl.header.ledgerSeq + 1;
    const closeTime = BigInt(value.closeTime);
    const working = cloneHeader(lcl.header);
    working.ledgerSeq = ledgerSeq;
    working.previousLedgerHash = lcl.hash;
    working.scpValue = {
      txSetHash: value.txSetHash,
      closeTime: value.closeTime,
      upgrades: [],
      signature: value.signature ? { ...value.signature } : null,
    };

    const order = sortForApply(txs, txSet.hash);
    const ltx = this.root.begin(working, ledgerSeq);
    let results: TxApplyResult[];
    let resultSetXdr: string;
    let txSetResultHash: Hash;
    let finalWorking: LedgerHeader;
    let changedKeys: LedgerKey[];
    try {
      const fees = order.map((tx) => chargeFee(ltx, tx));
      const outcomes = order.map((tx) => applyTransaction(ltx, tx, ledgerSeq, closeTime, this.channels));

      const pairs: xdr.TransactionResultPair[] = [];
      results = order.map((tx, i) => {
        const { code, opResults } = outcomes[i];
        const resultXdr = txResultToXdr(fees[i], code as TxCode, tx.ops.map((o) => o.type), opResults);
        pairs.push(new xdr.TransactionResultPair({ transactionHash: tx.hash, result: resultXdr }));
        return {
          hash: tx.hashHex,
          applyIndex: i,
          envelopeXdr: tx.envelopeXdr,
          resultXdr: resultXdr.toXdr('base64'),
          sourceAccount: tx.sourceId,
          feeCharged: fees[i],
          maxFee: tx.fee,
          successful: code === 'txSUCCESS',
          resultCode: code,
          memo: extractMemo(tx.envelope),
          operations: summarizeOperations(tx.envelope, resultXdr),
          accounts: touchedAccounts(tx.envelope, resultXdr),
        };
      });
      const resultSet = new xdr.TransactionResultSet({ results: pairs });
      const resultSetBytes = resultSet.toXdr();
      resultSetXdr = toBase64(resultSetBytes);
      txSetResultHash = sha256Hex(resultSetBytes);
      finalWorking = ltx.header;
      changedKeys = ltx.commit();
    } catch (err) {
      ltx.rollback();
      throw err;
    }

    const header: LedgerHeader = {
      ...cloneHeader(finalWorking),
      txSetResultHash,
      bucketListHash: this.root.stateHash(),
    };
    const headerXdr = encodeLedgerHeader(header);
    const hash = hashLedgerHeader(header);
    this.lcl = { header: cloneHeader(header), hash, headerXdr };
    return { header, hash, headerXdr, txSet, results, resultSetXdr, changedKeys };
  }

  // ------------------------------------------------------------ state

  stateHash(): Hash {
    return this.root.stateHash();
  }

  snapshot(): LedgerSnapshot {
    const entries = [...this.root.keys()].sort().map((k) => serializeEntry(this.root.get(k) as LedgerEntry));
    return {
      version: 1,
      networkPassphrase: this.networkPassphrase,
      seq: this.lcl.header.ledgerSeq,
      hash: this.lcl.hash,
      headerXdr: this.lcl.headerXdr,
      entries,
    };
  }
}

/**
 * A ledger at genesis (ledger 1) for the network passphrase. Nodes use the
 * default: the root account is locked. `opts.unlockRoot` is for tests only.
 */
export function createGenesisLedger(passphrase: string, opts: GenesisOptions = {}): LedgerManager {
  return new LedgerManager(passphrase, new LedgerRoot(genesisEntries(passphrase, opts)), genesisHeader(passphrase, opts));
}

/**
 * Load a ledger from a snapshot. Verifies hashLedgerHeader(header) ===
 * snapshot.hash and stateHash(entries) === header.bucketListHash. Throws on
 * any mismatch or malformed data. When `expectedPassphrase` is given the
 * snapshot must belong to that network.
 */
export function loadLedgerFromSnapshot(snapshot: LedgerSnapshot, expectedPassphrase?: string): LedgerManager {
  if (!snapshot || snapshot.version !== 1) throw new Error('unsupported snapshot version');
  if (typeof snapshot.networkPassphrase !== 'string') throw new Error('snapshot has no network passphrase');
  if (expectedPassphrase !== undefined && snapshot.networkPassphrase !== expectedPassphrase) {
    throw new Error('snapshot belongs to another network');
  }
  const header = decodeLedgerHeader(snapshot.headerXdr);
  if (hashLedgerHeader(header) !== snapshot.hash) throw new Error('snapshot header hash mismatch');
  if (header.ledgerSeq !== snapshot.seq) throw new Error('snapshot sequence mismatch');
  if (!Array.isArray(snapshot.entries)) throw new Error('snapshot entries missing');
  const root = new LedgerRoot(snapshot.entries.map(deserializeEntry));
  if (root.stateHash() !== header.bucketListHash) throw new Error('snapshot state hash mismatch');
  return new LedgerManager(snapshot.networkPassphrase, root, header);
}
