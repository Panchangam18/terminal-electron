import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pixel = path.dirname(require.resolve('@zenbu-labs/pixel/package.json'));
const { serializeStyle } = require(path.join(pixel, 'dist/react/styles.js'));

export function canceledDialog(kind, options = {}) {
  if (kind === 'message')
    return {
      response:
        options.cancelId ??
        Math.max(
          0,
          (options.buttons ?? []).findIndex((label) =>
            /^(cancel|no)$/i.test(label.replaceAll('&', '')),
          ),
        ),
      checkboxChecked: options.checkboxChecked ?? false,
    };
  return kind === 'save'
    ? { canceled: true, filePath: undefined }
    : { canceled: true, filePaths: [] };
}

export class FileDialog {
  constructor(request, ops, info, complete) {
    this.request = request;
    this.ops = ops;
    this.info = info;
    this.complete = complete;
    this.options = request.options ?? {};
    this.kind = request.kind;
    this.ids = [];
    this.next = 10000;
    this.actions = new Map();
    this.selected = new Set();
    this.checkbox = !!this.options.checkboxChecked;
    this.value = this.options.defaultPath || os.homedir();
    try {
      this.directory = fs.statSync(this.value).isDirectory()
        ? this.value
        : path.dirname(this.value);
    } catch {
      this.directory = path.dirname(this.value);
    }
    this.render();
  }
  node(props, parent) {
    const id = ++this.next;
    this.ids.push(id);
    this.batch.push(
      { op: 'create', id, props },
      { op: 'insertBefore', parent, child: id, before: null },
    );
    return id;
  }
  text(text, parent, style = {}, action) {
    const id = this.node(
      {
        text,
        clickable: !!action,
        style: serializeStyle({
          font: this.info.dialogFont,
          fontSize: 16,
          color: '#e8edf5',
          ...style,
        }),
      },
      parent,
    );
    if (action) this.actions.set(id, action);
    return id;
  }
  clear() {
    if (this.ids.length)
      this.ops([
        { op: 'remove', id: this.ids[0] },
        ...this.ids.toReversed().map((id) => ({ op: 'forget', id })),
      ]);
    this.ids = [];
    this.actions.clear();
  }
  render() {
    this.clear();
    this.batch = [];
    const root = this.node(
      {
        style: serializeStyle({
          position: 'absolute',
          inset: { left: 0, top: 0 },
          width: '100%',
          height: '100%',
          flexDirection: 'column',
          padding: 24,
          gap: 10,
          background: '#111827',
          opaque: true,
        }),
      },
      0,
    );
    this.text(
      this.options.title ||
        (this.kind === 'message'
          ? 'Message'
          : this.kind === 'save'
            ? 'Save file'
            : 'Choose a file or folder'),
      root,
      { height: 34, fontSize: 23 },
    );
    if (this.options.message) this.text(this.options.message, root, { wrap: true });
    if (this.kind === 'message') {
      if (this.options.detail)
        this.text(this.options.detail, root, { wrap: true, flexGrow: 1, color: '#b9c5d6' });
      if (this.options.checkboxLabel)
        this.text(
          `${this.checkbox ? '[x]' : '[ ]'} ${this.options.checkboxLabel}`,
          root,
          {},
          () => {
            this.checkbox = !this.checkbox;
            this.render();
          },
        );
      const row = this.node({ style: serializeStyle({ flexDirection: 'row', gap: 12 }) }, root);
      for (const [index, label] of (this.options.buttons ?? ['OK']).entries())
        this.text(
          label,
          row,
          {
            padding: 12,
            background: index === (this.options.defaultId ?? 0) ? '#245c9a' : '#2a3546',
          },
          () => this.finish({ response: index, checkboxChecked: this.checkbox }),
        );
    } else {
      this.input = this.node(
        {
          input: { initial: this.value, value: this.value, autoFocus: true, submit: true },
          style: serializeStyle({
            height: 40,
            padding: 8,
            font: this.info.dialogFont,
            fontSize: 16,
            color: '#ffffff',
            background: '#253247',
          }),
        },
        root,
      );
      this.text(
        this.error ||
          'Enter a path, browse folders, then choose Open. Ctrl+L edits the path; Escape cancels.',
        root,
        { height: 22, color: this.error ? '#ff9c9c' : '#adbad0', fontSize: 13 },
      );
      const list = this.node(
        {
          style: serializeStyle({
            height: Math.max(100, this.info.height - 244),
            overflow: 'scroll',
            flexDirection: 'column',
            gap: 2,
          }),
        },
        root,
      );
      let entries = [];
      try {
        entries = fs
          .readdirSync(this.directory, { withFileTypes: true })
          .filter(
            (entry) =>
              (this.options.properties ?? []).includes('showHiddenFiles') ||
              !entry.name.startsWith('.'),
          )
          .map((entry) => {
            const file = path.join(this.directory, entry.name);
            let directory = entry.isDirectory();
            if (entry.isSymbolicLink())
              try {
                directory = fs.statSync(file).isDirectory();
              } catch {}
            return { name: entry.name, file, directory };
          })
          .sort(
            (a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name),
          );
      } catch (error) {
        this.error = error.message;
      }
      this.text('../  Parent folder', list, { height: 28, padding: 4 }, () =>
        this.navigate(path.dirname(this.directory)),
      );
      for (const entry of entries) {
        const allowed = entry.directory || this.allowFile(entry.file);
        this.text(
          `${entry.directory ? '[dir]' : this.selected.has(entry.file) ? '[x]' : '[ ]'}  ${entry.name}`,
          list,
          {
            height: 28,
            padding: 4,
            color: allowed ? '#e8edf5' : '#68788e',
            background: this.selected.has(entry.file) ? '#24466e' : undefined,
          },
          allowed
            ? () => {
                if (entry.directory) this.navigate(entry.file);
                else {
                  this.value = entry.file;
                  if ((this.options.properties ?? []).includes('multiSelections')) {
                    if (this.selected.has(entry.file)) this.selected.delete(entry.file);
                    else this.selected.add(entry.file);
                  } else {
                    this.selected.clear();
                    this.selected.add(entry.file);
                  }
                  this.render();
                }
              }
            : undefined,
        );
      }
      const row = this.node(
        { style: serializeStyle({ flexDirection: 'row', gap: 12, height: 42 }) },
        root,
      );
      this.text(
        this.options.buttonLabel || (this.kind === 'save' ? 'Save' : 'Open'),
        row,
        { padding: 10, background: '#245c9a' },
        () => this.submit(),
      );
      this.text('Cancel', row, { padding: 10, background: '#2a3546' }, () => this.cancel());
      if ((this.options.properties ?? []).includes('createDirectory'))
        this.text('Create folder at path', row, { padding: 10, background: '#2a3546' }, () => {
          try {
            fs.mkdirSync(this.resolve(), { recursive: false });
            this.navigate(this.resolve());
          } catch (error) {
            this.error = error.message;
            this.render();
          }
        });
    }
    if (this.input)
      this.batch.push({ op: 'focus', id: this.input }, { op: 'inputSelectAll', id: this.input });
    this.ops(this.batch);
  }
  allowFile(file) {
    if (
      this.kind === 'open' &&
      (this.options.properties ?? []).includes('openDirectory') &&
      !(this.options.properties ?? []).includes('openFile')
    )
      return false;
    const extensions = this.options.filters?.[0]?.extensions;
    return (
      !extensions?.length ||
      extensions.includes('*') ||
      extensions.some((extension) => file.toLowerCase().endsWith('.' + extension.toLowerCase()))
    );
  }
  resolve() {
    return path.resolve(this.directory, this.value.replace(/^~(?=\/|$)/, os.homedir()));
  }
  navigate(directory) {
    this.directory = directory;
    this.value = directory;
    this.error = null;
    this.selected.clear();
    this.render();
  }
  submit() {
    try {
      let file = this.resolve();
      if (this.kind === 'save') {
        if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
          this.navigate(file);
          return;
        }
        const extension = this.options.filters?.[0]?.extensions?.find((value) => value !== '*');
        if (extension && !path.extname(file)) file += '.' + extension;
        if (!fs.statSync(path.dirname(file)).isDirectory())
          throw new Error('Parent directory does not exist.');
        if (fs.existsSync(file) && this.overwrite !== file) {
          this.overwrite = file;
          throw new Error('File exists. Press Save again to replace it.');
        }
        this.finish({ canceled: false, filePath: file });
        return;
      }
      if (this.selected.size && (this.options.properties ?? []).includes('multiSelections')) {
        this.finish({ canceled: false, filePaths: [...this.selected] });
        return;
      }
      const stat = fs.statSync(file);
      if (stat.isDirectory() && !(this.options.properties ?? []).includes('openDirectory')) {
        this.navigate(file);
        return;
      }
      if (stat.isFile() && !this.allowFile(file)) throw new Error('Choose a permitted file type.');
      this.finish({ canceled: false, filePaths: [file] });
    } catch (error) {
      this.error = error.message;
      this.render();
    }
  }
  handle(event) {
    if (event.type === 'change' && event.node === this.input) this.value = event.text;
    else if (event.type === 'submit' && event.node === this.input) {
      this.value = event.text;
      this.submit();
    } else if (event.type === 'click') this.actions.get(event.node)?.();
    else if (event.type === 'key' && event.kind !== 'release') {
      if (event.key === 'escape') this.cancel();
      else if (event.key === 'l' && event.mods.ctrl && this.input)
        this.ops([
          { op: 'focus', id: this.input },
          { op: 'inputSelectAll', id: this.input },
        ]);
      else if (event.key === 'enter' && this.kind === 'message')
        this.finish({ response: this.options.defaultId ?? 0, checkboxChecked: this.checkbox });
    }
  }
  cancel() {
    this.finish(canceledDialog(this.kind, this.options));
  }
  finish(result) {
    if (this.finished) return;
    this.finished = true;
    this.clear();
    this.complete(result);
  }
}
