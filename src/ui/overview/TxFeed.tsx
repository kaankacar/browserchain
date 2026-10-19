import {
  ArrowLeftRight,
  ArrowRight,
  Database,
  Gift,
  Link2,
  Send,
  Settings2,
  UserPlus,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { TxSummary } from '../../node/api';
import { AccountLink, LedgerLink } from '../components/links';
import { CloseTimeAgo } from '../components/TimeAgo';
import { Card, cx, EmptyState, Skeleton } from '../components/ui';
import { describeTx, type OpKind } from '../lib/describe';
import { href } from '../lib/route';
import { useNodeState } from '../state/NodeProvider';

export const OP_ICON: Record<OpKind, { icon: LucideIcon; cls: string }> = {
  payment: { icon: Send, cls: 'bg-ledger-fill/12 text-ledger' },
  account: { icon: UserPlus, cls: 'bg-network/12 text-network' },
  trust: { icon: Link2, cls: 'bg-consensus/12 text-consensus' },
  offer: { icon: ArrowLeftRight, cls: 'bg-network/12 text-network' },
  claim: { icon: Gift, cls: 'bg-ledger-fill/12 text-ledger' },
  data: { icon: Database, cls: 'bg-fg-3/12 text-fg-2' },
  options: { icon: Settings2, cls: 'bg-fg-3/12 text-fg-2' },
  other: { icon: Zap, cls: 'bg-fg-3/12 text-fg-2' },
};

export function TxRow({ tx, animate }: { tx: TxSummary; animate?: boolean }) {
  const d = describeTx(tx);
  const { icon: Icon, cls } = OP_ICON[d.kind];
  return (
    <li className={cx('flex items-center gap-3 px-4 py-2.5', animate && 'animate-flash')}>
      <span className={cx('inline-flex size-8 shrink-0 items-center justify-center rounded-lg', cls)}>
        <Icon aria-hidden className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <a href={href.tx(tx.hash)} className="flex min-w-0 items-baseline gap-1.5 text-sm hover:text-ledger">
          <span className="truncate font-medium text-fg">{d.title}</span>
          {d.amount ? <span className="shrink-0 tabular-nums text-fg-2">{d.amount}</span> : null}
          {d.more ? <span className="shrink-0 text-xs text-fg-3">+{d.more} more</span> : null}
        </a>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-fg-3">
          <AccountLink id={tx.sourceAccount} size={14} showName={false} />
          {d.counterparty ? (
            <>
              <ArrowRight aria-hidden className="size-3 shrink-0" />
              <AccountLink id={d.counterparty} size={14} showName={false} />
            </>
          ) : d.note ? (
            <span className="truncate">{d.note}</span>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5 text-xs">
        {tx.successful ? (
          <span className="font-medium text-ok">Success</span>
        ) : (
          <span className="font-medium text-bad" title={tx.resultCode}>
            Failed
          </span>
        )}
        <span className="text-fg-3">
          <LedgerLink seq={tx.ledgerSeq} className="font-normal text-fg-3" />
        </span>
      </div>
    </li>
  );
}

export function TxFeed() {
  const txs = useNodeState((s) => s.txs);
  const ready = useNodeState((s) => s.ready);
  const newest = txs[0]?.ledgerSeq ?? 0;
  const shown = txs.slice(0, 8);
  return (
    <Card
      title="Live transactions"
      subtitle={shown[0] ? <span>Latest in ledger #{newest.toLocaleString('en-US')}, <CloseTimeAgo seconds={shown[0].closeTime} /></span> : undefined}
      icon={Zap}
      iconClass="text-ledger"
      fill
      bodyClass="p-0"
      actions={
        <a href={href.txs()} className="inline-flex items-center gap-1 text-xs font-medium text-fg-3 hover:text-fg">
          All transactions <ArrowRight aria-hidden className="size-3" />
        </a>
      }
    >
      {!ready && txs.length === 0 ? (
        <div className="space-y-3 p-4">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : shown.length === 0 ? (
        <EmptyState icon={Zap} title="No transactions yet">
          Fund an account in the wallet to see your first one here.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line">
          {shown.map((t) => (
            <TxRow key={t.hash} tx={t} animate={t.ledgerSeq === newest} />
          ))}
        </ul>
      )}
    </Card>
  );
}
