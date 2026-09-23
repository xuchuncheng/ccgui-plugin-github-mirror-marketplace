import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDb, createUser, getUserByName, findOrCreateUser,
  createChat, addMember, isMember, listChatsForUser,
  insertMessage, listMessages, DEFAULT_GROUP_NAME,
} from '../src/db.js';

test('createDb 建表并自动创建默认群', () => {
  const db = createDb(':memory:');
  const row = db.prepare("SELECT name FROM chats WHERE type='group'").get();
  assert.equal(row.name, DEFAULT_GROUP_NAME);
});

test('createUser 写入昵称并可查回', () => {
  const db = createDb(':memory:');
  const u = createUser(db, '阿强');
  assert.ok(u.id > 0);
  assert.equal(getUserByName(db, '阿强').nickname, '阿强');
});

test('昵称唯一,重复创建抛错', () => {
  const db = createDb(':memory:');
  createUser(db, '小明');
  assert.throws(() => createUser(db, '小明'));
});

test('findOrCreateUser 幂等', () => {
  const db = createDb(':memory:');
  const a = findOrCreateUser(db, '老王');
  const b = findOrCreateUser(db, '老王');
  assert.equal(a.id, b.id);
});

test('群成员关系与按用户列群', () => {
  const db = createDb(':memory:');
  const u = createUser(db, '张三');
  const c = createChat(db, { type: 'group', name: '测试群' });
  addMember(db, c.id, u.id);
  assert.equal(isMember(db, c.id, u.id), true);
  assert.equal(isMember(db, c.id, 999), false);
  assert.ok(listChatsForUser(db, u.id).some((x) => x.id === c.id));
});

test('insertMessage + listMessages 按时间升序、支持 after', () => {
  const db = createDb(':memory:');
  const u = createUser(db, '李四');
  const c = createChat(db, { type: 'dm' });
  insertMessage(db, { chat_id: c.id, sender_id: u.id, content: '第一条', ts: 100 });
  insertMessage(db, { chat_id: c.id, sender_id: u.id, content: '第二条', ts: 200 });
  const all = listMessages(db, c.id);
  assert.deepEqual(all.map((m) => m.content), ['第一条', '第二条']);
  const after = listMessages(db, c.id, 150);
  assert.deepEqual(after.map((m) => m.content), ['第二条']);
});
