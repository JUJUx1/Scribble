const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'], credentials: false },
  allowEIO3: true,
  pingInterval: 25000,
  pingTimeout: 20000
});

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST');
  next();
});
app.use(express.static(path.join(__dirname)));
app.get('/health', (req, res) => res.json({ ok: true, rooms: Object.keys(rooms).length }));

const rooms = {};

let WORDS = ['cat','dog','sun','car','tree','fish','bird','hat','ball','star','guitar','castle','rocket','dragon','bridge','umbrella','elephant','laptop','cactus','pirate','wizard','trophy','camera','ribbon','tunnel','blanket','puzzle','candle','orange','penguin','constellation','architecture','thermometer','encyclopedia','kaleidoscope','photosynthesis','refrigerator','sophisticated'];
try {
  const fs = require('fs');
  const raw = fs.readFileSync(path.join(__dirname, 'words.txt'), 'utf8');
  const loaded = raw.split('\n').map(w => w.trim()).filter(Boolean);
  if (loaded.length > 10) { WORDS = loaded; console.log(`Loaded ${WORDS.length} words`); }
} catch (e) { console.log('words.txt not found, using built-in words'); }

const AVATARS = ['🦊','🐸','🦁','🐼','🦄','🐬','🦋','🐢','🦉','🐙','🦀','🐧'];
const AVATAR_BG = ['#151e30','#0c2118','#221a09','#1a0c1a','#0d1a2d','#0c1a1a','#1a1500','#0a1a0a','#1a0a0a','#0a0a1a','#1a1010','#101a1a'];

function pickWords(n, pool, exclude) {
  const p = (pool && pool.length >= 3 ? pool : WORDS).filter(w => w !== exclude);
  const out = [];
  let tries = 0;
  while (out.length < n && tries < 500) {
    const w = p[Math.floor(Math.random() * p.length)];
    if (!out.includes(w)) out.push(w);
    tries++;
  }
  while (out.length < n) out.push(WORDS[Math.floor(Math.random() * WORDS.length)]);
  return out;
}

function hint(word, reveal) {
  return word.split('').map((c, i) => c === ' ' ? ' ' : i < reveal ? c : '_').join(' ');
}

function makeRoom(id, isPublic) {
  return {
    id, isPublic,
    players: [],
    phase: 'lobby',
    round: 1, maxRounds: 3, totalTime: 60, timeLeft: 60,
    word: '', drawerIdx: 0, timer: null,
    likes: {}, dislikes: {},
    customMode: false, customWordPool: [], wordsSubmitted: {},
    lastActivity: Date.now()
  };
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
    customMode: room.customMode,
    wordsSubmitted: Object.keys(room.wordsSubmitted),
    players: room.players.map(p => ({
      id: p.id, name: p.name, score: p.score,
      avatar: p.avatar, bg: p.bg, guessed: p.guessed
    }))
  };
}

function drawer(room) {
  if (!room.players.length) return null;
  return room.players[room.drawerIdx % room.players.length];
}

