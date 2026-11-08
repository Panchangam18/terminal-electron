#!/usr/bin/env node
import { Session } from './session.mjs';
import { Terminal } from './pixel.mjs';

const args = process.argv.slice(2);
if (!args.length || args.includes('--help')) {
  console.log(`Usage: terminal-electron <App.app | source-directory | executable> [options] [-- app-arguments]

  --electron PATH   Electron executable for a source app
  --profile PATH    Use a persistent profile (default: isolated temporary profile)
  --import-profile PATH  Import a desktop Chromium session into a new --profile
  --fps NUMBER      Maximum frame rate, 1–60 (default: 15)

Requires Node.js 22.12+ and a Kitty-graphics terminal such as Ghostty or Kitty.
Ctrl+Q exits; Ctrl+Tab switches windows; Ctrl+Shift+W closes a window.
macOS bundles run from a private, ad-hoc-signed copy with an entry shim.
Private copies and credential identities are reused; existing vendor profiles are refused.
The installed app is unchanged. App output goes to a session log.`);
  process.exit(0);
}
const target = args.shift();
const options = { args: [], frameFormat: 'bgra' };
while (args.length) {
  const option = args.shift();
  if (option === '--') {
    options.args = args;
    break;
  }
  if (option === '--profile' || option === '--electron') options[option.slice(2)] = args.shift();
  else if (option === '--import-profile') options.importProfile = args.shift();
  else if (option === '--fps') options.fps = Number(args.shift());
  else throw new Error(`Unknown option: ${option}. Pass app arguments after --.`);
}
if (
  options.fps !== undefined &&
  (!Number.isInteger(options.fps) || options.fps < 1 || options.fps > 60)
)
  throw new Error('--fps must be an integer between 1 and 60.');
if (options.importProfile && !options.profile)
  throw new Error('--import-profile requires a new --profile directory.');
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('Run this command in an interactive Ghostty or Kitty terminal.');
  process.exit(1);
}
const session = new Session(target, options);
let terminal;
let failed = false;
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
  console.error(error.message);
} finally {
  terminal?.stop();
  await session.stop();
  console.log(`Session ended. Log: ${session.logPath}\nProfile: ${session.profile}`);
}
process.exitCode = failed ? 1 : 0;
