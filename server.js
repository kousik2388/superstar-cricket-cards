// ═══════════════════════════════════════════════════════════════════════════════
// SUPERSTAR CRICKET CARDS — Multiplayer Server
// ═══════════════════════════════════════════════════════════════════════════════
// SETUP:
//   npm install
//   node server.js
//
// DEPLOY:
//   Railway:  push repo, set start command to "node server.js"
//   Render:   new Web Service, build "npm install", start "node server.js"
//   Fly.io:   fly launch, fly deploy
//   Local:    node server.js  →  open http://localhost:3000
//
// ENV VARS (optional):
//   PORT=3000   (default 3000)
// ═══════════════════════════════════════════════════════════════════════════════

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 10000,
  pingInterval: 5000
});

const PORT = process.env.PORT || 3000;

// Serve the game client
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── GAME CONSTANTS ────────────────────────────────────────────────────────────
const TOTAL_ROUNDS     = 10;
const CARDS_PER_PLAYER = 10;
const RECONNECT_GRACE  = 0; // ms — we declare winner immediately on disconnect

// ── IN-MEMORY STATE ───────────────────────────────────────────────────────────
// rooms: { [roomCode]: Room }
// matchmakingQueue: Socket[]
const rooms           = {};
const matchmakingQueue = [];
// socketToRoom: { [socketId]: roomCode }
const socketToRoom    = {};

// ── HELPERS ───────────────────────────────────────────────────────────────────
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms[code]);
  return code;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function dealHands(deck) {
  const shuffled = shuffle(deck);
  return {
    hand1: shuffled.slice(0, CARDS_PER_PLAYER),
    hand2: shuffled.slice(CARDS_PER_PLAYER, CARDS_PER_PLAYER * 2)
  };
}

// ── COMPARISON ENGINE (mirrors client logic) ──────────────────────────────────
const STAT_CONFIG = {
  matches:      { lowerBetter: false },
  runs:         { lowerBetter: false },
  fours:        { lowerBetter: false },
  sixes:        { lowerBetter: false },
  fifties:      { lowerBetter: false },
  hundreds:     { lowerBetter: false },
  highestScore: { lowerBetter: false },
  strikeRate:   { lowerBetter: false },
  bestBowling:  { special: true },
  economyRate:  { lowerBetter: true  },
  wickets:      { lowerBetter: false },
  catches:      { lowerBetter: false },
  stumpings:    { lowerBetter: false },
};

function compareStats(card1, card2, statKey) {
  if (statKey === 'bestBowling') {
    const w1 = card1.bestBowlingWickets, w2 = card2.bestBowlingWickets;
    const r1 = card1.bestBowlingRuns,    r2 = card2.bestBowlingRuns;
    if (w1 > w2) return 'p1';
    if (w2 > w1) return 'p2';
    if (r1 < r2) return 'p1';
    if (r2 < r1) return 'p2';
    return 'draw';
  }
  const cfg = STAT_CONFIG[statKey];
  const v1 = parseFloat(card1[statKey]) || 0;
  const v2 = parseFloat(card2[statKey]) || 0;
  if (v1 === v2) return 'draw';
  if (cfg.lowerBetter) {
    if (v1 === 0) return 'p2';
    if (v2 === 0) return 'p1';
    return v1 < v2 ? 'p1' : 'p2';
  }
  return v1 > v2 ? 'p1' : 'p2';
}

// ── ROOM FACTORY ──────────────────────────────────────────────────────────────
function createRoom(code, format = 'ODI') {
  return {
    code,
    format,
    players: [],        // [{ socketId, name, score }]
    hands: {},          // { socketId: Card[] }
    round: 0,
    roundStat: null,    // stat chosen this round
    p1Ready: false,     // both must receive deal before round starts
    p2Ready: false,
    started: false,
    finished: false,
  };
}

