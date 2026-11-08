import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extractFile } from '@electron/asar';
import { flipFuses, FuseVersion, FuseV1Options } from '@electron/fuses';
import { electronFramework } from './bundle.mjs';
import { patchArchive } from './archive.mjs';

const bootstrap = fileURLToPath(new URL('./bootstrap.cjs', import.meta.url));

function entryCode(appDirectory, main, type) {
  const entry = path.resolve(appDirectory, main || 'index.js');
  const esm = entry.endsWith('.mjs') || (type === 'module' && !entry.endsWith('.cjs'));
  return `const config = JSON.parse(process.env.TERMINAL_ELECTRON_BOOTSTRAP);
delete process.env.TERMINAL_ELECTRON_BOOTSTRAP;
require(${JSON.stringify(bootstrap)})(config);
require('electron').app.setAppPath(${JSON.stringify(appDirectory)});
${esm ? `import(${JSON.stringify(pathToFileURL(entry).href)}).catch(error => { console.error(error); require('electron').app.exit(1); });` : `require(${JSON.stringify(entry)});`}
`;
}

export function prepareSource(original, directory) {
  const pkg = JSON.parse(fs.readFileSync(path.join(original, 'package.json'), 'utf8'));
  const wrapper = path.join(directory, 'entry');
  fs.mkdirSync(wrapper);
  fs.writeFileSync(
    path.join(wrapper, 'package.json'),
    JSON.stringify({
      name: pkg.name || 'terminal-electron-app',
      productName: pkg.productName,
      version: pkg.version || '0.0.0',
      main: 'main.cjs',
    }),
  );
  fs.writeFileSync(path.join(wrapper, 'main.cjs'), entryCode(original, pkg.main, pkg.type));
  return wrapper;
}

function codeHash(bundle) {
  const result = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', bundle], {
    encoding: 'utf8',
  });
  const hash = /^CDHash=(\w+)/m.exec(result.stderr ?? '')?.[1];
  if (result.status !== 0 || !hash)
    throw new Error('Could not identify the private runtime signature.');
  return hash;
}

function validateRuntime(runtime) {
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', runtime.path], {
    stdio: 'pipe',
  });
  if (codeHash(runtime.path) !== runtime.codeHash)
    throw new Error(
      'The private runtime identity changed; the existing profile has been preserved.',
    );
  if (
    spawnSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', runtime.path], { stdio: 'ignore' })
      .status === 0
  )
    execFileSync('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', runtime.path], {
      stdio: 'pipe',
    });
  return runtime;
}

