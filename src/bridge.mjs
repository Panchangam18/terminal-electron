export class BridgeDecoder {
  constructor(receive) {
    this.receive = receive;
    this.parts = [];
    this.length = 0;
    this.frame = null;
  }
  push(chunk) {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.frame) {
        const frame = this.frame;
        const count = Math.min(chunk.length - offset, frame.bytes.length - frame.offset);
        chunk.copy(frame.bytes, frame.offset, offset, offset + count);
        offset += count;
        frame.offset += count;
        if (frame.offset === frame.bytes.length) {
          this.frame = null;
          this.receive({ ...frame.header, bgra: frame.bytes });
        }
        continue;
      }
      const end = chunk.indexOf(10, offset);
      if (end < 0) {
        this.parts.push(chunk.subarray(offset));
        this.length += chunk.length - offset;
        return;
      }
      const part = chunk.subarray(offset, end);
      const line = this.parts.length
        ? Buffer.concat([...this.parts, part], this.length + part.length)
        : part;
      this.parts = [];
      this.length = 0;
      offset = end + 1;
      const message = JSON.parse(line.toString('utf8'));
      if (message.type === 'frame' && message.format === 'bgra') {
        if (
          !Number.isInteger(message.width) ||
          !Number.isInteger(message.height) ||
          message.width < 1 ||
          message.height < 1 ||
          !Number.isInteger(message.byteLength) ||
          message.byteLength !== message.width * message.height * 4 ||
          message.byteLength > 128 * 1024 * 1024
        )
          throw new Error('Invalid bitmap frame size.');
        this.frame = { header: message, bytes: Buffer.allocUnsafe(message.byteLength), offset: 0 };
      } else this.receive(message);
    }
  }
}
