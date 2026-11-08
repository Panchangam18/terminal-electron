#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(uname -s)" = Darwin && "$(uname -m)" = arm64 ]] || { echo 'Build on an Apple Silicon Mac.' >&2; exit 1; }
version=$(node -p 'require("./package.json").version')
node_version=${NODE_VERSION:-v24.22.2}
[[ "$node_version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Invalid NODE_VERSION.' >&2; exit 1; }
archive="terminal-electron-$version-macos-arm64.zip"
build_directory=$(mktemp -d "${TMPDIR:-/tmp}/terminal-electron-build.XXXXXX")
trap 'rm -rf "$build_directory"' EXIT
payload="$build_directory/${archive%.zip}"
mkdir -p "$payload/app" "$payload/runtime/bin" dist
cp package.json package-lock.json .npmrc "$payload/app/"
cp -R src "$payload/app/src"
(cd "$payload/app" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
rm -rf "$payload/app/node_modules/.bin"
node_archive="node-$node_version-darwin-arm64.tar.gz"
curl -fsSL "https://nodejs.org/dist/$node_version/$node_archive" -o "$build_directory/$node_archive"
curl -fsSL "https://nodejs.org/dist/$node_version/SHASUMS256.txt" -o "$build_directory/NODE-SHA256SUMS"
(cd "$build_directory" && awk -v name="$node_archive" '$2 == name {print}' NODE-SHA256SUMS | shasum -a 256 -c -)
tar -xzf "$build_directory/$node_archive" -C "$build_directory"
cp "$build_directory/node-$node_version-darwin-arm64/bin/node" "$payload/runtime/bin/node"
cp "$build_directory/node-$node_version-darwin-arm64/LICENSE" "$payload/runtime/LICENSE"
cp packaging/launcher.sh "$payload/terminal-electron"
cp packaging/install.sh "$payload/install.sh"
cp README.md "$payload/README.md"
cp -R docs "$payload/docs"
printf '%s\n' "$node_version" > "$payload/runtime/VERSION"
printf '%s\n' "$version" > "$payload/VERSION"
chmod +x "$payload/terminal-electron" "$payload/install.sh"
node --input-type=module - "$payload" <<'NODE'
import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
const root=process.argv[2];const hashes=[];
function visit(directory){for(const entry of fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const file=path.join(directory,entry.name);if(entry.isDirectory())visit(file);else if(entry.isFile())hashes.push(createHash('sha256').update(fs.readFileSync(file)).digest('hex')+'  '+path.relative(root,file));else throw new Error('Unexpected symlink in release payload: '+file);}}
visit(root);fs.writeFileSync(path.join(root,'SHA256SUMS'),hashes.join('\n')+'\n');
NODE
ditto --norsrc --noextattr --noqtn -c -k --keepParent "$payload" "dist/$archive"
sha256=$(shasum -a 256 "dist/$archive");sha256=${sha256%% *}
printf '%s  %s\n' "$sha256" "$archive" > dist/SHA256SUMS
sed -e "s/@ARCHIVE@/$archive/g" -e "s/@TAG@/v$version/g" -e "s/@SHA256@/$sha256/g" -e "s/@VERSION@/$version/g" packaging/get.sh > dist/get.sh
echo "Built dist/$archive and dist/get.sh"
