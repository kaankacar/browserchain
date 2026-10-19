import { Check, Droplets, ExternalLink, Eye, EyeOff, Pencil, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import type { AccountView } from '../../node/api';
import { ConfirmDialog } from '../components/Dialog';
import { CopyButton, HashText } from '../components/Hash';
import { Identicon } from '../components/Identicon';
import { AssetLabel } from '../components/links';
import { Button, Card, IconButton, Input, Skeleton } from '../components/ui';
import { formatAmount } from '../lib/format';
import { href } from '../lib/route';
import type { WalletKey } from '../lib/wallet';
import { useWallet } from '../state/wallet';
import { FundFirst, spendable } from './shared';

export function AccountPanel({ wallet, account, loading }: { wallet: WalletKey; account: AccountView | null; loading: boolean }) {
  const { renameKey, removeKey, fund } = useWallet();
  const [reveal, setReveal] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(wallet.name);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [funding, setFunding] = useState(false);

  return (
    <Card>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <Identicon value={wallet.publicKey} size={44} />
          <div className="min-w-0">
            {editing ? (
              <form
                className="flex items-center gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  renameKey(wallet.publicKey, name);
                  setEditing(false);
                }}
              >
                <label htmlFor="wallet-name" className="sr-only">
                  Account name
                </label>
                <Input id="wallet-name" autoFocus value={name} maxLength={40} onChange={(e) => setName(e.target.value)} className="h-8" />
                <IconButton icon={Check} label="Save name" size="sm" type="submit" />
                <IconButton icon={X} label="Cancel" size="sm" onClick={() => setEditing(false)} />
              </form>
            ) : (
              <div className="flex items-center gap-1">
                <h2 className="truncate text-lg font-semibold tracking-tight">{wallet.name}</h2>
                <IconButton
                  icon={Pencil}
                  label="Rename"
                  size="sm"
                  onClick={() => {
                    setName(wallet.name);
                    setEditing(true);
                  }}
                />
              </div>
            )}
            <div className="mt-0.5 text-sm text-fg-2">
              <HashText value={wallet.publicKey} head={8} tail={8} />
            </div>
            <div className="mt-1 flex items-center gap-1 text-sm">
              <span className="text-xs text-fg-3">Secret</span>
              <span className="min-w-0 truncate font-mono text-xs text-fg-2">{reveal ? wallet.secret : 'S' + '•'.repeat(18)}</span>
              <IconButton icon={reveal ? EyeOff : Eye} label={reveal ? 'Hide secret key' : 'Show secret key'} size="sm" onClick={() => setReveal((r) => !r)} />
              <CopyButton value={wallet.secret} label="Copy secret key" size="xs" />
            </div>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {account ? (
            <Button
              size="sm"
              icon={Droplets}
              loading={funding}
              onClick={async () => {
                setFunding(true);
                try {
                  await fund(wallet.publicKey, 'Friendbot top-up');
                } finally {
                  setFunding(false);
                }
              }}
            >
              Top up
            </Button>
          ) : null}
          <a
            href={href.account(wallet.publicKey)}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-strong bg-raised px-2.5 text-xs font-medium hover:bg-hover"
          >
            <ExternalLink aria-hidden className="size-3.5" /> Explorer
          </a>
          <IconButton icon={Trash2} label="Remove this key from the browser" size="sm" danger onClick={() => setConfirmRemove(true)} />
        </div>
      </div>

      <div className="mt-5 border-t border-line pt-4">
        {loading && !account ? (
          <Skeleton className="h-16 w-full" />
        ) : !account ? (
          <FundFirst wallet={wallet} />
        ) : (
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3" aria-label="Balances">
            {account.balances.map((b) => (
              <li key={`${b.asset.code}:${b.asset.issuer ?? ''}`} className="min-w-0 rounded-lg border border-line bg-raised px-3 py-2.5">
                <AssetLabel asset={b.asset} className="text-xs" />
                <p className="mt-1 truncate text-lg font-semibold tracking-tight">{formatAmount(b.balance, { maxDecimals: 4 })}</p>
                <p className="text-xs text-fg-3">
                  {formatAmount(spendable(account, b.asset), { maxDecimals: 4 })} spendable
                  {b.asset.type === 'native' ? ` · ${formatAmount(account.minBalance)} reserved` : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={confirmRemove}
        title={`Remove “${wallet.name}”?`}
        confirmLabel="Remove key"
        danger
        onConfirm={() => {
          removeKey(wallet.publicKey);
          setConfirmRemove(false);
        }}
        onClose={() => setConfirmRemove(false)}
      >
        <p>The account stays on the network, but this browser forgets its secret key. Copy the secret first if you want to use it again.</p>
      </ConfirmDialog>
    </Card>
  );
}
