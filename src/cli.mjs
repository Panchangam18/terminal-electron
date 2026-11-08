#!/usr/bin/env node
import { Session } from './session.mjs';
import { Terminal } from './pixel.mjs';
import { appendFileSync } from 'node:fs';

import { readFileSync } from 'node:fs';
import { discoverApplications } from './discover.mjs';
import { chooseApplication } from './picker.mjs';
import { parseArguments } from './options.mjs';

let parsed;
try {
  parsed = parseArguments(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const { options, help, version, list, directories } = parsed;
if (parsed.completion) {
  process.stdout.write(readFileSync(new URL('./completion.zsh', import.meta.url), 'utf8'));
  process.exit(0);
}
if (version) {
  console.log(
    JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
  );
  process.exit(0);
}
if (help) {
  console.log(`Usage: terminal-electron [App.app | source-directory | executable] [options] [-- app-arguments]

Run without a path to choose from installed Electron apps.

  --list                 List discovered Electron apps without launching
  --app-dir PATH         Include another folder when discovering apps
  --completion zsh       Print native zsh Tab-completion setup
  --profile PATH         Use a persistent profile (default: isolated temporary profile)
  --import-profile PATH  Import a desktop Chromium session into a new --profile
  --electron PATH        Electron executable for a source app
  --fps NUMBER           Maximum frame rate, 1–60 (default: 15)
  --version              Show version
  --help                 Show help

Requires macOS and a Kitty-graphics terminal such as Ghostty or Kitty.
Ctrl+Q exits; Ctrl+Tab switches windows; Ctrl+Shift+W closes a window.
Prepared private bundles and credential identities are reused.
The installed app is unchanged. App output goes to a session log.`);
  process.exit(0);
}
if (list) {
  for (const app of await discoverApplications({ directories }))
    console.log(app.name + '\t' + app.path);
  process.exit(0);
}
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('Run this command in an interactive Ghostty or Kitty terminal, or use --list.');
  process.exit(1);
}
let target = parsed.target;
if (!target) {
  try {
    console.log('Finding installed Electron apps…');
    const apps = await discoverApplications({ directories });
    if (!apps.length) {
      console.error(
        'No Electron apps found. Pass an .app path directly, or add a folder with --app-dir PATH.',
      );
      process.exit(1);
    }
    target = await chooseApplication(apps);
    if (!target) process.exit(0);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
const session = new Session(target, options);
let terminal;
let failed = false;
session.on('progress', ({ message }) => {
  if (!terminal) console.log(message);
});
session.on('app-error', (error) => {
  failed = true;
  console.error(error.message);
  session.stop();
});
const quit = () => session.stop();
process.on('SIGINT', quit);
process.on('SIGTERM', quit);
process.on('SIGHUP', quit);
try {
  console.log(`Starting ${target}\nSession log: ${session.logPath}`);
  const onReady = (message) => {
    if (message.type === 'ready' && !terminal) {
      terminal = new Terminal(session);
      terminal.start();
      session.off('message', onReady);
    }
  };
  session.on('message', onReady);
  const exited = new Promise((resolve) =>
    session.once('exit', (code, signal) => {
      if (code || signal) failed = true;
      resolve();
    }),
  );
  await session.start();
  await exited;
} catch (error) {
  failed = true;
  appendFileSync(session.logPath, (error.stack ?? error.message) + '\n');
  console.error(error.message);
} finally {
  terminal?.stop();
  await session.stop();
  console.log(`Session ended. Log: ${session.logPath}\nProfile: ${session.profile}`);
}
process.exitCode = failed ? 1 : 0;
