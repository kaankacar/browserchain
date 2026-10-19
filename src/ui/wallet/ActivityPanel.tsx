import { Activity, CircleCheck, CircleHelp, CircleX, LoaderCircle, Trash2, TriangleAlert } from 'lucide-react';
import { NodeName, TxLink } from '../components/links';
import { TimeAgo } from '../components/TimeAgo';
import { Button, Card, EmptyState } from '../components/ui';
import { humanizeCode } from '../lib/format';
import { href } from '../lib/route';
import { useNodeState } from '../state/NodeProvider';
import { useWallet, type ActivityItem } from '../state/wallet';

function Status({ item }: { item: ActivityItem }) {
  const s = useNodeState((st) => st.txStatus[item.hash] ?? null);
  if (item.error)
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-bad" title={item.error.detail}>
        <CircleX aria-hidden className="size-3.5" /> Rejected · {humanizeCode(item.error.code)}
      </span>
    );
  if (!s)
    // sent in an earlier visit and not in this node's history
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-fg-3" title="This node has no record of this transaction.">
        <CircleHelp aria-hidden className="size-3.5" /> Unknown
      </span>
    );
  if (s.status === 'pending')
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-warn">
        <LoaderCircle aria-hidden className="size-3.5 animate-spin" /> Pending
      </span>
    );
  if (s.status === 'applied')
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-ok">
        <CircleCheck aria-hidden className="size-3.5" /> Applied
        {s.ledgerSeq ? (
          <a className="text-fg-3 hover:text-ledger" href={href.ledger(s.ledgerSeq)}>
            #{s.ledgerSeq.toLocaleString('en-US')}
          </a>
        ) : null}
      </span>
    );
  if (s.status === 'dropped')
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-warn">
        <TriangleAlert aria-hidden className="size-3.5" /> Dropped
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-bad">
      <CircleX aria-hidden className="size-3.5" /> Failed{s.resultCode ? ` · ${humanizeCode(s.resultCode)}` : ''}
    </span>
  );
}

export function ActivityPanel() {
  const { activity, clearActivity } = useWallet();
  return (
    <Card
      title="Activity"
      subtitle="Transactions sent from this wallet"
      icon={Activity}
      bodyClass="p-0"
      actions={
        activity.length ? (
          <Button size="sm" variant="ghost" icon={Trash2} onClick={clearActivity}>
            Clear
          </Button>
        ) : null
      }
    >
      {activity.length === 0 ? (
        <EmptyState icon={Activity} title="Nothing sent yet">
          Payments, trustlines, offers and claims you submit show up here with their live status.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line">
          {activity.map((a) => (
            <li key={a.hash} className="flex flex-col gap-1 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{a.label}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-fg-3">
                  <NodeName id={a.account} size={14} you={false} />
                  <span aria-hidden>·</span>
                  <TimeAgo ms={a.ts} />
                  {!a.error ? (
                    <>
                      <span aria-hidden>·</span>
                      <TxLink hash={a.hash} head={8} tail={4} className="text-fg-3" />
                    </>
                  ) : null}
                </p>
              </div>
              <Status item={a} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
