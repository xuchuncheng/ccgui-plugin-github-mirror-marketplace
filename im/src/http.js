import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findOrCreateUser } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_SIZE = 5 * 1024 * 1024;

export function createApp({ db, uploadDir }) {
  const app = express();

  app.get('/api/login', (req, res) => {
    const name = (req.query.name || '').trim();
    if (!name) return res.status(400).json({ error: '请输入昵称' });
    const user = findOrCreateUser(db, name);
    res.json({ id: user.id, nickname: user.nickname });
  });

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '');
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    },
  });
  const upload = multer({ storage, limits: { fileSize: MAX_SIZE } });

  app.post('/api/upload', (req, res) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        const code = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
        return res.status(code).json({ error: err.message });
      }
      if (!req.file) return res.status(400).json({ error: '未收到文件' });
      res.json({ url: '/uploads/' + req.file.filename, name: req.file.originalname });
    });
  });

  app.use('/uploads', express.static(uploadDir));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  return app;
}
