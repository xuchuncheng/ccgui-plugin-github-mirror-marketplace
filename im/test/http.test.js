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
    .attach('file', Buffer.from('fake-image-bytes'), 'pic.png')
    .expect(200);
  assert.match(res.body.url, /^\/uploads\/.+\.png$/);
  await request(a).get(res.body.url).expect(200);
});