function startGame(room) {
  room.started = true;
  room.round   = 0;

  // Import deck from module-level ODI_CARDS (loaded at bottom of file)
  const deck = ODI_CARDS;
  const { hand1, hand2 } = dealHands(deck);

  room.hands[room.players[0].socketId] = hand1;
  room.hands[room.players[1].socketId] = hand2;

  // Tell each player their own hand (not the opponent's)
  const [p1, p2] = room.players;

  io.to(p1.socketId).emit('game:start', {
    yourHand:      hand1,
    opponentName:  p2.name,
    yourIndex:     0,      // p1 always picks first
    totalRounds:   TOTAL_ROUNDS,
    format:        room.format,
  });
  io.to(p2.socketId).emit('game:start', {
    yourHand:      hand2,
    opponentName:  p1.name,
    yourIndex:     1,
    totalRounds:   TOTAL_ROUNDS,
    format:        room.format,
  });

  emitRound(room);
}

function emitRound(room) {
  const r = room.round;
  room.roundStat = null;

  const [p1, p2] = room.players;
  const p1Card   = room.hands[p1.socketId][r];
  const p2Card   = room.hands[p2.socketId][r];

  // p1 gets their card + is told to pick
  io.to(p1.socketId).emit('round:start', {
    round:      r,
    yourCard:   p1Card,
    canPick:    true,
  });
  // p2 gets their card + waits
  io.to(p2.socketId).emit('round:start', {
    round:      r,
    yourCard:   p2Card,
    canPick:    false,
  });
}

function resolveRound(room, statKey) {
  const r    = room.round;
  const [p1, p2] = room.players;
  const p1Card   = room.hands[p1.socketId][r];
  const p2Card   = room.hands[p2.socketId][r];

  const winner = compareStats(p1Card, p2Card, statKey);

  if (winner === 'p1') p1.score++;
  else if (winner === 'p2') p2.score++;

  const payload = {
    round:      r,
    statKey,
    p1Card,
    p2Card,
    winner,           // 'p1' | 'p2' | 'draw'
    scores: { p1: p1.score, p2: p2.score },
    isLastRound: r + 1 >= TOTAL_ROUNDS,
  };

  io.to(p1.socketId).emit('round:result', { ...payload, youAre: 'p1' });
  io.to(p2.socketId).emit('round:result', { ...payload, youAre: 'p2' });
}

function endGame(room, reason = 'normal') {
  if (room.finished) return;
  room.finished = true;

  const [p1, p2] = room.players;
  let matchWinner;
  if (p1.score > p2.score)      matchWinner = 'p1';
  else if (p2.score > p1.score) matchWinner = 'p2';
  else                          matchWinner = 'draw';

  const payload = {
    reason,
    scores: { p1: p1.score, p2: p2.score },
    matchWinner,
    p1Name: p1.name,
    p2Name: p2.name,
  };

  if (p1) io.to(p1.socketId).emit('game:over', { ...payload, youAre: 'p1' });
  if (p2) io.to(p2.socketId).emit('game:over', { ...payload, youAre: 'p2' });

  // Clean up after a short delay
  setTimeout(() => { delete rooms[room.code]; }, 30000);
}

