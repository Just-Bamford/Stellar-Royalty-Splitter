import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS } from "./src/constants.js";

/**
 * Safe IPC Bridge exposed to the React frontend via contextBridge.
 */
const electronAPI = {
  isElectron: true,
  platform: process.platform,

  // App & System info
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.GET_APP_INFO),
  openExternal: (url) => ipcRenderer.invoke(IPC_CHANNELS.OPEN_EXTERNAL, url),

  // Native Notifications
  showNotification: (options) =>
    ipcRenderer.invoke(IPC_CHANNELS.SHOW_NOTIFICATION, options),

  // Tray & Earnings Ticker
  updateTrayEarnings: (earnings) =>
    ipcRenderer.invoke(IPC_CHANNELS.UPDATE_TRAY_EARNINGS, earnings),
  getTrayEarnings: () =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_TRAY_EARNINGS),

  // Clipboard Monitoring
  setClipboardMonitoring: (enabled) =>
    ipcRenderer.invoke(IPC_CHANNELS.SET_CLIPBOARD_MONITORING, enabled),
  getClipboardMonitoring: () =>
    ipcRenderer.invoke(IPC_CHANNELS.GET_CLIPBOARD_MONITORING),

  // Auto Updater
  checkForUpdates: () =>
    ipcRenderer.invoke(IPC_CHANNELS.CHECK_FOR_UPDATES),
  restartAndInstall: () =>
    ipcRenderer.invoke(IPC_CHANNELS.RESTART_AND_INSTALL),

  // File Dialogs
  openContractFileDialog: () =>
    ipcRenderer.invoke(IPC_CHANNELS.OPEN_CONTRACT_DIALOG),
  saveContractFileDialog: (contractData) =>
    ipcRenderer.invoke(IPC_CHANNELS.SAVE_CONTRACT_DIALOG, contractData),

  // Subscriptions
  onNavigate: (callback) => {
    const subscription = (_event, page) => callback(page);
    ipcRenderer.on(IPC_CHANNELS.NAVIGATE, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.NAVIGATE, subscription);
  },

  onDeepLink: (callback) => {
    const subscription = (_event, deepLinkData) => callback(deepLinkData);
    ipcRenderer.on(IPC_CHANNELS.DEEP_LINK, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.DEEP_LINK, subscription);
  },

  onStellarAddressDetected: (callback) => {
    const subscription = (_event, addressData) => callback(addressData);
    ipcRenderer.on(IPC_CHANNELS.STELLAR_ADDRESS_DETECTED, subscription);
    return () =>
      ipcRenderer.removeListener(IPC_CHANNELS.STELLAR_ADDRESS_DETECTED, subscription);
  },

  onContractFileOpened: (callback) => {
    const subscription = (_event, fileData) => callback(fileData);
    ipcRenderer.on(IPC_CHANNELS.FILE_OPENED, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.FILE_OPENED, subscription);
  },

  onUpdateStatus: (callback) => {
    const subscription = (_event, status) => callback(status);
    ipcRenderer.on(IPC_CHANNELS.UPDATE_STATUS, subscription);
    return () =>
      ipcRenderer.removeListener(IPC_CHANNELS.UPDATE_STATUS, subscription);
  },
};

// Expose the API to the window object in renderer process safely
try {
  contextBridge.exposeInMainWorld("electronAPI", electronAPI);
} catch (_err) {
  if (typeof window !== "undefined") {
    window.electronAPI = electronAPI;
  }
}

export default electronAPI;
