/**
 * Configuration for wallet services.
 * Note: This is a stub for experimental wallet features.
 */

export function getProjectId(): string {
  return process.env.REACT_APP_WALLETCONNECT_PROJECT_ID || '';
}
