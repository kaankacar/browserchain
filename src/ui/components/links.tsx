import { useMemo } from 'react';
import type { AssetView } from '../../node/api';
import { formatNumber, middleEllipsis, parseAssetKey } from '../lib/format';
import { href } from '../lib/route';
import { useNodeState } from '../state/NodeProvider';
import { useWallet } from '../state/wallet';
import { Identicon } from './Identicon';
import { cx } from './ui';

export interface KnownName {
  name: string;
  kind: 'self' | 'validator' | 'wallet';
}

/** Friendly names for keys we know: this node, other validators, wallet keys. */
export function useNameOf(): (id: string) => KnownName | null {
  const validators = useNodeState((s) => s.validators);
  const selfId = useNodeState((s) => s.status?.nodeId ?? null);
  const selfName = useNodeState((s) => s.status?.name ?? null);
  const { keys } = useWallet();
  return useMemo(() => {
    const map = new Map<string, KnownName>();
    for (const v of validators) map.set(v.nodeId, { name: v.name, kind: v.isSelf ? 'self' : 'validator' });
    if (selfId && selfName) map.set(selfId, { name: selfName, kind: 'self' });
    for (const k of keys) map.set(k.publicKey, { name: k.name, kind: 'wallet' });
    return (id: string) => map.get(id) ?? null;
  }, [validators, selfId, selfName, keys]);
}

export function AccountLink({
  id,
  className,
  size = 18,
  showName = true,
  link = true,
  head = 4,
  tail = 4,
}: {
  id: string;
  className?: string;
  size?: number;
  showName?: boolean;
  link?: boolean;
  head?: number;
  tail?: number;
}) {
  const nameOf = useNameOf();
  const known = showName ? nameOf(id) : null;
  const body = (
    <>
      <Identicon value={id} size={size} />
      <span className="truncate font-mono text-[0.92em]">{middleEllipsis(id, head, tail)}</span>
      {known ? (
        <span className={cx('truncate text-xs', known.kind === 'wallet' ? 'text-ledger' : 'text-fg-3')}>
          {known.kind === 'wallet' ? `${known.name} · yours` : known.name}
        </span>
      ) : null}
    </>
  );
  const cls = cx('inline-flex min-w-0 max-w-full items-center gap-1.5 align-middle', className);
  return link ? (
    <a href={href.account(id)} title={id} className={cx(cls, 'text-fg hover:text-ledger')}>
      {body}
    </a>
  ) : (
    <span title={id} className={cls}>
      {body}
    </span>
  );
}

/** A validator by node id: identicon + name (+ "you"). `name` is used when the id is not a known validator. */
export function NodeName({ id, name, className, size = 18, you = true }: { id: string; name?: string; className?: string; size?: number; you?: boolean }) {
  const nameOf = useNameOf();
  const known = nameOf(id);
  return (
    <span title={id} className={cx('inline-flex min-w-0 max-w-full items-center gap-1.5 align-middle', className)}>
      <Identicon value={id} size={size} />
      <span className="truncate">{known?.name ?? name ?? middleEllipsis(id, 4, 4)}</span>
      {you && known?.kind === 'self' ? (
        <span className="rounded bg-ledger-fill/15 px-1 text-[10px] font-semibold uppercase tracking-wide text-ledger">you</span>
      ) : null}
    </span>
  );
}

export function LedgerLink({ seq, className }: { seq: number; className?: string }) {
  return (
    <a href={href.ledger(seq)} className={cx('font-medium tabular-nums text-fg hover:text-ledger hover:underline', className)}>
      #{formatNumber(seq)}
    </a>
  );
}

export function TxLink({ hash, className, head = 6, tail = 6 }: { hash: string; className?: string; head?: number; tail?: number }) {
  return (
    <a href={href.tx(hash)} title={hash} className={cx('font-mono text-[0.92em] text-fg hover:text-ledger hover:underline', className)}>
      {middleEllipsis(hash, head, tail)}
    </a>
  );
}

function toAsset(a: AssetView | string): AssetView | null {
  if (typeof a !== 'string') return a;
  try {
    return parseAssetKey(a);
  } catch {
    return null;
  }
}

/** Asset code with its issuer; XLM shown as the native asset. */
export function AssetLabel({ asset, className, issuer = true }: { asset: AssetView | string; className?: string; issuer?: boolean }) {
  const a = toAsset(asset);
  if (!a) return <span className={className}>{String(asset)}</span>;
  if (a.type === 'native') {
    return (
      <span className={cx('inline-flex items-center gap-1.5 align-middle', className)}>
        <span aria-hidden className="inline-flex size-4 items-center justify-center rounded-full bg-ledger-fill/20 text-[9px] font-bold text-ledger">
          ✦
        </span>
        <span className="font-medium">XLM</span>
      </span>
    );
  }
  return (
    <span className={cx('inline-flex min-w-0 max-w-full items-center gap-1.5 align-middle', className)} title={`${a.code} issued by ${a.issuer}`}>
      <Identicon value={a.issuer ?? a.code} size={16} rounded="full" />
      <span className="font-medium">{a.code}</span>
      {issuer && a.issuer ? (
        <a href={href.account(a.issuer)} className="truncate font-mono text-[11px] text-fg-3 hover:text-ledger">
          {middleEllipsis(a.issuer, 4, 4)}
        </a>
      ) : null}
    </span>
  );
}