export async function prepareBundle(
  original,
  directory,
  cacheRoot = fileURLToPath(new URL('../profiles/runtimes/', import.meta.url)),
  profile = {},
  progress = () => {},
) {
  cacheRoot = path.resolve(cacheRoot);
  const sourceHash = createHash('sha256').update(original);
  const legacyHash = createHash('sha256').update(
    JSON.stringify({ schema: 2, original, bootstrap, cacheRoot }),
  );
  const signature = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', original], {
    encoding: 'utf8',
  });
  sourceHash.update(signature.stderr ?? '');
  legacyHash.update(signature.stderr ?? '');
  for (const relative of [
    'Contents/Info.plist',
    'Contents/_CodeSignature/CodeResources',
    'Contents/Resources/app.asar',
    'Contents/Resources/app/package.json',
  ]) {
    const file = path.join(original, relative);
    if (fs.existsSync(file))
      for await (const chunk of fs.createReadStream(file)) {
        sourceHash.update(chunk);
        legacyHash.update(chunk);
      }
  }
  const sourceFingerprint = sourceHash.digest('hex');
  const legacyId = legacyHash.digest('hex').slice(0, 24);
  if (profile.runtime) {
    if (
      profile.runtime.target !== original ||
      profile.runtime.sourceFingerprint !== sourceFingerprint
    )
      throw new Error(
        'The source app changed; use a new private profile to upgrade without changing the previous credential identity.',
      );
    progress('Using the saved private runtime…');
    return validateRuntime(profile.runtime);
  }
  if (profile.credentialName === `Terminal Electron ${legacyId}`) {
    const legacy = JSON.parse(
      fs.readFileSync(path.join(cacheRoot, legacyId, 'runtime.json'), 'utf8'),
    );
    return validateRuntime({
      ...legacy,
      target: original,
      sourceFingerprint,
      codeHash: codeHash(legacy.path),
    });
  }
  const id = createHash('sha256')
    .update(JSON.stringify({ schema: 4, original, bootstrap, cacheRoot, sourceFingerprint }))
    .digest('hex')
    .slice(0, 24);
  const destination = path.join(cacheRoot, id);
  const bundle = path.join(destination, path.basename(original));
  const manifest = path.join(destination, 'runtime.json');
  if (fs.existsSync(manifest) && fs.existsSync(bundle)) {
    progress('Using the cached private runtime…');
    return validateRuntime(JSON.parse(fs.readFileSync(manifest, 'utf8')));
  }
  fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  const staging = fs.mkdtempSync(path.join(cacheRoot, '.prepare-'));
  try {
    await stageBundle(original, staging, bundle, progress);
    const info = JSON.parse(
      execFileSync(
        '/usr/bin/plutil',
        ['-convert', 'json', '-o', '-', path.join(original, 'Contents/Info.plist')],
        { encoding: 'utf8' },
      ),
    );
    const protocolSchemes = [
      ...new Set((info.CFBundleURLTypes ?? []).flatMap((type) => type.CFBundleURLSchemes ?? [])),
    ];
    const result = {
      path: bundle,
      credentialName: `Terminal Electron ${id}`,
      protocolSchemes,
      cached: true,
      target: original,
      sourceFingerprint,
      codeHash: codeHash(path.join(staging, path.basename(original))),
    };
    fs.writeFileSync(path.join(staging, 'runtime.json'), JSON.stringify(result), { mode: 0o600 });
    try {
      fs.renameSync(staging, destination);
    } catch (error) {
      if (!fs.existsSync(manifest)) throw error;
    }
    return validateRuntime(JSON.parse(fs.readFileSync(manifest, 'utf8')));
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

async function stageBundle(original, directory, finalBundle, progress) {
  const resources = path.join(original, 'Contents/Resources');
  const archived = fs.existsSync(path.join(resources, 'app.asar'));
  if (!archived && !fs.existsSync(path.join(resources, 'app/package.json')))
    throw new Error('No Electron app/package.json or app.asar was found in this bundle.');
  const staged = path.join(directory, path.basename(original));
  progress('Copying the app into its private runtime…');
  execFileSync('/bin/cp', ['-cR', original, staged], { stdio: 'pipe' });
  const stagedResources = fs.realpathSync(path.join(staged, 'Contents/Resources'));
  const appDirectory = path.join(stagedResources, archived ? 'app.asar' : 'app');
  const pkg = JSON.parse(
    archived
      ? extractFile(appDirectory, 'package.json').toString()
      : fs.readFileSync(path.join(appDirectory, 'package.json'), 'utf8'),
  );
  const finalAppDirectory = path.join(
    finalBundle,
    'Contents/Resources',
    archived ? 'app.asar' : 'app',
  );
  const entry = entryCode(finalAppDirectory, pkg.main, pkg.type);
  pkg.main = '.terminal-electron.cjs';
  progress('Adding the terminal entry point…');
  if (archived) {
    await patchArchive(appDirectory, {
      'package.json': JSON.stringify(pkg),
      '.terminal-electron.cjs': entry,
    });
    const framework = await electronFramework(staged);
    if (!framework)
      throw new Error('Could not identify the Electron framework in the private bundle.');
    await flipFuses(framework.binary, {
      version: FuseVersion.V1,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
    });
  } else {
    fs.writeFileSync(path.join(appDirectory, '.terminal-electron.cjs'), entry);
    fs.writeFileSync(path.join(appDirectory, 'package.json'), JSON.stringify(pkg));
  }
  progress('Signing and verifying the private runtime…');
  execFileSync(
    '/usr/bin/codesign',
    ['--force', '--deep', '--sign', '-', '--preserve-metadata=entitlements,flags,runtime', staged],
    { stdio: 'pipe' },
  );
  // Some runtimes nest helper apps inside a versioned framework rather than
  // beside it. Walk real directories only, and re-seal containers inside out.
  const bundles = [];
  function visit(root) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = path.join(root, entry.name);
      visit(child);
      if (/\.(app|framework|xpc|appex)$/.test(entry.name)) bundles.push(child);
    }
  }
  visit(staged);
  for (const bundle of [...bundles, staged]) {
    const xml = execFileSync('/usr/bin/codesign', ['-d', '--entitlements', ':-', bundle], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const entitlements = xml.trim()
      ? JSON.parse(
          execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], {
            input: xml,
            encoding: 'utf8',
          }),
        )
      : {};
    // Team-scoped grants cannot survive an ad-hoc signature.
    for (const key of Object.keys(entitlements)) {
      if (
        key.startsWith('com.apple.developer.') ||
        key === 'keychain-access-groups' ||
        key === 'application-identifier' ||
        key === 'com.apple.application-identifier' ||
        key === 'com.apple.security.application-groups'
      )
        delete entitlements[key];
    }
    entitlements['com.apple.security.cs.disable-library-validation'] = true;
    const file = path.join(directory, 'entitlements.plist');
    fs.writeFileSync(
      file,
      execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', '--', '-'], {
        input: JSON.stringify(entitlements),
      }),
    );
    // Remove explicit CS_REQUIRE_LV, preserving the other original flags.
    // In particular, do not add hardened runtime to development helper apps:
    // those may have no JIT entitlement and would fail to start a renderer.
    const signature = spawnSync('/usr/bin/codesign', ['-dv', bundle], { encoding: 'utf8' });
    if (signature.status !== 0) throw new Error(signature.stderr);
    const flags = /flags=0x([\da-f]+)/i.exec(signature.stderr);
    if (!flags) throw new Error(`Could not read signing flags for ${bundle}`);
    const options = (Number.parseInt(flags[1], 16) & ~0x2000).toString();
    execFileSync(
      '/usr/bin/codesign',
      [
        '--force',
        '--sign',
        '-',
        '--entitlements',
        file,
        '--options',
        options,
        '--preserve-metadata=runtime',
        bundle,
      ],
      { stdio: 'pipe' },
    );
  }
  return staged;
}
