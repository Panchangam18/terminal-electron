import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Inspector } from './inspector.mjs';
import { prepareSource, prepareBundle } from './prepare.mjs';
import { BridgeDecoder } from './bridge.mjs';
import { exportProfileSession, installProfileSnapshot } from './profile-import.mjs';
import { canceledDialog } from './dialog.mjs';
import { electronFramework } from './bundle.mjs';

const require = createRequire(import.meta.url);
const bootstrap = fileURLToPath(new URL('./bootstrap.cjs', import.meta.url));

export async function resolveApp(target, runtime) {
  const absolute = fs.realpathSync(path.resolve(target));
  if (absolute.endsWith('.app') && fs.statSync(absolute).isDirectory()) {
    const executable = execFileSync(
      '/usr/libexec/PlistBuddy',
      ['-c', 'Print :CFBundleExecutable', path.join(absolute, 'Contents/Info.plist')],
      { encoding: 'utf8' },
    ).trim();
    if (!(await electronFramework(absolute)))
      throw new Error('This bundle does not contain an Electron Framework.');
    return {
      executable: path.join(absolute, 'Contents/MacOS', executable),
      args: [],
      cwd: path.dirname(absolute),
    };
  }
  if (fs.statSync(absolute).isDirectory()) {
    const pkg = path.join(absolute, 'package.json');
    if (!fs.existsSync(pkg)) throw new Error('Source app must contain package.json.');
    let executable = runtime;
    if (!executable) {
      try {
        executable = createRequire(pkg)('electron');
      } catch {
        executable = require('electron');
      }
    }
    return { executable, args: [absolute], cwd: absolute };
  }
  return { executable: absolute, args: [], cwd: path.dirname(absolute) };
}

