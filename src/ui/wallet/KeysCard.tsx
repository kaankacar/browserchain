import { Download, Eye, EyeOff, KeyRound, Plus } from 'lucide-react';
import { useState } from 'react';
import { Dialog } from '../components/Dialog';
import { Identicon } from '../components/Identicon';
import { Button, Card, cx, ErrorNote, Field, Input } from '../components/ui';
import { useAsync } from '../hooks/useAsync';
import { formatAmount, middleEllipsis } from '../lib/format';
import { createKey, importKey, nextDefaultName } from '../lib/wallet';
import { useApi, useClock, useNodeState } from '../state/NodeProvider';
import { useToast } from '../state/toast';
import { useWallet } from '../state/wallet';

export function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { keys, addKey } = useWallet();
  const clock = useClock();
  const toast = useToast();
  const [secret, setSecret] = useState('');
  const [name, setName] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    try {
      const k = importKey(secret, name || nextDefaultName(keys, 'Imported'), clock.now());
      addKey(k);
      toast({ tone: 'ok', title: 'Key imported', body: middleEllipsis(k.publicKey, 6, 6) });
      setSecret('');
      setName('');
      setError(null);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Import a secret key"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={!secret.trim()}>
            Import
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Secret key" htmlFor="import-secret" hint="Starts with S. It stays in this browser only.">
          <div className="relative">
            <Input
              id="import-secret"
              mono
              autoComplete="off"
              type={show ? 'text' : 'password'}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="S…"
              className="pr-10"
            />
            <button
              type="button"
              onClick={() => setShow((s) => !s)}
              aria-label={show ? 'Hide secret' : 'Show secret'}
              className="absolute right-1 top-1/2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-fg-3 hover:text-fg"
            >
              {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
        </Field>
        <Field label="Name" htmlFor="import-name" optional>
          <Input id="import-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={nextDefaultName(keys, 'Imported')} />
        </Field>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

export function KeysCard() {
  const { keys, selected, select, addKey, network } = useWallet();
  const api = useApi();
  const clock = useClock();
  const closeCounter = useNodeState((s) => s.closeCounter);
  const [importing, setImporting] = useState(false);
  const balances = useAsync(() => Promise.all(keys.map((k) => api.getAccount(k.publicKey))), [keys, api, closeCounter]);

  return (
    <Card
      title="Keys"
      subtitle={`Stored in this browser · network ${network ?? '…'}`}
      icon={KeyRound}
      iconClass="text-ledger"
      bodyClass="p-0"
      actions={
        <>
          <Button size="sm" variant="ghost" icon={Download} onClick={() => setImporting(true)}>
            Import
          </Button>
          <Button size="sm" variant="primary" icon={Plus} onClick={() => addKey(createKey(nextDefaultName(keys), clock.now()))}>
            New
          </Button>
        </>
      }
    >
      <ul className="flex flex-col gap-1 p-2" aria-label="Wallet keys">
        {keys.map((k, i) => {
          const acc = balances.data?.[i] ?? null;
          const on = selected?.publicKey === k.publicKey;
          return (
            <li key={k.publicKey}>
              <button
                type="button"
                aria-pressed={on}
                onClick={() => select(k.publicKey)}
                className={cx(
                  'flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
                  on ? 'border-ledger-fill/50 bg-ledger-fill/8' : 'border-transparent hover:bg-hover',
                )}
              >
                <Identicon value={k.publicKey} size={30} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-fg">{k.name}</span>
                  <span className="block truncate font-mono text-[11px] text-fg-3">{middleEllipsis(k.publicKey, 6, 6)}</span>
                </span>
                <span className="shrink-0 text-right text-xs">
                  {balances.loading ? (
                    <span className="text-fg-3">…</span>
                  ) : acc ? (
                    <span className="font-medium tabular-nums text-fg">{formatAmount(acc.balances[0]?.balance ?? '0', { maxDecimals: 2 })} XLM</span>
                  ) : (
                    <span className="text-fg-3">not funded</span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <ImportDialog open={importing} onClose={() => setImporting(false)} />
    </Card>
  );
}
