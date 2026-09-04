const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { getPort, getBaseUrl } = require('./config');
const { createLauncher } = require('./dsh-launcher');

let mainWindow;
const launcher = createLauncher();
const loadingPath = path.join(__dirname, 'loading.html');

function showLoadingError(message) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  return mainWindow.loadFile(loadingPath, {
    query: { error: String(message) },
  });
}

async function bootDsh() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

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
}

launcher.onExit(() => {
  showLoadingError('dsh 已退出');
});

ipcMain.on('dsh-skin:retry', () => {
  bootDsh();
});

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
  mainWindow.loadFile(loadingPath);
}

app.whenReady().then(async () => {
  createWindow();
  await bootDsh();
});

app.on('window-all-closed', (e) => {
  // Task 5: prevent default quit so later tray hide can attach.
  // On non-macOS Electron would otherwise quit; keep process for upcoming tasks.
  e.preventDefault();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
    bootDsh();
  }
});
