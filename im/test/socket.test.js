import { test } from 'node:test';
import assert from 'node:assert/strict';
import { io as ioc } from 'socket.io-client';
import { makeServer } from './helpers.js';

function connect(url) {
  return ioc(url, { transports: ['websocket'], forceNew: true });
}
function once(sock, ev) {
  return new Promise((r) => sock.once(ev, r));
}

test('注册后可收发消息,并拉取历史', async () => {
  const { url, close } = await makeServer();
  const a = connect(url), b = connect(url);
  const ackA = await new Promise((r) => a.emit('register', { name: '甲' }, r));
  const ackB = await new Promise((r) => b.emit('register', { name: '乙' }, r));
  assert.equal(ackA.ok, true);
  assert.equal(ackB.ok, true);

  const dmA = await new Promise((r) => a.emit('dm', { peerId: ackB.id }, r));
  await new Promise((r) => b.emit('dm', { peerId: ackA.id }, r));
  assert.equal(dmA.ok, true);
  const chatId = dmA.chat.id;

  const got = once(b, 'message');
  a.emit('message', { chatId, content: '你好', msgType: 'text' });
  const msg = await got;
  assert.equal(msg.content, '你好');
  assert.equal(msg.sender_id, ackA.id);

  const hist = await new Promise((r) => b.emit('history', { chatId }, r));
  assert.equal(hist.ok, true);
  assert.equal(hist.messages[0].content, '你好');

  a.close(); b.close(); await close();
});

test('重名注册第二次被拒', async () => {
  const { url, close } = await makeServer();
  const a = connect(url);
  const first = await new Promise((r) => a.emit('register', { name: '独占' }, r));
  const b = connect(url);
  const dup = await new Promise((r) => b.emit('register', { name: '独占' }, r));
  assert.equal(first.ok, true);
  assert.equal(dup.ok, false);
  a.close(); b.close(); await close();
});

test('单侧发起 dm 时被动方也能实时收到 chat-added 与消息', async () => {
  const { url, close } = await makeServer();
  const a = connect(url), b = connect(url);
  const ackA = await new Promise((r) => a.emit('register', { name: '主动方' }, r));
  const ackB = await new Promise((r) => b.emit('register', { name: '被动方' }, r));
  assert.equal(ackA.ok, true);
  assert.equal(ackB.ok, true);

  // B 全程不调用 dm——先挂好监听，验证被动方在线 socket 被拉入新房间
  const added = once(b, 'chat-added');
  const dmA = await new Promise((r) => a.emit('dm', { peerId: ackB.id }, r));
  assert.equal(dmA.ok, true);
  const chatId = dmA.chat.id;

  const evt = await added;
  assert.equal(evt.chat.id, chatId);
  assert.equal(evt.user.id, ackA.id);

  const got = once(b, 'message');
  a.emit('message', { chatId, content: '在吗', msgType: 'text' });
  const msg = await got;
  assert.equal(msg.content, '在吗');
  assert.equal(msg.sender_id, ackA.id);

  a.close(); b.close(); await close();
});
