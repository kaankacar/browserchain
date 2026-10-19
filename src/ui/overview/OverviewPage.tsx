import { TriangleAlert, Users } from 'lucide-react';
import { useMemo } from 'react';
import { NodeName } from '../components/links';
import { NodeAlerts } from '../components/NodeAlerts';
import { Notice } from '../components/ui';
import { selfState } from '../lib/catchup';
import { describeQset, qsetValidators } from '../lib/quorum';
import { useNodeState } from '../state/NodeProvider';
import { ConsensusCard } from './ConsensusCard';
import { LedgerHero } from './LedgerHero';
import { LedgerStrip } from './LedgerStrip';
import { QuorumGraph } from './QuorumGraph';
import { StatsRow } from './StatsRow';
import { TxFeed } from './TxFeed';

/** Why consensus stalls: the quorum set needs validators that are not here. */
function StalledNotice() {
  const qset = useNodeState((s) => s.status?.quorum.qset ?? null);
  const selfId = useNodeState((s) => s.status?.nodeId ?? null);
  const validators = useNodeState((s) => s.validators);
  const missing = useMemo(() => {
    if (!qset) return [];
    const byId = new Map(validators.map((v) => [v.nodeId, v]));
    return qsetValidators(qset).filter((id) => {
      if (id === selfId) return false;
      const v = byId.get(id);
      return !v || !v.connected || !v.synced;
    });
  }, [qset, selfId, validators]);
  return (
    <Notice tone="warn" icon={TriangleAlert} title="Consensus is stalled">
      No ledger closed for a while.{' '}
      {qset ? (
        <>
          Your quorum set needs {describeQset(qset)}
          {missing.length ? (
            <>
              , and these validators are offline or not in sync:{' '}
              {missing.map((id, i) => (
                // a name keeps its comma or period on its line
                <span key={id}>
                  <span className="whitespace-nowrap">
                    <NodeName id={id} size={14} you={false} className="font-medium text-fg" />
                    {i < missing.length - 1 ? ',' : '.'}
                  </span>{' '}
                </span>
              ))}
            </>
          ) : (
            '.'
          )}{' '}
        </>
      ) : null}
      Check the quorum on the{' '}
      <a href="#/validator" className="font-medium text-ledger underline">
        Validator
      </a>{' '}
      page.
    </Notice>
  );
}

export function OverviewPage() {
  // a blocked node is neither stalled nor alone: its notice says why it does not vote
  const state = useNodeState((s) => selfState(s.status));
  const alone = useNodeState((s) => selfState(s.status) === 'synced' && s.status?.peers === 0);
  const error = useNodeState((s) => s.error);
  return (
    <div className="flex flex-col gap-4 sm:gap-5">
      <h1 className="sr-only">Network overview</h1>
      {error ? (
        <Notice tone="warn" icon={TriangleAlert} title="Cannot reach the node">
          {error}
        </Notice>
      ) : null}
      {state === 'stalled' ? <StalledNotice /> : null}
      <NodeAlerts />
      {alone ? (
        <Notice tone="info" icon={Users} title="This tab is the only validator">
          Open this page in another tab to add a second validator. Each tab is a validator with its own key.
        </Notice>
      ) : null}
      <div className="grid grid-cols-1 gap-4 sm:gap-5 lg:grid-cols-12">
        <div className="lg:col-span-5">
          <LedgerHero />
        </div>
        <div className="lg:col-span-7">
          <ConsensusCard />
        </div>
      </div>
      <StatsRow />
      <LedgerStrip />
      <div className="grid grid-cols-1 gap-4 sm:gap-5 lg:grid-cols-12">
        <div className="lg:col-span-7">
          <QuorumGraph />
        </div>
        <div className="lg:col-span-5">
          <TxFeed />
        </div>
      </div>
    </div>
  );
}
