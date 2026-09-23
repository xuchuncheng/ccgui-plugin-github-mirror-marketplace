import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { createDb } from './db.js';
import { createApp } from './http.js';
import { registerSocket } from './socket.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const db = createDb(process.env.DB_FILE || path.join(__dirname, '..', 'im.db'));
const app = createApp({ db, uploadDir: UPLOAD_DIR });
const server = http.createServer(app);
const io = new Server(server);
registerSocket(io, db);

server.listen(PORT, () => {
  console.log(`内网 IM 已启动: http://localhost:${PORT}`);
});
