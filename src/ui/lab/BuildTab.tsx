import { Hammer, PenLine, Plus, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import type { xdr } from '@stellar/stellar-sdk/base';
import { CopyButton } from '../components/Hash';
import { Button, Card, ErrorNote, Field, IconButton, Input, Select } from '../components/ui';
import { useAsync } from '../hooks/useAsync';
import { navigate } from '../hooks/useRoute';
import { assetKey, NATIVE_ASSET, opTypeLabel, parseAssetKey } from '../lib/format';
import { href } from '../lib/route';
import {
  bumpSequenceOp,
  buildTx,
  changeTrustOp,
  createAccountOp,
  envelopeXdr,
  manageDataOp,
  manageSellOfferOp,
  memoFromFields,
  paymentOp,
  setHomeDomainOp,
  txHashHex,
  type MemoType,
} from '../lib/txbuild';
import { useApi, useClock, useNodeState } from '../state/NodeProvider';
import { useWallet } from '../state/wallet';
import { useLab } from './LabPage';

type OpKind = 'payment' | 'createAccount' | 'changeTrust' | 'manageData' | 'setHomeDomain' | 'bumpSequence' | 'manageSellOffer';
const KINDS: OpKind[] = ['payment', 'createAccount', 'changeTrust', 'manageSellOffer', 'manageData', 'setHomeDomain', 'bumpSequence'];

interface OpDraft {
  id: number;
  kind: OpKind;
  f: Record<string, string>;
}

function opFromDraft(d: OpDraft): xdr.Operation {
  const f = d.f;
  const asset = (k: string) => parseAssetKey(f[k] || 'XLM');
  const source = f.source?.trim() || undefined;
  switch (d.kind) {
    case 'payment':
      return paymentOp({ destination: f.destination ?? '', asset: asset('asset'), amount: f.amount ?? '', source });
    case 'createAccount':
      return createAccountOp({ destination: f.destination ?? '', startingBalance: f.amount ?? '', source });
    case 'changeTrust':
      return changeTrustOp({ asset: asset('asset'), limit: f.limit, source });
    case 'manageSellOffer':
      return manageSellOfferOp({ selling: asset('selling'), buying: asset('buying'), amount: f.amount ?? '', price: f.price ?? '', offerId: f.offerId || undefined, source });
    case 'manageData':
      return manageDataOp({ name: f.name ?? '', value: f.value ?? null, source });
    case 'setHomeDomain':
      return setHomeDomainOp(f.domain ?? '', source);
    case 'bumpSequence':
      return bumpSequenceOp(f.bumpTo ?? '', source);
  }
}

function OpEditor({ d, onChange, onRemove, assets, index }: { d: OpDraft; onChange: (d: OpDraft) => void; onRemove: () => void; assets: string[]; index: number }) {
  const id = useId();
  const set = (k: string, v: string) => onChange({ ...d, f: { ...d.f, [k]: v } });
  const text = (k: string, label: string, placeholder = '', mono = false) => (
    <Field label={label} htmlFor={`${id}-${k}`}>
      <Input id={`${id}-${k}`} value={d.f[k] ?? ''} mono={mono} placeholder={placeholder} onChange={(e) => set(k, e.target.value)} />
    </Field>
  );
  const assetSel = (k: string, label: string) => (
    <Field label={label} htmlFor={`${id}-${k}`}>
      <Select id={`${id}-${k}`} value={d.f[k] ?? 'XLM'} onChange={(e) => set(k, e.target.value)}>
        {assets.map((a) => (
          <option key={a} value={a}>
            {a === 'XLM' ? 'XLM' : `${a.split(':')[0]} · ${a.split(':')[1].slice(0, 4)}…${a.split(':')[1].slice(-4)}`}
          </option>
        ))}
      </Select>
    </Field>
  );
  return (
    <li className="rounded-xl border border-line bg-raised p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-sm font-semibold">
          <span className="mr-1.5 text-fg-3">#{index + 1}</span>
          {opTypeLabel(d.kind)}
        </p>
        <IconButton icon={Trash2} label="Remove operation" size="sm" onClick={onRemove} />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {d.kind === 'payment' ? (
          <>
            {text('destination', 'Destination', 'G…', true)}
            {assetSel('asset', 'Asset')}
            {text('amount', 'Amount', '10')}
          </>
        ) : null}
        {d.kind === 'createAccount' ? (
          <>
            {text('destination', 'New account', 'G…', true)}
            {text('amount', 'Starting balance', '2')}
          </>
        ) : null}
        {d.kind === 'changeTrust' ? (
          <>
            {assetSel('asset', 'Asset')}
            {text('limit', 'Limit (empty = max, 0 = remove)', '')}
          </>
        ) : null}
        {d.kind === 'manageSellOffer' ? (
          <>
            {assetSel('selling', 'Selling')}
            {assetSel('buying', 'Buying')}
            {text('amount', 'Amount (0 deletes)', '10')}
            {text('price', 'Price (buying per selling)', '1')}
            {text('offerId', 'Offer id (empty = new)', '')}
          </>
        ) : null}
        {d.kind === 'manageData' ? (
          <>
            {text('name', 'Name', 'nickname')}
            {text('value', 'Value (empty deletes)', '')}
          </>
        ) : null}
        {d.kind === 'setHomeDomain' ? text('domain', 'Home domain', 'example.com') : null}
        {d.kind === 'bumpSequence' ? text('bumpTo', 'Bump to sequence', '') : null}
        {text('source', 'Operation source (optional)', 'defaults to the tx source', true)}
      </div>
    </li>
  );
}

export function BuildTab() {
  const { setXdr } = useLab();
  const { keys } = useWallet();
  const api = useApi();
  const clock = useClock();
  const passphrase = useNodeState((s) => s.status?.networkPassphrase ?? null);
  const assetList = useAsync(() => api.getAssets(), [api]);
  const assets = ['XLM', ...(assetList.data ?? []).map((a) => assetKey(a.asset))];
  const id = useId();
  const [source, setSource] = useState(keys[0]?.publicKey ?? '');
  const [fee, setFee] = useState('100');
  const [memoType, setMemoType] = useState<MemoType>('none');
  const [memo, setMemo] = useState('');
  const [validFor, setValidFor] = useState('');
  const [ops, setOps] = useState<OpDraft[]>([{ id: 1, kind: 'payment', f: { asset: assetKey(NATIVE_ASSET) } }]);
  const [nextKind, setNextKind] = useState<OpKind>('payment');
  const [built, setBuilt] = useState<{ xdr: string; hash: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const account = useAsync(() => (/^G[A-Z2-7]{55}$/.test(source) ? api.getAccount(source) : Promise.resolve(null)), [source, api]);
  const [seqOverride, setSeqOverride] = useState('');

  const build = () => {
    setError(null);
    setBuilt(null);
    try {
      if (!passphrase) throw new Error('Not connected to a node yet.');
      const seq = seqOverride.trim() || account.data?.sequence;
      if (!seq) throw new Error('The source account does not exist; enter its sequence number by hand.');
      const minutes = Number(validFor);
      const now = Math.floor(clock.now() / 1000);
      const tx = buildTx(
        {
          source: source.trim(),
          sequence: seq,
          networkPassphrase: passphrase,
          feePerOp: Number(fee),
          memo: memoFromFields(memoType, memo),
          timeBounds: validFor.trim() && minutes > 0 ? { minTime: 0, maxTime: now + Math.round(minutes * 60) } : undefined,
        },
        ops.map(opFromDraft),
      );
      const out = { xdr: envelopeXdr(tx), hash: txHashHex(tx) };
      setBuilt(out);
      setXdr(out.xdr);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-4 sm:gap-5 xl:grid-cols-12">
      <Card title="Transaction" subtitle="Builds an unsigned v1 envelope" icon={Hammer} className="xl:col-span-7">
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Source account" htmlFor={`${id}-src`} className="sm:col-span-2" hint={account.data ? `Current sequence ${account.data.sequence}; the tx uses the next one.` : source ? 'Account not found on the network.' : undefined}>
              <Input id={`${id}-src`} mono list={`${id}-keys`} value={source} onChange={(e) => setSource(e.target.value.trim())} placeholder="G…" />
              <datalist id={`${id}-keys`}>
                {keys.map((k) => (
                  <option key={k.publicKey} value={k.publicKey}>
                    {k.name}
                  </option>
                ))}
              </datalist>
            </Field>
            <Field label="Sequence override" htmlFor={`${id}-seq`} optional>
              <Input id={`${id}-seq`} mono value={seqOverride} onChange={(e) => setSeqOverride(e.target.value.replace(/\D/g, ''))} placeholder="current account sequence" />
            </Field>
            <Field label="Fee per operation (stroops)" htmlFor={`${id}-fee`}>
              <Input id={`${id}-fee`} inputMode="numeric" value={fee} onChange={(e) => setFee(e.target.value.replace(/\D/g, ''))} />
            </Field>
            <Field label="Memo" htmlFor={`${id}-mt`}>
              <div className="flex gap-2">
                <Select id={`${id}-mt`} value={memoType} onChange={(e) => setMemoType(e.target.value as MemoType)} className="w-28 shrink-0">
                  <option value="none">none</option>
                  <option value="text">text</option>
                  <option value="id">id</option>
                  <option value="hash">hash</option>
                  <option value="return">return</option>
                </Select>
                <Input aria-label="Memo value" value={memo} disabled={memoType === 'none'} onChange={(e) => setMemo(e.target.value)} />
              </div>
            </Field>
            <Field label="Valid for (minutes)" htmlFor={`${id}-tb`} optional hint="Sets a max time bound. Empty = no time bounds.">
              <Input id={`${id}-tb`} inputMode="numeric" value={validFor} onChange={(e) => setValidFor(e.target.value.replace(/\D/g, ''))} />
            </Field>
          </div>
          <ol className="flex flex-col gap-3" aria-label="Operations">
            {ops.map((d, i) => (
              <OpEditor
                key={d.id}
                d={d}
                index={i}
                assets={assets}
                onChange={(nd) => setOps((xs) => xs.map((x) => (x.id === d.id ? nd : x)))}
                onRemove={() => setOps((xs) => xs.filter((x) => x.id !== d.id))}
              />
            ))}
          </ol>
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={`${id}-kind`} className="sr-only">
              Operation type
            </label>
            <Select id={`${id}-kind`} value={nextKind} onChange={(e) => setNextKind(e.target.value as OpKind)} className="w-auto">
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {opTypeLabel(k)}
                </option>
              ))}
            </Select>
            <Button icon={Plus} onClick={() => setOps((xs) => [...xs, { id: Math.max(0, ...xs.map((x) => x.id)) + 1, kind: nextKind, f: { asset: 'XLM', selling: 'XLM', buying: assets[1] ?? 'XLM' } }])}>
              Add operation
            </Button>
          </div>
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          <div className="flex justify-end">
            <Button variant="primary" icon={Hammer} onClick={build}>
              Build transaction
            </Button>
          </div>
        </div>
      </Card>
      <Card title="Unsigned envelope" icon={PenLine} className="xl:col-span-5" actions={built ? <CopyButton value={built.xdr} label="Copy XDR" /> : null}>
        {built ? (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-fg-3">
              Hash <span className="font-mono text-fg-2 [overflow-wrap:anywhere]">{built.hash}</span>
            </p>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-sunken p-3 font-mono text-xs text-fg-2 [overflow-wrap:anywhere]">{built.xdr}</pre>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" icon={PenLine} onClick={() => navigate(href.lab('sign'))}>
                Sign it
              </Button>
              <Button onClick={() => navigate(href.lab('decode'))}>Decode</Button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-fg-3">Fill in the form and build. The result is shared with the Sign and Submit tabs.</p>
        )}
      </Card>
    </div>
  );
}
