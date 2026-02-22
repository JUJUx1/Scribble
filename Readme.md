# Scribble Multiplayer

Real-time multiplayer draw-and-guess. Node.js + Socket.io.

## Deploy to Render (free)

### Option A — One-click (recommended)
1. Push all 4 files to GitHub
2. Render dashboard → New → Blueprint → connect repo
3. Render reads render.yaml automatically → Deploy

### Option B — Manual
1. Render dashboard → New → Web Service → connect repo
2. Environment: Node | Build: `npm install` | Start: `node server.js` | Plan: Free
3. Deploy → get your URL

## Run locally
```
npm install
npm start
# Open http://localhost:3000
```

## Note
Free tier sleeps after 15min idle — first load after sleep takes ~30s.
