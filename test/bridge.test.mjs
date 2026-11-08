import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeDecoder } from '../src/bridge.mjs';

test('binary bitmap frames and Unicode metadata survive arbitrary stream boundaries', () => {
  const pixels = Buffer.from([10, 255, 0, 13, 0, 10, 255, 0]);
  const header = { type: 'frame', format: 'bgra', width: 2, height: 1, byteLength: 8, seq: 1 };
  const metadata = { type: 'windows', title: 'café 日本語' };
  const stream = Buffer.concat([
    Buffer.from(JSON.stringify(header) + '\n'),
    pixels,
    Buffer.from(JSON.stringify(metadata) + '\n'),
  ]);
  for (const size of [1, 2, 3, 7, 64, stream.length]) {
    const received = [];
    const decoder = new BridgeDecoder((message) => received.push(message));
    for (let offset = 0; offset < stream.length; offset += size)
      decoder.push(stream.subarray(offset, offset + size));
    assert.deepEqual(received, [{ ...header, bgra: pixels }, metadata]);
  }
});

test('bitmap header must agree with the pixel allocation', () => {
  const decoder = new BridgeDecoder(() => assert.fail('Invalid frame delivered'));
  assert.throws(
    () =>
      decoder.push(
        Buffer.from(
          JSON.stringify({ type: 'frame', format: 'bgra', width: 2, height: 2, byteLength: 8 }) +
            '\n',
        ),
      ),
    /Invalid bitmap frame/,
  );
});
