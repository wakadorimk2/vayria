// Overlay drag bridge: forward pointer drags on non-interactive
// areas to the main process so the frameless window can be moved
// without swallowing button/input clicks.
const { ipcRenderer } = require('electron');

const INTERACTIVE =
  'button, input, a, textarea, select, label, [role="button"], .message-form';

window.addEventListener('DOMContentLoaded', () => {
  let dragging = false;
  window.addEventListener('mousedown', (event) => {
    if (event.target.closest(INTERACTIVE)) return;
    dragging = true;
  });
  window.addEventListener('mousemove', (event) => {
    if (!dragging) return;
    ipcRenderer.send('overlay:drag-move', event.screenX, event.screenY);
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    ipcRenderer.send('overlay:drag-end');
  });
});
