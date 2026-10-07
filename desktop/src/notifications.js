import { Notification } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultIconPath = path.join(__dirname, "../assets/icons/icon.png");

/**
 * Shows a native desktop notification.
 *
 * @param {object} options
 * @param {string} options.title - Notification title
 * @param {string} options.body - Notification body text
 * @param {string} [options.icon] - Optional custom icon path
 * @param {boolean} [options.silent=false] - Whether notification is silent
 * @param {string} [options.page] - Optional page to open when clicked
 * @param {string} [options.txHash] - Optional transaction hash to view when clicked
 * @param {() => void} [options.onClick] - Callback when clicked
 * @param {typeof Notification} [notificationClass=Notification] - Overridable for testing
 * @returns {Notification|null}
 */
export function showNativeNotification(options = {}, notificationClass = Notification) {
  const {
    title = "Stellar Royalty Splitter",
    body = "",
    icon = defaultIconPath,
    silent = false,
    onClick,
  } = options;

  if (notificationClass && typeof notificationClass.isSupported === "function") {
    if (!notificationClass.isSupported()) {
      return null;
    }
  }

  try {
    const notification = new notificationClass({
      title,
      body,
      icon,
      silent,
    });

    if (onClick) {
      notification.on("click", onClick);
    }

    notification.show();
    return notification;
  } catch (err) {
    console.error("Failed to show native notification:", err);
    return null;
  }
}
