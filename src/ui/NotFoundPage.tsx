import { Compass } from 'lucide-react';
import { Card, EmptyState } from './components/ui';
import { href } from './lib/route';

export function NotFoundPage({ path }: { path: string }) {
  return (
    <Card>
      <EmptyState
        icon={Compass}
        title="Nothing here"
        action={
          <a href={href.overview()} className="text-sm font-medium text-ledger hover:underline">
            Back to the overview
          </a>
        }
      >
        <span className="font-mono text-xs">{path}</span> is not a page. Links look like <span className="font-mono">#/ledger/12</span> or{' '}
        <span className="font-mono">#/account/G…</span>.
      </EmptyState>
    </Card>
  );
}
