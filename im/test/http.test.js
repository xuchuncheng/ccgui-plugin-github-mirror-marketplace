import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createDb } from '../src/db.js';
import { createApp } from '../src/http.js';
import { tmpDir } from './helpers.js';

function app() {
  return createApp({ db: createDb(':memory:'), uploadDir: tmpDir() });
}

test('GET /api/login 建档并返回用户', async () => {
  const res = await request(app()).get('/api/login?name=阿强').expect(200);
  assert.equal(res.body.nickname, '阿强');
  assert.ok(res.body.id > 0);
});

test('GET /api/login 缺 name 返回 400', async () => {
  await request(app()).get('/api/login').expect(400);
});

test('POST /api/upload 保存图片并返回可访问 URL', async () => {
  const a = app();
  const res = await request(a)
    .post('/api/upload')
    .attach('file', Buffer.from('fake-image-bytes'), {
      filename: 'pic.png',
      contentType: 'image/png',
    })
    .expect(200);
  assert.match(res.body.url, /^\/uploads\/.+\.png$/);
  const got = await request(a).get(res.body.url).expect(200);
  assert.equal(got.headers['x-content-type-options'], 'nosniff');
  assert.equal(got.headers['content-disposition'], 'inline');
});

test('POST /api/upload 非图片（text/html）返回 415', async () => {
  const a = app();
  const res = await request(a)
    .post('/api/upload')
    .attach('file', Buffer.from('<script>alert(1)</script>'), {
      filename: 'evil.html',
      contentType: 'text/html',
    })
    .expect(415);
  assert.ok(res.body.error);
});

test('POST /api/upload 超过 5MB 返回 413', async () => {
  const a = app();
  const res = await request(a)
    .post('/api/upload')
    .attach('file', Buffer.alloc(5 * 1024 * 1024 + 1024), {
      filename: 'big.png',
      contentType: 'image/png',
    })
    .expect(413);
  assert.ok(res.body.error);
});

test('纵深防御:谎报 image/png 的 .html 落盘后被强制下载,绝不内联渲染', async () => {
  const a = app();
  // 绕过 fileFilter 的唯一途径是谎报 mimetype;此时扩展名白名单兜底为 attachment
  const res = await request(a)
    .post('/api/upload')
    .attach('file', Buffer.from('<script>alert(1)</script>'), {
      filename: 'evil.html',
      contentType: 'image/png',
    })
    .expect(200);
  const got = await request(a).get(res.body.url).expect(200);
  assert.equal(got.headers['content-type'], 'application/octet-stream');
  assert.match(got.headers['content-disposition'], /attachment/);
  assert.equal(got.headers['x-content-type-options'], 'nosniff');
});
