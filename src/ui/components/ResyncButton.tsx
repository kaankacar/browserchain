import { RotateCcw } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useApi, useStore } from '../state/NodeProvider';
import { useToast } from '../state/toast';
import { ConfirmDialog } from './Dialog';
import { Button } from './ui';

/**
 * Resync with a confirmation in the page: the node wipes its chain and
 * catches up from peers. It keeps its identity. The dialog lives in
 * document.body, so the styles of a notice around the button do not reach it.
 */
export function ResyncButton({
  label,
  title,
  children,
  variant = 'danger',
}: {
  label: string;
  title: string;
  children: ReactNode;
  variant?: 'danger' | 'secondary';
}) {
  const api = useApi();
  const store = useStore();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const resync = async () => {
    setBusy(true);
    try {
      await api.resync();
      store.noteResync();
      toast({ tone: 'info', title: 'Resync started', body: 'The local chain is wiped. Catching up from peers.' });
      setOpen(false);
    } catch (e) {
      toast({ tone: 'bad', title: 'Resync failed', body: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant={variant} size="sm" icon={RotateCcw} onClick={() => setOpen(true)}>
        {label}
      </Button>
      {createPortal(
        <ConfirmDialog open={open} title={title} confirmLabel="Wipe and resync" danger busy={busy} onConfirm={resync} onClose={() => setOpen(false)}>
          {children}
        </ConfirmDialog>,
        document.body,
      )}
    </>
  );
}
