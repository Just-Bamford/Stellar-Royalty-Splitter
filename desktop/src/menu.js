import { Menu, shell, app } from "electron";

/**
 * Builds the native application menu template.
 *
 * @param {object} options
 * @param {(page: string) => void} options.onNavigate
 * @param {() => void} options.onOpenContractFile
 * @param {() => void} options.onSaveContractFile
 * @param {() => void} options.onCheckForUpdates
 * @param {() => void} [options.onShowAbout]
 * @param {string} [platform=process.platform]
 * @returns {import('electron').MenuItemConstructorOptions[]}
 */
export function buildMenuTemplate(options, platform = process.platform) {
  const isMac = platform === "darwin";
  const {
    onNavigate = () => {},
    onOpenContractFile = () => {},
    onSaveContractFile = () => {},
    onCheckForUpdates = () => {},
    onShowAbout,
  } = options;

  const appMenu = isMac
    ? [
        {
          label: app ? app.name : "Stellar Royalty Splitter",
          submenu: [
            {
              label: "About Stellar Royalty Splitter",
              click: onShowAbout || (() => app && app.showAboutPanel && app.showAboutPanel()),
            },
            {
              label: "Check for Updates...",
              click: onCheckForUpdates,
            },
            { type: "separator" },
            {
              label: "Preferences...",
              accelerator: "CmdOrCtrl+,",
              click: () => onNavigate("settings"),
            },
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        },
      ]
    : [];

  const fileMenu = {
    label: "&File",
    submenu: [
      {
        label: "New Contract Split",
        accelerator: "CmdOrCtrl+N",
        click: () => onNavigate("initialize"),
      },
      {
        label: "Open Contract File...",
        accelerator: "CmdOrCtrl+O",
        click: onOpenContractFile,
      },
      {
        label: "Save Contract Configuration...",
        accelerator: "CmdOrCtrl+S",
        click: onSaveContractFile,
      },
      { type: "separator" },
      isMac ? { role: "close" } : { role: "quit" },
    ],
  };

  const editMenu = {
    label: "&Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  };

  const viewMenu = {
    label: "&View",
    submenu: [
      {
        label: "Dashboard",
        accelerator: "CmdOrCtrl+D",
        click: () => onNavigate("dashboard"),
      },
      {
        label: "Distribute Royalties",
        accelerator: "CmdOrCtrl+Shift+D",
        click: () => onNavigate("distribute"),
      },
      {
        label: "Transactions History",
        accelerator: "CmdOrCtrl+T",
        click: () => onNavigate("transactions"),
      },
      {
        label: "Earnings & Analytics",
        accelerator: "CmdOrCtrl+Shift+A",
        click: () => onNavigate("earnings"),
      },
      {
        label: "Settings",
        accelerator: isMac ? undefined : "Ctrl+,",
        click: () => onNavigate("settings"),
      },
      { type: "separator" },
      { role: "reload" },
      { role: "forceReload" },
      { role: "toggleDevTools" },
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  };

  const windowMenu = {
    label: "&Window",
    submenu: [
      { role: "minimize" },
      { role: "zoom" },
      ...(isMac
        ? [
            { type: "separator" },
            { role: "front" },
            { type: "separator" },
            { role: "window" },
          ]
        : [{ role: "close" }]),
    ],
  };

  const helpMenu = {
    role: "help",
    submenu: [
      {
        label: "Documentation",
        click: async () => {
          await shell.openExternal(
            "https://github.com/Just-Bamford/Stellar-Royalty-Splitter#readme"
          );
        },
      },
      {
        label: "GitHub Repository",
        click: async () => {
          await shell.openExternal(
            "https://github.com/Just-Bamford/Stellar-Royalty-Splitter"
          );
        },
      },
      {
        label: "Report Issue",
        click: async () => {
          await shell.openExternal(
            "https://github.com/Just-Bamford/Stellar-Royalty-Splitter/issues"
          );
        },
      },
      { type: "separator" },
      {
        label: "Check for Updates...",
        click: onCheckForUpdates,
      },
      ...(!isMac
        ? [
            { type: "separator" },
            {
              label: "About Stellar Royalty Splitter",
              click: onShowAbout || (() => app && app.showAboutPanel && app.showAboutPanel()),
            },
          ]
        : []),
    ],
  };

  return [...appMenu, fileMenu, editMenu, viewMenu, windowMenu, helpMenu];
}

/**
 * Creates and sets the application menu.
 * @param {object} options
 * @param {typeof Menu} [menuClass=Menu]
 */
export function setupApplicationMenu(options, menuClass = Menu) {
  const template = buildMenuTemplate(options);
  const menu = menuClass.buildFromTemplate(template);
  menuClass.setApplicationMenu(menu);
  return menu;
}
