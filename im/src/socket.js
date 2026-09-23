import {
  findOrCreateUser, getUserByName, getUserById, touchUser,
  createChat, addMember, isMember, listChatsForUser,
  insertMessage, listMessages, DEFAULT_GROUP_NAME,
} from './db.js';

export function roomOf(chatId) {
  return 'chat:' + chatId;
}

export function registerSocket(io, db) {
  io.on('connection', (socket) => {
    let uid = null;

    function broadcastPresence() {
      const ids = [...io.sockets.sockets.values()]
        .map((s) => s.data.uid).filter(Boolean);
      const online = ids.map((id) => getUserById(db, id)).filter(Boolean)
        .map((u) => ({ id: u.id, nickname: u.nickname }));
      io.emit('presence', { online });
    }

    function joinChat(chatId) {
      socket.join(roomOf(chatId));
    }

    socket.on('register', (data, ack) => {
      const name = (data?.name || '').trim();
      if (!name) return ack?.({ ok: false, error: '请输入昵称' });
      const existing = getUserByName(db, name);
      if (existing && ![...io.sockets.sockets.values()].some((s) => s.data.uid === existing.id)) {
        uid = existing.id;
      } else if (existing) {
        return ack?.({ ok: false, error: '昵称已被占用' });
      } else {
        uid = findOrCreateUser(db, name).id;
      }
      socket.data.uid = uid;
      touchUser(db, uid);

      const grp = db.prepare("SELECT * FROM chats WHERE type='group' AND name=?").get(DEFAULT_GROUP_NAME);
      if (grp) { addMember(db, grp.id, uid); joinChat(grp.id); }
      for (const c of listChatsForUser(db, uid)) joinChat(c.id);

      ack?.({ ok: true, id: uid, nickname: name });
      io.to(roomOf(grp.id)).emit('joined', { chat: grp.id, user: getUserById(db, uid) });
      broadcastPresence();
    });

    socket.on('dm', (data, ack) => {
      if (!uid) return ack?.({ ok: false, error: '未登录' });
      const peerId = Number(data?.peerId);
      if (!peerId) return ack?.({ ok: false, error: '缺少对象' });
      let chat = null;
      for (const c of listChatsForUser(db, uid)) {
        if (c.type === 'dm' && isMember(db, c.id, peerId)) { chat = c; break; }
      }
      if (!chat) {
        chat = createChat(db, { type: 'dm' });
        addMember(db, chat.id, uid);
        addMember(db, chat.id, peerId);
      }
      joinChat(chat.id);
      socket.to(roomOf(chat.id)).emit('chat-added', { chat, user: getUserById(db, uid) });
      ack?.({ ok: true, chat });
    });

    socket.on('message', (data) => {
      if (!uid) return;
      const chatId = Number(data?.chatId);
      if (!chatId || !isMember(db, chatId, uid)) return;
      const content = String(data?.content ?? '');
      const msgType = data?.msgType === 'image' ? 'image' : 'text';
      if (!content.trim() && msgType !== 'image') return;
      const msg = insertMessage(db, { chat_id: chatId, sender_id: uid, content, msg_type: msgType });
      io.to(roomOf(chatId)).emit('message', msg);
    });

    socket.on('history', (data, ack) => {
      if (!uid) return ack?.({ ok: false, error: '未登录' });
      const chatId = Number(data?.chatId);
      if (!chatId || !isMember(db, chatId, uid)) return ack?.({ ok: false, error: '无权' });
      const after = Number(data?.after) || 0;
      ack?.({ ok: true, messages: listMessages(db, chatId, after) });
    });

    socket.on('disconnect', () => { broadcastPresence(); });
  });
}
