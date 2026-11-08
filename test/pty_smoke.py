import base64
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import struct
import subprocess
import sys
import tempfile
import termios
import time
from pty_terminal import KittyTerminal

project = Path(__file__).resolve().parents[1]
proof = project / 'proof'
proof.mkdir(exist_ok=True)
high_dpi='--hi-dpi' in sys.argv
prefix='cli-hidpi' if high_dpi else 'cli'
profile = Path(tempfile.mkdtemp(prefix='terminal-electron-pty-profile-'))
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 35, 100, 1000, 700))
environment = dict(os.environ, TERM='xterm-kitty', TERM_PROGRAM='terminal-electron-test', TERMINAL_BROWSER_FRAMES='inline')
child = subprocess.Popen([shutil.which('node'), str(project / 'src/cli.mjs'), str(project / 'examples/ipc-app'), '--profile', str(profile)]+(['--','--fixture-high-dpi'] if high_dpi else []), stdin=slave, stdout=slave, stderr=slave, cwd=project, env=environment)
os.close(slave)
buffer = b''
raw = bytearray()
chunks = []
terminal = KittyTerminal(lambda data: os.write(master, data))
frames = terminal.frames
started = None
stage = 0
evidence_frame = None
deadline = time.monotonic() + 18
expected = 'Typed through Pixel.\nPasted through the original app. café 日本語 🚀'
try:
    while time.monotonic() < deadline:
        readable, _, _ = select.select([master], [], [], 0.05)
        if readable:
            try:
                data = os.read(master, 1024 * 1024)
            except OSError:
                break
            if not data:
                break
            raw.extend(data)
            terminal.feed(data)
            if frames and len(frames[-1]) > 8000 and started is None:
                started = time.monotonic()
        if started is not None:
            elapsed = time.monotonic() - started
            if stage == 0 and elapsed > 0.4:
                os.write(master, b'\x1b[<0;11;13M\x1b[<0;11;13m')
                stage = 1
            elif stage == 1 and elapsed > 0.7:
                os.write(master, b'Typed through Pixel.\r')
                stage = 2
            elif stage == 2 and elapsed > 1.0:
                os.write(master, b'\x1b[200~' + 'Pasted through the original app. café 日本語 🚀'.encode() + b'\x1b[201~')
                stage = 3
            elif stage == 3 and elapsed > 1.3:
                os.write(master, b'\x1b[<0;11;21M\x1b[<0;11;21m')
                stage = 4
            elif stage == 4 and elapsed > 1.6:
                os.write(master, b'\x1b[<0;30;21M\x1b[<0;30;21m')
                stage = 5
            elif stage == 5 and elapsed > 2.3:
                assert (profile / 'note.txt').read_text() == expected
                evidence_frame = frames[-1]
                os.write(master, b'\x11')
                stage = 6
        if child.poll() is not None:
            break
    assert stage == 6, f'CLI did not complete interaction sequence; reached stage {stage}'
    assert child.wait(timeout=5) == 0
    assert len(frames) >= 3, f'Expected rendered updates, got {len(frames)}'
    (proof / (prefix+'-frame.png')).write_bytes(evidence_frame)
    log_path = re.search(rb'Session log: ([^\r\n]+)', bytes(raw))[1].decode()
    stats = json.loads(re.search(r'Pixel presentation: (.+)', Path(log_path).read_text())[1])
    assert stats['appFrames'] >= 2 and stats['bitmapBytes'] > 0
    if high_dpi:
        assert stats['bitmapBytes']/stats['appFrames'] == 2000*1400*4, 'Expected actual 2x app bitmaps'
    (proof / (prefix+'-pty.json')).write_text(json.dumps({'renderer':stats,'appBitmapDimensions':[2000,1400] if high_dpi else [1000,700],'displayDimensions':[1000,700],'decodedGraphicsImages': len(frames), 'typed_text_saved_by_original_main_process': expected, 'exit_code': child.returncode, 'checks': ['real CLI attached to PTY', 'Pixel compressed RGBA packets reconstructed', 'raw BGRA bridge', 'Pixel mouse input', 'Pixel paste', 'main-process file save', 'Ctrl+Q shutdown']}, indent=2))
    print(f'PASS: real CLI PTY, {len(frames)} reconstructed frames, typed note saved by original app, clean Ctrl+Q exit.')
finally:
    if frames:
        (proof / (prefix+'-last.png')).write_bytes(frames[-1])
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=4)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
    os.close(master)
    shutil.rmtree(profile)
    (proof / 'cli-transcript.txt').write_text(re.sub(rb'\x1b_G.*?\x1b\\', b'[kitty graphics packet]', bytes(raw), flags=re.S).decode('utf8', errors='replace'))
