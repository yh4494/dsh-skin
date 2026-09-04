const { app, BrowserWindow } = require('electron');
const path = require('node:path');

let mainWindow;

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
  mainWindow.loadFile(path.join(__dirname, 'loading.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', (e) => {
  // Task 5: prevent default quit so later tray hide can attach.
  // On non-macOS Electron would otherwise quit; keep process for upcoming tasks.
  e.preventDefault();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
