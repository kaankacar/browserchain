import { xdr } from '@stellar/stellar-sdk/base';
import { CircleCheck, CircleX, Fingerprint, Hourglass, Layers, Zap } from 'lucide-react';
import { useMemo } from 'react';
import { HashText } from '../components/Hash';
import { AccountLink, LedgerLink } from '../components/links';
import { CloseTimeAgo } from '../components/TimeAgo';
import { Badge, Card, EmptyState, ErrorNote, Facts, PageHeader, Skeleton } from '../components/ui';
import { useAsync } from '../hooks/useAsync';
import { formatAmount, formatNumber, formatUtc, humanizeCode, plural } from '../lib/format';
import { useApi, useNodeState } from '../state/NodeProvider';
import { ExplorerNav, OperationCard, ResultBadge, XdrPanel } from './common';

function envelopeExtras(envelope: string): { seq: string | null; timeBounds: string | null } {
  try {
    const env = xdr.TransactionEnvelope.fromXdr(envelope, 'base64');
    if (env.type !== 'envelopeTypeTx') return { seq: null, timeBounds: null };
    const tx = env.v1.tx;
    const cond = tx.cond;
    let timeBounds: string | null = null;
    if (cond.type === 'precondTime') {
      const tb = cond.timeBounds;
      const min = tb.minTime.toString();
      const max = tb.maxTime.toString();
      timeBounds = min === '0' && max === '0' ? 'none' : `${min === '0' ? 'any' : formatUtc(Number(min))} → ${max === '0' ? 'no limit' : formatUtc(Number(max))}`;
    }
    return { seq: tx.seqNum.toString(), timeBounds };
  } catch {
    return { seq: null, timeBounds: null };
  }
}

export function TxPage({ hash }: { hash: string }) {
  const api = useApi();
  const tracked = useNodeState((s) => s.txStatus[hash] ?? null);
  const closeCounter = useNodeState((s) => s.closeCounter);
  // While not found, refetch after every ledger close (the tx may be pending).
  const first = useAsync(() => api.getTransaction(hash), [hash, api]);
  const found = !!first.data;
  const retry = useAsync(() => (found ? Promise.resolve(null) : api.getTransaction(hash)), [hash, api, found ? -1 : closeCounter]);
  const tx = first.data ?? retry.data ?? null;
  const extras = useMemo(() => (tx ? envelopeExtras(tx.envelopeXdr) : null), [tx]);

  return (
    <div>
      <PageHeader title="Transaction" icon={Zap}>
        <div className="mt-1.5 text-sm text-fg-2">
          <HashText value={hash} full />
        </div>
      </PageHeader>
      <ExplorerNav active="none" />
      {first.error ? <ErrorNote>{first.error.message}</ErrorNote> : null}
      {first.loading ? (
        <Skeleton className="h-72 w-full rounded-xl" />
      ) : !tx ? (
        <Card>
          {tracked?.status === 'pending' ? (
            <EmptyState icon={Hourglass} title="Pending">
              The node accepted this transaction. It will appear here when a ledger includes it, usually within 5 seconds.
            </EmptyState>
          ) : tracked && tracked.status !== 'applied' ? (
            <EmptyState icon={CircleX} title={tracked.status === 'dropped' ? 'Dropped from the queue' : 'Rejected'}>
              {tracked.resultCode ? humanizeCode(tracked.resultCode) : 'The node did not include it in a ledger.'}
            </EmptyState>
          ) : (
            <EmptyState icon={Zap} title="Transaction not found">
              This node has no transaction with that hash. It may be older than the history kept here, or it was never submitted.
            </EmptyState>
          )}
        </Card>
      ) : (
        <div className="flex flex-col gap-4 sm:gap-5">
          <Card
            title={tx.successful ? 'Applied successfully' : 'Failed'}
            subtitle={tx.successful ? `${plural(tx.opCount, 'operation')} applied` : humanizeCode(tx.resultCode)}
            icon={tx.successful ? CircleCheck : CircleX}
            iconClass={tx.successful ? 'text-ok' : 'text-bad'}
            actions={<ResultBadge code={tx.resultCode} />}
          >
            <Facts
              items={[
                {
                  label: 'Ledger',
                  value: (
                    <span className="inline-flex flex-wrap items-center gap-2">
                      <LedgerLink seq={tx.ledgerSeq} />
                      <span className="text-xs text-fg-3">
                        {formatUtc(tx.closeTime)} · <CloseTimeAgo seconds={tx.closeTime} />
                      </span>
                    </span>
                  ),
                },
                { label: 'Apply order', value: <span className="tabular-nums">#{tx.applyIndex + 1} in its ledger</span> },
                { label: 'Source account', value: <AccountLink id={tx.sourceAccount} />, wide: true },
                { label: 'Sequence', value: <span className="font-mono text-xs">{extras?.seq ?? '–'}</span> },
                { label: 'Operations', value: <span className="tabular-nums">{formatNumber(tx.opCount)}</span> },
                { label: 'Fee charged', value: <span className="tabular-nums">{formatAmount(tx.feeCharged)} XLM</span> },
                { label: 'Max fee', value: <span className="tabular-nums">{formatAmount(tx.maxFee)} XLM</span> },
                {
                  label: 'Memo',
                  value:
                    tx.memo.type === 'none' || tx.memo.value === null ? (
                      <span className="text-fg-3">none</span>
                    ) : (
                      <span className="inline-flex min-w-0 items-center gap-2">
                        <Badge>{tx.memo.type}</Badge>
                        <span className="min-w-0 [overflow-wrap:anywhere]">{tx.memo.value}</span>
                      </span>
                    ),
                  wide: true,
                },
                { label: 'Time bounds', value: <span className="text-fg-2">{extras?.timeBounds ?? '–'}</span>, wide: true },
              ]}
            />
          </Card>
          <Card title="Operations" subtitle={plural(tx.operations.length, 'operation')} icon={Layers} iconClass="text-ledger">
            <ol className="flex flex-col gap-3">
              {tx.operations.map((op) => (
                <OperationCard key={op.index} op={op} txSource={tx.sourceAccount} />
              ))}
            </ol>
          </Card>
          <Card title="Signatures" subtitle={plural(tx.signatures.length, 'signature')} icon={Fingerprint} bodyClass="p-0">
            <ul className="divide-y divide-line">
              {tx.signatures.map((s, i) => (
                <li key={i} className="flex flex-col gap-1 px-4 py-2.5 text-xs sm:flex-row sm:items-center sm:gap-4">
                  <span className="text-fg-3">
                    hint <span className="font-mono text-fg">{s.hint}</span>
                  </span>
                  <HashText value={s.signature} head={16} tail={12} />
                </li>
              ))}
            </ul>
          </Card>
          <div className="grid grid-cols-1 gap-4 sm:gap-5 xl:grid-cols-2">
            <XdrPanel title="Envelope" xdr={tx.envelopeXdr} type="TransactionEnvelope" />
            <XdrPanel title="Result" xdr={tx.resultXdr} type="TransactionResult" />
          </div>
        </div>
      )}
    </div>
  );
}