// ── SOCKET HANDLERS ───────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] ${socket.id} connected`);

  // ── CREATE ROOM ──
  socket.on('room:create', ({ playerName, format = 'ODI' }) => {
    const code = generateRoomCode();
    const room = createRoom(code, format);
    rooms[code] = room;

    room.players.push({ socketId: socket.id, name: playerName || 'Player 1', score: 0 });
    socketToRoom[socket.id] = code;
    socket.join(code);

    socket.emit('room:created', { code });
    console.log(`[room] ${code} created by ${socket.id}`);
  });

  // ── JOIN ROOM ──
  socket.on('room:join', ({ playerName, code }) => {
    const room = rooms[code];
    if (!room) {
      socket.emit('room:error', { message: 'Room not found. Check the code and try again.' });
      return;
    }
    if (room.players.length >= 2) {
      socket.emit('room:error', { message: 'Room is full.' });
      return;
    }
    if (room.started) {
      socket.emit('room:error', { message: 'Game already in progress.' });
      return;
    }

    room.players.push({ socketId: socket.id, name: playerName || 'Player 2', score: 0 });
    socketToRoom[socket.id] = code;
    socket.join(code);

    // Tell both players the room is ready
    const [p1, p2] = room.players;
    io.to(p1.socketId).emit('room:ready', { opponentName: p2.name, code });
    io.to(p2.socketId).emit('room:ready', { opponentName: p1.name, code });

    console.log(`[room] ${code} — ${p2.name} joined`);
    startGame(room);
  });

  // ── MATCHMAKING ──
  socket.on('matchmaking:join', ({ playerName, format = 'ODI' }) => {
    // Remove stale entries
    const staleIdx = matchmakingQueue.findIndex(s => !io.sockets.sockets.get(s.id));
    if (staleIdx !== -1) matchmakingQueue.splice(staleIdx, 1);

    if (matchmakingQueue.length > 0) {
      const opponent = matchmakingQueue.shift();
      const code = generateRoomCode();
      const room = createRoom(code, format);
      rooms[code] = room;

      room.players.push({ socketId: opponent.id, name: opponent._playerName || 'Player 1', score: 0 });
      room.players.push({ socketId: socket.id,   name: playerName || 'Player 2', score: 0 });

      socketToRoom[opponent.id] = code;
      socketToRoom[socket.id]   = code;

      opponent.join(code);
      socket.join(code);

      const [p1, p2] = room.players;
      io.to(p1.socketId).emit('matchmaking:matched', { opponentName: p2.name, code });
      io.to(p2.socketId).emit('matchmaking:matched', { opponentName: p1.name, code });

      console.log(`[matchmaking] ${code} — ${p1.name} vs ${p2.name}`);
      startGame(room);
    } else {
      socket._playerName = playerName;
      matchmakingQueue.push(socket);
      socket.emit('matchmaking:waiting');
      console.log(`[matchmaking] ${socket.id} waiting`);
    }
  });

  // ── CANCEL MATCHMAKING ──
  socket.on('matchmaking:cancel', () => {
    const idx = matchmakingQueue.indexOf(socket);
    if (idx !== -1) matchmakingQueue.splice(idx, 1);
    socket.emit('matchmaking:cancelled');
  });

  // ── PLAYER PICKS A STAT ──
  socket.on('round:pick', ({ statKey }) => {
    const code = socketToRoom[socket.id];
    if (!code) return;
    const room = rooms[code];
    if (!room || room.finished) return;

    const [p1] = room.players;
    // Only p1 can pick
    if (socket.id !== p1.socketId) return;
    // Already picked this round
    if (room.roundStat) return;

    room.roundStat = statKey;
    resolveRound(room, statKey);
  });

  // ── ADVANCE TO NEXT ROUND ──
  socket.on('round:next', () => {
    const code = socketToRoom[socket.id];
    if (!code) return;
    const room = rooms[code];
    if (!room || room.finished) return;

    // Track acknowledgements — both players must confirm before advancing
    if (!room._nextAcks) room._nextAcks = new Set();
    room._nextAcks.add(socket.id);

    if (room._nextAcks.size >= 2) {
      room._nextAcks = new Set();
      room.round++;
      if (room.round >= TOTAL_ROUNDS) {
        endGame(room, 'normal');
      } else {
        emitRound(room);
      }
    }
  });

  // ── PLAY AGAIN ──
  socket.on('game:playAgain', () => {
    const code = socketToRoom[socket.id];
    if (!code) return;
    const room = rooms[code];
    if (!room) return;

    if (!room._playAgainAcks) room._playAgainAcks = new Set();
    room._playAgainAcks.add(socket.id);

    if (room._playAgainAcks.size >= 2) {
      // Reset room and restart
      room._playAgainAcks = new Set();
      room._nextAcks = new Set();
      room.finished = false;
      room.started  = false;
      room.round    = 0;
      room.roundStat = null;
      room.players.forEach(p => { p.score = 0; });
      startGame(room);
    } else {
      // Tell the other player their opponent wants to play again
      const other = room.players.find(p => p.socketId !== socket.id);
      if (other) io.to(other.socketId).emit('game:opponentWantsRematch');
    }
  });

  // ── DISCONNECT ──
  socket.on('disconnect', () => {
    console.log(`[-] ${socket.id} disconnected`);

    // Remove from matchmaking queue
    const mmIdx = matchmakingQueue.indexOf(socket);
    if (mmIdx !== -1) matchmakingQueue.splice(mmIdx, 1);

    const code = socketToRoom[socket.id];
    if (!code) return;
    delete socketToRoom[socket.id];

    const room = rooms[code];
    if (!room || room.finished) return;

    // Find the remaining player
    const remaining = room.players.find(p => p.socketId !== socket.id);
    const left      = room.players.find(p => p.socketId === socket.id);

    if (remaining && room.started) {
      // Award win to remaining player
      room.players.forEach(p => {
        if (p.socketId !== socket.id) p.score = Math.max(p.score, room.players.find(x => x.socketId === socket.id)?.score ?? 0);
      });
      io.to(remaining.socketId).emit('game:opponentDisconnected', {
        opponentName: left?.name || 'Opponent',
      });
      endGame(room, 'disconnect');
    }

    delete rooms[code];
  });
});

