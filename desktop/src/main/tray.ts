import { Tray, BrowserWindow, Menu, app, nativeImage, screen } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let tray: Tray | null = null;
let dropdownWindow: BrowserWindow | null = null;

/** Create the system tray icon and dropdown window. */
export function createTray(): { tray: Tray; window: BrowserWindow } {
  // Load template image (macOS auto-adapts for dark/light menu bar)
  const iconPath = path.join(__dirname, '..', '..', 'src', 'assets', 'tray-icon.png');
  let icon: Electron.NativeImage;
  try {
    icon = nativeImage.createFromPath(iconPath);
    icon.setTemplateImage(true);
  } catch {
    // Fallback: create a simple colored icon
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip('ClawFace Gateway');

  // Create the dropdown BrowserWindow (hidden initially)
  dropdownWindow = new BrowserWindow({
    width: 340,
    height: 680,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'src', 'main', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const htmlPath = path.join(__dirname, '..', '..', 'src', 'renderer', 'index.html');
  dropdownWindow.loadFile(htmlPath);

  // Click tray → toggle dropdown
  tray.on('click', () => toggleDropdown());

  // Right-click → context menu
  tray.on('right-click', () => showContextMenu());

  // Hide on blur
  dropdownWindow.on('blur', () => {
    dropdownWindow?.hide();
  });

  return { tray, window: dropdownWindow };
}

/** Toggle the dropdown window visibility, positioned below the tray icon. */
function toggleDropdown(): void {
  if (!dropdownWindow || !tray) return;

  if (dropdownWindow.isVisible()) {
    dropdownWindow.hide();
    return;
  }

  // Position below the tray icon
  const trayBounds = tray.getBounds();
  const windowBounds = dropdownWindow.getBounds();
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });

  const x = Math.round(trayBounds.x + trayBounds.width / 2 - windowBounds.width / 2);
  const y = Math.round(trayBounds.y + trayBounds.height + 4);

  // Clamp to screen bounds
  const clampedX = Math.max(display.workArea.x, Math.min(x, display.workArea.x + display.workArea.width - windowBounds.width));

  dropdownWindow.setPosition(clampedX, y, false);
  dropdownWindow.show();
  dropdownWindow.focus();
}

/** Show the right-click context menu. */
function showContextMenu(): void {
  const contextMenu = Menu.buildFromTemplate([
    { label: 'ClawFace Gateway', enabled: false },
    { type: 'separator' },
    {
      label: 'Start at Login',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, openAsHidden: true }),
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => app.quit(),
    },
  ]);

  tray?.popUpContextMenu(contextMenu);
}

/** Update the tray tooltip with live stats. */
export function updateTrayTooltip(cpu: number, mem: number): void {
  tray?.setToolTip(`ClawFace — CPU: ${Math.round(cpu)}% | Mem: ${Math.round(mem)}%`);
}

/** Get the dropdown BrowserWindow for IPC communication. */
export function getDropdownWindow(): BrowserWindow | null {
  return dropdownWindow;
}
