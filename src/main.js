const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('node:path');
const { getPort, getBaseUrl } = require('./config');
const { createLauncher } = require('./dsh-launcher');

let mainWindow;
let tray;
let isQuitting = false;
let quitCleanupDone = false;
let bootInFlight = false;
const launcher = createLauncher();
const loadingPath = path.join(__dirname, 'loading.html');

function showLoadingError(message) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  return mainWindow.loadFile(loadingPath, {
    query: { error: String(message) },
  });
}

async function bootDsh() {
  if (bootInFlight) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;

  bootInFlight = true;
  try {
    const port = getPort();
    const baseUrl = getBaseUrl(port);
    await mainWindow.loadFile(loadingPath);

    try {
      await launcher.start({ port, baseUrl });
      if (!mainWindow || mainWindow.isDestroyed()) return;
      await mainWindow.loadURL(baseUrl);
    } catch (err) {
      await showLoadingError(err.message || err);
    }
  } finally {
    bootInFlight = false;
  }
}

launcher.onExit(() => {
  showLoadingError('dsh 已退出');
});

ipcMain.on('dsh-skin:retry', () => {
  bootDsh();
});

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    bootDsh();
    return;
  }
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'trayTemplate.png');
  const icon = nativeImage.createFromPath(iconPath);
  icon.setTemplateImage(true);

  tray = new Tray(icon);
  tray.setToolTip('dsh-skin');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '显示',
        click: () => showMainWindow(),
      },
      {
        label: '退出',
        // Routes through before-quit so stop runs on every quit path.
        click: () => app.quit(),
      },
    ]),
  );
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.loadFile(loadingPath);
}

app.whenReady().then(async () => {
  createWindow();
  createTray();
  app.dock?.show();
  await bootDsh();
});

app.on('before-quit', (e) => {
  isQuitting = true;
  if (quitCleanupDone) return;

  // Cancel this quit pass, stop owned dsh, then quit again (no recurse).
  e.preventDefault();
  launcher.stop().finally(() => {
    quitCleanupDone = true;
    app.quit();
  });
});

app.on('window-all-closed', (e) => {
  // Keep process alive when window is hidden to tray.
  e.preventDefault();
});

app.on('activate', () => {
  showMainWindow();
});
