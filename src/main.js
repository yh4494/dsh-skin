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

function urlHasLaunchToken(url) {
  try {
    return Boolean(new URL(url).searchParams.get('token'));
  } catch {
    return false;
  }
}

async function pageNeedsAuthentication() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  try {
    const text = await mainWindow.webContents.executeJavaScript(
      `(document.body && document.body.innerText) || ''`,
      true,
    );
    return /authentication required/i.test(String(text));
  } catch {
    return false;
  }
}

async function loadAppUrl(appUrl) {
  await mainWindow.loadURL(appUrl);
  if (urlHasLaunchToken(appUrl)) {
    await new Promise((r) => setTimeout(r, 50));
  }
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

    let appUrl = baseUrl;
    try {
      const started = await launcher.start({ port, baseUrl });
      appUrl = started.appUrl || baseUrl;
    } catch (err) {
      reportUnhealthy(gen, err);
      return;
    }
    if (!mainWindow || mainWindow.isDestroyed() || !bootGen.isCurrent(gen)) return;
    try {
      await loadAppUrl(appUrl);
    } catch {
      // Ignore: did-fail-load / render-process-gone own silent reload ≤1
      // then error page. Do not reportUnhealthy here (would steal that path).
      return;
    }
    if (!bootGen.isCurrent(gen)) return;

    if (await pageNeedsAuthentication()) {
      reportUnhealthy(
        gen,
        createDshError(DshErrorCode.AUTH_REQUIRED, 'auth required'),
      );
      return;
    }

    health.start(baseUrl, () => {
      reportUnhealthy(
        gen,
        createDshError(DshErrorCode.UNREACHABLE, 'unreachable'),
      );
    });
  } finally {
    bootInFlight = false;
  }
}

launcher.onExit(() => {
  if (isQuitting) return;
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

  // Close (✕) quits the shell and stops the owned dsh process.
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      app.quit();
    }
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

// Ctrl+C / kill: route through app.quit so before-quit can stop owned dsh.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (isQuitting && quitCleanupDone) {
      process.exit(0);
      return;
    }
    app.quit();
  });
}

app.on('window-all-closed', () => {
  if (!isQuitting) app.quit();
});

app.on('activate', () => {
  showMainWindow();
});
