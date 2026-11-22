'use strict';
// Electron main process for IRBY Dental Ledger.
// Starts the Express + SQLite backend in-process (Node >= 22.13 / Electron >= 35)
// and opens the clinic interface in a native desktop window.
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const { app, BrowserWindow, Menu, dialog, shell, session } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const { createApp } = require(path.join(ROOT, 'server', 'app'));
const { startOcrSidecar } = require(path.join(ROOT, 'server', 'ocr', 'autostart'));

let mainWindow = null;
let serverInstance = null;
let appContext = null;
let closeDb = null;
let ocrSidecar = null;
let housekeepingTimer = null;
let activePort = 3000;

const HOUR = 60 * 60 * 1000;

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

function resolveDataDir() {
  if (process.env.DATA_DIR) return path.resolve(ROOT, process.env.DATA_DIR);
  if (app.isPackaged) {
    return path.join(app.getPath('userData'), 'data');
  }
  return path.join(ROOT, 'data');
}

function listenWithFallback(expressApp, preferredPort, host) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(expressApp);
    srv.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        const fallback = http.createServer(expressApp);
        fallback.once('error', reject);
        fallback.listen(0, host, () => resolve(fallback));
      } else {
        reject(err);
      }
    });
    srv.listen(preferredPort, host, () => resolve(srv));
  });
}

async function startBackend() {
  const dataDir = resolveDataDir();
  const created = createApp({ dataDir });
  appContext = created.ctx;
  closeDb = created.close;

  const { config, services } = appContext;
  serverInstance = await listenWithFallback(created.app, config.port, config.host);
  activePort = serverInstance.address().port;
  ocrSidecar = startOcrSidecar(appContext);

  const housekeeping = () => {
    try {
      services.auth.purgeExpiredSessions();
      services.trash.purgeExpired();
      if (config.backupsEnabled) {
        services.backup.ensureDaily();
      }
    } catch (err) {
      console.error('[housekeeping]', err);
    }
  };
  housekeeping();
  housekeepingTimer = setInterval(housekeeping, HOUR);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'Clinic',
      submenu: [
        {
          label: 'Show LAN Address for Tablets…',
          click: () => {
            const ips = lanAddresses();
            const lines = ips.length
              ? ips.map((ip) => `http://${ip}:${activePort}`).join('\n')
              : 'No active LAN network interface detected.';
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'Connect Chairside Tablets (LAN)',
              message: 'Open any of these addresses on tablets or other computers on the clinic Wi-Fi:',
              detail: `${lines}\n\nLocal PC: http://localhost:${activePort}`,
            });
          },
        },
        {
          label: 'Run Encrypted Backup Now',
          click: () => {
            try {
              const info = appContext.services.backup.runNow();
              dialog.showMessageBox(mainWindow, {
                type: 'info',
                title: 'Backup Complete',
                message: `Created encrypted backup:\n${info.name} (${Math.round(info.size / 1024)} KB)`,
              });
            } catch (err) {
              dialog.showErrorBox('Backup Failed', err.message || String(err));
            }
          },
        },
        {
          label: 'Open Data & Backups Folder',
          click: () => {
            if (appContext) shell.openPath(appContext.config.dataDir);
          },
        },
        { type: 'separator' },
        {
          label: 'Print Current Page…',
          accelerator: 'CmdOrCtrl+P',
          click: () => {
            const focused = BrowserWindow.getFocusedWindow() || mainWindow;
            if (focused) focused.webContents.print({ printBackground: true });
          },
        },
        ...(!isMac ? [{ type: 'separator' }, { role: 'quit' }] : []),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [{ type: 'separator' }, { role: 'front' }] : [{ role: 'close' }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const iconPath = path.join(ROOT, 'build', 'icon.png');
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: 'IRBY Dental Ledger',
    backgroundColor: '#F3EFEA',
    icon: iconPath,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Allow camera permissions for portrait & intraoral photo capture
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media') return callback(true);
    callback(false);
  });

  // Open /print.html in a native child window; open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`http://localhost:${activePort}`) || url.startsWith(`http://127.0.0.1:${activePort}`)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 980,
          height: 820,
          title: 'IRBY Dental Ledger — Print / PDF',
          backgroundColor: '#FFFFFF',
          icon: iconPath,
        },
      };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadURL(`http://localhost:${activePort}`);
  mainWindow.on('closed', () => { mainWindow = null; });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      await startBackend();
      buildMenu();
      createWindow();
    } catch (err) {
      dialog.showErrorBox('IRBY Dental Ledger Startup Error', err.stack || String(err));
      app.quit();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && serverInstance) {
      createWindow();
    }
  });

  app.on('before-quit', () => {
    if (housekeepingTimer) clearInterval(housekeepingTimer);
    if (ocrSidecar) {
      try { ocrSidecar.stop(); } catch { /* ignore */ }
    }
    if (serverInstance) {
      try { serverInstance.close(); } catch { /* ignore */ }
    }
    if (closeDb) closeDb();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
