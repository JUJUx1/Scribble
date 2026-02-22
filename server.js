// Scribble Multiplayer Server
// Run: node server.js  (requires: npm install express socket.io)
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname)));

// ── State ────────────────────────────────────────────────────────
const rooms = {}; // roomId → Room

const WORDS = {
  easy:   ['cat','dog','sun','car','tree','fish','bird','hat','ball','star','bee','bus','cup','egg','fan','fly','frog','gem','ice','jet','key','map','net','owl','paw','pig','pot','ram','rat','saw','sea','sky','van','wax','web','wig','yak','zip','zoo'],
  medium: ['guitar','castle','rocket','dragon','bridge','umbrella','elephant','laptop','cactus','pirate','wizard','trophy','camera','ribbon','tunnel','blanket','puzzle','candle','orange','penguin','lantern','balloon','anchor','bottle','button','carpet','circle','cookie','donkey','faucet','forest','garden','goblin','hammer','island','jigsaw','jungle','locket','magnet','mirror','monkey','museum','needle','noodle','parrot','pencil','pepper','pickle','planet','pocket','potato','rabbit','saddle','sandal','shovel','spider','sponge','spring','square','statue','stitch','stream','stripe','sunset','switch','teapot','temple','thread','ticket','tomato','turtle','violin','wallet','walrus','window','winter','zipper'],
  hard:   ['constellation','architecture','thermometer','encyclopedia','kaleidoscope','catastrophe','hieroglyphics','extraordinary','revolutionary','perpendicular','paleontologist','electromagnetic','autobiography','chlorophyll','photosynthesis','psychological','refrigerator','rollercoaster','sophisticated','thunderstorm','uncomfortable','watermelon','xylophone']
};

const AVATARS = ['🦊','🐸','🦁','🐼','🦄','🐬','🦋','🐢','🦉','🐙','🦀','🐧'];
const AVATAR_BG = ['#151e30','#0c2118','#221a09','#1a0c1a','#0d1a2d','#0c1a1a','#1a1500','#0a1a0a','#1a0a0a','#0a0a1a','#1a1010','#101a1a'];

