import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createDb } from '../src/db.js';

export function tmpDir(prefix = 'im-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// 启动一个真实监听端口的 server,返回 {srv, io, db, dir, url, close}
export async function makeServer() {
  const { createServer } = await import('node:http');
  const { Server } = await import('socket.io');
  const { createApp } = await import('../src/http.js');
  const { registerSocket } = await import('../src/socket.js');
  const dir = tmpDir();
  const db = createDb(':memory:');
  const app = createApp({ db, uploadDir: dir });
  const srv = createServer(app);
  const io = new Server(srv);
  registerSocket(io, db);
  await new Promise((r) => srv.listen(0, r));
  const url = `http://localhost:${srv.address().port}`;
  return { srv, io, db, dir, url, close: () => new Promise((r) => srv.close(r)) };
}
