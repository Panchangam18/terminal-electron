"""Read-only production CLI check: launch, decode graphics, resize and quit."""
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shlex
import signal
import struct
import subprocess
import sys
import termios
import time
from pty_terminal import KittyTerminal

project = Path(__file__).resolve().parents[1]
target = Path(sys.argv[1]).resolve()
command = shlex.split(os.environ.get('TERMINAL_ELECTRON_TEST_COMMAND', 'node src/cli.mjs'))
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 35, 100, 1000, 700))
started = time.monotonic()
child = subprocess.Popen(command + [str(target)], stdin=slave, stdout=slave, stderr=slave,
                         cwd=project, env=dict(os.environ, TERM='xterm-kitty',
                         TERM_PROGRAM='terminal-electron-test', TERMINAL_BROWSER_FRAMES='inline'))
os.close(slave)
terminal = KittyTerminal(lambda data: os.write(master, data))
raw = bytearray()
first_frame = None
stage = 0
dimensions = set()
evidence = None
try:
    while time.monotonic() - started < 100:
        readable, _, _ = select.select([master], [], [], 0.05)
        if readable:
            try:
                data = os.read(master, 1024 * 1024)
            except OSError:
                break
            raw.extend(data)
            before = len(terminal.frames)
            terminal.feed(data)
            for frame in terminal.frames[before:]:
                dimensions.add(struct.unpack('>II', frame[16:24]))
                evidence = frame
                if first_frame is None:
                    first_frame = time.monotonic() - started
        elapsed = time.monotonic() - started
        if first_frame is not None and stage == 0 and elapsed - first_frame > 15:
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 38, 110, 1100, 760))
            os.kill(child.pid, signal.SIGWINCH)
            stage = 1
        if stage == 1 and (1100, 760) in dimensions:
            os.write(master, b'\x11')
            stage = 2
        if child.poll() is not None:
            break
    assert stage == 2, f'CLI stopped at stage {stage}'
    assert child.wait(timeout=25) == 0
    assert (1000, 700) in dimensions
    log = Path(re.search(rb'Session log: ([^\r\n]+)', raw)[1].decode())
    stats = json.loads(re.search(r'Pixel presentation: (.+)', log.read_text())[1])
    assert stats['appFrames'] >= 2
    proof = project / 'proof/runtime-pty'
    proof.mkdir(parents=True, exist_ok=True)
    (proof / 'frame.png').write_bytes(evidence)
    result = dict(target=str(target), command=command, firstFrameMs=round(first_frame*1000),
                  dimensions=sorted(dimensions), renderer=stats, messagesSent=0,
                  exitCode=child.returncode, log=str(log),
                  checks=['production CLI on PTY', 'decoded Pixel graphics', 'resize', 'Ctrl+Q'])
    (proof / 'result.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result))
finally:
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
    os.close(master)