function randWords(n, exclude) {
  const pool = [...WORDS.easy, ...WORDS.medium, ...WORDS.hard].filter(w => w !== exclude);
  const out = [];
  while (out.length < n) {
    const w = pool[Math.floor(Math.random() * pool.length)];
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

function buildHint(word, revealCount) {
  return word.split('').map((c, i) => c === ' ' ? ' ' : i < revealCount ? c : '_').join(' ');
}

function createRoom(id) {
  return {
    id,
    players: [],
    phase: 'lobby',   // lobby | choose | draw | roundover
    round: 1,
    maxRounds: 3,
    totalTime: 60,
    timeLeft: 60,
    word: '',
    drawerIdx: 0,
    timer: null,
    isPublic: false,
    autoStartTimer: null,
  };
}

function getRoomState(room) {
  return {
    id: room.id,
    players: room.players.map(p => ({
      socketId: p.socketId,
      name: p.name,
      score: p.score,
      avatar: p.avatar,
      avatarBg: p.avatarBg,
      guessed: p.guessed,
    })),
    phase: room.phase,
    round: room.round,
    maxRounds: room.maxRounds,
    totalTime: room.totalTime,
    drawerIdx: room.drawerIdx,
    wordLength: room.word ? room.word.length : 0,
    isPublic: room.isPublic,
  };
}

function getDrawer(room) {
  return room.players[room.drawerIdx % room.players.length];
}

function startTimer(room) {
  clearInterval(room.timer);
  room.timeLeft = room.totalTime;
  room.timer = setInterval(() => {
    room.timeLeft--;
    io.to(room.id).emit('timer', { timeLeft: room.timeLeft });
    if (room.timeLeft === 40) io.to(room.id).emit('wordHint', buildHint(room.word, 1));
    if (room.timeLeft === 20) io.to(room.id).emit('wordHint', buildHint(room.word, 2));
    if (room.timeLeft <= 0) endRound(room);
  }, 1000);
}

function showWordChoice(room) {
  if (room.players.length < 1) return;
  room.phase = 'choose';
  room.word = '';
  room.players.forEach(p => p.guessed = false);
  clearInterval(room.timer);
  clearTimeout(room.autoStartTimer);

  io.to(room.id).emit('clearCanvas');

  const drawer = getDrawer(room);
  if (!drawer) return;

  const picks = randWords(3);
  io.to(drawer.socketId).emit('chooseWord', { picks, round: room.round, maxRounds: room.maxRounds });
  io.to(room.id).emit('roundStart', {
    drawerName: drawer.name,
    drawerSocketId: drawer.socketId,
    round: room.round,
    maxRounds: room.maxRounds,
    phase: 'choose',
  });
  io.to(room.id).emit('roomState', getRoomState(room));
}

function startRound(room, word) {
  room.word = word;
  room.phase = 'draw';
  const drawer = getDrawer(room);

  io.to(drawer.socketId).emit('yourWord', word);
  const hint = buildHint(word, 0);
  room.players.forEach(p => {
    if (p.socketId !== drawer.socketId) {
      io.to(p.socketId).emit('wordHint', hint);
    }
  });

  io.to(room.id).emit('phaseChange', { phase: 'draw' });
  io.to(room.id).emit('roomState', getRoomState(room));
  startTimer(room);
}

function endRound(room) {
  if (room.phase === 'roundover') return;
  room.phase = 'roundover';
  clearInterval(room.timer);

  const isLast = room.round >= room.maxRounds;
  const sorted = [...room.players].sort((a, b) => b.score - a.score);

  io.to(room.id).emit('roundOver', {
    word: room.word,
    round: room.round,
    maxRounds: room.maxRounds,
    isLast,
    scores: sorted.map(p => ({ name: p.name, score: p.score })),
  });

  setTimeout(() => {
    if (!rooms[room.id]) return;
    if (isLast) {
      room.round = 1;
      room.players.forEach(p => p.score = 0);
      room.drawerIdx = 0;
    } else {
      room.round++;
      room.drawerIdx = (room.drawerIdx + 1) % room.players.length;
    }
    showWordChoice(room);
  }, 6000);
}

function lev(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0)
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

// ── Socket.io ─────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('connected:', socket.id);
  let currentRoom = null;

  function joinRoom(room, playerName) {
    currentRoom = room;
    const idx = room.players.length;
    const player = {
      socketId: socket.id,
      name: playerName,
      score: 0,
      avatar: AVATARS[idx % AVATARS.length],
      avatarBg: AVATAR_BG[idx % AVATAR_BG.length],
      guessed: false,
    };
    room.players.push(player);
    socket.join(room.id);

    const inProgress = room.phase !== 'lobby';

    socket.emit('joined', {
      roomId: room.id,
      socketId: socket.id,
      inProgress,
      phase: room.phase,
    });

    io.to(room.id).emit('roomState', getRoomState(room));
    io.to(room.id).emit('chat', { name: '', text: `${playerName} joined the room`, type: 'system' });

    // Catch up late joiners
    if (inProgress) {
      const drawer = getDrawer(room);
      socket.emit('roundStart', {
        drawerName: drawer ? drawer.name : '?',
        drawerSocketId: drawer ? drawer.socketId : null,
        round: room.round,
        maxRounds: room.maxRounds,
        phase: room.phase,
      });

      if (room.phase === 'draw') {
        const revealCount = room.timeLeft <= 20 ? 2 : room.timeLeft <= 40 ? 1 : 0;
        socket.emit('wordHint', buildHint(room.word, revealCount));
        socket.emit('timer', { timeLeft: room.timeLeft });
        socket.emit('phaseChange', { phase: 'draw' });
      }
    }

    // Auto-start public rooms when 2nd player joins lobby
    if (room.isPublic && room.phase === 'lobby' && room.players.length >= 2) {
      clearTimeout(room.autoStartTimer);
      io.to(room.id).emit('chat', { name: '', text: 'Game starting in 3 seconds…', type: 'system' });
      room.autoStartTimer = setTimeout(() => {
        if (rooms[room.id] && room.phase === 'lobby' && room.players.length >= 2) {
          showWordChoice(room);
        }
      }, 3000);
    }
  }

  socket.on('createRoom', ({ name, isPublic }) => {
    const roomId = Math.random().toString(36).substr(2, 6).toUpperCase();
    const room = createRoom(roomId);
    room.isPublic = !!isPublic;
    rooms[roomId] = room;
    joinRoom(room, name);
  });

  socket.on('joinRoom', ({ roomId, name }) => {
    const room = rooms[roomId.toUpperCase()];
    if (!room) { socket.emit('error', 'Room not found'); return; }
    if (room.players.length >= 8) { socket.emit('error', 'Room is full'); return; }
    joinRoom(room, name);
  });

  // Join random — matches ANY active public room (lobby OR in-game)
  socket.on('joinRandom', ({ name }) => {
    // Prefer lobby rooms (so you start fresh) but fall back to in-progress
    const lobbyRoom = Object.values(rooms).find(r =>
      r.isPublic && r.players.length < 8 && r.phase === 'lobby'
    );
    const activeRoom = Object.values(rooms).find(r =>
      r.isPublic && r.players.length < 8 && r.phase !== 'lobby'
    );
    const target = lobbyRoom || activeRoom;

    if (target) {
      joinRoom(target, name);
    } else {
      // No rooms — create a fresh public lobby
      const roomId = Math.random().toString(36).substr(2, 6).toUpperCase();
      const room = createRoom(roomId);
      room.isPublic = true;
      rooms[roomId] = room;
      joinRoom(room, name);
      socket.emit('chat', { name: '', text: 'Waiting for more players to join…', type: 'system' });
    }
  });

  // Start game — only for private rooms, host only
  socket.on('startGame', () => {
    if (!currentRoom) return;
    if (currentRoom.phase !== 'lobby') return;
    if (currentRoom.players.length < 1) return;
    showWordChoice(currentRoom);
  });

  socket.on('wordChosen', ({ word }) => {
    if (!currentRoom || currentRoom.phase !== 'choose') return;
    const drawer = getDrawer(currentRoom);
    if (!drawer || drawer.socketId !== socket.id) return;
    startRound(currentRoom, word);
  });

  socket.on('draw', data => {
    if (!currentRoom) return;
    socket.to(currentRoom.id).emit('draw', data);
  });

  socket.on('clearCanvas', () => {
    if (!currentRoom) return;
    socket.to(currentRoom.id).emit('clearCanvas');
  });

  socket.on('guess', ({ text }) => {
    if (!currentRoom || !text) return;
    const room = currentRoom;
    const player = room.players.find(p => p.socketId === socket.id);
    if (!player) return;

    const drawer = getDrawer(room);
    const isDrawer = drawer && drawer.socketId === socket.id;

    if (room.phase !== 'draw' || isDrawer || player.guessed) {
      io.to(room.id).emit('chat', { name: player.name, text, type: '' });
      return;
    }

    const g = text.toLowerCase().trim();
    const w = room.word.toLowerCase();

    if (g === w) {
      player.guessed = true;
      const pts = 100 + Math.round(room.timeLeft * 6) + (room.maxRounds + 1 - room.round) * 15;
      player.score += pts;

      io.to(room.id).emit('correct', { name: player.name, pts });

      if (drawer) {
        drawer.score += 50;
      }
      io.to(room.id).emit('roomState', getRoomState(room));

      const allGuessed = room.players.filter(p => p.socketId !== drawer?.socketId).every(p => p.guessed);
      if (allGuessed) setTimeout(() => endRound(room), 800);
    } else {
      const d = lev(g, w);
      io.to(room.id).emit('chat', { name: player.name, text: d === 1 ? text + ' (close! 🔥)' : text, type: '' });
    }
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const room = currentRoom;
    const idx = room.players.findIndex(p => p.socketId === socket.id);
    if (idx === -1) return;
    const name = room.players[idx].name;
    const wasDrawer = room.phase === 'draw' && idx === room.drawerIdx % room.players.length;
    room.players.splice(idx, 1);

    if (room.players.length === 0) {
      clearInterval(room.timer);
      clearTimeout(room.autoStartTimer);
      delete rooms[room.id];
      return;
    }

    if (room.drawerIdx >= room.players.length) room.drawerIdx = 0;

    io.to(room.id).emit('chat', { name: '', text: `${name} left the room`, type: 'system' });
    io.to(room.id).emit('roomState', getRoomState(room));

    if (wasDrawer) {
      io.to(room.id).emit('chat', { name: '', text: 'Drawer left! Skipping round…', type: 'system' });
      endRound(room);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Scribble server running at http://localhost:${PORT}`);
  setInterval(() => {}, 1000 * 60 * 10);
});

app.get('/health', (req, res) => res.json({ status: 'ok', rooms: Object.keys(rooms).length }));
