"""Verify actual zsh Tab completion without running any selected desktop app."""
import os,pty,fcntl,termios,struct,subprocess,shutil,shlex,time,select,tempfile,json
from pathlib import Path
project=Path(__file__).resolve().parents[1]
fixture=Path(tempfile.mkdtemp(prefix='terminal-electron-completion-')).resolve();target=fixture/'Completion proof.app'
for folder in ['Contents/MacOS','Contents/Resources','Contents/Frameworks/Electron Framework.framework']:(target/folder).mkdir(parents=True,exist_ok=True)
(target/'Contents/MacOS/proof').write_text('fixture');(target/'Contents/Resources/app.asar').write_text('fixture');(target/'Contents/Info.plist').write_text(json.dumps({'CFBundleName':'Completion proof','CFBundleExecutable':'proof'}))
master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',30,120,1200,600))
child=subprocess.Popen(['/bin/zsh','-f'],stdin=slave,stdout=slave,stderr=slave,cwd=project,env=dict(os.environ,TERM='xterm-256color'))
os.close(slave);raw=bytearray();stage=0;deadline=time.monotonic()+25
node=shlex.quote(shutil.which('node'));cli=shlex.quote(str(project/'src/cli.mjs'));app_dir=shlex.quote(str(fixture))
setup=f'HISTFILE=; PROMPT="completion> "; bindkey -e; autoload -Uz compinit; compinit -D; terminal-electron() {{ {node} {cli} --app-dir {app_dir} "$@"; }}; source <(terminal-electron --completion zsh); print -r -- __COMPLETION_READY__\n'
os.write(master,setup.encode())
try:
 while time.monotonic()<deadline:
  ready,_,_=select.select([master],[],[],0.05)
  if ready:
   try:data=os.read(master,65536)
   except OSError:break
   raw.extend(data)
  if stage==0 and b'\r\n__COMPLETION_READY__\r\n' in raw:
   os.write(master,b'terminal-electron Completion\t');stage=1
  elif stage==1 and b'Completion\\ proof.app' in raw:
   os.write(master,b'\x15exit\r');stage=2
  if child.poll() is not None:break
 assert stage==2,'zsh did not complete the discovered app path'
 assert child.wait(timeout=3)==0
 assert b'Starting ' not in raw,'completion launched an app'
 print('PASS: actual zsh Tab completion inserts the discovered app path without launching it.')
finally:
 if child.poll() is None:child.kill();child.wait()
 os.close(master);shutil.rmtree(fixture);(project/'proof').mkdir(exist_ok=True);(project/'proof/completion-transcript.txt').write_bytes(raw)