function lev(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

function startTimer(room) {
  clearInterval(room.timer);
  room.timeLeft = room.totalTime;
  room.timer = setInterval(() => {
    if (!rooms[room.id]) { clearInterval(room.timer); return; }
    room.timeLeft--;
    room.lastActivity = Date.now();
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
  room.likes = {}; room.dislikes = {};
  room.players.forEach(p => p.guessed = false);
  clearInterval(room.timer);
  room.lastActivity = Date.now();

  io.to(room.id).emit('clearCanvas');
  io.to(room.id).emit('state', roomInfo(room));

  const d = drawer(room);
  if (!d) return;
  const pool = room.customMode && room.customWordPool.length >= 3 ? room.customWordPool : null;
  io.to(d.id).emit('pickWord', { words: pickWords(3, pool, room.word), round: room.round, max: room.maxRounds });
  io.to(room.id).emit('sys', `${d.name} is choosing a word…`);
}

function beginRound(room, word) {
  if (!rooms[room.id]) return;
  room.word = word;
  room.phase = 'draw';
  room.lastActivity = Date.now();
  const d = drawer(room);
  if (d) io.to(d.id).emit('yourWord', word);
  room.players.forEach(p => { if (p.id !== d?.id) io.to(p.id).emit('hint', hint(word, 0)); });
  io.to(room.id).emit('state', roomInfo(room));
  io.to(room.id).emit('gameActive', { phase: 'draw' });
  startTimer(room);
}

function endRound(room) {
  if (room.phase === 'over' || room.phase === 'lobby') return;
  room.phase = 'over';
  clearInterval(room.timer);
  room.lastActivity = Date.now();

  // Apply like/dislike vote scoring to drawer
  const d = drawer(room);
  if (d) {
    const likeCount = Object.keys(room.likes).length;
    const dislikeCount = Object.keys(room.dislikes).length;
    const bonus = likeCount * 15 - dislikeCount * 10;
    d.score = Math.max(0, d.score + bonus);
  }

  const isLast = room.round >= room.maxRounds;
  const sorted = [...room.players].sort((a, b) => b.score - a.score);

  io.to(room.id).emit('roundOver', {
    word: room.word, round: room.round, max: room.maxRounds, isLast,
    scores: sorted.map(p => ({ name: p.name, score: p.score, id: p.id }))
  });

  setTimeout(() => {
    if (!rooms[room.id]) return;
    if (isLast) {
      room.round = 1; room.drawerIdx = 0;
      room.players.forEach(p => p.score = 0);
      // Keep custom word pool but reset submitted tracking
      if (!room.customMode) { room.customWordPool = []; room.wordsSubmitted = {}; }
    } else {
      room.round++;
      room.drawerIdx = (room.drawerIdx + 1) % room.players.length;
    }
    beginWordChoice(room);
  }, 7000);
}

// Clean up stale/empty rooms every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of Object.entries(rooms)) {
    if (room.players.length === 0 || now - room.lastActivity > 45 * 60 * 1000) {
      clearInterval(room.timer);
      delete rooms[id];
      console.log(`Cleaned up room ${id}`);
    }
  }
}, 5 * 60 * 1000);

