import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { getRawHeader } from '@electron/asar';

// ASAR offsets are relative to the payload. Keep that payload (and all existing
// unpacked files) intact; append only the entry shim and amended package.json.
// The two Chromium pickle headers contain uint32 sizes and a padded UTF-8 string.
export async function patchArchive(archive, edits) {
  const { header, headerSize } = getRawHeader(archive);
  const stat = fs.statSync(archive);
  let offset = stat.size - 8 - headerSize;
  const buffers = [];
  for (const [name, value] of Object.entries(edits)) {
    if (!name || name.includes('/') || name.includes('\\') || ['.', '..'].includes(name))
      throw new Error('Archive edits must name root files.');
    const data = Buffer.from(value);
    const hash = (part) => createHash('sha256').update(part).digest('hex');
    const blockSize = 4 * 1024 * 1024;
    const blocks = [];
    for (let i = 0; i < data.length; i += blockSize)
      blocks.push(hash(data.subarray(i, i + blockSize)));
    if (!blocks.length) blocks.push(hash(data));
    header.files[name] = {
      size: data.length,
      offset: String(offset),
      integrity: { algorithm: 'SHA256', hash: hash(data), blockSize, blocks },
    };
    offset += data.length;
    buffers.push(data);
  }
  const json = Buffer.from(JSON.stringify(header));
  const padded = Math.ceil(json.length / 4) * 4;
  const prefix = Buffer.alloc(16 + padded);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(8 + padded, 4);
  prefix.writeUInt32LE(4 + padded, 8);
  prefix.writeUInt32LE(json.length, 12);
  json.copy(prefix, 16);
  const temporary = archive + '.terminal-electron-tmp';
  try {
    await pipeline(
      async function* () {
        yield prefix;
        if (stat.size > 8 + headerSize)
          yield* fs.createReadStream(archive, { start: 8 + headerSize });
        yield* buffers;
      },
      fs.createWriteStream(temporary, { mode: stat.mode, flags: 'wx' }),
    );
    // Validate with the ASAR reader before replacing the private copy.
    getRawHeader(temporary);
    fs.renameSync(temporary, archive);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
