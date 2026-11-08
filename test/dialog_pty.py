import fcntl,json,os,pty,re,select,shutil,struct,subprocess,tempfile,termios,time
from pathlib import Path
from pty_terminal import KittyTerminal
project=Path(__file__).resolve().parents[1]
(project/'proof').mkdir(exist_ok=True)
root=Path(tempfile.mkdtemp(prefix='terminal-electron-dialog-'))
profile=root/'profile';target=root/'chosen café 日本語';target.mkdir()
master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',35,100,1000,700))
child=subprocess.Popen([shutil.which('node'),str(project/'src/cli.mjs'),str(project/'examples/dialog-app'),'--profile',str(profile)],stdin=slave,stdout=slave,stderr=slave,cwd=project,env=dict(os.environ,TERM='xterm-kitty',TERM_PROGRAM='terminal-electron-test',TERMINAL_BROWSER_FRAMES='inline',TERMINAL_ELECTRON_DIALOG_DEFAULT=str(root)))
os.close(slave);raw=bytearray();terminal=KittyTerminal(lambda b:os.write(master,b));started=None;stage=0;proof=None;deadline=time.monotonic()+15
try:
 while time.monotonic()<deadline:
  ready,_,_=select.select([master],[],[],0.05)
  if ready:
   try:data=os.read(master,1024*1024)
   except OSError:break
   if not data:break
   raw.extend(data);terminal.feed(data)
   if terminal.frames and len(terminal.frames[-1])>10000 and started is None:started=time.monotonic()
  if started is not None:
   elapsed=time.monotonic()-started
   if stage==0 and elapsed>0.6:
    proof=terminal.frames[-1];os.write(master,b'\x0c\x1b[200~'+str(target).encode()+b'\x1b[201~');stage=1
   elif stage==1 and elapsed>1:
    os.write(master,b'\r');stage=2
  if child.poll() is not None:break
 assert child.wait(timeout=3)==0,f'dialog child exit {child.returncode}'
 result=json.loads((profile/'dialog-result.json').read_text())
 assert result['paths']==[str(target)],result
 assert result['pid']!=child.pid
 out=project/'proof';out.mkdir(exist_ok=True)
 (out/'dialog-picker.png').write_bytes(proof)
 (out/'dialog-pty.json').write_text(json.dumps({'status':'pass','renderer':'@zenbu-labs/pixel','kind':'synchronous directory picker','unicodePathReturned':True,'originalBackendWroteResult':True,'decodedGraphicsImages':len(terminal.frames),'exitCode':child.returncode},indent=2))
 print('PASS: Pixel synchronous folder picker; Unicode path selected through terminal input and returned to the original backend.')
finally:
 if terminal.frames:(project/'proof/dialog-last.png').write_bytes(terminal.frames[-1])
 if child.poll() is None:
  child.terminate()
  try:child.wait(timeout=3)
  except subprocess.TimeoutExpired:child.kill();child.wait()
 os.close(master);shutil.rmtree(root)
 (project/'proof/dialog-transcript.txt').write_text(re.sub(rb'\x1b_G.*?\x1b\\',b'[Pixel graphics]',bytes(raw),flags=re.S).decode(errors='replace'))
