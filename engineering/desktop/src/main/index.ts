import { app, dialog } from 'electron';
import { startDesktop, publicError } from './app';
startDesktop().catch((error) => {
  const safe = publicError(error);
  if (safe.code !== 'ALREADY_RUNNING') dialog.showErrorBox('产品工厂未能启动', safe.message);
  app.quit();
});
