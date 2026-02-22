const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: false
  },
  allowEIO3: true
});

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST');
  next();
});
app.use(express.static(path.join(__dirname)));
app.get('/health', (req, res) => res.json({ ok: true, rooms: Object.keys(rooms).length }));

const rooms = {};

const WORDS = [
  'cat','dog','sun','car','tree','fish','bird','hat','ball','star','bee','bus','cup','egg','fan','frog','ice','jet','key','map','owl','paw','pig','saw','sea','sky','van','web','zip','zoo',
  'guitar','castle','rocket','dragon','bridge','umbrella','elephant','laptop','cactus','pirate','wizard','trophy','camera','ribbon','tunnel','blanket','puzzle','candle','orange','penguin','lantern','balloon','anchor','bottle','button','carpet','cookie','donkey','forest','garden','hammer','island','jigsaw','jungle','magnet','mirror','monkey','museum','needle','noodle','parrot','pencil','pepper','pickle','planet','pocket','potato','rabbit','saddle','sandal','shovel','spider','sponge','spring','square','statue','stream','sunset','switch','teapot','temple','thread','ticket','tomato','turtle','violin','wallet','walrus','window','zipper',
  'constellation','architecture','thermometer','encyclopedia','kaleidoscope','catastrophe','extraordinary','revolutionary','autobiography','photosynthesis','refrigerator','rollercoaster','sophisticated','thunderstorm','xylophone'
];

const AVATARS = ['🦊','🐸','🦁','🐼','🦄','🐬','🦋','🐢','🦉','🐙','🦀','🐧'];
const AVATAR_BG = ['#151e30','#0c2118','#221a09','#1a0c1a','#0d1a2d','#0c1a1a','#1a1500','#0a1a0a','#1a0a0a','#0a0a1a','#1a1010','#101a1a'];

function pickWords(n, exclude) {
  const pool = WORDS.filter(w => w !== exclude);
  const out = [];
  while (out.length < n) {
    const w = pool[Math.floor(Math.random() * pool.length)];
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

function hint(word, reveal) {
  return word.split('').map((c, i) => c === ' ' ? ' ' : i < reveal ? c : '_').join(' ');
}

function makeRoom(id, isPublic) {
  return { id, isPublic, players: [], phase: 'lobby', round: 1, maxRounds: 3, totalTime: 60, timeLeft: 60, word: '', drawerIdx: 0, timer: null };
}

function roomInfo(room) {
  return {
    id: room.id,
    isPublic: room.isPublic,
    phase: room.phase,
    round: room.round,
    maxRounds: room.maxRounds,
    totalTime: room.totalTime,
    drawerIdx: room.drawerIdx,
    players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score, avatar: p.avatar, bg: p.bg, guessed: p.guessed })),
  };
}

function drawer(room) {
  return room.players[room.drawerIdx % Math.max(room.players.length, 1)];
}

function lev(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({length:m+1},(_,i)=>Array.from({length:n+1},(_,j)=>i===0?j:j===0?i:0));
  for (let i=1;i<=m;i++) for (let j=1;j<=n;j++) dp[i][j]=a[i-1]===b[j-1]?dp[i-1][j-1]:1+Math.min(dp[i-1][j],dp[i][j-1],dp[i-1][j-1]);
  return dp[m][n];
}

function startTimer(room) {
  clearInterval(room.timer);
  room.timeLeft = room.totalTime;
  room.timer = setInterval(() => {
    room.timeLeft--;
    io.to(room.id).emit('tick', room.timeLeft);
    if (room.timeLeft === 40) io.to(room.id).emit('hint', hint(room.word, 1));
    if (room.timeLeft === 20) io.to(room.id).emit('hint', hint(room.word, 2));
    if (room.timeLeft <= 0) endRound(room);
  }, 1000);
}

function beginWordChoice(room) {
  if (!rooms[room.id] || room.players.length === 0) return;
  room.phase = 'choose';
  room.word = '';
  room.players.forEach(p => p.guessed = false);
  clearInterval(room.timer);
  io.to(room.id).emit('clearCanvas');

  const d = drawer(room);
  io.to(d.id).emit('pickWord', { words: pickWords(3), round: room.round, max: room.maxRounds });
  io.to(room.id).emit('state', roomInfo(room));
  io.to(room.id).emit('sys', `${d.name} is choosing a word…`);
}

function beginRound(room, word) {
  room.word = word;
  room.phase = 'draw';
  const d = drawer(room);
  io.to(d.id).emit('yourWord', word);
  room.players.forEach(p => { if (p.id !== d.id) io.to(p.id).emit('hint', hint(word, 0)); });
  io.to(room.id).emit('state', roomInfo(room));
  startTimer(room);
}

