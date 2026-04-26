interface Props {
  onClose: () => void;
}

const SHORTCUTS = [
  { keys: "Ctrl+K", desc: "Focus contract ID input" },
  { keys: "Ctrl+D", desc: "Toggle dark mode" },
  { keys: "?", desc: "Show this help modal" },
  { keys: "Esc", desc: "Close this modal" },
];

export default function HelpModal({ onClose }: Props) {
  return (
    <div
      className="modal-overlay"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal-box" role="dialog" aria-modal="true" aria-label="Help">
        <div className="modal-header">
          <h2>Stellar Royalty Splitter</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <p>Automatically distribute NFT sale proceeds among collaborators based on predefined percentage allocations.</p>

        <ol style={{ paddingLeft: "1.25rem", lineHeight: 1.8 }}>
          <li>Connect your Freighter wallet</li>
          <li>Enter a contract ID (starts with C, 56 chars)</li>
          <li>Call <strong>Initialize</strong> with collaborator addresses and shares (basis points summing to 10,000)</li>
          <li>Call <strong>Distribute</strong> to split funds proportionally</li>
        </ol>

        <h3 style={{ marginTop: "1rem" }}>Keyboard shortcuts</h3>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <tbody>
            {SHORTCUTS.map(({ keys, desc }) => (
              <tr key={keys}>
                <td style={{ padding: "0.25rem 0.5rem 0.25rem 0" }}>
                  <kbd style={{ background: "var(--bg-secondary, #eee)", borderRadius: 4, padding: "0.1rem 0.4rem", fontFamily: "monospace" }}>{keys}</kbd>
                </td>
                <td style={{ padding: "0.25rem 0" }}>{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <button className="btn-primary" style={{ marginTop: "1.25rem", width: "100%" }} onClick={onClose}>
          Got it
        </button>
      </div>
    </div>
  );
}