io.on('connection', socket => {
  let room = null;

  function addToRoom(r, name) {
    if (r.players.find(p => p.id === socket.id)) return;
    room = r;
    const idx = r.players.length;
    r.players.push({
      id: socket.id, name, score: 0,
      avatar: AVATARS[idx % AVATARS.length],
      bg: AVATAR_BG[idx % AVATAR_BG.length],
      guessed: false
    });
    socket.join(r.id);
    r.lastActivity = Date.now();

    const inProgress = r.phase !== 'lobby';
    socket.emit('joined', { roomId: r.id, inProgress, phase: r.phase, isPublic: r.isPublic });
    io.to(r.id).emit('state', roomInfo(r));
    io.to(r.id).emit('sys', `${name} joined`);

    // Catch up late joiner
    if (r.phase === 'draw') {
      const reveal = r.timeLeft <= 20 ? 2 : r.timeLeft <= 40 ? 1 : 0;
      socket.emit('hint', hint(r.word, reveal));
      socket.emit('tick', r.timeLeft);
      socket.emit('gameActive', { phase: 'draw' });
    } else if (r.phase === 'choose') {
      socket.emit('gameActive', { phase: 'choose' });
    }

    // Auto-start public room at 2+ players
    if (r.isPublic && r.phase === 'lobby' && r.players.length >= 2) {
      beginWordChoice(r);
    }
  }

  socket.on('createRoom', ({ name }) => {
    const id = Math.random().toString(36).substr(2, 6).toUpperCase();
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

  socket.on('joinRandom', ({ name }) => {
    // Prefer lobby rooms, fall back to in-progress
    let target = Object.values(rooms).find(r => r.isPublic && r.players.length < 8 && r.phase === 'lobby');
    if (!target) target = Object.values(rooms).find(r => r.isPublic && r.players.length < 8);
    if (target) {
      addToRoom(target, name);
    } else {
      const id = Math.random().toString(36).substr(2, 6).toUpperCase();
      const r = makeRoom(id, true);
      rooms[id] = r;
      addToRoom(r, name);
    }
  });

  socket.on('startGame', () => {
    if (!room || room.phase !== 'lobby') return;
    if (room.players[0]?.id !== socket.id) return; // host only
    // Notify all players (including non-host) to transition to game screen
    io.to(room.id).emit('gameStarting');
    beginWordChoice(room);
  });

  socket.on('wordPicked', ({ word }) => {
    if (!room || room.phase !== 'choose') return;
    const d = drawer(room);
    if (!d || d.id !== socket.id) return;
    beginRound(room, word);
  });

  socket.on('draw', data => {
    if (room) {
      room.lastActivity = Date.now();
      socket.to(room.id).emit('draw', data);
    }
  });

  socket.on('clearCanvas', () => { if (room) socket.to(room.id).emit('clearCanvas'); });

  // Like/dislike voting
  socket.on('vote', ({ type }) => {
    if (!room || room.phase !== 'draw') return;
    const d = drawer(room);
    if (!d || socket.id === d.id) return; // drawer can't vote

    if (type === 'like') {
      room.likes[socket.id] = true;
      delete room.dislikes[socket.id];
    } else if (type === 'dislike') {
      room.dislikes[socket.id] = true;
      delete room.likes[socket.id];
    } else {
      delete room.likes[socket.id];
      delete room.dislikes[socket.id];
    }

    io.to(room.id).emit('voteUpdate', {
      likes: Object.keys(room.likes).length,
      dislikes: Object.keys(room.dislikes).length
    });
  });

  // Custom words mode (host only, while in lobby)
  socket.on('setCustomMode', ({ enabled }) => {
    if (!room || room.phase !== 'lobby') return;
    if (room.players[0]?.id !== socket.id) return;
    room.customMode = enabled;
    room.wordsSubmitted = {};
    room.customWordPool = [];
    io.to(room.id).emit('state', roomInfo(room));
    io.to(room.id).emit('sys', enabled ? 'Custom words mode enabled! Everyone submit your words.' : 'Custom words mode disabled.');
  });

  socket.on('submitWords', ({ words }) => {
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    const clean = words
      .map(w => w.trim().toLowerCase())
      .filter(w => w.length >= 2 && w.length <= 30);
    if (clean.length === 0) return;
    room.wordsSubmitted[socket.id] = clean;
    room.customWordPool = Object.values(room.wordsSubmitted).flat();
    io.to(room.id).emit('state', roomInfo(room));
    io.to(room.id).emit('sys', `${player.name} submitted ${clean.length} word${clean.length !== 1 ? 's' : ''}`);
  });

  socket.on('guess', ({ text }) => {
    if (!room || !text) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    const d = drawer(room);
    const isDrawer = d && d.id === socket.id;
    room.lastActivity = Date.now();

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
      const allDone = room.players.filter(p => p.id !== d?.id).every(p => p.guessed);
      if (allDone) setTimeout(() => endRound(room), 800);
    } else {
      const close = lev(g, w) === 1;
      io.to(room.id).emit('chat', { name: player.name, text: close ? text + ' (close! 🔥)' : text });
    }
  });

  socket.on('disconnect', () => {
    if (!room) return;
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx === -1) return;
    const { name } = room.players[idx];
    const wasDrawer = (room.phase === 'draw') && idx === (room.drawerIdx % room.players.length);
    room.players.splice(idx, 1);
    delete room.likes[socket.id];
    delete room.dislikes[socket.id];
    delete room.wordsSubmitted[socket.id];
    room.customWordPool = Object.values(room.wordsSubmitted).flat();

    if (room.players.length === 0) { clearInterval(room.timer); delete rooms[room.id]; return; }
    if (room.drawerIdx >= room.players.length) room.drawerIdx = 0;
    io.to(room.id).emit('sys', `${name} left`);
    io.to(room.id).emit('state', roomInfo(room));
    if (wasDrawer) endRound(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Scribble server running on :${PORT}`));
setInterval(() => {}, 30000); // keep alive
