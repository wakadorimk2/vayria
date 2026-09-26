// Minimal frameless overlay shell for Vayria stream mode.
// Loads the local dev server in a borderless always-on-top window so
// the avatar can float over a borderless-windowed game.
//
// Usage:  electron overlay/main.cjs [url]
// Hotkey: Ctrl+Shift+C toggles click-through (mouse events pass to
//         the game while the window stays visible).

const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  session,
  desktopCapturer,
} = require('electron');
const { join } = require('node:path');

const targetUrl = process.argv[2] || 'https://127.0.0.1:5189/';
let ignoreMouse = false;

// The local dev server uses a self-signed certificate.
app.commandLine.appendSwitch('ignore-certificate-errors');

// Electron has no getDisplayMedia picker: resolve the source here.
// VAYRIA_CAPTURE_MATCH is an optional case-insensitive regex matched
// against capture source names (e.g. "7 Days"). Default prefers a
// 7 Days to Die window, then the first whole screen.
const matchPattern = process.env.VAYRIA_CAPTURE_MATCH;
const captureMatch = matchPattern ? new RegExp(matchPattern, 'i') : null;

app.whenReady().then(() => {
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    void (async () => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['window', 'screen'],
        });
        const preferred =
          (captureMatch &&
            sources.find((source) => captureMatch.test(source.name))) ||
          sources.find((source) => /7 days/i.test(source.name)) ||
          sources.find((source) => source.id.startsWith('screen')) ||
          sources[0];
        if (!preferred) {
          callback({});
          return;
        }
        callback({ video: preferred });
      } catch {
        callback({});
      }
    })();
  });

  const win = new BrowserWindow({
    width: 420,
    height: 720,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    hasShadow: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, 'preload.cjs'),
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  // Keep Vayria out of her own observations: the overlay window is
  // excluded from screen/window capture APIs.
  win.setContentProtection(true);
  win.loadURL(targetUrl);

  // Manual drag: the preload reports pointer positions and the main
  // process moves the window. Clicks stay intact because no
  // app-region swallows input.
  let dragOffset = null;
  ipcMain.on('overlay:drag-move', (_event, x, y) => {
    const [wx, wy] = win.getPosition();
    if (!dragOffset) {
      dragOffset = { x: x - wx, y: y - wy };
      return;
    }
    win.setPosition(x - dragOffset.x, y - dragOffset.y);
  });
  ipcMain.on('overlay:drag-end', () => {
    dragOffset = null;
  });

  const toggleClickThrough = () => {
    ignoreMouse = !ignoreMouse;
    win.setIgnoreMouseEvents(ignoreMouse, { forward: true });
    win.setTitle(`Vayria${ignoreMouse ? ' [click-through]' : ''}`);
  };
  globalShortcut.register('Control+Shift+C', toggleClickThrough);
  // Alt+drag is not available without a frame; resize/move via the
  // window edges while click-through is off.
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  app.quit();
});
