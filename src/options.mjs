export function parseArguments(args) {
  args = [...args];
  let target;
  let help = false;
  let version = false;
  let list = false;
  let completion;
  const directories = [];
  const options = { args: [], frameFormat: 'bgra' };
  while (args.length) {
    const arg = args.shift();
    if (arg === '--') {
      options.args = args;
      break;
    }
    if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--version' || arg === '-v') version = true;
    else if (arg === '--list') list = true;
    else if (
      [
        '--profile',
        '--electron',
        '--import-profile',
        '--fps',
        '--app-dir',
        '--completion',
      ].includes(arg)
    ) {
      const value = args.shift();
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
      if (arg === '--completion') {
        if (value !== 'zsh') throw new Error('Supported shell completion: zsh.');
        completion = value;
      } else if (arg === '--app-dir') directories.push(value);
      else
        options[
          {
            '--profile': 'profile',
            '--electron': 'electron',
            '--import-profile': 'importProfile',
            '--fps': 'fps',
          }[arg]
        ] = arg === '--fps' ? Number(value) : value;
    } else if (arg.startsWith('-'))
      throw new Error(`Unknown option: ${arg}. Pass app arguments after --.`);
    else if (target) throw new Error('Pass app arguments after --.');
    else target = arg;
  }
  if (
    options.fps !== undefined &&
    (!Number.isInteger(options.fps) || options.fps < 1 || options.fps > 60)
  )
    throw new Error('--fps must be an integer between 1 and 60.');
  if (options.importProfile && !options.profile)
    throw new Error('--import-profile requires a new --profile directory.');
  return { target, options, help, version, list, directories, completion };
}
