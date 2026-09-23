import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findOrCreateUser } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_SIZE = 5 * 1024 * 1024;
// 本接口按规格只做图片上传；限制 mimetype 可防止 evil.html 等任意扩展名被同源内联投递（存储型 XSS / 钓鱼）
const ALLOWED_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
]);
// 与 mimetype 白名单一致的扩展名白名单；static 的 setHeaders 用它兜底（见下）
const ALLOWED_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

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
  const upload = multer({
    storage,
    limits: { fileSize: MAX_SIZE },
    fileFilter: (_req, file, cb) => {
      if (!ALLOWED_IMAGE_MIMES.has(file.mimetype)) {
        const err = new Error('仅支持图片上传（png/jpeg/gif/webp/bmp）');
        err.code = 'UNSUPPORTED_MEDIA_TYPE';
        err.status = 415;
        return cb(err);
      }
      cb(null, true);
    },
  });

  app.post('/api/upload', (req, res) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        const code = err.code === 'LIMIT_FILE_SIZE' ? 413 : err.status || 400;
        return res.status(code).json({ error: err.message });
      }
      if (!req.file) return res.status(400).json({ error: '未收到文件' });
      res.json({ url: '/uploads/' + req.file.filename, name: req.file.originalname });
    });
  });

  app.use('/uploads', express.static(uploadDir, {
    setHeaders: (res, filePath) => {
      // 纵深防御：nosniff 阻断 MIME 混淆；inline 保证 <img src> 仍可渲染
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // fileFilter 只看客户端自报的 mimetype，攻击者可谎报 image/png 却保留 evil.html 文件名。
      // 落盘扩展名不在图片白名单内时，强制下载而非同源内联渲染。
      const ext = path.extname(filePath).toLowerCase();
      if (!ALLOWED_IMAGE_EXTS.has(ext)) {
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', 'attachment');
        return;
      }
      res.setHeader('Content-Disposition', 'inline');
    },
  }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  return app;
}
