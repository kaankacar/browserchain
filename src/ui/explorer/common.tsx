import { Blocks, Braces, ChevronLeft, ChevronRight, Coins, FileCode2, Zap, type LucideIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { OperationView, TxSummary } from '../../node/api';
import { CopyButton } from '../components/Hash';
import { JsonView } from '../components/JsonView';
import { AccountLink, AssetLabel, LedgerLink, TxLink } from '../components/links';
import { CloseTimeAgo } from '../components/TimeAgo';
import { Badge, Card, cx, ErrorNote, Segmented, TabLinks } from '../components/ui';
import { describeTx, detailKind, detailLabel, opKind } from '../lib/describe';
import { formatAmount, humanizeCode, opTypeLabel, resultTone } from '../lib/format';
import { href } from '../lib/route';
import { decodeXdr, jsonText, type XdrTypeName } from '../lib/xdrJson';
import { SearchBox } from '../layout/SearchBox';
import { OP_ICON } from '../overview/TxFeed';

export function ExplorerNav({ active }: { active: 'ledgers' | 'txs' | 'assets' | 'none' }) {
  return (
    <div className="mb-5 flex flex-col gap-4 sm:mb-6">
      <SearchBox large />
      <TabLinks
        label="Explorer sections"
        active={active}
        tabs={[
          { id: 'ledgers', href: href.ledgers(), label: 'Ledgers', icon: Blocks },
          { id: 'txs', href: href.txs(), label: 'Transactions', icon: Zap },
          { id: 'assets', href: href.assets(), label: 'Assets', icon: Coins },
        ]}
      />
    </div>
  );
}

export function ResultBadge({ code }: { code: string }) {
  const tone = resultTone(code);
  return (
    <Badge tone={tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : 'bad'} title={humanizeCode(code)}>
      <span className="font-mono text-[11px]">{code}</span>
    </Badge>
  );
}

function DetailValue({ k, v }: { k: string; v: string | number | boolean | null }) {
  if (v === null || v === '') return <span className="text-fg-3">–</span>;
  switch (detailKind(k, v)) {
    case 'account':
      return <AccountLink id={String(v)} />;
    case 'accounts':
      return (
        <span className="flex flex-col gap-1">
          {String(v)
            .split(',')
            .map((a) => (
              <AccountLink key={a} id={a} />
            ))}
        </span>
      );
    case 'asset':
      return <AssetLabel asset={String(v)} />;
    case 'amount':
      return <span className="tabular-nums">{formatAmount(String(v))}</span>;
    case 'hash':
      return (
        <span className="inline-flex items-center gap-1">
          <span className="font-mono text-xs [overflow-wrap:anywhere]">{String(v)}</span>
          <CopyButton value={String(v)} size="xs" />
        </span>
      );
    default:
      return <span className="[overflow-wrap:anywhere]">{String(v)}</span>;
  }
}

export function OperationCard({ op, txSource }: { op: OperationView; txSource: string }) {
  const { icon: Icon, cls } = OP_ICON[opKind(op.type)];
  const details = Object.entries(op.details);
  return (
    <li className="rounded-xl border border-line bg-raised p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className={cx('inline-flex size-8 shrink-0 items-center justify-center rounded-lg', cls)}>
            <Icon aria-hidden className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold">
              <span className="mr-1.5 text-fg-3">#{op.index + 1}</span>
              {opTypeLabel(op.type)}
            </p>
            {op.sourceAccount !== txSource ? (
              <p className="text-xs text-fg-3">
                source <AccountLink id={op.sourceAccount} size={14} />
              </p>
            ) : null}
          </div>
        </div>
        <ResultBadge code={op.resultCode} />
      </div>
      {details.length ? (
        <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 border-t border-line pt-3 text-sm sm:grid-cols-2">
          {details.map(([k, v]) => (
            <div key={k} className="min-w-0">
              <dt className="text-xs text-fg-3">{detailLabel(k)}</dt>
              <dd className="mt-0.5 min-w-0">
                <DetailValue k={k} v={v} />
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </li>
  );
}

/** Base64 XDR with copy, and a decoded JSON view on demand. */
export function XdrPanel({ title, xdr, type, icon = FileCode2 }: { title: string; xdr: string; type: XdrTypeName; icon?: LucideIcon }) {
  const [view, setView] = useState<'xdr' | 'json'>('xdr');
  const decoded = useMemo(() => {
    if (view !== 'json') return null;
    try {
      return { ok: true as const, json: decodeXdr(type, xdr) };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  }, [view, type, xdr]);
  return (
    <Card
      title={title}
      subtitle={type}
      icon={icon}
      actions={
        <>
          <Segmented
            label={`${title} view`}
            size="sm"
            value={view}
            onChange={setView}
            options={[
              { value: 'xdr', label: 'XDR', icon: FileCode2 },
              { value: 'json', label: 'JSON', icon: Braces },
            ]}
          />
          <CopyButton value={view === 'json' && decoded?.ok ? jsonText(decoded.json) : xdr} label={view === 'json' ? 'Copy JSON' : 'Copy XDR'} />
        </>
      }
    >
      {view === 'xdr' ? (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-sunken p-3 font-mono text-xs leading-relaxed text-fg-2 [overflow-wrap:anywhere]">
          {xdr}
        </pre>
      ) : decoded?.ok ? (
        <JsonView value={decoded.json} className="max-h-[520px] overflow-auto" />
      ) : (
        <ErrorNote>{decoded?.error}</ErrorNote>
      )}
    </Card>
  );
}

/** Compact transaction table used by the ledger, account and transactions pages. */
export function TxTable({ txs, showLedger = true, empty }: { txs: TxSummary[]; showLedger?: boolean; empty?: React.ReactNode }) {
  if (txs.length === 0) return <div className="px-4 py-8 text-center text-sm text-fg-3">{empty ?? 'No transactions.'}</div>;
  return (
    <ul className="divide-y divide-line">
      {txs.map((t) => {
        const d = describeTx(t);
        const { icon: Icon, cls } = OP_ICON[d.kind];
        return (
          <li key={t.hash} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-2.5">
            <span className={cx('inline-flex size-8 items-center justify-center rounded-lg', cls)}>
              <Icon aria-hidden className="size-4" />
            </span>
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm">
                <a href={href.tx(t.hash)} className="font-medium text-fg hover:text-ledger">
                  {d.title}
                </a>
                {d.amount ? <span className="tabular-nums text-fg-2">{d.amount}</span> : null}
                {d.more ? <span className="text-xs text-fg-3">+{d.more} ops</span> : null}
                {d.note && !d.amount ? <span className="truncate text-xs text-fg-3">{d.note}</span> : null}
              </div>
              <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-fg-3">
                <AccountLink id={t.sourceAccount} size={14} />
                <span aria-hidden>·</span>
                <TxLink hash={t.hash} head={6} tail={4} className="text-fg-3" />
                {t.memo.value ? (
                  <>
                    <span aria-hidden>·</span>
                    <span className="max-w-40 truncate" title={`memo (${t.memo.type})`}>
                      “{t.memo.value}”
                    </span>
                  </>
                ) : null}
              </div>
            </div>
            <div className="flex flex-col items-end gap-0.5 text-xs">
              {t.successful ? <span className="font-medium text-ok">Success</span> : <span className="font-medium text-bad">{humanizeCode(t.resultCode)}</span>}
              <span className="flex items-center gap-1.5 text-fg-3">
                {showLedger ? <LedgerLink seq={t.ledgerSeq} className="font-normal text-fg-3" /> : null}
                <CloseTimeAgo seconds={t.closeTime} />
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function Pager({ newer, older, label }: { newer: string | null; older: string | null; label: string }) {
  const cls = 'inline-flex h-8 items-center gap-1 rounded-lg border border-line-strong bg-raised px-3 text-xs font-medium text-fg hover:bg-hover';
  const off = 'pointer-events-none opacity-40';
  return (
    <nav aria-label={label} className="flex items-center justify-between gap-2 border-t border-line px-4 py-3">
      <a href={newer ?? undefined} aria-disabled={!newer} className={cx(cls, !newer && off)}>
        <ChevronLeft aria-hidden className="size-3.5" /> Newer
      </a>
      <a href={older ?? undefined} aria-disabled={!older} className={cx(cls, !older && off)}>
        Older <ChevronRight aria-hidden className="size-3.5" />
      </a>
    </nav>
  );
}
