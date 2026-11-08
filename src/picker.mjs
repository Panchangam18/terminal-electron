import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const pixel = path.dirname(require.resolve('@zenbu-labs/pixel/package.json'));
const { serializeStyle } = require(path.join(pixel, 'dist/react/styles.js'));

export class AppPicker {
  constructor(apps, ops, info, complete) {
    this.apps = apps;
    this.ops = ops;
    this.info = info;
    this.complete = complete;
    this.query = '';
    this.selected = 0;
    this.next = 100;
    this.rows = [];
    this.actions = new Map();
    this.build();
  }
  node(props, parent = 0) {
    const id = ++this.next;
    this.batch.push(
      { op: 'create', id, props },
      { op: 'insertBefore', parent, child: id, before: null },
    );
    return id;
  }
  build() {
    if (this.root)
      this.ops([
        { op: 'remove', id: this.root },
        ...[...this.ids, ...this.rows].toReversed().map((id) => ({ op: 'forget', id })),
      ]);
    this.batch = [];
    this.ids = [];
    this.rows = [];
    const node = (props, parent) => {
      const id = this.node(props, parent);
      this.ids.push(id);
      return id;
    };
    const text = (value, parent, style = {}) =>
      node(
        {
          text: value,
          style: serializeStyle({ font: this.info.font, fontSize: 16, color: '#e8edf5', ...style }),
        },
        parent,
      );
    this.root = node(
      {
        style: serializeStyle({
          width: '100%',
          height: '100%',
          background: '#111827',
          padding: 24,
          gap: 10,
          flexDirection: 'column',
          opaque: true,
        }),
      },
      0,
    );
    text('terminal-electron', this.root, { fontSize: 26, height: 36 });
    text('Choose an Electron app', this.root, { color: '#aebcd0', height: 24 });
    this.input = node(
      {
        input: { initial: this.query, value: this.query, autoFocus: true, submit: true },
        style: serializeStyle({
          height: 40,
          padding: 8,
          font: this.info.font,
          fontSize: 16,
          color: '#ffffff',
          background: '#253247',
        }),
      },
      this.root,
    );
    this.list = node(
      { style: serializeStyle({ flexDirection: 'column', gap: 4, flexGrow: 1 }) },
      this.root,
    );
    this.footer = text('', this.root, { height: 28, color: '#aebcd0', fontSize: 13 });
    this.ops(this.batch);
    this.refresh();
    this.ops([{ op: 'focus', id: this.input }]);
  }
  get matches() {
    const q = this.query.normalize('NFKC').toLocaleLowerCase();
    return this.apps.filter((app) =>
      (app.name + ' ' + app.path).normalize('NFKC').toLocaleLowerCase().includes(q),
    );
  }
  refresh() {
    this.ops(
      this.rows.toReversed().flatMap((id) => [
        { op: 'remove', id },
        { op: 'forget', id },
      ]),
    );
    this.rows = [];
    this.actions.clear();
    this.batch = [];
    const apps = this.matches;
    this.selected = Math.max(0, Math.min(this.selected, apps.length - 1));
    const count = Math.max(1, Math.floor((this.info.height - 212) / 62));
    const start = Math.max(0, Math.min(this.selected - Math.floor(count / 2), apps.length - count));
    for (let i = start; i < Math.min(apps.length, start + count); i++) {
      const app = apps[i];
      const id = this.node(
        {
          text: app.name + '\n' + app.path,
          clickable: true,
          style: serializeStyle({
            font: this.info.font,
            fontSize: 16,
            color: i === this.selected ? '#ffffff' : '#c4cfdf',
            height: 58,
            padding: 8,
            background: i === this.selected ? '#245c9a' : '#182233',
            wrap: false,
            ellipsis: true,
          }),
        },
        this.list,
      );
      this.rows.push(id);
      this.actions.set(id, () => this.finish(app.path));
    }
    if (!apps.length) {
      const id = this.node(
        {
          text: 'No matching Electron apps. Edit the search to try again.',
          style: serializeStyle({ fontSize: 16, color: '#aebcd0', padding: 8 }),
        },
        this.list,
      );
      this.rows.push(id);
    }
    this.batch.push({
      op: 'update',
      id: this.footer,
      props: {
        text: `${apps.length} app${apps.length === 1 ? '' : 's'} · Type to filter · Up/Down select · Enter open · Escape cancel`,
      },
    });
    this.ops(this.batch);
  }
  handle(event) {
    if (this.finished) return;
    if (event.type === 'change' && event.node === this.input) {
      this.query = event.text;
      this.selected = 0;
      this.refresh();
    } else if (event.type === 'submit' && event.node === this.input)
      this.finish(this.matches[this.selected]?.path);
    else if (event.type === 'click') this.actions.get(event.node)?.();
    else if (event.type === 'wheel') {
      this.selected += event.deltaY > 0 ? 1 : -1;
      this.refresh();
    } else if (event.type === 'resize') {
      Object.assign(this.info, { width: event.width, height: event.height });
      this.build();
    } else if (event.type === 'key' && event.kind !== 'release') {
      if (event.key === 'escape' || (event.mods?.ctrl && ['q', 'c'].includes(event.key)))
        this.finish(null);
      else if (event.key === 'down' || event.key === 'up') {
        this.selected += event.key === 'down' ? 1 : -1;
        this.refresh();
      } else if (event.key === 'enter') this.finish(this.matches[this.selected]?.path);
    }
  }
  finish(value) {
    if (this.finished || value === undefined) return;
    this.finished = true;
    this.complete(value);
  }
}

export function chooseApplication(apps) {
  return new Promise((resolve, reject) => {
    let engine, picker;
    let settled = false;
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      process.off('SIGINT', cancel);
      process.off('SIGTERM', cancel);
      process.off('SIGHUP', cancel);
      // Finish the native event callback before stopping its event loop.
      setImmediate(() => {
        try {
          engine?.stop();
          error ? reject(error) : resolve(value);
        } catch (stopError) {
          reject(stopError);
        }
      });
    };
    const cancel = () => finish(null);
    try {
      const tty = execFileSync('/usr/bin/tty', {
        stdio: ['inherit', 'pipe', 'ignore'],
        encoding: 'utf8',
      }).trim();
      engine = require(path.join(pixel, 'dist/react/native.js')).createNativeEngine(tty);
      const info = JSON.parse(engine.info());
      const ops = (operations) => engine.applyOps(JSON.stringify({ view: 0, ops: operations }));
      engine.setKeyEventTypes(true);
      engine.start((error, json) => {
        if (settled) return;
        if (error) {
          finish(null, error);
          return;
        }
        try {
          const event = JSON.parse(json);
          if (event.type === 'exit') finish(null, event.error ? new Error(event.error) : undefined);
          else if (event.type === 'fontRegistered') {
            info.font = event.font;
            picker?.build();
          } else picker?.handle(event);
        } catch (error) {
          finish(null, error);
        }
      });
      ops([
        { op: 'setDefaultMenu', on: false },
        { op: 'setKeyCapture', keys: ['escape', 'up', 'down', 'enter', 'ctrl+q', 'ctrl+c'] },
        { op: 'setTitle', text: 'terminal-electron · Choose an app' },
      ]);
      picker = new AppPicker(apps, ops, info, (value) => finish(value));
      const font = '/System/Library/Fonts/Hiragino Sans GB.ttc';
      if (fs.existsSync(font)) ops([{ op: 'registerFont', path: font }]);
      process.once('SIGINT', cancel);
      process.once('SIGTERM', cancel);
      process.once('SIGHUP', cancel);
    } catch (error) {
      finish(null, error);
    }
  });
}
