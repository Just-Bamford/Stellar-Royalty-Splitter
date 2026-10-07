import { STELLAR_CONTRACT_REGEX } from "./constants.js";

/**
 * Parses deep link URLs for Stellar Royalty Splitter.
 * Supports schemes: desktop:// and stellar-splitter://
 *
 * Example URLs:
 * - desktop://distribute/CA3...
 * - desktop://distribute?contractId=CA3...
 * - desktop://tx/0123456789abcdef...
 * - desktop://contract/CA3...
 * - desktop://dashboard
 * - desktop://analytics
 * - desktop://settings
 *
 * @param {string} urlString
 * @returns {{ valid: boolean, action?: string, page?: string, contractId?: string, txHash?: string, params?: Record<string, string>, rawUrl: string }}
 */
export function parseDeepLink(urlString) {
  if (!urlString || typeof urlString !== "string") {
    return { valid: false, rawUrl: urlString || "" };
  }

  const trimmed = urlString.trim();

  // Check scheme
  if (!trimmed.startsWith("desktop://") && !trimmed.startsWith("stellar-splitter://")) {
    return { valid: false, rawUrl: trimmed };
  }

  try {
    const urlObj = new URL(trimmed.replace(/^stellar-splitter:\/\//, "desktop://"));

    const host = urlObj.host.toLowerCase();
    const pathname = urlObj.pathname.replace(/^\/+|\/+$/g, "");
    const searchParams = Object.fromEntries(urlObj.searchParams.entries());

    let action = host;
    let page = host;
    let contractId = searchParams.contractId || searchParams.contract || undefined;
    let txHash = searchParams.txHash || searchParams.hash || undefined;

    if (host === "distribute") {
      page = "distribute";
      if (pathname && (pathname.startsWith("C") || pathname.length === 56)) {
        contractId = pathname;
      }
    } else if (host === "contract" || host === "contracts") {
      page = "dashboard";
      if (pathname && (pathname.startsWith("C") || pathname.length === 56)) {
        contractId = pathname;
      }
    } else if (host === "tx" || host === "transactions" || host === "transaction") {
      page = "transactions";
      if (pathname) {
        txHash = pathname;
      }
    } else if (
      host === "dashboard" ||
      host === "earnings" ||
      host === "analytics" ||
      host === "settings" ||
      host === "initialize"
    ) {
      page = host;
      if (pathname && STELLAR_CONTRACT_REGEX.test(pathname)) {
        contractId = pathname;
      }
    }

    return {
      valid: true,
      action,
      page,
      contractId,
      txHash,
      params: searchParams,
      rawUrl: trimmed,
    };
  } catch (_err) {
    return { valid: false, rawUrl: trimmed };
  }
}

/**
 * Registers custom protocol client with Electron app.
 * @param {import('electron').App} app
 * @param {string} scheme
 */
export function registerProtocolClient(app, scheme = "desktop") {
  if (app && typeof app.setAsDefaultProtocolClient === "function") {
    app.setAsDefaultProtocolClient(scheme);
  }
}
