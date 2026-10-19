import { StrKey, xdr as X } from '@stellar/stellar-sdk/base';
import { Braces, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { fromHex } from '../../lib/bytes';
import { CopyButton } from '../components/Hash';
import { JsonView } from '../components/JsonView';
import { Badge, Button, Card, ErrorNote, Field, Select, Textarea } from '../components/ui';
import { decodeXdr, detectXdrType, jsonText, XDR_TYPES, type Json, type XdrTypeName } from '../lib/xdrJson';

type Decoded = { kind: 'ok'; type: XdrTypeName; json: Json } | { kind: 'error'; error: string };
import { useApi, useNodeState } from '../state/NodeProvider';
import { useLab } from './LabPage';

/** An unsigned sample SCP EXTERNALIZE statement for the latest ledger (for trying the decoder). */
function sampleScpEnvelope(nodeId: string, slot: number, txSetHash: string, closeTime: number): string {
  const value = new X.StellarValue({
    txSetHash: fromHex(txSetHash),
    closeTime: BigInt(closeTime),
    upgrades: [],
    ext: X.StellarValueExt.stellarValueBasic(),
  });
  const statement = new X.ScpStatement({
    nodeId: X.PublicKey.publicKeyTypeEd25519(StrKey.decodeEd25519PublicKey(nodeId)),
    slotIndex: BigInt(slot),
    pledges: X.ScpStatementPledges.scpStExternalize(
      new X.ScpStatementExternalize({ commit: new X.ScpBallot({ counter: 1, value: value.toXdr() }), nH: 1, commitQuorumSetHash: new Uint8Array(32) }),
    ),
  });
  return new X.ScpEnvelope({ statement, signature: new Uint8Array(64) }).toXdr('base64');
}

export function DecodeTab() {
  const { xdr, setXdr } = useLab();
  const api = useApi();
  const latestTx = useNodeState((s) => s.txs[0]?.hash ?? null);
  const status = useNodeState((s) => s.status);
  const [type, setType] = useState<'auto' | XdrTypeName>('auto');
  const [loading, setLoading] = useState<string | null>(null);
  const [exampleError, setExampleError] = useState<string | null>(null);

  const result = useMemo((): Decoded | null => {
    if (!xdr.trim()) return null;
    const t = type === 'auto' ? detectXdrType(xdr) : type;
    if (!t) return { kind: 'error', error: 'Could not detect the type. Pick it from the list.' };
    try {
      return { kind: 'ok', type: t, json: decodeXdr(t, xdr) };
    } catch (e) {
      return { kind: 'error', error: (e as Error).message };
    }
  }, [xdr, type]);

  const example = async (kind: 'env' | 'result' | 'header' | 'scp') => {
    setLoading(kind);
    setExampleError(null);
    try {
      if (kind === 'env' || kind === 'result') {
        if (!latestTx) throw new Error('No transactions yet.');
        const tx = await api.getTransaction(latestTx);
        if (!tx) throw new Error('Transaction not found.');
        setXdr(kind === 'env' ? tx.envelopeXdr : tx.resultXdr);
        setType(kind === 'env' ? 'TransactionEnvelope' : 'TransactionResult');
      } else if (kind === 'header') {
        if (!status) throw new Error('Not connected yet.');
        const l = await api.getLedger(status.lcl.seq);
        if (!l) throw new Error('Ledger not found.');
        setXdr(l.headerXdr);
        setType('LedgerHeader');
      } else {
        if (!status) throw new Error('Not connected yet.');
        setXdr(sampleScpEnvelope(status.nodeId, status.lcl.seq, status.lcl.txSetHash, status.lcl.closeTime));
        setType('ScpEnvelope');
      }
    } catch (e) {
      setExampleError((e as Error).message);
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-4 sm:gap-5 xl:grid-cols-2">
      <Card title="XDR input" subtitle="Base64 or hex" icon={Braces}>
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Type" htmlFor="lab-type" className="w-full sm:w-64">
              <Select id="lab-type" value={type} onChange={(e) => setType(e.target.value as 'auto' | XdrTypeName)}>
                <option value="auto">Detect automatically</option>
                {XDR_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="XDR" htmlFor="lab-xdr">
            <Textarea id="lab-xdr" value={xdr} onChange={(e) => setXdr(e.target.value)} rows={9} placeholder="AAAAAgAAAAA…" />
          </Field>
          <div>
            <p className="mb-2 text-xs text-fg-3">Try an example from this network:</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" icon={Sparkles} loading={loading === 'env'} onClick={() => void example('env')}>
                Latest transaction
              </Button>
              <Button size="sm" loading={loading === 'result'} onClick={() => void example('result')}>
                Its result
              </Button>
              <Button size="sm" loading={loading === 'header'} onClick={() => void example('header')}>
                Ledger header
              </Button>
              <Button size="sm" loading={loading === 'scp'} onClick={() => void example('scp')}>
                SCP envelope
              </Button>
            </div>
            {exampleError ? <ErrorNote className="mt-2">{exampleError}</ErrorNote> : null}
          </div>
        </div>
      </Card>
      <Card
        title="Decoded"
        subtitle={result?.kind === 'ok' ? result.type : 'JSON view of the XDR'}
        icon={Braces}
        iconClass="text-consensus"
        actions={result?.kind === 'ok' ? <CopyButton value={jsonText(result.json)} label="Copy JSON" /> : null}
      >
        {!result ? (
          <p className="text-sm text-fg-3">Paste XDR on the left, or load an example.</p>
        ) : result.kind === 'error' ? (
          <ErrorNote>{result.error}</ErrorNote>
        ) : (
          <>
            <div className="mb-3 flex items-center gap-2">
              <Badge tone="consensus">{result.type}</Badge>
              {type === 'auto' ? <span className="text-xs text-fg-3">detected</span> : null}
            </div>
            <JsonView value={result.json} className="max-h-[560px] overflow-auto" />
          </>
        )}
      </Card>
    </div>
  );
}
