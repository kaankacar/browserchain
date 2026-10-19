/** BrowserChain mark: a browser window whose tabs are linked validators. */
export function LogoMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden className={className}>
      <rect x="2.5" y="4.5" width="27" height="23" rx="6" stroke="var(--bc-ledger-fill)" strokeWidth="2" />
      <path d="M2.5 10.5h27" stroke="var(--bc-ledger-fill)" strokeWidth="2" />
      <circle cx="6.5" cy="7.6" r="1" fill="var(--bc-ledger-fill)" />
      <circle cx="9.8" cy="7.6" r="1" fill="var(--bc-ledger-fill)" />
      <path d="M10 22.5 16 15l6 7.5H10Z" stroke="var(--bc-consensus)" strokeWidth="1.6" strokeLinejoin="round" />
      <circle cx="16" cy="15" r="2.4" fill="var(--bc-panel)" stroke="var(--bc-consensus)" strokeWidth="1.6" />
      <circle cx="10" cy="22.5" r="2.4" fill="var(--bc-panel)" stroke="var(--bc-network)" strokeWidth="1.6" />
      <circle cx="22" cy="22.5" r="2.4" fill="var(--bc-ledger-fill)" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="text-[15px] font-semibold tracking-tight text-fg">
      Browser<span className="text-ledger">Chain</span>
    </span>
  );
}
