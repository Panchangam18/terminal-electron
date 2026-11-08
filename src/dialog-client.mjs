import net from 'node:net';
process.stdin.setEncoding('utf8');
let request = '';
for await (const chunk of process.stdin) request += chunk;
const socket = net.connect(process.argv[2]);
socket.setEncoding('utf8');
let response = '';
socket.on('connect', () => socket.write(request + '\n'));
socket.on('data', (chunk) => {
  response += chunk.toString('utf8');
  const end = response.indexOf('\n');
  if (end >= 0) {
    process.stdout.write(response.slice(0, end));
    socket.destroy();
  }
});
socket.on('error', () => {
  process.exitCode = 1;
});
socket.on('close', () => {
  if (!response) process.exitCode = 1;
});