// ── START SERVER ──────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🏏 Superstar Cricket Cards server running on port ${PORT}`);
  console.log(`   Local:  http://localhost:${PORT}\n`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// ODI CARD DATA (same dataset as the client — server needs it for comparison)
//
// DATA NOTE:
// Replace these values with verified real stats before release.
// Stats should be checked from ESPNcricinfo Statsguru, Cricbuzz, HowSTAT,
// ICC profiles. Use a fixed stats snapshot date for final release.
// ═══════════════════════════════════════════════════════════════════════════════
const ODI_CARDS = [

  // ── INDIA ──────────────────────────────────────────────────────────────────

  {
    id: "sachin_tendulkar_odi",
    name: "Sachin Tendulkar",
    country: "India", role: "Batter", rarity: "Legendary",
    // Final career: 463 matches, 18426 runs — confirmed multiple sources
    matches: 463, runs: 18426, fours: 2016, sixes: 195,
    fifties: 96, hundreds: 49, highestScore: 200,
    strikeRate: 86.23,
    bestBowlingWickets: 5, bestBowlingRuns: 32,
    economyRate: 5.10, wickets: 154, catches: 140, stumpings: 0
  },

  {
    id: "ms_dhoni_odi",
    name: "MS Dhoni",
    country: "India", role: "Wicket-keeper", rarity: "Legendary",
    // Final career: 350 matches, 10773 runs — confirmed mykhel/ESPNcricinfo
    matches: 350, runs: 10773, fours: 826, sixes: 229,
    fifties: 73, hundreds: 10, highestScore: 183,
    strikeRate: 87.56,
    bestBowlingWickets: 1, bestBowlingRuns: 14,
    economyRate: 5.93, wickets: 1, catches: 321, stumpings: 123
  },

  {
    id: "virat_kohli_odi",
    name: "Virat Kohli",
    country: "India", role: "Batter", rarity: "Legendary",
    // Active as of May 2026: ~14,557+ runs, 54 hundreds (scored 54th in Jan 2026 vs NZ)
    // 302-310 matches range from sources; using conservative verified figure
    matches: 302, runs: 14557, fours: 1310, sixes: 155,
    fifties: 74, hundreds: 54, highestScore: 183,
    strikeRate: 93.62,
    bestBowlingWickets: 4, bestBowlingRuns: 13,
    economyRate: 6.39, wickets: 4, catches: 150, stumpings: 0
  },

  {
    id: "rohit_sharma_odi",
    name: "Rohit Sharma",
    country: "India", role: "Batter", rarity: "Legendary",
    // As of Jan 2026: 282 matches, 11577 runs, 357 sixes, 1090 fours — mykhel
    matches: 282, runs: 11577, fours: 1090, sixes: 357,
    fifties: 57, hundreds: 32, highestScore: 264,
    strikeRate: 89.80,
    bestBowlingWickets: 2, bestBowlingRuns: 9,
    economyRate: 5.42, wickets: 8, catches: 115, stumpings: 0
  },

  {
    id: "sourav_ganguly_odi",
    name: "Sourav Ganguly",
    country: "India", role: "All-rounder", rarity: "Epic",
    matches: 311, runs: 11363, fours: 1122, sixes: 190,
    fifties: 72, hundreds: 22, highestScore: 183,
    strikeRate: 73.70,
    bestBowlingWickets: 5, bestBowlingRuns: 16,
    economyRate: 4.37, wickets: 100, catches: 100, stumpings: 0
  },

  {
    id: "yuvraj_singh_odi",
    name: "Yuvraj Singh",
    country: "India", role: "All-rounder", rarity: "Epic",
    matches: 304, runs: 8701, fours: 779, sixes: 284,
    fifties: 52, hundreds: 14, highestScore: 150,
    strikeRate: 87.66,
    bestBowlingWickets: 5, bestBowlingRuns: 31,
    economyRate: 5.02, wickets: 111, catches: 89, stumpings: 0
  },

  {
    id: "jasprit_bumrah_odi",
    name: "Jasprit Bumrah",
    country: "India", role: "Bowler", rarity: "Legendary",
    // As of 2026: 89 matches, 149 wickets, econ 4.60 — mykhel confirmed
    matches: 89, runs: 65, fours: 3, sixes: 2,
    fifties: 0, hundreds: 0, highestScore: 10,
    strikeRate: 62.00,
    bestBowlingWickets: 6, bestBowlingRuns: 19,
    economyRate: 4.60, wickets: 149, catches: 18, stumpings: 0
  },

  // ── AUSTRALIA ──────────────────────────────────────────────────────────────

  {
    id: "ricky_ponting_odi",
    name: "Ricky Ponting",
    country: "Australia", role: "Batter", rarity: "Legendary",
    matches: 375, runs: 13704, fours: 1231, sixes: 163,
    fifties: 82, hundreds: 30, highestScore: 164,
    strikeRate: 80.39,
    bestBowlingWickets: 3, bestBowlingRuns: 0,
    economyRate: 4.73, wickets: 3, catches: 160, stumpings: 0
  },

  {
    id: "adam_gilchrist_odi",
    name: "Adam Gilchrist",
    country: "Australia", role: "Wicket-keeper", rarity: "Legendary",
    matches: 287, runs: 9619, fours: 1000, sixes: 149,
    fifties: 55, hundreds: 16, highestScore: 172,
    strikeRate: 96.94,
    bestBowlingWickets: 0, bestBowlingRuns: 0,
    economyRate: 0, wickets: 0, catches: 417, stumpings: 55
  },

  {
    id: "brett_lee_odi",
    name: "Brett Lee",
    country: "Australia", role: "Bowler", rarity: "Epic",
    matches: 221, runs: 950, fours: 59, sixes: 32,
    fifties: 2, hundreds: 0, highestScore: 52,
    strikeRate: 83.04,
    bestBowlingWickets: 5, bestBowlingRuns: 22,
    economyRate: 4.76, wickets: 380, catches: 49, stumpings: 0
  },

  {
    id: "shane_warne_odi",
    name: "Shane Warne",
    country: "Australia", role: "Bowler", rarity: "Legendary",
    matches: 194, runs: 1018, fours: 78, sixes: 8,
    fifties: 1, hundreds: 0, highestScore: 55,
    strikeRate: 68.92,
    bestBowlingWickets: 5, bestBowlingRuns: 33,
    economyRate: 4.25, wickets: 293, catches: 80, stumpings: 0
  },

  {
    id: "mitchell_starc_odi",
    name: "Mitchell Starc",
    country: "Australia", role: "Bowler", rarity: "Epic",
    // 130 matches, 247 wickets, econ 5.27 — mykhel May 2026
    matches: 130, runs: 620, fours: 35, sixes: 18,
    fifties: 0, hundreds: 0, highestScore: 52,
    strikeRate: 91.00,
    bestBowlingWickets: 6, bestBowlingRuns: 28,
    economyRate: 5.27, wickets: 247, catches: 26, stumpings: 0
  },

  {
    id: "steve_smith_odi",
    name: "Steve Smith",
    country: "Australia", role: "Batter", rarity: "Epic",
    matches: 170, runs: 5431, fours: 439, sixes: 67,
    fifties: 36, hundreds: 13, highestScore: 164,
    strikeRate: 86.55,
    bestBowlingWickets: 3, bestBowlingRuns: 26,
    economyRate: 5.88, wickets: 31, catches: 83, stumpings: 0
  },

  // ── ENGLAND ────────────────────────────────────────────────────────────────

  {
    id: "ben_stokes_odi",
    name: "Ben Stokes",
    country: "England", role: "All-rounder", rarity: "Epic",
    // Retired from ODIs Jul 2022; 114 matches, 3463 runs, 282 fours, 109 sixes — mykhel
    matches: 114, runs: 3463, fours: 282, sixes: 109,
    fifties: 21, hundreds: 3, highestScore: 102,
    strikeRate: 95.09,
    bestBowlingWickets: 5, bestBowlingRuns: 61,
    economyRate: 6.19, wickets: 74, catches: 43, stumpings: 0
  },

  {
    id: "andrew_flintoff_odi",
    name: "Andrew Flintoff",
    country: "England", role: "All-rounder", rarity: "Epic",
    matches: 141, runs: 3394, fours: 318, sixes: 72,
    fifties: 18, hundreds: 3, highestScore: 123,
    strikeRate: 87.22,
    bestBowlingWickets: 5, bestBowlingRuns: 19,
    economyRate: 4.89, wickets: 169, catches: 38, stumpings: 0
  },

  {
    id: "eoin_morgan_odi",
    name: "Eoin Morgan",
    country: "England", role: "Batter", rarity: "Rare",
    matches: 248, runs: 7701, fours: 631, sixes: 220,
    fifties: 45, hundreds: 13, highestScore: 148,
    strikeRate: 87.57,
    bestBowlingWickets: 0, bestBowlingRuns: 0,
    economyRate: 0, wickets: 0, catches: 90, stumpings: 0
  },

  // ── SOUTH AFRICA ───────────────────────────────────────────────────────────

  {
    id: "ab_devilliers_odi",
    name: "AB de Villiers",
    country: "South Africa", role: "Batter", rarity: "Legendary",
    // Final career: 228 matches, 9577 runs, 839 fours, 204 sixes — mykhel confirmed
    matches: 228, runs: 9577, fours: 839, sixes: 204,
    fifties: 53, hundreds: 25, highestScore: 176,
    strikeRate: 101.10,
    bestBowlingWickets: 1, bestBowlingRuns: 47,
    economyRate: 6.39, wickets: 1, catches: 232, stumpings: 1
  },

  {
    id: "shaun_pollock_odi",
    name: "Shaun Pollock",
    country: "South Africa", role: "All-rounder", rarity: "Epic",
    // 303 matches, 393 wickets — confirmed top wicket-takers list
    matches: 303, runs: 3519, fours: 273, sixes: 15,
    fifties: 14, hundreds: 0, highestScore: 130,
    strikeRate: 70.63,
    bestBowlingWickets: 6, bestBowlingRuns: 35,
    economyRate: 3.67, wickets: 393, catches: 112, stumpings: 0
  },

  {
    id: "hashim_amla_odi",
    name: "Hashim Amla",
    country: "South Africa", role: "Batter", rarity: "Epic",
    matches: 181, runs: 8113, fours: 835, sixes: 64,
    fifties: 48, hundreds: 27, highestScore: 159,
    strikeRate: 88.93,
    bestBowlingWickets: 0, bestBowlingRuns: 0,
    economyRate: 0, wickets: 0, catches: 60, stumpings: 0
  },

  // ── PAKISTAN ───────────────────────────────────────────────────────────────

  {
    id: "wasim_akram_odi",
    name: "Wasim Akram",
    country: "Pakistan", role: "Bowler", rarity: "Legendary",
    // 356 matches, 502 wickets — confirmed multiple sources
    matches: 356, runs: 3717, fours: 263, sixes: 72,
    fifties: 6, hundreds: 3, highestScore: 86,
    strikeRate: 86.09,
    bestBowlingWickets: 5, bestBowlingRuns: 15,
    economyRate: 3.89, wickets: 502, catches: 88, stumpings: 0
  },

  {
    id: "shahid_afridi_odi",
    name: "Shahid Afridi",
    country: "Pakistan", role: "All-rounder", rarity: "Legendary",
    // 398 matches, 395 wickets — confirmed multiple sources
    matches: 398, runs: 8064, fours: 687, sixes: 351,
    fifties: 39, hundreds: 6, highestScore: 124,
    strikeRate: 117.00,
    bestBowlingWickets: 7, bestBowlingRuns: 12,
    economyRate: 4.62, wickets: 395, catches: 125, stumpings: 0
  },

  {
    id: "babar_azam_odi",
    name: "Babar Azam",
    country: "Pakistan", role: "Batter", rarity: "Epic",
    // 140 matches, 6501 runs, 601 fours, 68 sixes — mykhel Nov 2025
    matches: 140, runs: 6501, fours: 601, sixes: 68,
    fifties: 43, hundreds: 20, highestScore: 158,
    strikeRate: 87.89,
    bestBowlingWickets: 0, bestBowlingRuns: 0,
    economyRate: 0, wickets: 0, catches: 46, stumpings: 0
  },

  // ── WEST INDIES ────────────────────────────────────────────────────────────

  {
    id: "brian_lara_odi",
    name: "Brian Lara",
    country: "West Indies", role: "Batter", rarity: "Legendary",
    matches: 299, runs: 10405, fours: 1058, sixes: 97,
    fifties: 63, hundreds: 19, highestScore: 169,
    strikeRate: 79.29,
    bestBowlingWickets: 4, bestBowlingRuns: 37,
    economyRate: 5.29, wickets: 4, catches: 120, stumpings: 0
  },

  {
    id: "chris_gayle_odi",
    name: "Chris Gayle",
    country: "West Indies", role: "Batter", rarity: "Legendary",
    matches: 301, runs: 10480, fours: 1002, sixes: 331,
    fifties: 54, hundreds: 25, highestScore: 215,
    strikeRate: 85.90,
    bestBowlingWickets: 3, bestBowlingRuns: 30,
    economyRate: 5.05, wickets: 167, catches: 91, stumpings: 0
  },

  {
    id: "courtney_walsh_odi",
    name: "Courtney Walsh",
    country: "West Indies", role: "Bowler", rarity: "Rare",
    matches: 205, runs: 297, fours: 14, sixes: 2,
    fifties: 0, hundreds: 0, highestScore: 30,
    strikeRate: 44.67,
    bestBowlingWickets: 5, bestBowlingRuns: 1,
    economyRate: 3.99, wickets: 227, catches: 32, stumpings: 0
  },

  // ── NEW ZEALAND ────────────────────────────────────────────────────────────

  {
    id: "brendon_mccullum_odi",
    name: "Brendon McCullum",
    country: "New Zealand", role: "Wicket-keeper", rarity: "Epic",
    matches: 260, runs: 6083, fours: 537, sixes: 200,
    fifties: 30, hundreds: 5, highestScore: 166,
    strikeRate: 96.98,
    bestBowlingWickets: 0, bestBowlingRuns: 0,
    economyRate: 0, wickets: 0, catches: 377, stumpings: 24
  },

  {
    id: "kane_williamson_odi",
    name: "Kane Williamson",
    country: "New Zealand", role: "Batter", rarity: "Epic",
    matches: 163, runs: 6555, fours: 610, sixes: 63,
    fifties: 46, hundreds: 13, highestScore: 148,
    strikeRate: 81.30,
    bestBowlingWickets: 4, bestBowlingRuns: 22,
    economyRate: 5.00, wickets: 37, catches: 67, stumpings: 0
  },

  {
    id: "trent_boult_odi",
    name: "Trent Boult",
    country: "New Zealand", role: "Bowler", rarity: "Rare",
    // 114 matches, 211 wickets, econ 5.00 — mykhel 2025
    matches: 114, runs: 280, fours: 20, sixes: 7,
    fifties: 0, hundreds: 0, highestScore: 26,
    strikeRate: 63.02,
    bestBowlingWickets: 7, bestBowlingRuns: 34,
    economyRate: 5.00, wickets: 211, catches: 38, stumpings: 0
  },

  // ── SRI LANKA ──────────────────────────────────────────────────────────────

  {
    id: "kumar_sangakkara_odi",
    name: "Kumar Sangakkara",
    country: "Sri Lanka", role: "Wicket-keeper", rarity: "Legendary",
    matches: 404, runs: 14234, fours: 1382, sixes: 99,
    fifties: 93, hundreds: 25, highestScore: 169,
    strikeRate: 78.86,
    bestBowlingWickets: 0, bestBowlingRuns: 0,
    economyRate: 0, wickets: 0, catches: 402, stumpings: 99
  },

  {
    id: "muttiah_muralitharan_odi",
    name: "Muttiah Muralitharan",
    country: "Sri Lanka", role: "Bowler", rarity: "Legendary",
    // 350 matches, 534 wickets — confirmed multiple sources as all-time record
    matches: 350, runs: 674, fours: 45, sixes: 4,
    fifties: 0, hundreds: 0, highestScore: 33,
    strikeRate: 58.98,
    bestBowlingWickets: 7, bestBowlingRuns: 30,
    economyRate: 3.93, wickets: 534, catches: 131, stumpings: 0
  },

  {
    id: "lasith_malinga_odi",
    name: "Lasith Malinga",
    country: "Sri Lanka", role: "Bowler", rarity: "Epic",
    matches: 226, runs: 805, fours: 49, sixes: 29,
    fifties: 0, hundreds: 0, highestScore: 56,
    strikeRate: 91.39,
    bestBowlingWickets: 6, bestBowlingRuns: 38,
    economyRate: 5.24, wickets: 338, catches: 34, stumpings: 0
  },

  // ── BANGLADESH ─────────────────────────────────────────────────────────────

  {
    id: "shakib_al_hasan_odi",
    name: "Shakib Al Hasan",
    country: "Bangladesh", role: "All-rounder", rarity: "Epic",
    // 247 matches, 7570 runs, 699 fours — mykhel (last ODI Nov 2023)
    matches: 247, runs: 7570, fours: 699, sixes: 54,
    fifties: 54, hundreds: 9, highestScore: 134,
    strikeRate: 82.92,
    bestBowlingWickets: 6, bestBowlingRuns: 55,
    economyRate: 4.45, wickets: 299, catches: 82, stumpings: 0
  },

  {
    id: "tamim_iqbal_odi",
    name: "Tamim Iqbal",
    country: "Bangladesh", role: "Batter", rarity: "Rare",
    matches: 240, runs: 8357, fours: 906, sixes: 107,
    fifties: 56, hundreds: 14, highestScore: 158,
    strikeRate: 80.68,
    bestBowlingWickets: 0, bestBowlingRuns: 0,
    economyRate: 0, wickets: 0, catches: 63, stumpings: 0
  },

  // ── AFGHANISTAN ────────────────────────────────────────────────────────────

  {
    id: "rashid_khan_odi",
    name: "Rashid Khan",
    country: "Afghanistan", role: "Bowler", rarity: "Epic",
    // 117 matches, 210 wickets, econ 4.21 — mykhel 2025
    // Took 200th ODI wicket vs Bangladesh, Oct 2025
    matches: 117, runs: 1106, fours: 104, sixes: 37,
    fifties: 3, hundreds: 0, highestScore: 60,
    strikeRate: 103.50,
    bestBowlingWickets: 7, bestBowlingRuns: 18,
    economyRate: 4.21, wickets: 210, catches: 28, stumpings: 0
  },

]; // end ODI_CARDS
