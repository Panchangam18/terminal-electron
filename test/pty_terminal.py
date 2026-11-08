import base64
import re
import struct
import zlib


def png_rgba(width, height, rgba):
    assert len(rgba) == width * height * 4
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    rows = b''.join(b'\0' + rgba[y*width*4:(y+1)*width*4] for y in range(height))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b'')


class KittyTerminal:
    def __init__(self, write):
        self.write = write
        self.buffer = b''
        self.chunks = []
        self.header = None
        self.frames = []

    def feed(self, data):
        self.buffer += data
        while self.buffer:
            begin = self.buffer.find(b'\x1b')
            if begin < 0:
                self.buffer = b''
                return
            self.buffer = self.buffer[begin:]
            if len(self.buffer) < 2:
                return
            if self.buffer.startswith(b'\x1b['):
                match = re.match(rb'\x1b\[[0-?]*[ -/]*[@-~]', self.buffer)
                if not match:
                    return
                sequence = match[0]
                if sequence == b'\x1b[16t':
                    self.write(b'\x1b[6;20;10t')
                elif sequence == b'\x1b[?1004h':
                    self.write(b'\x1b[I')
                elif sequence == b'\x1b[?u':
                    self.write(b'\x1b[?0u')
                elif re.match(rb'\x1b\[\?\d+\$p', sequence):
                    mode = re.search(rb'\d+', sequence)[0]
                    self.write(b'\x1b[?' + mode + b';0$y')
                self.buffer = self.buffer[len(sequence):]
            elif self.buffer.startswith((b'\x1b_G', b'\x1b]', b'\x1bP')):
                end = self.buffer.find(b'\x1b\\', 2)
                if end < 0:
                    return
                sequence = self.buffer[:end+2]
                self.buffer = self.buffer[end+2:]
                if sequence.startswith(b'\x1b_G'):
                    self.graphics(sequence[3:-2])
            else:
                self.buffer = self.buffer[2:]

    def graphics(self, packet):
        header, _, payload = packet.partition(b';')
        fields = dict(part.split(b'=', 1) for part in header.split(b',') if b'=' in part)
        if fields.get(b'a') == b'T':
            self.header = fields
            self.chunks = []
        if self.header is None or not payload:
            return
        self.chunks.append(payload)
        if fields.get(b'm', b'0') != b'0':
            return
        fields = self.header
        self.header = None
        data = base64.b64decode(b''.join(self.chunks), validate=True)
        assert fields.get(b't', b'd') == b'd', 'Test expects inline graphics transport'
        if fields.get(b'o') == b'z':
            data = zlib.decompress(data)
        if fields[b'f'] == b'100':
            png = data
        else:
            assert fields[b'f'] == b'32'
            png = png_rgba(int(fields[b's']), int(fields[b'v']), data)
        assert png.startswith(b'\x89PNG\r\n\x1a\n')
        self.frames.append(png)
