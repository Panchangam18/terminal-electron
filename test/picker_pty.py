"""Search the real Pixel app picker, open a packaged fixture, and cancel safely."""
import fcntl,json,os,pty,re,select,shutil,struct,subprocess,tempfile,termios,time
from pathlib import Path
from pty_terminal import KittyTerminal

project=Path(__file__).resolve().parents[1]
root=Path(tempfile.mkdtemp(prefix='terminal-electron-picker-')).resolve()
apps=root/'Applications';apps.mkdir();bundle=apps/'Terminal picker proof.app'
node=shutil.which('node');profile=root/'profile'
subprocess.run([node,'--input-type=module','-e',"""
import fs from 'node:fs';import path from 'node:path';import {createRequire} from 'node:module';import {createPackageWithOptions} from '@electron/asar';import {execFileSync} from 'node:child_process';
const require=createRequire(import.meta.url);const runtime=require('electron');const bundle=process.argv[1];execFileSync('/bin/cp',['-cR',path.resolve(runtime,'../../..'),bundle]);const resources=path.join(bundle,'Contents/Resources');fs.rmSync(path.join(resources,'default_app.asar'),{force:true});await createPackageWithOptions(path.resolve('examples/ipc-app'),path.join(resources,'app.asar'),{unpack:'{*,.*}'});execFileSync('/usr/bin/plutil',['-replace','CFBundleName','-string','Terminal picker proof',path.join(bundle,'Contents/Info.plist')]);execFileSync('/usr/bin/codesign',['--force','--deep','--sign','-',bundle],{stdio:'ignore'});
""",str(bundle)],cwd=project,check=True)

def run(cancel=False):
 master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',35,100,1000,700))
 command=os.environ.get('TERMINAL_ELECTRON_TEST_COMMAND',str(project/'terminal-electron'))
 child=subprocess.Popen([command,'--app-dir',str(apps),'--profile',str(profile)],stdin=slave,stdout=slave,stderr=slave,cwd=project,env=dict(os.environ,TERM='xterm-kitty',TERMINAL_BROWSER_FRAMES='inline',PATH=os.environ.get('TERMINAL_ELECTRON_TEST_PATH',os.environ['PATH'])))
 os.close(slave);raw=bytearray();terminal=KittyTerminal(lambda data:os.write(master,data));first=None;stage=0;app_started=None;app_frame_start=0;evidence=None;deadline=time.monotonic()+45
 try:
  while time.monotonic()<deadline:
   readable,_,_=select.select([master],[],[],0.05)
   if readable:
    try:data=os.read(master,1024*1024)
    except OSError:break
    if not data:break
    raw.extend(data);terminal.feed(data)
    if terminal.frames and first is None:first=time.monotonic()
   if first is not None:
    elapsed=time.monotonic()-first
    if stage==0 and elapsed>0.6:
     evidence=terminal.frames[-1]
     if cancel:os.write(master,b'\x1b[27u');stage=4
     else:os.write(master,b'\x1b[200~Terminal picker proof\x1b[201~');stage=1
    elif stage==1 and elapsed>1:
     os.write(master,b'\r');stage=2
    elif stage==2 and b'Starting '+str(bundle).encode() in raw:
     app_started=time.monotonic();app_frame_start=len(terminal.frames);stage=3
    elif stage==3 and time.monotonic()-app_started>1 and len(terminal.frames)>app_frame_start+1 and len(terminal.frames[-1])>10000:
     os.write(master,b'\x11');stage=4
   if child.poll() is not None:break
  assert stage==4,f'picker flow stopped at stage {stage}'
  assert child.wait(timeout=5)==0
  if cancel:assert b'Starting ' not in raw
  else:
   assert b'Starting '+str(bundle).encode() in raw
   log=Path(re.search(rb'Session log: ([^\r\n]+)',bytes(raw))[1].decode())
   stats=json.loads(re.search(r'Pixel presentation: (.+)',log.read_text())[1]);assert stats['appFrames']>=2
  if not cancel:
   (project/'proof').mkdir(exist_ok=True);(project/'proof/app-picker.png').write_bytes(evidence)
  return {'cancel':cancel,'exitCode':child.returncode,'decodedImages':len(terminal.frames),'launchedSelectedApp':not cancel}
 finally:
  if child.poll() is None:
   child.terminate()
   try:child.wait(timeout=4)
   except subprocess.TimeoutExpired:child.kill();child.wait()
  os.close(master)
  if terminal.frames:(project/'proof/picker-last.png').write_bytes(terminal.frames[-1])
  (project/'proof/picker-transcript.txt').write_text(re.sub(rb'\x1b_G.*?\x1b\\',b'[Pixel graphics]',bytes(raw),flags=re.S).decode(errors='replace'))

try:
 print('Checking picker launch',flush=True);first=run();print('Checking picker cancel',flush=True)
 result=[first,run(True)];(project/'proof/picker-pty.json').write_text(json.dumps({'status':'pass','checks':result},indent=2));print('PASS: real Pixel app picker, text filtering, selected packaged app launch, Ctrl+Q, Escape cancellation.')
finally:shutil.rmtree(root)
