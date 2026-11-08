"""Exercise Slack through the production Pixel CLI, without composing anything."""
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
from pty_terminal import KittyTerminal

project=Path(__file__).resolve().parents[1]
proof=project/'proof'
proof.mkdir(exist_ok=True)
owned_profile=len(sys.argv)<2
profile=Path(tempfile.mkdtemp(prefix='terminal-electron-slack-pty-')) if owned_profile else Path(sys.argv[1]).resolve()
target=Path(os.environ['TERMINAL_ELECTRON_SLACK_APP']).resolve() if os.environ.get('TERMINAL_ELECTRON_SLACK_APP') else next((candidate for candidate in [Path('/Applications/Slack.app'),project.parent/'Slack.app'] if candidate.is_dir()),None)
if target is None or not target.is_dir():
 raise SystemExit('Install Slack or set TERMINAL_ELECTRON_SLACK_APP to its .app path.')
prefix='slack-cli' if owned_profile else 'slack-pixel-signed'
master,slave=pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',35,100,1000,700))
child=subprocess.Popen([shutil.which('node'),str(project/'src/cli.mjs'),str(target),'--profile',str(profile)],stdin=slave,stdout=slave,stderr=slave,cwd=project,env=dict(os.environ,TERM='xterm-kitty',TERM_PROGRAM='terminal-electron-test',TERMINAL_BROWSER_FRAMES='inline'))
os.close(slave)
raw=bytearray()
terminal=KittyTerminal(lambda data:os.write(master,data))
dimensions=set()
started=None
stage=0
evidence=None
deadline=time.monotonic()+100
try:
 while time.monotonic()<deadline:
  readable,_,_=select.select([master],[],[],0.05)
  if readable:
   try:data=os.read(master,1024*1024)
   except OSError:break
   if not data:break
   raw.extend(data)
   before=len(terminal.frames)
   terminal.feed(data)
   for frame in terminal.frames[before:]:
    dimensions.add(struct.unpack('>II',frame[16:24]))
    if len(frame)>20000:
     evidence=frame
     if started is None:started=time.monotonic()
  if started is not None:
   elapsed=time.monotonic()-started
   if stage==0:
    os.write(master,b'\x1b[<0;2;2M\x1b[<0;2;2m\t')
    stage=1
   elif stage==1 and elapsed>0.5:
    fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',38,110,1100,760))
    os.kill(child.pid,signal.SIGWINCH)
    stage=2
   elif stage==2 and elapsed>(1 if owned_profile else 5) and (1100,760) in dimensions and struct.unpack('>II',evidence[16:24])==(1100,760):
    os.write(master,b'\x11')
    stage=3
  if child.poll() is not None:break
 assert stage==3,f'Slack Pixel CLI stopped at stage {stage}'
 assert child.wait(timeout=6)==0
 assert (1000,700) in dimensions and (1100,760) in dimensions
 log_path=re.search(rb'Session log: ([^\r\n]+)',bytes(raw))[1].decode()
 stats=json.loads(re.search(r'Pixel presentation: (.+)',Path(log_path).read_text())[1])
 assert stats['appFrames']>=2
 (proof/(prefix+'.png')).write_bytes(evidence)
 (proof/(prefix+'.json')).write_text(json.dumps({'target':str(target),'renderer':stats,'decodedGraphicsImages':len(terminal.frames),'frameDimensions':sorted(dimensions),'exitCode':child.returncode,'profile':'isolated temporary' if owned_profile else 'private local signed-in profile copy','checks':['production Pixel CLI on a real PTY','raw BGRA bridge','Pixel compressed RGBA packets reconstructed','SIGWINCH resize','Ctrl+Q clean shutdown','no message composition or submission'],'unverified':['live Ghostty display']},indent=2))
 print(f'PASS: Slack Pixel CLI PTY; {len(terminal.frames)} decoded images, {stats["appFrames"]} app bitmaps, resize, clean Ctrl+Q.')
finally:
 if child.poll() is None:
  child.terminate()
  try:child.wait(timeout=4)
  except subprocess.TimeoutExpired:child.kill();child.wait()
 os.close(master)
 if owned_profile:shutil.rmtree(profile)
 (proof/(prefix+'-transcript.txt')).write_text(re.sub(rb'\x1b_G.*?\x1b\\',b'[Pixel graphics packet]',bytes(raw),flags=re.S).decode('utf8',errors='replace'))
