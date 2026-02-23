const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*", // In production, set this to your GitHub Pages URL
    methods: ["GET", "POST"],
  },
});

app.use(cors());

app.get("/", (req, res) => {
  res.send("Voice Call Signaling Server is running ✅");
});

// Track rooms: roomId -> [socketId, socketId]
const rooms = {};

io.on("connection", (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // --- Join a room ---
  socket.on("join-room", (roomId) => {
    if (!rooms[roomId]) rooms[roomId] = [];

    const room = rooms[roomId];

    if (room.length >= 2) {
      socket.emit("room-full");
      return;
    }

    room.push(socket.id);
    socket.join(roomId);
    socket.data.roomId = roomId;

    console.log(`[Room ${roomId}] ${socket.id} joined. Users: ${room.length}`);

    if (room.length === 2) {
      // Tell both users the call can start; caller is the first person in the room
      const [caller, callee] = room;
      io.to(caller).emit("ready", { initiator: true });
      io.to(callee).emit("ready", { initiator: false });
      console.log(`[Room ${roomId}] Call starting between ${caller} and ${callee}`);
    } else {
      socket.emit("waiting"); // Waiting for the other person
    }
  });

  // --- WebRTC Signaling relay ---
  socket.on("offer", ({ offer, roomId }) => {
    socket.to(roomId).emit("offer", { offer });
  });

  socket.on("answer", ({ answer, roomId }) => {
    socket.to(roomId).emit("answer", { answer });
  });

  socket.on("ice-candidate", ({ candidate, roomId }) => {
    socket.to(roomId).emit("ice-candidate", { candidate });
  });

  // --- Hang up ---
  socket.on("hang-up", ({ roomId }) => {
    socket.to(roomId).emit("hang-up");
    console.log(`[Room ${roomId}] Hang up by ${socket.id}`);
  });

  // --- Voice signaling (used by Scribble + any other app) ---
  // Join a named voice room (keyed by game room ID)
  socket.on('voice:room', ({ roomId }) => {
    // Leave any previous voice room
    if (socket.data.voiceRoom) socket.leave(socket.data.voiceRoom);
    socket.data.voiceRoom = roomId;
    socket.join(roomId);
    console.log(`[Voice] ${socket.id.slice(0,6)} joined voice room ${roomId}`);
  });

  socket.on('voice:join', () => {
    const r = socket.data.voiceRoom || socket.data.roomId;
    if (r) socket.to(r).emit('voice:joined', { id: socket.id });
  });

  socket.on('voice:leave', () => {
    const r = socket.data.voiceRoom || socket.data.roomId;
    if (r) socket.to(r).emit('voice:left', { id: socket.id });
  });

  socket.on('voice:offer', ({ to, offer }) => {
    io.to(to).emit('voice:offer', { from: socket.id, offer });
  });

  socket.on('voice:answer', ({ to, answer }) => {
    io.to(to).emit('voice:answer', { from: socket.id, answer });
  });

  socket.on('voice:ice', ({ to, candidate }) => {
    io.to(to).emit('voice:ice', { from: socket.id, candidate });
  });

  socket.on('voice:speaking', ({ speaking }) => {
    const r = socket.data.voiceRoom || socket.data.roomId;
    if (r) socket.to(r).emit('voice:speaking', { id: socket.id, speaking });
  });

  // --- Disconnect ---
  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (roomId && rooms[roomId]) {
      rooms[roomId] = rooms[roomId].filter((id) => id !== socket.id);
      socket.to(roomId).emit("hang-up"); // Notify the other person
      if (rooms[roomId].length === 0) {
        delete rooms[roomId];
        console.log(`[Room ${roomId}] Deleted (empty)`);
      }
    }
    console.log(`[-] Disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
});
