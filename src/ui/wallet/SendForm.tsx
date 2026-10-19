import { Info, Send } from 'lucide-react';
import { useId, useState } from 'react';
import type { AccountView } from '../../node/api';
import { Button, Card, ErrorNote, Field, Input, Notice, Select } from '../components/ui';
import { assetKey, formatAmount, parseAssetKey, tryAmountToStroops, stroopsToAmount } from '../lib/format';
import { createAccountOp, memoFromFields, paymentOp, type MemoType } from '../lib/txbuild';
import type { WalletKey } from '../lib/wallet';
import { useApi } from '../state/NodeProvider';
import { useWallet } from '../state/wallet';
import { spendable, TxStatusLine, useAction } from './shared';

const FEE = 100n;

export function SendForm({ wallet, account }: { wallet: WalletKey; account: AccountView }) {
  const api = useApi();
  const { submit, keys } = useWallet();
  const id = useId();
  const [dest, setDest] = useState('');
  const [assetK, setAssetK] = useState('XLM');
  const [amount, setAmount] = useState('');
  const [memoType, setMemoType] = useState<MemoType>('text');
  const [memo, setMemo] = useState('');
  const [hash, setHash] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  const asset = (() => {
    try {
      return parseAssetKey(assetK);
    } catch {
      return parseAssetKey('XLM');
    }
  })();
  const max = spendable(account, asset);
  const maxMinusFee = (() => {
    const v = tryAmountToStroops(max) ?? 0n;
    const fee = asset.type === 'native' ? FEE : 0n;
    return stroopsToAmount(v > fee ? v - fee : 0n);
  })();
  const others = keys.filter((k) => k.publicKey !== wallet.publicKey);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      setHash(null);
      setNote(null);
      const to = dest.trim();
      if (to === wallet.publicKey) throw new Error('Choose a different destination: this is the sending account.');
      const exists = /^G[A-Z2-7]{55}$/.test(to) ? await api.getAccount(to) : null;
      let ops;
      let label: string;
      if (!exists && asset.type === 'native') {
        const v = tryAmountToStroops(amount);
        if (v !== null && v < 10_000_000n) throw new Error('The destination does not exist yet. Send at least 1 XLM to create it.');
        ops = [createAccountOp({ destination: to, startingBalance: amount })];
        label = `Create account with ${formatAmount(amount)} XLM`;
        setNote('The destination did not exist, so this creates it.');
      } else if (!exists) {
        throw new Error(`The destination does not exist yet. Send XLM first to create it, then it can add a ${asset.code} trustline.`);
      } else {
        if (asset.type !== 'native' && asset.issuer !== to && !exists.balances.some((b) => assetKey(b.asset) === assetKey(asset))) {
          throw new Error(`The destination has no ${asset.code} trustline, so it cannot receive ${asset.code}.`);
        }
        ops = [paymentOp({ destination: to, asset, amount })];
        label = `Send ${formatAmount(amount)} ${asset.code}`;
      }
      const res = await submit({ key: wallet, ops, label, memo: memoFromFields(memoType, memo) });
      if (!res.ok) throw new Error(res.message ?? 'Rejected by the node.');
      setHash(res.hash);
      setAmount('');
      setMemo('');
    });
  };

  return (
    <Card title="Send a payment" subtitle="XLM or any asset you hold" icon={Send} iconClass="text-ledger">
      <form onSubmit={onSubmit} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Destination" htmlFor={`${id}-dest`} className="sm:col-span-2" hint="A G… account id. New accounts are created when you send XLM.">
          <Input
            id={`${id}-dest`}
            mono
            list={`${id}-keys`}
            value={dest}
            onChange={(e) => setDest(e.target.value.trim())}
            placeholder="G…"
            autoComplete="off"
            required
          />
          <datalist id={`${id}-keys`}>
            {others.map((k) => (
              <option key={k.publicKey} value={k.publicKey}>
                {k.name}
              </option>
            ))}
          </datalist>
        </Field>
        <Field label="Asset" htmlFor={`${id}-asset`}>
          <Select id={`${id}-asset`} value={assetK} onChange={(e) => setAssetK(e.target.value)}>
            {account.balances.map((b) => (
              <option key={assetKey(b.asset)} value={assetKey(b.asset)}>
                {b.asset.code}
                {b.asset.issuer ? ` · ${b.asset.issuer.slice(0, 4)}…${b.asset.issuer.slice(-4)}` : ''} ({formatAmount(b.balance, { maxDecimals: 2 })})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Amount" htmlFor={`${id}-amount`} hint={`Spendable: ${formatAmount(max)} ${asset.code}`}>
          <div className="flex gap-2">
            <Input id={`${id}-amount`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(',', '.'))} placeholder="0.00" required className="tabular-nums" />
            <Button size="md" variant="ghost" onClick={() => setAmount(formatAmount(maxMinusFee, { group: false }))}>
              Max
            </Button>
          </div>
        </Field>
        <Field label="Memo type" htmlFor={`${id}-mt`}>
          <Select id={`${id}-mt`} value={memoType} onChange={(e) => setMemoType(e.target.value as MemoType)}>
            <option value="none">No memo</option>
            <option value="text">Text (28 bytes)</option>
            <option value="id">ID (number)</option>
            <option value="hash">Hash (64 hex)</option>
          </Select>
        </Field>
        <Field label="Memo" htmlFor={`${id}-memo`} optional>
          <Input id={`${id}-memo`} value={memo} disabled={memoType === 'none'} onChange={(e) => setMemo(e.target.value)} placeholder={memoType === 'id' ? '12345' : memoType === 'hash' ? '64 hex characters' : 'e.g. coffee'} />
        </Field>
        <div className="flex flex-col gap-3 sm:col-span-2">
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          {note ? (
            <Notice tone="info" icon={Info}>
              {note}
            </Notice>
          ) : null}
          {hash ? <TxStatusLine hash={hash} /> : null}
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-fg-3">Fee: 0.00001 XLM (100 stroops)</p>
            <Button type="submit" variant="primary" icon={Send} loading={busy}>
              Send
            </Button>
          </div>
        </div>
      </form>
    </Card>
  );
}
