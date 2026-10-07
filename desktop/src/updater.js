import { dialog } from "electron";
import electronUpdater from "electron-updater";
import { showNativeNotification } from "./notifications.js";

const autoUpdater = electronUpdater.autoUpdater || electronUpdater;

export class AutoUpdateManager {
  /**
   * @param {object} options
   * @param {import('electron').BrowserWindow} [options.mainWindow]
   * @param {(status: { status: string, info?: any, error?: string }) => void} [options.onStatusChange]
   * @param {typeof autoUpdater} [updaterInstance=autoUpdater]
   * @param {typeof dialog} [dialogInstance=dialog]
   */
  constructor(options = {}, updaterInstance = autoUpdater, dialogInstance = dialog) {
    this.mainWindow = options.mainWindow;
    this.onStatusChange = options.onStatusChange || (() => {});
    this.updater = updaterInstance;
    this.dialog = dialogInstance;
    this.isManualCheck = false;

    this.setupListeners();
  }

  setupListeners() {
    if (!this.updater || typeof this.updater.on !== "function") return;

    this.updater.autoDownload = true;
    this.updater.autoInstallOnAppQuit = true;

    this.updater.on("checking-for-update", () => {
      this.notify({ status: "checking" });
    });

    this.updater.on("update-available", (info) => {
      this.notify({ status: "available", info });
      showNativeNotification({
        title: "Update Available",
        body: `A new version (${info?.version || "latest"}) is downloading in background.`,
      });
    });

    this.updater.on("update-not-available", (info) => {
      this.notify({ status: "not-available", info });
      if (this.isManualCheck) {
        this.dialog.showMessageBox(this.mainWindow || null, {
          type: "info",
          title: "Up to Date",
          message: "Stellar Royalty Splitter is up to date!",
          detail: `Current version: ${info?.version || "0.1.0"} is the latest available.`,
        });
        this.isManualCheck = false;
      }
    });

    this.updater.on("error", (err) => {
      const errorMsg = err?.message || String(err);
      this.notify({ status: "error", error: errorMsg });
      if (this.isManualCheck) {
        this.dialog.showMessageBox(this.mainWindow || null, {
          type: "warning",
          title: "Update Check Failed",
          message: "Could not check for updates.",
          detail: errorMsg,
        });
        this.isManualCheck = false;
      }
    });

    this.updater.on("download-progress", (progressObj) => {
      this.notify({ status: "downloading", info: progressObj });
    });

    this.updater.on("update-downloaded", (info) => {
      this.notify({ status: "downloaded", info });

      showNativeNotification({
        title: "Update Ready to Install",
        body: `Version ${info?.version || "latest"} has been downloaded. Restart the application to apply the update.`,
        onClick: () => this.installUpdate(),
      });

      this.dialog
        .showMessageBox(this.mainWindow || null, {
          type: "info",
          title: "Update Ready",
          message: `Stellar Royalty Splitter ${info?.version || "update"} has been downloaded.`,
          buttons: ["Restart and Install", "Later"],
          defaultId: 0,
        })
        .then((result) => {
          if (result.response === 0) {
            this.installUpdate();
          }
        })
        .catch(() => {});
    });
  }

  notify(statusObj) {
    this.onStatusChange(statusObj);
  }

  checkForUpdates(isManual = false) {
    this.isManualCheck = isManual;
    try {
      if (this.updater && typeof this.updater.checkForUpdates === "function") {
        return this.updater.checkForUpdates();
      }
    } catch (err) {
      console.error("Failed to check for updates:", err);
      this.notify({ status: "error", error: err.message });
    }
    return Promise.resolve(null);
  }

  installUpdate() {
    if (this.updater && typeof this.updater.quitAndInstall === "function") {
      this.updater.quitAndInstall(false, true);
    }
  }
}
