"""Search the real Pixel app picker, open a packaged fixture, and cancel safely."""
import fcntl,json,os,pty,re,select,shutil,struct,subprocess,tempfile,termios,time
from pathlib import Path
from pty_terminal import KittyTerminal

project=Path(__file__).resolve().parents[1]
root=Path(tempfile.mkdtemp(prefix='terminal-electron-picker-')).resolve()
apps=root/'Applications';apps.mkdir();bundle=apps/'Terminal picker proof A.app';selected_bundle=apps/'Terminal picker proof B.app'
node=shutil.which('node');profile=root/'profile'
subprocess.run([node,'--input-type=module','-e',"""
import fs from 'node:fs';import path from 'node:path';import {createRequire} from 'node:module';import {createPackageWithOptions} from '@electron/asar';import {execFileSync} from 'node:child_process';
const require=createRequire(import.meta.url);const runtime=require('electron');const bundle=process.argv[1];execFileSync('/bin/cp',['-cR',path.resolve(runtime,'../../..'),bundle]);const resources=path.join(bundle,'Contents/Resources');fs.rmSync(path.join(resources,'default_app.asar'),{force:true});await createPackageWithOptions(path.resolve('examples/ipc-app'),path.join(resources,'app.asar'),{unpack:'{*,.*}'});execFileSync('/usr/bin/plutil',['-replace','CFBundleName','-string','Terminal picker proof',path.join(bundle,'Contents/Info.plist')]);execFileSync('/usr/bin/codesign',['--force','--deep','--sign','-',bundle],{stdio:'ignore'});
""",str(bundle)],cwd=project,check=True)
subprocess.run(['/bin/cp','-cR',str(bundle),str(selected_bundle)],check=True)

def run(cancel=False,tab=False):
 master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',35,100,1000,700))
 command=os.environ.get('TERMINAL_ELECTRON_TEST_COMMAND',str(project/'terminal-electron'))
 child=subprocess.Popen([command,'--app-dir',str(apps),'--profile',str(profile)],stdin=slave,stdout=slave,stderr=slave,cwd=project,env=dict(os.environ,TERM='xterm-kitty',TERMINAL_BROWSER_FRAMES='inline',PATH=os.environ.get('TERMINAL_ELECTRON_TEST_PATH',os.environ['PATH'])))
 os.close(slave);raw=bytearray();terminal=KittyTerminal(lambda data:os.write(master,data));first=None;stage=0;app_started=None;evidence=None;deadline=time.monotonic()+45
 try:
  while time.monotonic()<deadline:
   readable,_,_=select.select([master],[],[],0.05)
   if readable:
    try:data=os.read(master,1024*1024)
    except OSError:break
    if not data:break
    raw.extend(data);terminal.feed(data)
    if b'Electron app ' in raw and first is None:first=time.monotonic()
   if first is not None:
    elapsed=time.monotonic()-first
    if stage==0 and elapsed>0.15:
     if cancel:os.write(master,b'\x1b');stage=4
     else:os.write(master,b'\x1b[200~Terminal picker proof\x1b[201~');stage=1
    elif stage==1 and elapsed>0.5:
     os.write(master,b'\t\x1b[Z\t\r' if tab else b'\x1b[B\x1b[A\x1b[B\r');stage=2
    elif stage==2 and b'Starting '+str(selected_bundle).encode() in raw:
     app_started=time.monotonic();stage=3
    elif stage==3 and time.monotonic()-app_started>1 and terminal.frames and len(terminal.frames[-1])>10000:
     os.write(master,b'\x11');stage=4
   if child.poll() is not None:break
  assert stage==4,f'inline selector flow stopped at stage {stage}'
  assert child.wait(timeout=5)==0
  before_app=bytes(raw).split(b'Starting ')[0]
  assert b'\x1b[?1049h' not in before_app,'selector entered an alternate screen'
  assert b'\x1b_G' not in before_app,'selector used terminal graphics'
  assert len(re.findall(rb'\x1b\[\d+A',before_app))>0,'selector did not update inline'
  if cancel:assert b'Starting ' not in raw
  else:
   assert b'Starting '+str(selected_bundle).encode() in raw
   log=Path(re.search(rb'Session log: ([^\r\n]+)',bytes(raw))[1].decode())
   stats=json.loads(re.search(r'Pixel presentation: (.+)',log.read_text())[1]);assert stats['appFrames']>=2
  flags=termios.tcgetattr(master)[3];assert flags&termios.ICANON and flags&termios.ECHO,'terminal mode was not restored'
  return {'cancel':cancel,'tab':tab,'exitCode':child.returncode,'decodedAppImages':len(terminal.frames),'launchedSelectedApp':not cancel,'inlineTextOnly':True,'terminalModeRestored':True}
 finally:
  if child.poll() is None:
   child.terminate()
   try:child.wait(timeout=4)
   except subprocess.TimeoutExpired:child.kill();child.wait()
  os.close(master)
  (project/'proof').mkdir(exist_ok=True)
  (project/'proof/picker-transcript.txt').write_text(re.sub(rb'\x1b_G.*?\x1b\\',b'[Pixel graphics]',bytes(raw),flags=re.S).decode(errors='replace'))

try:
 print('Checking inline arrow selection',flush=True);first=run();print('Checking inline Tab selection',flush=True);tabbed=run(tab=True);print('Checking inline Escape cancel',flush=True)
 result=[first,tabbed,run(True)];(project/'proof/picker-pty.json').write_text(json.dumps({'status':'pass','checks':result},indent=2));print('PASS: inline suggestions, filtering, arrow/Tab selection, selected app launch, quit, Escape, terminal restoration; no alternate screen or graphics before launch.')
finally:shutil.rmtree(root)
