import { app, BrowserWindow, BrowserView, ipcMain, shell, clipboard } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = process.env.NODE_ENV === 'development';

let mainWindow = null;
let robinhoodView = null;   // BrowserView for the embedded Robinhood panel
let robinhoodOpen = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0A0A0B',
    titleBarStyle: 'hiddenInset',
    icon: path.join(__dirname, '../fortress-512.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Allow the embedded Robinhood webview to load mixed content
      webviewTag: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:3000');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
    robinhoodView = null;
    robinhoodOpen = false;
  });

  mainWindow.on('resize', () => {
    if (robinhoodOpen) positionRobinhoodView();
  });
}

// ── Robinhood split-panel ─────────────────────────────────────────────────────

function positionRobinhoodView() {
  if (!mainWindow || !robinhoodView) return;
  const [w, h] = mainWindow.getContentSize();
  const leftW = Math.floor(w * 0.45);   // 45 % for Fortress, 55 % for Robinhood
  mainWindow.setBrowserView(robinhoodView);
  robinhoodView.setBounds({ x: leftW, y: 0, width: w - leftW, height: h });
  robinhoodView.setAutoResize({ width: true, height: true });
}

// Called from renderer: open / navigate Robinhood panel
ipcMain.handle('robinhood:open', async (_event, { symbol, tradeDetails }) => {
  if (!mainWindow) return;

  if (tradeDetails) {
    clipboard.writeText(tradeDetails);
  }

  const url = `https://robinhood.com/options/${encodeURIComponent(symbol)}`;

  if (!robinhoodView) {
    robinhoodView = new BrowserView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        // Let Robinhood run normally — don't inject anything
      },
    });
  }

  positionRobinhoodView();
  robinhoodOpen = true;

  if (robinhoodView.webContents.getURL() === '') {
    robinhoodView.webContents.loadURL(url);
  } else {
    robinhoodView.webContents.loadURL(url);
  }

  // Shrink the Fortress webContents to the left panel
  const [w, h] = mainWindow.getContentSize();
  const leftW = Math.floor(w * 0.45);
  mainWindow.webContents.setSize({ width: leftW, height: h });

  return { ok: true };
});

// Called from renderer: close Robinhood panel
ipcMain.handle('robinhood:close', async () => {
  if (!mainWindow) return;
  if (robinhoodView) {
    mainWindow.removeBrowserView(robinhoodView);
  }
  robinhoodOpen = false;
  const [w, h] = mainWindow.getContentSize();
  mainWindow.webContents.setSize({ width: w, height: h });
  return { ok: true };
});

// Open external links in the system browser instead of a new Electron window
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
