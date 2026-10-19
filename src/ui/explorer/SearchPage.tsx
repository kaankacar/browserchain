import { SearchX } from 'lucide-react';
import { useEffect } from 'react';
import { Card, EmptyState, PageHeader } from '../components/ui';
import { navigate } from '../hooks/useRoute';
import { href } from '../lib/route';
import { classifySearch } from '../lib/search';
import { ExplorerNav } from './common';

/** "#/search/<q>": jump to the matching page, or explain why nothing matches. */
export function SearchPage({ q }: { q: string }) {
  const target = classifySearch(q);
  useEffect(() => {
    if (target.kind === 'account') navigate(href.account(target.id), { replace: true });
    else if (target.kind === 'tx') navigate(href.tx(target.hash), { replace: true });
    else if (target.kind === 'ledger') navigate(href.ledger(target.seq), { replace: true });
  }, [target.kind, q]);
  return (
    <div>
      <PageHeader title="Search" icon={SearchX} />
      <ExplorerNav active="none" />
      {target.kind === 'invalid' ? (
        <Card>
          <EmptyState icon={SearchX} title={q ? `Nothing found for “${q}”` : 'Search the network'}>
            {target.reason}
          </EmptyState>
        </Card>
      ) : null}
    </div>
  );
}
