# 🏏 Superstar Cricket Cards — Multiplayer

A real-time 2-player cricket trump card game built with Node.js + Socket.io.

---

## Quick Start (Local)

```bash
npm install
node server.js
```

Open **http://localhost:3000** in two browser tabs to test locally.

---

## Project Structure

```
superstar-cricket-cards/
├── server.js          ← Node.js + Socket.io game server
├── package.json
├── public/
│   └── index.html     ← Full game client (single file)
└── README.md
```

---

## How to Play

1. Both players open the game URL
2. Enter your name
3. **Quick Match** — auto-match with a random opponent
4. **Create Room** — get a 4-letter code to share with a friend
5. **Join with Code** — enter the code your friend shared
6. Player 1 picks a stat each round; Player 2 sees the reveal
7. Most points after 10 rounds wins!

---

## Deploy to Railway (Recommended — Free Tier)

1. Push this folder to a GitHub repo
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Select your repo
4. Railway auto-detects Node.js and runs `npm start`
5. Click **Generate Domain** to get a public URL
6. Share the URL with your friend!

---

## Deploy to Render (Free Tier)

1. Push to GitHub
2. Go to [render.com](https://render.com) → New Web Service
3. Connect your GitHub repo
4. **Build Command:** `npm install`
5. **Start Command:** `node server.js`
6. Deploy — get a public `.onrender.com` URL

---

## Deploy to Fly.io

```bash
npm install -g flyctl
fly auth login
fly launch
fly deploy
```

---

## Deploy to VPS / DigitalOcean

```bash
git clone <your-repo>
cd superstar-cricket-cards
npm install
# Install PM2 for process management
npm install -g pm2
pm2 start server.js --name cricket-cards
pm2 save
```

Then point nginx to port 3000.

---

## Environment Variables

| Variable | Default | Description          |
|----------|---------|----------------------|
| `PORT`   | `3000`  | Server port          |

---

## Adding More Cards / Formats

- **ODI Cards:** Edit `ODI_CARDS` array in `server.js` (same structure in `public/index.html`)
- **Test/T20I/IPL:** Add `TEST_CARDS`, `T20I_CARDS`, `IPL_CARDS` arrays in both files
- **Stats note:** Replace placeholder stats with verified data from ESPNcricinfo Statsguru

---

## Game Architecture

```
Browser (P1) ←──────────────────────────→ Browser (P2)
               Socket.io events
               via Node.js server

Events:
  room:create / room:join       → Room management
  matchmaking:join              → Auto-matchmaking
  game:start                    → Deal cards, start match
  round:start                   → Show current round cards
  round:pick    (P1 only)       → P1 chooses a stat
  round:result                  → Both see comparison + result
  round:next    (both ack)      → Advance to next round
  game:over                     → Final scores
  game:opponentDisconnected     → Handle disconnects
  game:playAgain                → Rematch request
```
