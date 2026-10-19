import { Microscope, Radio, ScrollText, Server } from 'lucide-react';
import { NodeAlerts } from '../components/NodeAlerts';
import { PageHeader, TabLinks } from '../components/ui';
import { href, type ValidatorTab } from '../lib/route';
import { useNodeState } from '../state/NodeProvider';
import { IdentityCard } from './IdentityCard';
import { ForksCard, LogsCard, PeersTable, ValidatorsTable } from './NetworkCards';
import { QuorumCard } from './QuorumCard';
import { ScpLog } from './ScpLog';
import { SlotInspector } from './SlotInspector';

export function ValidatorPage({ tab }: { tab: ValidatorTab }) {
  const name = useNodeState((s) => s.status?.name ?? 'This node');
  const peers = useNodeState((s) => s.peers.length);
  return (
    <div>
      <PageHeader
        title={name}
        icon={Server}
        description="This browser tab is a full validator: it keeps the ledger, votes in SCP and serves history to peers."
      />
      <div className="mb-5 flex flex-col gap-3 empty:hidden sm:mb-6">
        <NodeAlerts linkToValidator={false} />
      </div>
      <TabLinks
        label="Validator sections"
        active={tab}
        tabs={[
          { id: 'node', href: href.validator('node'), label: 'Node & quorum', icon: Server },
          { id: 'scp', href: href.validator('scp'), label: 'Consensus', icon: Microscope },
          { id: 'peers', href: href.validator('peers'), label: 'Peers', icon: Radio, count: peers },
          { id: 'logs', href: href.validator('logs'), label: 'Logs', icon: ScrollText },
        ]}
      />
      <div className="mt-5 sm:mt-6">
        {tab === 'node' ? (
          <div className="grid grid-cols-1 gap-4 sm:gap-5 lg:grid-cols-12">
            <div className="lg:col-span-5">
              <IdentityCard />
            </div>
            <div className="lg:col-span-7">
              <QuorumCard />
            </div>
          </div>
        ) : null}
        {tab === 'scp' ? (
          <div className="grid grid-cols-1 gap-4 sm:gap-5 xl:grid-cols-12">
            <div className="min-w-0 xl:col-span-5">
              <SlotInspector />
            </div>
            <div className="min-w-0 xl:col-span-7">
              <ScpLog />
            </div>
          </div>
        ) : null}
        {tab === 'peers' ? (
          <div className="flex flex-col gap-4 sm:gap-5">
            <PeersTable />
            <div className="grid grid-cols-1 gap-4 sm:gap-5 lg:grid-cols-12">
              <div className="min-w-0 lg:col-span-7">
                <ValidatorsTable />
              </div>
              <div className="min-w-0 lg:col-span-5">
                <ForksCard />
              </div>
            </div>
          </div>
        ) : null}
        {tab === 'logs' ? <LogsCard /> : null}
      </div>
    </div>
  );
}

