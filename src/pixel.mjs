import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { FileDialog } from './dialog.mjs';

const require = createRequire(import.meta.url);
const pixel = path.dirname(require.resolve('@zenbu-labs/pixel/package.json'));
const { Surface } = require(path.join(pixel, 'dist/react/surface.js'));

export class Terminal {
  constructor(session) {
    this.session = session;
    this.source = null;
    this.dialogs = [];
    this.onDialog = (request) => {
      this.dialogs.push(request);
      if (!this.dialog) this.showDialog();
    };
    this.stats = {
      renderer: '@zenbu-labs/pixel',
      version: require(path.join(pixel, 'package.json')).version,
      appFrames: 0,
      bitmapBytes: 0,
    };
    this.onResize = () => this.ops([]);
    this.onMessage = (message) => {
      if (message.type === 'frame' && message.bgra) {
        this.source = {
          width: message.inputWidth ?? message.width,
          height: message.inputHeight ?? message.height,
        };
        this.stats.appFrames++;
        this.stats.bitmapBytes += message.bgra.length;
        this.surface.present({
          bgra: message.bgra,
          width: message.width,
          height: message.height,
          damage: message.damage,
        });
      } else if (message.type === 'ready') this.resize();
      else if (message.type === 'windows') {
        const window = message.windows.find((window) => window.id === message.selected);
        const title = (window?.title ?? 'terminal-electron').replace(/[\x00-\x1f\x7f]/g, '');
        this.ops([{ op: 'setTitle', text: `${title} · Ctrl+Q quit · Ctrl+Tab windows` }]);
      }
    };
  }
  ops(ops) {
    this.engine?.applyOps(JSON.stringify({ view: 0, ops }));
  }
  point(event) {
    const source = this.source ?? this.info;
    return {
      ...event,
      x: (event.x * source.width) / this.info.width,
      y: (event.y * source.height) / this.info.height,
    };
  }
  dispatch(event) {
    if (event.type === 'fontRegistered' && event.font != null) {
      this.info.dialogFont = event.font;
      this.dialog?.render();
      return;
    }
    if (this.dialog && event.type !== 'resize' && event.type !== 'exit') {
      if (
        event.type === 'key' &&
        event.kind !== 'release' &&
        event.mods.ctrl &&
        event.key === 'q'
      ) {
        while (this.dialog) this.dialog.cancel();
        this.session.send({ type: 'quit' });
      } else this.dialog.handle(event);
      return;
    }
    if (event.type === 'key') {
      if (event.kind !== 'release' && event.mods.ctrl && event.key === 'q')
        this.session.send({ type: 'quit' });
      else if (event.kind !== 'release' && event.mods.ctrl && event.key === 'tab')
        this.session.send({ type: 'next-window' });
      else if (event.kind !== 'release' && event.mods.ctrl && event.mods.shift && event.key === 'w')
        this.session.send({ type: 'close-window' });
      else this.session.send({ type: 'pixel-input', kind: 'key', event });
    } else if (event.type === 'paste')
      this.session.send({ type: 'pixel-input', kind: 'paste', text: event.text });
    else if (event.type === 'pointer')
      this.session.send({ type: 'pixel-input', kind: 'pointer', event: this.point(event) });
    else if (event.type === 'wheel')
      this.session.send({ type: 'pixel-input', kind: 'wheel', event: this.point(event) });
    else if (event.type === 'focus')
      this.session.send({ type: 'pixel-input', kind: event.focused ? 'focus' : 'release' });
    else if (event.type === 'resize') {
      Object.assign(this.info, { width: event.width, height: event.height });
      this.dialog?.render();
      this.resize();
    } else if (event.type === 'exit') {
      if (event.error) this.session.emit('app-error', new Error(`Pixel: ${event.error}`));
      this.session.stop();
    }
  }
  start() {
    const tty = execFileSync('/usr/bin/tty', {
      stdio: ['inherit', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    const { createNativeEngine } = require(path.join(pixel, 'dist/react/native.js'));
    this.engine = createNativeEngine(tty);
    this.info = JSON.parse(this.engine.info());
    this.engine.setKeyEventTypes(true);
    this.surface = new Surface(this.engine, 1);
    this.engine.start((error, json) => {
      if (!error) this.dispatch(JSON.parse(json));
    });
    this.ops([
      { op: 'setDefaultMenu', on: false },
      {
        op: 'create',
        id: 1,
        props: {
          style: { width: '100%', height: '100%' },
          surface: 1,
          pointerEvents: true,
          wheelEvents: true,
        },
      },
      { op: 'insertBefore', parent: 0, child: 1, before: null },
    ]);
    if (process.platform === 'darwin') {
      const font = '/System/Library/Fonts/Hiragino Sans GB.ttc';
      if (fs.existsSync(font)) this.ops([{ op: 'registerFont', path: font }]);
    }
    this.session.on('message', this.onMessage);
    this.session.on('dialog', this.onDialog);
    process.stdout.on('resize', this.onResize);
    this.resize();
  }
  resize() {
    this.session.send({
      type: 'resize',
      width: Math.min(2560, Math.round(this.info.width)),
      height: Math.min(1600, Math.round(this.info.height)),
    });
  }
  showDialog() {
    const request = this.dialogs[0];
    if (!request) return;
    this.ops([
      {
        op: 'update',
        id: 1,
        props: {
          style: { width: '100%', height: '100%' },
          surface: 1,
          hidden: true,
          pointerEvents: false,
          wheelEvents: false,
        },
      },
    ]);
    this.dialog = new FileDialog(
      request,
      (ops) => this.ops(ops),
      this.info,
      (result) => {
        request.reply(result);
        this.dialogs.shift();
        this.dialog = null;
        this.ops([
          { op: 'focus', id: null },
          {
            op: 'update',
            id: 1,
            props: {
              style: { width: '100%', height: '100%' },
              surface: 1,
              hidden: false,
              pointerEvents: true,
              wheelEvents: true,
            },
          },
        ]);
        if (this.dialogs.length) this.showDialog();
        else this.session.send({ type: 'pixel-input', kind: 'focus' });
      },
    );
  }
  stop() {
    this.session.off('message', this.onMessage);
    this.session.off('dialog', this.onDialog);
    process.stdout.off('resize', this.onResize);
    if (this.engine) {
      this.stats.surfaces = JSON.parse(this.engine.surfaceStats());
      fs.appendFileSync(
        this.session.logPath,
        '\nPixel presentation: ' + JSON.stringify(this.stats) + '\n',
      );
      this.surface?.close();
      this.engine.stop();
      this.engine = null;
    }
  }
}
