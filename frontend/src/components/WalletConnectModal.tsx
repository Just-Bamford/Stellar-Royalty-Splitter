/**
 * WalletConnect connection modal — closes #942.
 *
 * Manages the connection flow for WalletConnect:
 * 1. Display QR code for mobile wallet scanning
 * 2. Handle connection events
 * 3. Show loading and error states
 * 4. Notify parent on successful connection
 */

import React, { useEffect, useState, useRef } from "react";
import { WalletConnectAdapter } from "../lib/wallet-adapters/walletconnect";
import QRModal from "./QRModal";
import logger from "../utils/logger";

interface WalletConnectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConnect: (address: string) => void;
  network?: "testnet" | "mainnet";
}

/**
 * Modal that handles WalletConnect connection flow.
 * Displays QR code and manages connection state.
 */
export const WalletConnectModal: React.FC<WalletConnectModalProps> = ({
  isOpen,
  onClose,
  onConnect,
  network = "testnet",
}) => {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [qrUri, setQrUri] = useState<string | null>(null);
  const adapterRef = useRef<WalletConnectAdapter | null>(null);

  useEffect(() => {
    if (!isOpen) {
      // Clean up on close
      setQrUri(null);
      setError(null);
      setIsLoading(false);
      return;
    }

    const initializeConnection = async () => {
      try {
        setIsLoading(true);
        setError(null);
        setQrUri(null);

        // Create adapter instance
        const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID;
        if (!projectId) {
          throw new Error(
            "VITE_WALLETCONNECT_PROJECT_ID environment variable is not set",
          );
        }

        const adapter = new WalletConnectAdapter({
          projectId,
          network,
          onQRCodeURI: (uri) => {
            setQrUri(uri);
            setIsLoading(false);
          },
          onSessionConnect: (address) => {
            logger.info(`WalletConnect connected: ${address}`);
            onConnect(address);
            onClose();
          },
          onSessionDisconnect: () => {
            logger.info("WalletConnect session disconnected");
          },
        });

        adapterRef.current = adapter;

        // Start connection (this will trigger QR code display)
        await adapter.connect();
      } catch (err: any) {
        logger.error(`WalletConnect connection error: ${err.message}`, {
          error: err,
        });
        setError(
          err.message || "Failed to initialize WalletConnect. Please try again.",
        );
        setIsLoading(false);
      }
    };

    initializeConnection();

    // Cleanup on unmount
    return () => {
      adapterRef.current?.disconnect().catch((err) =>
        logger.warn(`Cleanup disconnect failed: ${err.message}`),
      );
    };
  }, [isOpen, network, onConnect, onClose]);

  const handleRetry = () => {
    setError(null);
    setQrUri(null);
    adapterRef.current?.disconnect().catch(() => {});
    adapterRef.current = null;

    // Re-trigger connection by temporarily closing and reopening
    // In a real app, this would be handled differently
  };

  if (!isOpen) return null;

  return (
    <QRModal
      uri={qrUri}
      isLoading={isLoading}
      error={error}
      onClose={onClose}
      walletName="WalletConnect"
    />
  );
};

export default WalletConnectModal;