function endRound(room) {
  if (room.phase === 'over') return;
  room.phase = 'over';
  clearInterval(room.timer);
  const isLast = room.round >= room.maxRounds;
  const sorted = [...room.players].sort((a,b) => b.score - a.score);
  io.to(room.id).emit('roundOver', { word: room.word, round: room.round, max: room.maxRounds, isLast, scores: sorted.map(p=>({name:p.name,score:p.score})) });
  setTimeout(() => {
    if (!rooms[room.id]) return;
    if (isLast) { room.round=1; room.drawerIdx=0; room.players.forEach(p=>p.score=0); }
    else { room.round++; room.drawerIdx=(room.drawerIdx+1)%room.players.length; }
    beginWordChoice(room);
  }, 6000);
}

// ── Socket ────────────────────────────────────────────────────────
io.on('connection', socket => {
  let room = null;

  function addToRoom(r, name) {
    // Prevent duplicate: if socket already in room, do nothing
    if (r.players.find(p => p.id === socket.id)) return;

    room = r;
    const idx = r.players.length;
    r.players.push({ id: socket.id, name, score: 0, avatar: AVATARS[idx%AVATARS.length], bg: AVATAR_BG[idx%AVATAR_BG.length], guessed: false });
    socket.join(r.id);

    const inProgress = r.phase !== 'lobby';
    socket.emit('joined', { roomId: r.id, inProgress, phase: r.phase, isPublic: r.isPublic });
    io.to(r.id).emit('state', roomInfo(r));
    io.to(r.id).emit('sys', `${name} joined`);

    // Catch up late joiner mid-round
    if (r.phase === 'draw') {
      const reveal = r.timeLeft <= 20 ? 2 : r.timeLeft <= 40 ? 1 : 0;
      socket.emit('hint', hint(r.word, reveal));
      socket.emit('tick', r.timeLeft);
      // Signal client to clear overlay and show canvas
      socket.emit('gameActive', { phase: 'draw' });
    } else if (r.phase === 'choose') {
      socket.emit('gameActive', { phase: 'choose' });
    }

    // Auto-start public room the moment 2 players are in
    if (r.isPublic && r.phase === 'lobby' && r.players.length >= 2) {
      beginWordChoice(r);
    }
  }

  socket.on('createRoom', ({ name }) => {
    const id = Math.random().toString(36).substr(2,6).toUpperCase();
    const r = makeRoom(id, false);
    rooms[id] = r;
    addToRoom(r, name);
  });

  socket.on('joinRoom', ({ roomId, name }) => {
    const r = rooms[roomId.toUpperCase()];
    if (!r) return socket.emit('err', 'Room not found');
    if (r.players.length >= 8) return socket.emit('err', 'Room is full');
    addToRoom(r, name);
  });

  // Random: join ANY public room (lobby or in-game), else create one
  socket.on('joinRandom', ({ name }) => {
    const existing = Object.values(rooms).find(r => r.isPublic && r.players.length < 8);
    if (existing) {
      addToRoom(existing, name);
    } else {
      const id = Math.random().toString(36).substr(2,6).toUpperCase();
      const r = makeRoom(id, true);
      rooms[id] = r;
      addToRoom(r, name);
    }
  });

  socket.on('startGame', () => {
    if (!room || room.phase !== 'lobby') return;
    beginWordChoice(room);
  });

  socket.on('wordPicked', ({ word }) => {
    if (!room || room.phase !== 'choose') return;
    const d = drawer(room);
    if (!d || d.id !== socket.id) return;
    beginRound(room, word);
  });

  socket.on('draw', data => { if (room) socket.to(room.id).emit('draw', data); });
  socket.on('clearCanvas', () => { if (room) socket.to(room.id).emit('clearCanvas'); });

  socket.on('guess', ({ text }) => {
    if (!room || !text) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    const d = drawer(room);
    const isDrawer = d && d.id === socket.id;

    if (room.phase !== 'draw' || isDrawer || player.guessed) {
      io.to(room.id).emit('chat', { name: player.name, text });
      return;
    }

    const g = text.toLowerCase().trim(), w = room.word.toLowerCase();
    if (g === w) {
      player.guessed = true;
      const pts = 100 + Math.round(room.timeLeft * 6) + (room.maxRounds + 1 - room.round) * 15;
      player.score += pts;
      if (d) d.score += 50;
      io.to(room.id).emit('correct', { name: player.name, pts });
      io.to(room.id).emit('state', roomInfo(room));
      const allDone = room.players.filter(p=>p.id!==d?.id).every(p=>p.guessed);
      if (allDone) setTimeout(() => endRound(room), 800);
    } else {
      const close = lev(g, w) === 1;
      io.to(room.id).emit('chat', { name: player.name, text: close ? text+' (close! 🔥)' : text });
    }
  });

  socket.on('disconnect', () => {
    if (!room) return;
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx === -1) return;
    const { name } = room.players[idx];
    const wasDrawer = room.phase === 'draw' && idx === room.drawerIdx % room.players.length;
    room.players.splice(idx, 1);
    if (room.players.length === 0) { clearInterval(room.timer); delete rooms[room.id]; return; }
    if (room.drawerIdx >= room.players.length) room.drawerIdx = 0;
    io.to(room.id).emit('sys', `${name} left`);
    io.to(room.id).emit('state', roomInfo(room));
    if (wasDrawer) endRound(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Running on :${PORT}`));
setInterval(() => {}, 60000);
