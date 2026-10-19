import { Send } from 'lucide-react';
import { useState } from 'react';
import type { SubmitResult } from '../../node/api';
import { Badge, Button, Card, ErrorNote, Facts, Field, Textarea } from '../components/ui';
import { humanizeCode } from '../lib/format';
import { href } from '../lib/route';
import { useApi, useStore } from '../state/NodeProvider';
import { TxStatusLine } from '../wallet/shared';
import { useLab } from './LabPage';

const TONE: Record<SubmitResult['status'], 'ok' | 'warn' | 'bad' | 'neutral'> = {
  PENDING: 'ok',
  DUPLICATE: 'neutral',
  TRY_AGAIN_LATER: 'warn',
  ERROR: 'bad',
};

export function SubmitTab() {
  const { xdr, setXdr } = useLab();
  const api = useApi();
  const store = useStore();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.submitTransaction(xdr.trim());
      if (res.status === 'PENDING' && res.hash) store.trackSubmitted(res.hash);
      setResult(res);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-4 sm:gap-5 xl:grid-cols-2">
      <Card title="Submit a signed envelope" icon={Send} iconClass="text-ledger">
        <Field label="TransactionEnvelope (base64)" htmlFor="submit-xdr">
          <Textarea id="submit-xdr" value={xdr} onChange={(e) => setXdr(e.target.value)} rows={10} placeholder="AAAAAgAAAAA…" />
        </Field>
        {error ? <ErrorNote className="mt-3">{error}</ErrorNote> : null}
        <div className="mt-4 flex justify-end">
          <Button variant="primary" icon={Send} loading={busy} disabled={!xdr.trim()} onClick={() => void submit()}>
            Submit to the network
          </Button>
        </div>
      </Card>
      <Card title="Result" icon={Send}>
        {!result ? (
          <p className="text-sm text-fg-3">The node checks the envelope (sequence, fee, signatures) and queues it for the next ledger.</p>
        ) : (
          <div className="flex flex-col gap-4">
            <Facts
              items={[
                { label: 'Status', value: <Badge tone={TONE[result.status]}>{result.status}</Badge> },
                { label: 'Result code', value: result.errorResultCode ? <span className="font-mono text-xs">{result.errorResultCode}</span> : <span className="text-fg-3">–</span> },
                {
                  label: 'Hash',
                  wide: true,
                  value: result.hash ? (
                    <a href={href.tx(result.hash)} className="font-mono text-xs text-fg hover:text-ledger [overflow-wrap:anywhere]">
                      {result.hash}
                    </a>
                  ) : (
                    '–'
                  ),
                },
                ...(result.errorResultCode || result.errorDetail
                  ? [{ label: 'Why', value: `${result.errorResultCode ? humanizeCode(result.errorResultCode) : ''}${result.errorDetail ? ` (${result.errorDetail})` : ''}`, wide: true }]
                  : []),
              ]}
            />
            {result.status === 'PENDING' || result.status === 'DUPLICATE' ? <TxStatusLine hash={result.hash} /> : null}
          </div>
        )}
      </Card>
    </div>
  );
}
