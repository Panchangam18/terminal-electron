import readline from 'node:readline';
import stringWidth from 'string-width';

const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const clean = (text) => String(text).replace(/[\x00-\x1f\x7f-\x9f]/g, '');
function fit(text, width) {
  text = clean(text);
  if (stringWidth(text) <= width) return text;
  let result = '';
  for (const { segment } of segments.segment(text)) {
    if (stringWidth(result + segment) > Math.max(0, width - 1)) break;
    result += segment;
  }
  return result + '…';
}

// This prompt stays in the normal terminal screen. Pixel is started only after selection.
export function chooseApplication(apps, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve, reject) => {
    let chars = [],
      cursor = 0,
      selected = 0,
      pasting = false,
      finished = false;
    const wasRaw = !!input.isRaw;
    const query = () => chars.join('');
    const matches = () =>
      apps.filter((app) =>
        (app.name + ' ' + app.path + ' ' + (app.id ?? ''))
          .normalize('NFKC')
          .toLocaleLowerCase()
          .includes(query().normalize('NFKC').toLocaleLowerCase()),
      );
    const clear = () => {
      readline.cursorTo(output, 0);
      readline.clearScreenDown(output);
    };
    const render = () => {
      if (finished) return;
      const columns = Math.max(12, output.columns ?? 80);
      const prompt = columns >= 24 ? 'Electron app › ' : 'App › ';
      const room = Math.max(1, columns - stringWidth(prompt) - 1);
      let offset = 0;
      while (offset < cursor && stringWidth(chars.slice(offset, cursor).join('')) >= room) offset++;
      const found = matches();
      selected = Math.max(0, Math.min(selected, found.length - 1));
      const count = Math.max(1, Math.min(5, (output.rows ?? 24) - 3));
      const start = Math.max(0, Math.min(selected - Math.floor(count / 2), found.length - count));
      const lines = [fit(prompt, columns - 1) + fit(chars.slice(offset).join(''), room)];
      const color = process.env.NO_COLOR === undefined;
      for (let i = start; i < Math.min(start + count, found.length); i++) {
        const app = found[i];
        const name = fit(app.name, Math.min(28, Math.max(8, Math.floor(columns / 3))));
        const row = fit((i === selected ? '› ' : '  ') + name + '  ' + app.path, columns - 1);
        lines.push(color && i === selected ? '\x1b[36m' + row + '\x1b[0m' : row);
      }
      if (!found.length) lines.push(fit('  No matching Electron apps.', columns - 1));
      const hint = fit('  Tab/↑↓ select · Enter open · Esc cancel', columns - 1);
      lines.push(color ? '\x1b[2m' + hint + '\x1b[0m' : hint);
      clear();
      output.write(lines.join('\n'));
      readline.moveCursor(output, 0, -(lines.length - 1));
      readline.cursorTo(
        output,
        Math.min(
          columns - 1,
          stringWidth(prompt) + stringWidth(chars.slice(offset, cursor).join('')),
        ),
      );
    };
    const finish = (value, error) => {
      if (finished) return;
      finished = true;
      input.off('keypress', onKey);
      input.off('end', cancel);
      input.off('error', onError);
      output.off('resize', render);
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, cancel);
      try {
        input.setRawMode?.(wasRaw);
      } catch {}
      input.pause();
      clear();
      if (value)
        output.write(
          'Electron app › ' + clean(apps.find((app) => app.path === value)?.name ?? value) + '\n',
        );
      error ? reject(error) : resolve(value);
    };
    const cancel = () => finish(null);
    const onError = (error) => finish(null, error);
    const onKey = (text, key = {}) => {
      if (key.name === 'paste-start' || key.sequence === '\x1b[200~') {
        pasting = true;
        return;
      }
      if (key.name === 'paste-end' || key.sequence === '\x1b[201~') {
        pasting = false;
        return;
      }
      if (key.name === 'escape' || (key.ctrl && ['c', 'q'].includes(key.name))) {
        cancel();
        return;
      }
      if ((key.name === 'return' || key.name === 'enter') && !pasting) {
        const app = matches()[selected];
        if (app) finish(app.path);
        return;
      }
      if (['tab', 'up', 'down'].includes(key.name)) {
        const length = matches().length;
        const delta = key.name === 'up' || (key.name === 'tab' && key.shift) ? -1 : 1;
        if (length) selected = (selected + delta + length) % length;
      } else if (key.name === 'left') cursor = Math.max(0, cursor - 1);
      else if (key.name === 'right') cursor = Math.min(chars.length, cursor + 1);
      else if (key.name === 'home' || (key.ctrl && key.name === 'a')) cursor = 0;
      else if (key.name === 'end' || (key.ctrl && key.name === 'e')) cursor = chars.length;
      else if (key.ctrl && key.name === 'u') {
        chars = [];
        cursor = 0;
        selected = 0;
      } else if (key.name === 'backspace') {
        if (cursor) chars.splice(--cursor, 1);
        selected = 0;
      } else if (key.name === 'delete') {
        chars.splice(cursor, 1);
        selected = 0;
      } else if (key.ctrl && key.name === 'd') {
        if (!chars.length) {
          cancel();
          return;
        }
        chars.splice(cursor, 1);
      } else if (text && !key.ctrl && !key.meta && !text.includes('\x1b')) {
        const value = [...text.replace(/[\r\n]/g, ' ').replace(/[\x00-\x1f\x7f-\x9f]/g, '')];
        chars.splice(cursor, 0, ...value);
        cursor += value.length;
        selected = 0;
      }
      render();
    };
    try {
      readline.emitKeypressEvents(input);
      input.on('keypress', onKey);
      input.once('end', cancel);
      input.once('error', onError);
      output.on('resize', render);
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, cancel);
      input.setRawMode?.(true);
      input.resume();
      render();
    } catch (error) {
      finish(null, error);
    }
  });
}
