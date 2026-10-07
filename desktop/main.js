import { app, BrowserWindow, ipcMain, dialog, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

import { IPC_CHANNELS, DEFAULT_WINDOW_OPTIONS } from "./src/constants.js";
import { parseDeepLink, registerProtocolClient } from "./src/protocolHandler.js";
import { readContractFile, writeContractFile } from "./src/contractFileHandler.js";
import { ClipboardWatcher } from "./src/clipboardWatcher.js";
import { setupApplicationMenu } from "./src/menu.js";
import { SystemTrayManager } from "./src/tray.js";
import { AutoUpdateManager } from "./src/updater.js";
import { showNativeNotification } from "./src/notifications.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow = null;
let trayManager = null;
let clipboardWatcher = null;
let autoUpdateManager = null;
let pendingDeepLink = null;
let pendingContractFile = null;

// Ensure single instance
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, commandLine) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();

      handleCommandLineArgs(commandLine);
    }
  });
}

// Register protocol clients
registerProtocolClient(app, "desktop");
registerProtocolClient(app, "stellar-splitter");

/**
 * Parses command line arguments for deep links or files.
 * @param {string[]} args
 */
function handleCommandLineArgs(args) {
  if (!args || !Array.isArray(args)) return;

  for (const arg of args) {
    if (arg.startsWith("desktop://") || arg.startsWith("stellar-splitter://")) {
      const parsed = parseDeepLink(arg);
      if (parsed.valid) {
        dispatchDeepLink(parsed);
      }
    } else if (arg.endsWith(".contract") || arg.endsWith(".stellar")) {
      void loadAndDispatchContractFile(arg);
    }
  }
}

/**
 * Dispatches deep link navigation to the renderer window.
 * @param {object} parsedLink
 */
function dispatchDeepLink(parsedLink) {
  if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send(IPC_CHANNELS.DEEP_LINK, parsedLink);
    if (parsedLink.page) {
      mainWindow.webContents.send(IPC_CHANNELS.NAVIGATE, parsedLink.page);
    }
  } else {
    pendingDeepLink = parsedLink;
  }
}

/**
 * Loads a contract file and dispatches it to renderer.
 * @param {string} filePath
 */
async function loadAndDispatchContractFile(filePath) {
  const result = await readContractFile(filePath);
  if (result.success) {
    if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isLoading()) {
      mainWindow.webContents.send(IPC_CHANNELS.FILE_OPENED, result.data);
    } else {
      pendingContractFile = result.data;
    }
  } else {
    showNativeNotification({
      title: "Failed to Open Contract",
      body: result.error || "Invalid contract file",
    });
  }
}

/**
 * Creates the primary application window.
 */
function createMainWindow() {
  const isDev = process.argv.includes("--dev") || process.env.NODE_ENV === "development";

  mainWindow = new BrowserWindow({
    ...DEFAULT_WINDOW_OPTIONS,
    icon: path.join(__dirname, "assets/icons/icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
    show: false,
  });

  // Native application menu
  setupApplicationMenu({
    onNavigate: (page) => {
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send(IPC_CHANNELS.NAVIGATE, page);
      }
    },
    onOpenContractFile: () => {
      void handleOpenContractFileDialog();
    },
    onSaveContractFile: () => {
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send(IPC_CHANNELS.NAVIGATE, "settings");
      }
    },
    onCheckForUpdates: () => {
      if (autoUpdateManager) {
        autoUpdateManager.checkForUpdates(true);
      }
    },
  });

  // System Tray
  trayManager = new SystemTrayManager({
    mainWindow,
    onNavigate: (page) => {
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send(IPC_CHANNELS.NAVIGATE, page);
      }
    },
    onRefreshEarnings: () => {
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send(IPC_CHANNELS.NAVIGATE, "earnings");
      }
    },
    onCheckForUpdates: () => {
      if (autoUpdateManager) {
        autoUpdateManager.checkForUpdates(true);
      }
    },
    onToggleClipboard: (enabled) => {
      if (clipboardWatcher) {
        if (enabled) clipboardWatcher.start();
        else clipboardWatcher.stop();
      }
    },
    isClipboardEnabled: () => (clipboardWatcher ? clipboardWatcher.isEnabled() : false),
  });
  trayManager.create();

  // Clipboard monitoring
  clipboardWatcher = new ClipboardWatcher({
    intervalMs: 1200,
    onAddressDetected: (match) => {
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send(IPC_CHANNELS.STELLAR_ADDRESS_DETECTED, match);
      }
      showNativeNotification({
        title: "Stellar Address Detected",
        body: `Copied ${match.type === "contract" ? "Contract ID" : "Account Address"}: ${match.value.substring(0, 8)}...${match.value.substring(48)}`,
        onClick: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
            if (match.type === "contract") {
              mainWindow.webContents.send(IPC_CHANNELS.NAVIGATE, "dashboard");
            } else {
              mainWindow.webContents.send(IPC_CHANNELS.NAVIGATE, "distribute");
            }
          }
        },
      });
    },
  });
  clipboardWatcher.start();

  // Auto Updater
  autoUpdateManager = new AutoUpdateManager({
    mainWindow,
    onStatusChange: (status) => {
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send(IPC_CHANNELS.UPDATE_STATUS, status);
      }
    },
  });

  // Load URL or build file
  const devServerUrl = process.env.ELECTRON_START_URL || "http://localhost:5173";
  const distIndexPath = path.join(__dirname, "../frontend/dist/index.html");

  if (isDev) {
    mainWindow.loadURL(devServerUrl).catch(() => {
      if (fs.existsSync(distIndexPath)) {
        mainWindow.loadFile(distIndexPath);
      }
    });
  } else {
    if (fs.existsSync(distIndexPath)) {
      mainWindow.loadFile(distIndexPath);
    } else {
      mainWindow.loadURL(devServerUrl).catch(() => {
        mainWindow.loadFile(path.join(__dirname, "assets/fallback.html")).catch(() => {});
      });
    }
  }

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();

    if (pendingDeepLink) {
      dispatchDeepLink(pendingDeepLink);
      pendingDeepLink = null;
    }
    if (pendingContractFile) {
      mainWindow.webContents.send(IPC_CHANNELS.FILE_OPENED, pendingContractFile);
      pendingContractFile = null;
    }

    if (!isDev) {
      autoUpdateManager.checkForUpdates(false);
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

/**
 * Handle opening contract file dialog.
 */
async function handleOpenContractFileDialog() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Open Stellar Royalty Splitter Contract File",
    filters: [
      { name: "Contract Files (*.contract, *.stellar, *.json)", extensions: ["contract", "stellar", "json"] },
      { name: "All Files", extensions: ["*"] },
    ],
    properties: ["openFile"],
  });

  if (!result.canceled && result.filePaths.length > 0) {
    await loadAndDispatchContractFile(result.filePaths[0]);
  }
}

