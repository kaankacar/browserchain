import { Braces, FlaskConical, Hammer, PenLine, Send } from 'lucide-react';
import { createContext, useContext, useMemo, useState } from 'react';
import { PageHeader, TabLinks } from '../components/ui';
import { href, type LabTab } from '../lib/route';
import { BuildTab } from './BuildTab';
import { DecodeTab } from './DecodeTab';
import { SignTab } from './SignTab';
import { SubmitTab } from './SubmitTab';

interface LabState {
  /** The XDR shared by all lab tabs (build → sign → submit). */
  xdr: string;
  setXdr: (x: string) => void;
}

const LabContext = createContext<LabState>({ xdr: '', setXdr: () => {} });

export function useLab(): LabState {
  return useContext(LabContext);
}

const KEY = 'browserchain:lab:xdr';

function readSession(): string {
  try {
    return sessionStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

export function LabPage({ tab }: { tab: LabTab }) {
  const [xdr, setXdrState] = useState(readSession);
  const value = useMemo<LabState>(
    () => ({
      xdr,
      setXdr: (x) => {
        setXdrState(x);
        try {
          sessionStorage.setItem(KEY, x);
        } catch {
          // best effort
        }
      },
    }),
    [xdr],
  );
  return (
    <LabContext.Provider value={value}>
      <PageHeader title="Lab" icon={FlaskConical} description="Work with raw Stellar XDR: decode anything, build and sign transactions by hand, and submit them." />
      <TabLinks
        label="Lab tools"
        active={tab}
        tabs={[
          { id: 'decode', href: href.lab('decode'), label: 'Decode', icon: Braces },
          { id: 'build', href: href.lab('build'), label: 'Build', icon: Hammer },
          { id: 'sign', href: href.lab('sign'), label: 'Sign', icon: PenLine },
          { id: 'submit', href: href.lab('submit'), label: 'Submit', icon: Send },
        ]}
      />
      <div className="mt-5 sm:mt-6">
        {tab === 'decode' ? <DecodeTab /> : null}
        {tab === 'build' ? <BuildTab /> : null}
        {tab === 'sign' ? <SignTab /> : null}
        {tab === 'submit' ? <SubmitTab /> : null}
      </div>
    </LabContext.Provider>
  );
}