export class Session extends EventEmitter {
  constructor(target, options = {}) {
    super();
    this.target = target;
    this.options = options;
    this.startedAt = performance.now();
    this.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-electron-'));
    fs.chmodSync(this.directory, 0o700);
    this.socketPath = path.join(this.directory, 'bridge.sock');
    this.dialogSocketPath = path.join(this.directory, 'dialog.sock');
    this.dialogConnections = new Set();
    this.logPath = options.log ?? path.join(this.directory, 'app.log');
    fs.closeSync(fs.openSync(this.logPath, 'a', 0o600));
    this.profile = options.profile
      ? path.resolve(options.profile)
      : path.join(this.directory, 'profile');
    this.profileMarker = path.join(this.profile, '.terminal-electron-profile.json');
    if (!fs.existsSync(this.profile) || fs.readdirSync(this.profile).length === 0) {
      fs.mkdirSync(this.profile, { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        this.profileMarker,
        JSON.stringify({ owner: 'terminal-electron', credentialName: null }),
        { mode: 0o600 },
      );
    }
    this.closed = false;
    this.stopping = false;
  }
  progress(stage, message) {
    fs.appendFileSync(
      this.logPath,
      `[terminal-electron +${Math.round(performance.now() - this.startedAt)}ms] ${message}\n`,
    );
    this.emit('progress', { stage, message });
  }
  async start() {
    if (!fs.existsSync(this.profileMarker))
      throw new Error(
        'This profile was not created by terminal-electron. Choose a new empty --profile directory; existing app profiles use a different credential store.',
      );
    const profileInfo = JSON.parse(fs.readFileSync(this.profileMarker, 'utf8'));
    if (profileInfo.owner !== 'terminal-electron')
      throw new Error('Invalid terminal-electron profile marker.');
    let command = await resolveApp(this.target, this.options.electron);
    const original = fs.realpathSync(path.resolve(this.target));
    let wrapped = false;
    if (fs.statSync(original).isDirectory() && !this.options.inspector) {
      if (original.endsWith('.app')) {
        this.progress('preparing', 'Checking and preparing the private app runtime…');
        const staged = await prepareBundle(
          original,
          this.directory,
          this.options.cacheRoot,
          profileInfo,
          (message) => this.progress('preparing', message),
        );
        this.runtime = staged;
        this.preparedPath = staged.path;
        this.preparedCached = staged.cached;
        this.credentialName = staged.credentialName;
        this.protocolSchemes = staged.protocolSchemes;
        command = await resolveApp(staged.path);
      } else {
        this.preparedPath = path.join(this.directory, 'entry');
        command.args = [prepareSource(original, this.directory)];
      }
      wrapped = true;
    }
    this.command = command;
    this.credentialName ??= `Terminal Electron ${createHash('sha256')
      .update(JSON.stringify({ original, runtime: command.executable, schema: 1 }))
      .digest('hex')
      .slice(0, 24)}`;
    if (profileInfo.credentialName && profileInfo.credentialName !== this.credentialName)
      throw new Error(
        'This profile belongs to a different private runtime. Choose a new empty --profile directory; the previous profile has been preserved.',
      );
    if (this.options.importProfile) {
      const entries = fs
        .readdirSync(this.profile)
        .filter((name) => name !== '.terminal-electron-profile.json');
      if (entries.length)
        throw new Error('Session import requires a new empty --profile directory.');
      this.progress('importing', 'Importing the desktop browser session into the new profile…');
      const snapshot = await exportProfileSession(
        original,
        this.options.importProfile,
        this.directory,
      );
      this.importCookies = installProfileSnapshot(
        snapshot.profile,
        this.profile,
        snapshot.cookies,
        this.directory,
      );
      fs.rmSync(snapshot.profile, { recursive: true, force: true });
    }
    fs.writeFileSync(
      this.profileMarker,
      JSON.stringify({
        ...profileInfo,
        credentialName: this.credentialName,
        ...(this.runtime ? { runtime: this.runtime } : {}),
      }),
      { mode: 0o600 },
    );
    fs.mkdirSync(this.profile, { recursive: true });
    this.log = fs.createWriteStream(this.logPath, { flags: 'a', mode: 0o600 });
    this.server = net.createServer((socket) => {
      if (this.bridge) {
        socket.destroy();
        return;
      }
      this.bridge = socket;
      socket.on('error', (error) => {
        if (!this.stopping) this.emit('app-error', error);
      });
      const decoder = new BridgeDecoder((message) => {
        if (message.type === 'ready' || (message.type === 'frame' && !this.receivedFrame)) {
          if (message.type === 'frame') this.receivedFrame = true;
          fs.appendFileSync(
            this.logPath,
            `[terminal-electron +${Math.round(performance.now() - this.startedAt)}ms] ${message.type === 'frame' ? 'First app frame' : 'App runtime ready'}\n`,
          );
        }
        if (message.type === 'profile-imported') this.importReport = message;
        this.emit('message', message);
        if (message.type === 'error') this.emit('app-error', new Error(message.message));
      });
      socket.on('data', (chunk) => {
        try {
          decoder.push(chunk);
        } catch (error) {
          this.emit('app-error', error);
        }
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.socketPath, resolve);
    });
    this.dialogServer = net.createServer((socket) => {
      socket.setEncoding('utf8');
      this.dialogConnections.add(socket);
      socket.once('close', () => this.dialogConnections.delete(socket));
      socket.on('error', () => {});
      let buffer = '';
      let received = false;
      socket.on('data', (chunk) => {
        if (received) return;
        buffer += chunk.toString('utf8');
        if (buffer.length > 1024 * 1024) {
          socket.destroy();
          return;
        }
        const end = buffer.indexOf('\n');
        if (end < 0) return;
        received = true;
        let request;
        try {
          request = JSON.parse(buffer.slice(0, end));
        } catch {
          socket.destroy();
          return;
        }
        if (request.runtime?.pid !== this.child?.pid) {
          socket.destroy();
          return;
        }
        const reply = (result) => {
          if (!socket.destroyed) socket.end(JSON.stringify(result) + '\n');
        };
        if (!this.installation) this.emit('message', { type: 'ready', ...request.runtime });
        const dialog = { kind: request.kind, options: request.options ?? {}, reply };
        if (this.listenerCount('dialog')) this.emit('dialog', dialog);
        else reply(canceledDialog(dialog.kind, dialog.options));
      });
    });
    await new Promise((resolve, reject) => {
      this.dialogServer.once('error', reject);
      this.dialogServer.listen(this.dialogSocketPath, resolve);
    });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    const pixelPackage = path.dirname(require.resolve('@zenbu-labs/pixel/package.json'));
    const config = {
      socket: this.socketPath,
      dialogSocket: this.dialogSocketPath,
      nodePath: process.execPath,
      dialogClient: fileURLToPath(new URL('./dialog-client.mjs', import.meta.url)),
      profile: this.profile,
      credentialName: this.credentialName,
      protocolSchemes: this.protocolSchemes ?? [],
      importCookies: this.importCookies,
      width: this.options.width ?? 1000,
      height: this.options.height ?? 700,
      fps: this.options.fps ?? 15,
      test: !!this.options.test,
      frameFormat: this.options.frameFormat ?? 'png',
      pixelInput: path.join(pixelPackage, 'dist/web/input.js'),
    };
    if (wrapped) env.TERMINAL_ELECTRON_BOOTSTRAP = JSON.stringify(config);
    this.progress('launching', 'Opening the app in the terminal…');
    this.child = spawn(
      command.executable,
      [
        ...(wrapped ? [] : ['--inspect-brk=127.0.0.1:0']),
        ...command.args,
        `--user-data-dir=${this.profile}`,
        ...(this.options.args ?? []),
      ],
      {
        cwd: command.cwd,
        env,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    this.child.stdout.pipe(this.log, { end: false });
    this.child.stderr.pipe(this.log, { end: false });
    this.child.once('exit', (code, signal) => {
      this.closed = true;
      this.emit('exit', code, signal);
    });
    try {
      if (wrapped) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => finish(new Error(`Adapter did not start. Log: ${this.logPath}`)),
            20000,
          );
          const onMessage = (message) => {
            if (message.type === 'ready') {
              this.installation = message;
              finish();
            }
          };
          const onExit = (code, signal) =>
            finish(
              new Error(`App exited (${signal ?? code}) during startup. Log: ${this.logPath}`),
            );
          const finish = (error) => {
            clearTimeout(timer);
            this.off('message', onMessage);
            this.child.off('exit', onExit);
            this.child.off('error', finish);
            error ? reject(error) : resolve();
          };
          this.on('message', onMessage);
          this.child.once('error', finish);
          this.child.once('exit', onExit);
        });
        if (this.importCookies && !this.importReport)
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              cleanup();
              reject(new Error('Private cookie import did not finish.'));
            }, 20000);
            const listener = (message) => {
              if (message.type === 'profile-imported') {
                cleanup();
                resolve();
              }
            };
            const error = () => {
              cleanup();
              reject(new Error('App exited during cookie import.'));
            };
            const cleanup = () => {
              clearTimeout(timer);
              this.off('message', listener);
              this.child.off('exit', error);
            };
            this.on('message', listener);
            this.child.once('exit', error);
          });
        return this;
      }
      const url = await new Promise((resolve, reject) => {
        let stderr = '';
        const timer = setTimeout(
          () =>
            done(
              new Error(
                `The app did not expose its startup inspector. Debugging may be disabled by its Electron fuses. Log: ${this.logPath}`,
              ),
            ),
          12000,
        );
        const onData = (data) => {
          stderr = (stderr + data.toString()).slice(-16000);
          const match = stderr.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/);
          if (match) done(null, match[1]);
        };
        const onExit = (code) =>
          done(new Error(`App exited (${code}) before startup interception. Log: ${this.logPath}`));
        const done = (error, value) => {
          clearTimeout(timer);
          this.child.stderr.off('data', onData);
          this.child.off('exit', onExit);
          error ? reject(error) : resolve(value);
        };
        this.child.stderr.on('data', onData);
        this.child.once('error', (error) => done(error));
        this.child.once('exit', onExit);
      });
      const inspector = (this.inspector = new Inspector(url));
      await inspector.call('Debugger.enable');
      const paused = inspector.once('Debugger.paused');
      await inspector.call('Runtime.runIfWaitingForDebugger');
      const frame = (await paused).callFrames[0];
      const expression = `(() => { const r = process.getBuiltinModule('module').createRequire(${JSON.stringify(bootstrap)}); return r(${JSON.stringify(bootstrap)})(${JSON.stringify(config)}); })()`;
      const result = await inspector.call('Debugger.evaluateOnCallFrame', {
        callFrameId: frame.callFrameId,
        expression,
        returnByValue: true,
      });
      if (result.exceptionDetails)
        throw new Error(
          result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
        );
      this.installation = result.result.value;
      await inspector.call('Debugger.resume');
      inspector.close();
      this.inspector = null;
      return this;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
  send(message) {
    if (this.bridge && !this.bridge.destroyed) this.bridge.write(JSON.stringify(message) + '\n');
  }
  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    for (const socket of this.dialogConnections) socket.destroy();
    this.dialogServer?.close();
    this.inspector?.close();
    const signal = (name) => {
      if (!this.child?.pid) return;
      try {
        if (process.platform !== 'win32') process.kill(-this.child.pid, name);
        else if (!this.closed) this.child.kill(name);
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    };
    if (this.child && !this.closed) {
      const exited = new Promise((resolve) => this.child.once('exit', resolve));
      signal('SIGTERM');
      const timer = setTimeout(() => {
        if (!this.closed) signal('SIGKILL');
      }, 2500);
      await exited;
      clearTimeout(timer);
    }
    // Native helpers may inherit stdio and outlive their parent. Only this
    // session's process group is owned here; desktop instances have other groups.
    signal('SIGKILL');
    this.child?.stdout?.destroy();
    this.child?.stderr?.destroy();
    this.bridge?.destroy();
    this.server?.close();
    this.log?.end();
    fs.rmSync(this.socketPath, { force: true });
    fs.rmSync(this.dialogSocketPath, { force: true });
    if (this.importCookies) fs.rmSync(this.importCookies, { force: true });
    if (this.preparedPath && !this.preparedCached)
      fs.rmSync(this.preparedPath, { recursive: true, force: true });
  }
}
