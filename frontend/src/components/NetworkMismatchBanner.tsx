import { useNetwork } from "../context/NetworkContext";

const NETWORK_LABELS: Record<string, string> = {
  TESTNET: "Testnet",
  PUBLIC: "Mainnet",
  FUTURENET: "Futurenet",
};

function humanizeNetworkName(name: string): string {
  return NETWORK_LABELS[name] ?? name;
}

/**
 * Global banner shown whenever the connected wallet's network does not
 * match the network this app is configured for (#663). Renders nothing when
 * there is no wallet connected or the networks agree.
 */
export function NetworkMismatchBanner(): JSX.Element | null {
  const { network, walletNetworkName, networkMismatch } = useNetwork();

  if (!networkMismatch || !walletNetworkName) return null;

  const appLabel = network === "mainnet" ? "Mainnet" : "Testnet";
  const walletLabel = humanizeNetworkName(walletNetworkName);

  return (
    <div
      role="alert"
      aria-live="assertive"
      style={{
        position: "sticky",
        top: 0,
        zIndex: 9998,
        background: "#991b1b",
        color: "#fff",
        textAlign: "center",
        padding: "0.6rem 1rem",
        fontSize: "0.9rem",
        fontFamily: "system-ui, sans-serif",
        boxShadow: "0 2px 6px rgba(0,0,0,0.18)",
      }}
    >
      ⚠️ Network mismatch: your wallet is connected to <strong>{walletLabel}</strong>,
      but this app is configured for <strong>{appLabel}</strong>. Switch your wallet's
      network to continue — contract actions are disabled until they match.
    </div>
  );
}
