const $ = (id) => document.getElementById(id);
let socket = null;
let me = null;
const chats = new Map();
let current = null;

$('enter').onclick = login;
$('nick').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });

async function login() {
  const name = $('nick').value.trim();
  if (!name) return;
  const r = await fetch('/api/login?name=' + encodeURIComponent(name));
  if (!r.ok) { $('loginErr').textContent = (await r.json()).error || '登录失败'; return; }
  me = await r.json();
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('me').textContent = '我:' + me.nickname;
  connect();
}

function connect() {
  socket = io();
  socket.on('connect', () => socket.emit('register', { name: me.nickname }, (res) => {
    if (!res.ok) { alert('昵称被占用:' + res.error); location.reload(); return; }
  }));
  socket.on('presence', renderPeople);
  socket.on('message', onMessage);
  // 服务端 register 后会向默认群房间广播 joined,自己也在房间内 → 首屏即出现默认群
  socket.on('joined', (d) => { addChat(d.chat); if (!current) openChat(d.chat.id); });
  socket.on('chat-added', (d) => { addChat(d.chat); });
  socket.on('disconnect', () => $('chatTitle').textContent = '连接断开,重连中…');
}

function addChat(chat) {
  if (chat && !chats.has(chat.id)) { chats.set(chat.id, { ...chat, unread: 0 }); renderChats(); }
}

function renderPeople(p) {
  const ul = $('people'); ul.innerHTML = '';
  for (const u of p.online) {
    if (me && u.id === me.id) continue;
    const li = document.createElement('li');
    li.textContent = u.nickname;
    li.onclick = () => socket.emit('dm', { peerId: u.id }, (res) => {
      if (res.ok) { addChat(res.chat); openChat(res.chat.id); }
    });
    ul.appendChild(li);
  }
}

function renderChats() {
  const ul = $('chats'); ul.innerHTML = '';
  for (const c of chats.values()) {
    const li = document.createElement('li');
    li.textContent = (c.name || '私聊') + (c.unread ? ` (${c.unread})` : '');
    li.className = current === c.id ? 'active' : '';
    li.onclick = () => openChat(c.id);
    ul.appendChild(li);
  }
}

function openChat(id) {
  current = id;
  const c = chats.get(id);
  if (c) c.unread = 0;
  $('chatTitle').textContent = c ? (c.name || '私聊') : '';
  $('msgs').innerHTML = '';
  socket.emit('history', { chatId: id }, (res) => {
    if (res.ok) { res.messages.forEach(addBubble); renderChats(); }
  });
}

function onMessage(m) {
  addChat({ id: m.chat_id, type: 'dm', name: '' });
  if (m.chat_id === current) { addBubble(m); }
  else { const c = chats.get(m.chat_id); if (c) { c.unread++; renderChats(); } }
}

function addBubble(m) {
  const box = $('msgs');
  const div = document.createElement('div');
  div.className = 'msg' + (me && m.sender_id === me.id ? ' mine' : '');
  const who = document.createElement('div'); who.className = 'who';
  who.textContent = (m.sender_id === me?.id) ? '我' : ('#' + m.sender_id);
  const bubble = document.createElement('div'); bubble.className = 'bubble';
  if (m.msg_type === 'image') { const img = document.createElement('img'); img.src = m.content; bubble.appendChild(img); }
  else bubble.textContent = m.content;
  div.append(who, bubble);
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

$('send').onclick = sendText;
$('input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendText(); });
function sendText() {
  const v = $('input').value.trim();
  if (!v || !current) return;
  socket.emit('message', { chatId: current, content: v, msgType: 'text' });
  $('input').value = '';
}

$('imgBtn').onclick = () => $('file').click();
$('file').onchange = async (e) => {
  const f = e.target.files[0]; if (!f || !current) return;
  const fd = new FormData(); fd.append('file', f);
  const r = await fetch('/api/upload', { method: 'POST', body: fd });
  if (!r.ok) { alert('图片过大或上传失败'); return; }
  const { url } = await r.json();
  socket.emit('message', { chatId: current, content: url, msgType: 'image' });
  e.target.value = '';
};