/**
 * Handle saving contract file dialog.
 * @param {object} contractData
 */
async function handleSaveContractFileDialog(contractData) {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Save Contract Configuration",
    defaultPath: "contract-config.contract",
    filters: [
      { name: "Contract File (*.contract)", extensions: ["contract"] },
      { name: "JSON File (*.json)", extensions: ["json"] },
    ],
  });

  if (!result.canceled && result.filePath) {
    const saveResult = await writeContractFile(result.filePath, contractData);
    if (saveResult.success) {
      showNativeNotification({
        title: "Contract Saved",
        body: `Configuration saved to ${path.basename(result.filePath)}`,
      });
      return { success: true, filePath: result.filePath };
    } else {
      dialog.showErrorBox("Save Failed", saveResult.error || "Could not save file");
      return { success: false, error: saveResult.error };
    }
  }
  return { success: false, canceled: true };
}

// macOS open-url event (deep link)
app.on("open-url", (event, url) => {
  event.preventDefault();
  const parsed = parseDeepLink(url);
  if (parsed.valid) {
    dispatchDeepLink(parsed);
  }
});

// macOS open-file event (.contract association)
app.on("open-file", (event, filePath) => {
  event.preventDefault();
  void loadAndDispatchContractFile(filePath);
});

// Register IPC handlers
function registerIpcHandlers() {
  ipcMain.handle(IPC_CHANNELS.GET_APP_INFO, () => ({
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electronVersion: process.versions.electron,
  }));

  ipcMain.handle(IPC_CHANNELS.OPEN_EXTERNAL, async (_event, url) => {
    if (url && (url.startsWith("https://") || url.startsWith("http://"))) {
      await shell.openExternal(url);
      return true;
    }
    return false;
  });

  ipcMain.handle(IPC_CHANNELS.SHOW_NOTIFICATION, (_event, options) => {
    return !!showNativeNotification(options);
  });

  ipcMain.handle(IPC_CHANNELS.UPDATE_TRAY_EARNINGS, (_event, earnings) => {
    if (trayManager) {
      trayManager.updateEarnings(earnings);
      return true;
    }
    return false;
  });

  ipcMain.handle(IPC_CHANNELS.GET_TRAY_EARNINGS, () => {
    return trayManager ? trayManager.getEarnings() : "0.00 XLM";
  });

  ipcMain.handle(IPC_CHANNELS.SET_CLIPBOARD_MONITORING, (_event, enabled) => {
    if (clipboardWatcher) {
      if (enabled) clipboardWatcher.start();
      else clipboardWatcher.stop();
      if (trayManager) trayManager.updateContextMenu();
      return true;
    }
    return false;
  });

  ipcMain.handle(IPC_CHANNELS.GET_CLIPBOARD_MONITORING, () => {
    return clipboardWatcher ? clipboardWatcher.isEnabled() : false;
  });

  ipcMain.handle(IPC_CHANNELS.CHECK_FOR_UPDATES, () => {
    if (autoUpdateManager) {
      return autoUpdateManager.checkForUpdates(true);
    }
    return null;
  });

  ipcMain.handle(IPC_CHANNELS.RESTART_AND_INSTALL, () => {
    if (autoUpdateManager) {
      autoUpdateManager.installUpdate();
      return true;
    }
    return false;
  });

  ipcMain.handle(IPC_CHANNELS.OPEN_CONTRACT_DIALOG, async () => {
    await handleOpenContractFileDialog();
    return true;
  });

  ipcMain.handle(IPC_CHANNELS.SAVE_CONTRACT_DIALOG, async (_event, contractData) => {
    return await handleSaveContractFileDialog(contractData);
  });
}

// App lifecycle
app.whenReady().then(() => {
  registerIpcHandlers();
  createMainWindow();

  handleCommandLineArgs(process.argv);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    if (clipboardWatcher) clipboardWatcher.stop();
    if (trayManager) trayManager.destroy();
    app.quit();
  }
});
