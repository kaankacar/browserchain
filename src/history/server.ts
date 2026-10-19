// Serving history to peers (ARCHITECTURE 12.1): headers, ledgers (at most 64
// per request), the latest snapshot at or before a seq (genesis can always be
// produced), SCP state and branch weights.

import type { ILedgerManager } from '../ledger/types';
import { createGenesisLedger } from '../ledger/manager';
import type { RequestBody, ResponseBody } from '../overlay/types';
import type { ChainStore } from './chainStore';

/** Max ledgers or headers in one answer. */
export const MAX_LEDGERS_PER_REQUEST = 64;

export interface HistoryServerOptions {
  chain: ChainStore;
  passphrase: string;
  ledger: () => ILedgerManager;
  /** Latest SCP envelopes for slots >= fromSlot (base64), or null when SCP is not running. */
  scpState: (fromSlot: number) => string[] | null;
}

export class HistoryServer {
  private genesisSnapshot: string | null = null;

  constructor(private readonly opts: HistoryServerOptions) {}

  async handle(body: RequestBody): Promise<ResponseBody | null> {
    const lcl = this.opts.ledger().lastClosed();
    const lclSeq = lcl.header.ledgerSeq;
    switch (body.kind) {
      case 'headers': {
        const [from, to] = this.range(body.from, body.to, lclSeq);
        const items = (await this.opts.chain.getLedgers(from, to)).map((l) => ({ seq: l.seq, headerXdr: l.headerXdr }));
        return { kind: 'headers', items };
      }
      case 'ledgers': {
        const [from, to] = this.range(body.from, body.to, lclSeq);
        const items = (await this.opts.chain.getLedgers(from, to)).map((l) => ({
          seq: l.seq,
          headerXdr: l.headerXdr,
          txSetXdr: l.txSetXdr,
        }));
        return { kind: 'ledgers', items };
      }
      case 'snapshot': {
        if (body.atOrBefore < 1) return null;
        const snap = await this.opts.chain.snapshotAtOrBefore(Math.min(body.atOrBefore, lclSeq));
        if (snap) return { kind: 'snapshot', seq: snap.seq, data: snap.data };
        return { kind: 'snapshot', seq: 1, data: this.genesis() };
      }
      case 'scpState': {
        const envelopes = this.opts.scpState(body.fromSlot);
        return envelopes === null ? null : { kind: 'scpState', envelopes };
      }
      case 'branchWeight': {
        // at most MAX_BRANCH_WEIGHT_LEDGERS ledgers after afterSeq: bounded work per request
        const weight = await this.opts.chain.branchWeight(body.afterSeq, lclSeq);
        return { kind: 'branchWeight', afterSeq: body.afterSeq, weight, lcl: { seq: lclSeq, hash: lcl.hash } };
      }
      default:
        return null;
    }
  }

  private range(from: number, to: number, lclSeq: number): [number, number] {
    const lo = Math.max(1, from);
    const hi = Math.min(to, lclSeq, lo + MAX_LEDGERS_PER_REQUEST - 1);
    return [lo, hi];
  }

  private genesis(): string {
    if (this.genesisSnapshot === null) {
      this.genesisSnapshot = JSON.stringify(createGenesisLedger(this.opts.passphrase).snapshot());
    }
    return this.genesisSnapshot;
  }
}
