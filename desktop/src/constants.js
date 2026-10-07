/**
 * Constants for the Stellar Royalty Splitter Desktop App.
 */

export const APP_SCHEME_DESKTOP = "desktop";
export const APP_SCHEME_STELLAR = "stellar-splitter";

export const IPC_CHANNELS = {
  // Navigation & Deep Links
  NAVIGATE: "desktop:navigate",
  DEEP_LINK: "desktop:deep-link",
  FILE_OPENED: "desktop:file-opened",

  // Tray & Earnings
  UPDATE_TRAY_EARNINGS: "desktop:update-tray-earnings",
  GET_TRAY_EARNINGS: "desktop:get-tray-earnings",

  // Clipboard
  STELLAR_ADDRESS_DETECTED: "desktop:stellar-address-detected",
  SET_CLIPBOARD_MONITORING: "desktop:set-clipboard-monitoring",
  GET_CLIPBOARD_MONITORING: "desktop:get-clipboard-monitoring",

  // Notifications
  SHOW_NOTIFICATION: "desktop:show-notification",

  // Auto Updater
  CHECK_FOR_UPDATES: "desktop:check-for-updates",
  UPDATE_STATUS: "desktop:update-status",
  RESTART_AND_INSTALL: "desktop:restart-and-install",

  // System / App
  GET_APP_INFO: "desktop:get-app-info",
  OPEN_EXTERNAL: "desktop:open-external",
  OPEN_CONTRACT_DIALOG: "desktop:open-contract-dialog",
  SAVE_CONTRACT_DIALOG: "desktop:save-contract-dialog",
};

export const STELLAR_ACCOUNT_REGEX = /^G[A-Z2-7]{55}$/;
export const STELLAR_CONTRACT_REGEX = /^C[A-Z2-7]{55}$/;

export const DEFAULT_WINDOW_OPTIONS = {
  width: 1280,
  height: 860,
  minWidth: 900,
  minHeight: 650,
  title: "Stellar Royalty Splitter",
};
