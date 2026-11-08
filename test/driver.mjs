const modsOf = (bits) => ({
  shift: !!(bits & 1),
  alt: !!(bits & 2),
  ctrl: !!(bits & 4),
  super: !!(bits & 8),
});

export class Input {
  constructor(session) {
    this.session = session;
  }
  paste(text) {
    this.session.send({ type: 'pixel-input', kind: 'paste', text });
  }
  key(code, modifiers = 0) {
    const special = {
      9: 'tab',
      13: 'enter',
      27: 'escape',
      127: 'backspace',
      57347: 'backspace',
      57350: 'left',
      57351: 'right',
      57352: 'up',
      57353: 'down',
      57354: 'pageup',
      57355: 'pagedown',
      57356: 'home',
      57357: 'end',
    };
    const key = special[code] ?? String.fromCodePoint(code);
    if (modifiers & 4 && key === 'q') {
      this.session.send({ type: 'quit' });
      return;
    }
    if (modifiers & 4 && key === 'tab') {
      this.session.send({ type: 'next-window' });
      return;
    }
    const mods = modsOf(modifiers);
    this.session.send({
      type: 'pixel-input',
      kind: 'key',
      event: {
        key,
        kind: 'press',
        mods,
        ...(!modifiers && code >= 32 && code < 57344 ? { text: String.fromCodePoint(code) } : {}),
      },
    });
    this.session.send({ type: 'pixel-input', kind: 'key', event: { key, kind: 'release', mods } });
  }
  clickAt(x, y) {
    const event = { x, y, button: 'left', mods: modsOf(0) };
    this.session.send({ type: 'pixel-input', kind: 'pointer', event: { ...event, kind: 'down' } });
    this.session.send({ type: 'pixel-input', kind: 'pointer', event: { ...event, kind: 'up' } });
  }
  move(x, y) {
    this.session.send({
      type: 'pixel-input',
      kind: 'pointer',
      event: { x, y, kind: 'move', button: 'none', mods: modsOf(0) },
    });
  }
  wheel(x, y, deltaY) {
    this.session.send({
      type: 'pixel-input',
      kind: 'wheel',
      event: { x, y, deltaX: 0, deltaY, precise: false, mods: modsOf(0) },
    });
  }
}
