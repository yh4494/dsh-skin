const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('node:path');
const { getPort, getBaseUrl } = require('./config');
const { createLauncher } = require('./dsh-launcher');
const { createSessionHealth } = require('./session-health');
const { createBootGeneration } = require('./boot-generation');
const { DshErrorCode, createDshError } = require('./errors');
const { messageForError } = require('./error-messages');

let mainWindow;
let tray;
let isQuitting = false;
let quitCleanupDone = false;
let bootInFlight = false;
const launcher = createLauncher();
const health = createSessionHealth();
const bootGen = createBootGeneration();
let activeGen = 0;
let autoReloadUsed = false;
const loadingPath = path.join(__dirname, 'loading.html');

function showLoadingError(message) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  return mainWindow.loadFile(loadingPath, {
    query: { error: String(message) },
  });
}

function reportUnhealthy(gen, err) {
  health.stop();
  bootGen.runOnce(gen, () => {
    showLoadingError(messageForError(err));
  });
}

async function bootDsh() {
  if (bootInFlight) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;

  bootInFlight = true;
  health.stop();
  activeGen = bootGen.next();
  autoReloadUsed = false;
  const gen = activeGen;
  try {
    const port = getPort();
    const baseUrl = getBaseUrl(port);
    await mainWindow.loadFile(loadingPath);

    try {
      await launcher.start({ port, baseUrl });
      if (!mainWindow || mainWindow.isDestroyed() || !bootGen.isCurrent(gen)) return;
      await mainWindow.loadURL(baseUrl);
      if (!bootGen.isCurrent(gen)) return;
      health.start(baseUrl, () => {
        reportUnhealthy(
          gen,
          createDshError(DshErrorCode.UNREACHABLE, 'unreachable'),
        );
      });
    } catch (err) {
      reportUnhealthy(gen, err);
    }
  } finally {
    bootInFlight = false;
  }
}

launcher.onExit(() => {
  reportUnhealthy(
    activeGen,
    createDshError(DshErrorCode.DSH_EXITED, 'dsh exited'),
  );
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

  mainWindow.on('minimize', () => {
    mainWindow.hide();
  });

  mainWindow.webContents.on('did-fail-load', (_e, _code, _desc, url, isMainFrame) => {
    if (!isMainFrame || isQuitting) return;
    if (typeof url === 'string' && url.startsWith('file:') && url.includes('loading.html')) {
      return;
    }
    if (!autoReloadUsed) {
      autoReloadUsed = true;
      mainWindow.reload();
      return;
    }
    reportUnhealthy(
      activeGen,
      createDshError(DshErrorCode.RENDERER_FAILED, 'load failed'),
    );
  });

  mainWindow.webContents.on('render-process-gone', () => {
    if (isQuitting) return;
    if (!autoReloadUsed) {
      autoReloadUsed = true;
      mainWindow.webContents.reload();
      return;
    }
    reportUnhealthy(
      activeGen,
      createDshError(DshErrorCode.RENDERER_FAILED, 'renderer gone'),
    );
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

  // Cancel this quit pass, stop health then owned dsh, then quit again (no recurse).
  e.preventDefault();
  health.stop();
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
