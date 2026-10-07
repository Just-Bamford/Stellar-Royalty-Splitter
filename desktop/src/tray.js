import { Tray, Menu, nativeImage, app } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Formats earnings data for display in the tray.
 * @param {object|string|number} earnings
 * @returns {string}
 */
export function formatTrayEarnings(earnings) {
  if (earnings === null || earnings === undefined || earnings === "") {
    return "0.00 XLM";
  }

  if (typeof earnings === "string" || typeof earnings === "number") {
    const num = typeof earnings === "number" ? earnings : parseFloat(earnings);
    if (!isNaN(num)) {
      return `${num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })} XLM`;
    }
    return String(earnings);
  }

  if (typeof earnings === "object") {
    if (earnings.formatted) {
      return String(earnings.formatted);
    }
    if (earnings.total !== undefined) {
      const num = Number(earnings.total);
      const currency = earnings.currency || "XLM";
      return isNaN(num)
        ? "0.00 XLM"
        : `${num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })} ${currency}`;
    }
    if (earnings.amount !== undefined) {
      const num = Number(earnings.amount);
      const currency = earnings.currency || "XLM";
      return isNaN(num)
        ? "0.00 XLM"
        : `${num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })} ${currency}`;
    }
  }

  return "0.00 XLM";
}

export class SystemTrayManager {
  /**
   * @param {object} options
   * @param {import('electron').BrowserWindow} options.mainWindow
   * @param {string} [options.iconPath]
   * @param {(page: string) => void} [options.onNavigate]
   * @param {() => void} [options.onRefreshEarnings]
   * @param {() => void} [options.onCheckForUpdates]
   * @param {(enabled: boolean) => void} [options.onToggleClipboard]
   * @param {() => boolean} [options.isClipboardEnabled]
   * @param {typeof Tray} [trayClass=Tray]
   * @param {typeof Menu} [menuClass=Menu]
   */
  constructor(options, trayClass = Tray, menuClass = Menu) {
    this.mainWindow = options.mainWindow;
    this.iconPath = options.iconPath || path.join(__dirname, "../assets/icons/tray-icon.png");
    this.onNavigate = options.onNavigate || (() => {});
    this.onRefreshEarnings = options.onRefreshEarnings || (() => {});
    this.onCheckForUpdates = options.onCheckForUpdates || (() => {});
    this.onToggleClipboard = options.onToggleClipboard || (() => {});
    this.isClipboardEnabled = options.isClipboardEnabled || (() => true);
    this.trayClass = trayClass;
    this.menuClass = menuClass;

    this.tray = null;
    this.currentEarnings = "0.00 XLM";
    this.lastUpdated = null;
  }

  create() {
    let icon;
    try {
      icon = nativeImage.createFromPath(this.iconPath);
      if (process.platform === "darwin" && typeof icon.setTemplateImage === "function") {
        icon.setTemplateImage(true);
      }
    } catch (_err) {
      icon = this.iconPath;
    }

    this.tray = new this.trayClass(icon);
    this.tray.setToolTip(`Stellar Royalty Splitter — Earnings: ${this.currentEarnings}`);

    // Click behavior
    this.tray.on("click", () => {
      this.toggleWindow();
    });

    this.tray.on("double-click", () => {
      this.showWindow();
    });

    this.updateContextMenu();
    return this.tray;
  }

  showWindow() {
    if (!this.mainWindow) return;
    if (this.mainWindow.isMinimized()) {
      this.mainWindow.restore();
    }
    this.mainWindow.show();
    this.mainWindow.focus();
  }

  toggleWindow() {
    if (!this.mainWindow) return;
    if (this.mainWindow.isVisible() && !this.mainWindow.isMinimized()) {
      this.mainWindow.focus();
    } else {
      this.showWindow();
    }
  }

  /**
   * Updates the earnings ticker displayed in the tray.
   * @param {object|string|number} earnings
   */
  updateEarnings(earnings) {
    this.currentEarnings = formatTrayEarnings(earnings);
    this.lastUpdated = new Date();

    if (this.tray) {
      this.tray.setToolTip(`Stellar Royalty Splitter — Earnings: ${this.currentEarnings}`);

      if (process.platform === "darwin" && typeof this.tray.setTitle === "function") {
        this.tray.setTitle(` ${this.currentEarnings}`);
      }

      this.updateContextMenu();
    }
  }

  getEarnings() {
    return this.currentEarnings;
  }

  updateContextMenu() {
    if (!this.tray) return;

    const timeStr = this.lastUpdated
      ? `(updated ${this.lastUpdated.toLocaleTimeString()})`
      : "";

    const clipboardActive = this.isClipboardEnabled();

    const contextMenu = this.menuClass.buildFromTemplate([
      {
        label: `Earnings: ${this.currentEarnings} ${timeStr}`.trim(),
        enabled: false,
      },
      { type: "separator" },
      {
        label: "Open Dashboard",
        click: () => {
          this.showWindow();
          this.onNavigate("dashboard");
        },
      },
      {
        label: "Distribute Royalties",
        click: () => {
          this.showWindow();
          this.onNavigate("distribute");
        },
      },
      {
        label: "View Transactions",
        click: () => {
          this.showWindow();
          this.onNavigate("transactions");
        },
      },
      { type: "separator" },
      {
        label: "Refresh Earnings",
        click: () => {
          this.onRefreshEarnings();
        },
      },
      {
        label: "Monitor Clipboard for Stellar Addresses",
        type: "checkbox",
        checked: clipboardActive,
        click: (menuItem) => {
          this.onToggleClipboard(menuItem.checked);
        },
      },
      {
        label: "Check for Updates...",
        click: () => {
          this.onCheckForUpdates();
        },
      },
      { type: "separator" },
      {
        label: "Quit Stellar Royalty Splitter",
        click: () => {
          if (app) app.quit();
        },
      },
    ]);

    this.tray.setContextMenu(contextMenu);
  }

  destroy() {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}
