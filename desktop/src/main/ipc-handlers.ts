import { ipcMain, app } from 'electron';

/** Register all IPC handlers for renderer → main communication. */
export function registerIpcHandlers(): void {
  ipcMain.handle('app:quit', () => {
    app.quit();
  });

  ipcMain.handle('app:toggle-auto-launch', (_e, enabled: boolean) => {
    app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true });
    return enabled;
  });

  ipcMain.handle('app:get-auto-launch', () => {
    return app.getLoginItemSettings().openAtLogin;
  });
}
