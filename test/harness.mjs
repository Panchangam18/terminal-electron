import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Session } from '../src/session.mjs';
import { Input } from './driver.mjs';
import { FileDialog } from '../src/dialog.mjs';

export class Harness extends Input {
  constructor(target, options = {}) {
    super(new Session(target, { ...options, test: true }));
    this.viewport = {
      width: options.width ?? 1000,
      height: options.height ?? 700,
      columns: 100,
      rows: 35,
    };
    this.pending = new Map();
    this.next = 0;
    this.frames = 0;
    this.errors = [];
    this.steps = [];
    this.dialogs = [];
    this.session.on('dialog', (request) => {
      this.dialogs.push(request);
      if (!this.dialog) this.openDialog();
    });
    this.session.on('app-error', (error) => this.errors.push(error.message));
    this.session.on('exit', (code, signal) => {
      this.exit = { code, signal };
    });
    this.session.on('message', (message) => {
      if (message.type === 'frame') {
        this.frame = message;
        this.frames++;
      }
      if (message.type === 'windows') this.windows = message;
      if (message.type === 'diagnostic') {
        this.errors.push(message);
        console.log('DIAGNOSTIC', JSON.stringify(message));
      }
      if (message.type === 'result') {
        const pending = this.pending.get(message.request);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(message.request);
          message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.value);
        }
      }
    });
  }
  evaluate(expression, main = false) {
    return new Promise((resolve, reject) => {
      const request = ++this.next;
      const timer = setTimeout(() => {
        this.pending.delete(request);
        reject(new Error('Evaluation timed out'));
      }, 6000);
      this.pending.set(request, { resolve, reject, timer });
      this.session.send({ type: main ? 'evaluate-main' : 'evaluate', request, expression });
    });
  }
  async wait(check, label = 'condition', timeout = 20000) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      if (this.exit) throw new Error(`App exited: ${JSON.stringify(this.exit)}`);
      const fatal = this.errors.find((error) => typeof error === 'string');
      if (fatal) throw new Error(fatal);
      try {
        const result = await check();
        if (result) return result;
      } catch (e) {
        last = e;
      }
      await new Promise((r) => setTimeout(r, 80));
    }
    throw new Error(
      `${label} timed out${last ? ': ' + last.message : ''}; log ${this.session.logPath}`,
    );
  }
  async start() {
    await this.session.start();
    return this;
  }
  openDialog() {
    const request = this.dialogs[0];
    if (!request) return;
    this.dialog = new FileDialog(
      request,
      () => {},
      this.viewport,
      (result) => {
        request.reply(result);
        this.dialogs.shift();
        this.dialog = null;
        this.openDialog();
      },
    );
  }
  async click(selector, index = 0) {
    const point = await this.wait(
      () =>
        this.evaluate(
          `(()=>{const e=document.querySelectorAll(${JSON.stringify(selector)})[${index}];if(!e)return null;const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null;})()`,
        ),
      'click target',
    );
    this.clickAt(point.x, point.y);
    await this.settle();
  }
  async clickText(text, selector = 'button') {
    const point = await this.wait(
      () =>
        this.evaluate(
          `(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)return null;const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null;})()`,
        ),
      'click text target',
    );
    this.clickAt(point.x, point.y);
    await this.settle();
  }
  async settle() {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  async resize(width, height) {
    this.viewport = { ...this.viewport, width, height };
    this.session.send({ type: 'resize', width, height });
    await this.wait(
      async () =>
        (this.frame?.inputWidth ?? this.frame?.width) === width &&
        (this.frame?.inputHeight ?? this.frame?.height) === height &&
        (await this.evaluate(`innerWidth===${width}&&innerHeight===${height}`)),
      'resize',
    );
  }
  hidden() {
    assert(this.windows?.windows.length);
    assert(this.windows.windows.every((w) => w.offscreen && !w.nativeVisible));
  }
  async step(label, operation) {
    const start = Date.now();
    try {
      const value = await operation();
      this.steps.push({ label, status: 'pass', ms: Date.now() - start });
      console.log('PASS', label);
      return value;
    } catch (e) {
      this.steps.push({ label, status: 'fail', error: e.message, ms: Date.now() - start });
      throw e;
    }
  }
  save(directory) {
    fs.mkdirSync(directory, { recursive: true });
    if (this.frame)
      fs.writeFileSync(path.join(directory, 'frame.png'), Buffer.from(this.frame.png, 'base64'));
    fs.writeFileSync(
      path.join(directory, 'result.json'),
      JSON.stringify(
        {
          runtime: this.session.installation,
          frames: this.frames,
          windows: this.windows,
          errors: this.errors,
          steps: this.steps,
          log: this.session.logPath,
        },
        null,
        2,
      ),
    );
  }
  async quit(timeout = 5000) {
    while (this.dialog) this.dialog.cancel();
    const closed = new Promise((resolve) =>
      this.session.once('exit', (code, signal) => resolve({ code, signal })),
    );
    this.session.send({ type: 'quit' });
    const timer = setTimeout(() => this.session.stop(), timeout);
    try {
      const result = await closed;
      assert.equal(result.code, 0);
      assert.equal(result.signal, null);
    } finally {
      clearTimeout(timer);
    }
  }
  async stop() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Harness stopped'));
    }
    this.pending.clear();
    await this.session.stop();
  }
}
