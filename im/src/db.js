import Database from 'better-sqlite3';

export const DEFAULT_GROUP_NAME = '吹水群';

export function createDb(file = ':memory:') {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nickname TEXT UNIQUE NOT NULL,
      last_seen INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK (type IN ('dm','group')),
      name TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS chat_members (
      chat_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      PRIMARY KEY (chat_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      sender_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      msg_type TEXT NOT NULL DEFAULT 'text',
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_msg_chat_ts ON messages(chat_id, ts);
  `);
  const g = db.prepare("SELECT id FROM chats WHERE type='group' LIMIT 1").get();
  if (!g) db.prepare("INSERT INTO chats(type,name) VALUES('group',?)").run(DEFAULT_GROUP_NAME);
  return db;
}

export function createUser(db, nickname) {
  const info = db.prepare('INSERT INTO users(nickname,last_seen) VALUES(?,?)')
    .run(nickname, Date.now());
  return getUserById(db, info.lastInsertRowid);
}

export function getUserByName(db, nickname) {
  return db.prepare('SELECT * FROM users WHERE nickname=?').get(nickname);
}

export function getUserById(db, id) {
  return db.prepare('SELECT * FROM users WHERE id=?').get(id);
}

export function findOrCreateUser(db, nickname) {
  return getUserByName(db, nickname) || createUser(db, nickname);
}

export function touchUser(db, id, ts = Date.now()) {
  db.prepare('UPDATE users SET last_seen=? WHERE id=?').run(ts, id);
}

export function listUsers(db) {
  return db.prepare('SELECT * FROM users ORDER BY id').all();
}

export function createChat(db, { type, name = '' }) {
  const info = db.prepare('INSERT INTO chats(type,name) VALUES(?,?)').run(type, name);
  return getChat(db, info.lastInsertRowid);
}

export function getChat(db, id) {
  return db.prepare('SELECT * FROM chats WHERE id=?').get(id);
}

export function addMember(db, chatId, userId) {
  db.prepare('INSERT OR IGNORE INTO chat_members(chat_id,user_id) VALUES(?,?)')
    .run(chatId, userId);
}

export function isMember(db, chatId, userId) {
  return !!db.prepare('SELECT 1 FROM chat_members WHERE chat_id=? AND user_id=?')
    .get(chatId, userId);
}

export function listMembers(db, chatId) {
  return db.prepare(`SELECT u.* FROM users u JOIN chat_members m ON u.id=m.user_id
    WHERE m.chat_id=? ORDER BY u.id`).all(chatId);
}

export function listChatsForUser(db, userId) {
  return db.prepare(`SELECT c.* FROM chats c JOIN chat_members m ON c.id=m.chat_id
    WHERE m.user_id=? ORDER BY c.id`).all(userId);
}

export function insertMessage(db, { chat_id, sender_id, content, msg_type = 'text', ts = Date.now() }) {
  const info = db.prepare(
    'INSERT INTO messages(chat_id,sender_id,content,msg_type,ts) VALUES(?,?,?,?,?)')
    .run(chat_id, sender_id, content, msg_type, ts);
  return db.prepare('SELECT * FROM messages WHERE id=?').get(info.lastInsertRowid);
}

export function listMessages(db, chatId, after = 0) {
  return db.prepare('SELECT * FROM messages WHERE chat_id=? AND ts>? ORDER BY ts ASC')
    .all(chatId, after);
}
