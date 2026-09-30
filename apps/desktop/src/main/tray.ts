import { join } from 'node:path';
import { Menu, nativeImage, Tray } from 'electron';

let tray: Tray | null = null;

type TrayState = 'idle' | 'ok' | 'warn' | 'bad';

const resource = (name: string) => join(__dirname, '../../resources', name);

function iconFor(state: TrayState) {
  if (process.platform === 'darwin' && state === 'idle') {
    const img = nativeImage.createFromPath(resource('trayTemplate.png'));
    img.setTemplateImage(true);
    return img;
  }
  const file =
    state === 'bad'
      ? 'tray-bad.png'
      : state === 'warn'
        ? 'tray-warn.png'
        : state === 'ok'
          ? 'tray-ok.png'
          : 'icon.png';
  return nativeImage.createFromPath(resource(file)).resize({ width: 16, height: 16 });
}

export interface TrayActions {
  show(): void;
  quit(): void;
}

let actions: TrayActions | null = null;
let statusLine = 'EventKit';

export function createTray(a: TrayActions) {
  actions = a;
  tray = new Tray(iconFor('idle'));
  tray.setToolTip('EventKit');
  tray.on('click', () => a.show());
  rebuildMenu();
}

function rebuildMenu() {
  if (!tray || !actions) return;
  const a = actions;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: statusLine, enabled: false },
      { type: 'separator' },
      { label: 'Open EventKit', click: () => a.show() },
      { label: 'Quit', click: () => a.quit() },
    ]),
  );
}

export function setTrayStatus(state: TrayState, line: string) {
  if (!tray) return;
  tray.setImage(iconFor(state));
  tray.setToolTip(`EventKit: ${line}`);
  statusLine = line;
  rebuildMenu();
}
