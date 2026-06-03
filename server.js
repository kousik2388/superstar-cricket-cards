// ═══════════════════════════════════════════════════════════════════════════════
// SUPERSTAR CRICKET CARDS — Multiplayer Server v3
// Supports 2-4 players, batting/bowling phase split, podium points
// ═══════════════════════════════════════════════════════════════════════════════
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000, pingInterval: 25000,
  transports: ['websocket', 'polling'],
  allowEIO3: true, upgradeTimeout: 30000,
});

const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, 'public')));

// ── UPTIME / HEALTH ENDPOINTS ──────────────────────────────────────
// UptimeRobot pings /ping every 5 minutes to keep Render free tier awake
app.get('/ping', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), rooms: Object.keys(rooms).length, players: Object.keys(onlinePlayers).length });
});
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── CONSTANTS ─────────────────────────────────────────────────────────────────
const TOTAL_ROUNDS     = 10;
const BATTING_ROUNDS   = 5;   // rounds 0-4 = batting, 5-9 = bowling
const MAX_PLAYERS      = 4;
const MIN_PLAYERS      = 2;

const BATTING_STATS  = ['matches','runs','fours','sixes','fifties','hundreds','highestScore','strikeRate'];
const BOWLING_STATS  = ['bestBowling','economyRate','wickets','catches','stumpings'];

// Podium points: index = rank (0=1st, 1=2nd, 2=3rd, 3=4th)
const PODIUM_POINTS = [4, 3, 2, 1, 0];

// 1v1: winner gets 1 round win, loser gets 0
// 3-4 players: podium points
function awardPoints(rank, totalPlayers) {
  if (totalPlayers <= 2) return rank === 0 ? 1 : 0;
  return PODIUM_POINTS[rank] ?? 0;
}

// ── STATE ─────────────────────────────────────────────────────────────────────
const rooms            = {};
const matchmakingQueue = [];  // legacy quick match fallback
const socketToRoom     = {};
const onlinePlayers    = {};  // socketId → { name, status: 'lobby'|'in-game'|'challenged' }
const pendingChallenges= {};  // challengerSocketId → { targetSocketId, expiresAt }

// ── HELPERS ───────────────────────────────────────────────────────────────────
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({length:4}, () => chars[Math.floor(Math.random()*chars.length)]).join(''); }
  while (rooms[code]);
  return code;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i=a.length-1; i>0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
}

// ── COMPARISON ────────────────────────────────────────────────────────────────
const STAT_META = {
  matches:{lowerBetter:false}, runs:{lowerBetter:false}, fours:{lowerBetter:false},
  sixes:{lowerBetter:false}, fifties:{lowerBetter:false}, hundreds:{lowerBetter:false},
  highestScore:{lowerBetter:false}, strikeRate:{lowerBetter:false},
  bestBowling:{special:true}, economyRate:{lowerBetter:true},
  wickets:{lowerBetter:false}, catches:{lowerBetter:false}, stumpings:{lowerBetter:false},
};

function statValue(card, key) {
  if (key === 'bestBowling') return card.bestBowlingWickets * 1000 - card.bestBowlingRuns;
  const v = parseFloat(card[key]) || 0;
  return STAT_META[key].lowerBetter ? (v === 0 ? -Infinity : -v) : v;
}

// Returns sorted array of { socketId, value, rank, points }
function rankPlayers(players, hands, round, statKey) {
  const entries = players.map(p => ({
    socketId: p.socketId,
    name: p.name,
    value: statValue(hands[p.socketId][round], statKey),
  }));

  // Sort descending by value
  entries.sort((a,b) => b.value - a.value);

  // Assign ranks (handle ties — tied players share the same rank)
  let rank = 0;
  for (let i=0; i<entries.length; i++) {
    if (i > 0 && entries[i].value !== entries[i-1].value) rank++;
    entries[i].rank = rank;
    entries[i].points = awardPoints(rank, entries.length);
  }
  return entries;
}

// ── ROOM ──────────────────────────────────────────────────────────────────────
function createRoom(code, maxPlayers=2, format='ODI') {
  return {
    code, format, maxPlayers,
    players: [],     // [{ socketId, name, score }]
    spectators: [],  // [{ socketId, name }]
    hands: {},
    round: 0,
    pickerIndex: 0,
    roundStat: null,
    roundPhase: 'pick',  // 'pick' | 'confirm' | 'result'
    confirmAcks: new Set(),
    nextAcks: new Set(),
    playAgainAcks: new Set(),
    arrangeAcks: new Set(),
    tossReadyAcks: new Set(),
    started: false,
    finished: false,
    pickTimer: null,
    confirmTimer: null,
    playAgainTimer: null,
    fillTimer: null,       // 60s wait for players to fill room before force-starting
  };
}

function currentPhase(round) {
  return round < BATTING_ROUNDS ? 'batting' : 'bowling';
}

function allowedStats(round) {
  return round < BATTING_ROUNDS ? BATTING_STATS : BOWLING_STATS;
}


// ── DECK SELECTION ────────────────────────────────────────────────────────────
function getDeckForFormat(fmt) {
  if (fmt === 'IPL')  return IPL_CARDS;
  if (fmt === 'T20I') return T20I_CARDS;
  if (fmt === 'TEST') return TEST_CARDS;
  return ODI_CARDS;
}

function getSquadByRole(deck, role) {
  if (!role) return deck;
  if (role === 'batter') return deck.filter(c =>
    c.role === 'Batter' || c.role === 'All-rounder' || c.role === 'Wicket-keeper');
  if (role === 'bowler') return deck.filter(c =>
    c.role === 'Bowler' || c.role === 'All-rounder');
  return deck;
}

// 120s auto-start countdown for multi-player rooms
// Host can dismiss via room:keepWaiting for unlimited wait
function startFillTimer(room) {
  if (room.keepWaiting || room.started || room.finished) return;
  let secondsLeft = 120;
  const tick = setInterval(() => {
    secondsLeft--;
    if (room.keepWaiting || room.started || room.finished) { clearInterval(tick); return; }
    const notify = secondsLeft <= 30 && (secondsLeft <= 10 || secondsLeft % 10 === 0);
    if (notify) {
      room.players.forEach(p => io.to(p.socketId).emit('room:fillCountdown', {
        secondsLeft,
        playersNow: room.players.length,
        maxPlayers: room.maxPlayers,
      }));
    }
    if (secondsLeft <= 0) {
      clearInterval(tick);
      room.fillTimer = null;
      if (!room.started && !room.finished) {
        if (room.players.length >= MIN_PLAYERS) {
          room.players.forEach(p => io.to(p.socketId).emit('room:fillTimeout', {
            playersJoined: room.players.length,
            maxPlayers: room.maxPlayers,
          }));
          startGame(room);
        } else {
          room.players.forEach(p => io.to(p.socketId).emit('room:dissolved', {
            reason: 'Not enough players joined in time.',
          }));
          delete rooms[room.code];
          broadcastOpenRooms();
        }
      }
    }
  }, 1000);
  room.fillTimer = tick;
}

function startGame(room) {
  room.started     = true;
  room.round       = 0;
  room.pickerIndex = 0;
  room.roundStat   = null;
  room.roundPhase  = 'pick';
  room.nextAcks    = new Set();
  room.confirmAcks = new Set();

  const fullDeck = getDeckForFormat(room.format || 'ODI');
  const squad    = getSquadByRole(fullDeck, room.role);
  // Need at least 10 cards per player; fall back if squad too small
  let pool = squad.length >= room.maxPlayers * 10 ? squad : fullDeck;
  // Safety: if even fullDeck is too small (shouldn't happen), pad by repeating
  if (pool.length < room.maxPlayers * 10) {
    const padded = [];
    while (padded.length < room.maxPlayers * 10) padded.push(...pool);
    pool = padded;
  }
  const deck     = shuffle(pool);
  room.players.forEach((p, i) => {
    room.hands[p.socketId] = deck.slice(i * 10, (i+1) * 10);
  });

  room.arrangeAcks    = new Set();  // reset arrange acks for new game
  room.tossReadyAcks  = new Set();  // reset toss ready acks for new game

  room.players.forEach((p, i) => {
    io.to(p.socketId).emit('game:start', {
      yourHand:     room.hands[p.socketId],
      players:      room.players.map(x => ({ name: x.name, socketId: x.socketId })),
      yourIndex:    i,
      totalRounds:  TOTAL_ROUNDS,
      battingRounds: BATTING_ROUNDS,
      format:       room.format,
      role:         room.role || null,
      maxPlayers:   room.maxPlayers,
    });
  });

  // Do NOT call emitRound yet — wait for all players to finish arranging (hand:reorder)
}

function broadcastSpectateState(room) {
  if (!room.spectators || room.spectators.length === 0) return;
  const state = {
    players: room.players.map(p => ({ name: p.name, socketId: p.socketId, score: p.score })),
    round: room.round,
    totalRounds: TOTAL_ROUNDS,
    pickerIndex: room.pickerIndex,
    pickerName: room.players[room.pickerIndex]?.name,
    roundPhase: room.roundPhase,
    roundStat: room.roundStat,
  };
  room.spectators.forEach(s => io.to(s.socketId).emit('spectate:roundUpdate', state));
}

function emitRound(room) {
  room.roundStat   = null;
  room.roundPhase  = 'pick';
  room.confirmAcks = new Set();

  // Clear any previous pick timer
  if (room.pickTimer) { clearTimeout(room.pickTimer); room.pickTimer = null; }

  const picker     = room.players[room.pickerIndex];
  const phase      = currentPhase(room.round);
  const allowed    = allowedStats(room.round);
  const scores     = Object.fromEntries(room.players.map(p => [p.socketId, p.score]));

  room.players.forEach((p, i) => {
    io.to(p.socketId).emit('round:start', {
      round:       room.round,
      yourCard:    room.hands[p.socketId][room.round],
      pickerIndex: room.pickerIndex,
      pickerName:  picker.name,
      phase,
      allowedStats: allowed,
      scores,
      totalRounds:  TOTAL_ROUNDS,
      pickTimeLimit: 15,
    });
  });

  broadcastSpectateState(room);

  // Server-side 15s pick timeout — auto-pick a random stat if picker doesn't respond
  room.pickTimer = setTimeout(() => {
    if (room.finished || room.roundPhase !== 'pick') return;
    const randomStat = allowed[Math.floor(Math.random() * allowed.length)];
    console.log(`[pick-timeout] Room ${room.code} round ${room.round} auto-pick ${randomStat}`);
    room.players.forEach(p => io.to(p.socketId).emit('round:pickTimeout', { autoStat: randomStat }));
    emitStatChosen(room, randomStat);
  }, 15500);
}

function emitStatChosen(room, statKey) {
  room.roundStat  = statKey;
  room.roundPhase = 'confirm';

  const picker = room.players[room.pickerIndex];

  room.players.forEach(p => {
    const isPicker = p.socketId === picker.socketId;
    io.to(p.socketId).emit('round:statChosen', {
      statKey,
      pickerName:   picker.name,
      youMustConfirm: !isPicker,
      confirmTimeLimit: 10,
    });
  });

  // 10s confirm timer — auto-resolve if non-pickers don't confirm
  if (room.confirmTimer) clearTimeout(room.confirmTimer);
  room.confirmTimer = setTimeout(() => {
    if (room.finished || room.roundPhase !== 'confirm') return;
    console.log(`[confirm-timeout] Room ${room.code} round ${room.round} — auto-confirm`);
    room.players.forEach(p => io.to(p.socketId).emit('round:confirmTimeout'));
    resolveRound(room);
  }, 10500);
}

function resolveRound(room) {
  if (room.roundPhase !== 'confirm') return;
  room.roundPhase = 'result';

  const r       = room.round;
  const statKey = room.roundStat;
  const ranked  = rankPlayers(room.players, room.hands, r, statKey);

  // Award podium points
  ranked.forEach(entry => {
    const p = room.players.find(x => x.socketId === entry.socketId);
    if (p) p.score += entry.points;
  });

  // Winner of round picks next (rank 0 = first place)
  const winner = ranked.find(e => e.rank === 0);
  const winnerIdx = room.players.findIndex(p => p.socketId === winner.socketId);
  room.pickerIndex = winnerIdx;

  const isLastRound = r + 1 >= TOTAL_ROUNDS;
  const scores      = Object.fromEntries(room.players.map(p => [p.socketId, p.score]));
  const allCards    = Object.fromEntries(room.players.map(p => [p.socketId, room.hands[p.socketId][r]]));

  const payload = {
    round: r, statKey, ranked, scores, allCards, isLastRound,
    nextPickerIndex: room.pickerIndex,
    nextPickerName:  room.players[room.pickerIndex].name,
  };

  room.players.forEach((p, i) => {
    io.to(p.socketId).emit('round:result', {
      ...payload,
      yourIndex: i,
    });
  });
}

function endGame(room, reason='normal') {
  if (room.finished) return;
  room.finished = true;
  // Clear any active timers
  if (room.pickTimer) { clearTimeout(room.pickTimer); room.pickTimer = null; }
  if (room.confirmTimer) { clearTimeout(room.confirmTimer); room.confirmTimer = null; }
  if (room.playAgainTimer) { clearTimeout(room.playAgainTimer); room.playAgainTimer = null; }
  if (room.fillTimer) { clearTimeout(room.fillTimer); room.fillTimer = null; }

  const sorted  = [...room.players].sort((a,b) => b.score - a.score);
  const scores  = Object.fromEntries(room.players.map(p => [p.socketId, p.score]));
  const payload = { reason, scores, finalRanking: sorted.map(p => ({ name: p.name, socketId: p.socketId, score: p.score })) };

  room.players.forEach((p, i) => {
    io.to(p.socketId).emit('game:over', { ...payload, yourIndex: i });
  });

  setTimeout(() => { delete rooms[room.code]; }, 30000);
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function broadcastOnlinePlayers() {
  const list = Object.entries(onlinePlayers)
    .filter(([, p]) => p.status === 'lobby')
    .map(([socketId, p]) => ({ socketId, name: p.name, format: p.format, role: p.role }));
  io.emit('lobby:playerList', { players: list });
}

function broadcastOpenRooms() {
  const open = Object.values(rooms)
    .filter(r => !r.started && !r.finished && r.players.length < r.maxPlayers)
    .map(r => ({
      code: r.code,
      format: r.format,
      role: r.role || null,
      maxPlayers: r.maxPlayers,
      currentPlayers: r.players.length,
      hostName: r.players[0]?.name || 'Host',
    }));
  // Send personalised list — each player sees rooms they are NOT already in
  Object.keys(onlinePlayers).forEach(sid => {
    const myCode = socketToRoom[sid];
    const filtered = myCode ? open.filter(r => r.code !== myCode) : open;
    io.to(sid).emit('lobby:openRooms', { rooms: filtered });
  });
}

function setPlayerStatus(socketId, status) {
  if (onlinePlayers[socketId]) {
    onlinePlayers[socketId].status = status;
    broadcastOnlinePlayers();
  }
}

// ── SOCKET HANDLERS ───────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log(`[+] ${socket.id}`);

  // ── ENTER LOBBY ──
  socket.on('lobby:enter', ({ playerName, format, role }) => {
    onlinePlayers[socket.id] = { name: playerName || 'Player', status: 'lobby', format: format || 'ODI', role: role || null };
    socket._playerName = playerName;
    broadcastOnlinePlayers();
    broadcastOpenRooms();
  });

  // ── LEAVE LOBBY ──
  socket.on('lobby:leave', () => {
    delete onlinePlayers[socket.id];
    // cancel any pending challenge this player sent
    if (pendingChallenges[socket.id]) {
      const { targetSocketId } = pendingChallenges[socket.id];
      io.to(targetSocketId).emit('challenge:cancelled', { challengerName: socket._playerName });
      delete pendingChallenges[socket.id];
    }
    broadcastOnlinePlayers();
  });

  // ── SEND CHALLENGE ──
  socket.on('challenge:send', ({ targetSocketId }) => {
    const challenger = onlinePlayers[socket.id];
    const target     = onlinePlayers[targetSocketId];
    if (!challenger || !target) return socket.emit('challenge:error', { message: 'Player not available.' });
    if (target.status !== 'lobby') return socket.emit('challenge:error', { message: 'Player is busy.' });

    if (pendingChallenges[socket.id]) {
      const old = pendingChallenges[socket.id];
      io.to(old.targetSocketId).emit('challenge:cancelled', { challengerName: challenger.name });
    }

    pendingChallenges[socket.id] = { targetSocketId, expiresAt: Date.now() + 30000 };
    setPlayerStatus(socket.id, 'challenged');
    setPlayerStatus(targetSocketId, 'challenged');

    socket.emit('challenge:sent', { targetName: target.name });
    io.to(targetSocketId).emit('challenge:received', {
      challengerSocketId: socket.id,
      challengerName: challenger.name,
      challengerFormat: challenger.format,
      challengerRole: challenger.role,
      targetFormat: target.format,
      targetRole: target.role,
    });
  });

  // ── ACCEPT CHALLENGE ──
  socket.on('challenge:accept', ({ challengerSocketId, agreedFormat, agreedRole }) => {
    const challenge = pendingChallenges[challengerSocketId];
    if (!challenge || challenge.targetSocketId !== socket.id) return;
    delete pendingChallenges[challengerSocketId];

    const format = agreedFormat || onlinePlayers[challengerSocketId]?.format || 'ODI';
    const role   = agreedRole   || null;

    const code = generateRoomCode();
    const room = createRoom(code, 2, format);
    room.role = role;
    rooms[code] = room;
    const p1name = onlinePlayers[challengerSocketId]?.name || 'Player 1';
    const p2name = onlinePlayers[socket.id]?.name || 'Player 2';
    room.players.push({ socketId: challengerSocketId, name: p1name, score: 0 });
    room.players.push({ socketId: socket.id,          name: p2name, score: 0 });
    socketToRoom[challengerSocketId] = code;
    socketToRoom[socket.id]          = code;

    const challengerSocket = io.sockets.sockets.get(challengerSocketId);
    if (challengerSocket) challengerSocket.join(code);
    socket.join(code);

    setPlayerStatus(challengerSocketId, 'in-game');
    setPlayerStatus(socket.id,          'in-game');

    io.to(challengerSocketId).emit('challenge:accepted', { opponentName: p2name, code, agreedFormat: format, agreedRole: role });
    io.to(socket.id).emit('challenge:accepted',          { opponentName: p1name, code, agreedFormat: format, agreedRole: role });

    startGame(room);
  });

  // ── DECLINE CHALLENGE ──
  socket.on('challenge:decline', ({ challengerSocketId }) => {
    const challenge = pendingChallenges[challengerSocketId];
    if (!challenge || challenge.targetSocketId !== socket.id) return;
    delete pendingChallenges[challengerSocketId];

    setPlayerStatus(challengerSocketId, 'lobby');
    setPlayerStatus(socket.id,          'lobby');

    io.to(challengerSocketId).emit('challenge:declined', { targetName: onlinePlayers[socket.id]?.name });
  });

  // ── CANCEL CHALLENGE ──
  socket.on('challenge:cancel', ({ targetSocketId }) => {
    if (pendingChallenges[socket.id]?.targetSocketId === targetSocketId) {
      delete pendingChallenges[socket.id];
      setPlayerStatus(socket.id,     'lobby');
      setPlayerStatus(targetSocketId,'lobby');
      io.to(targetSocketId).emit('challenge:cancelled', { challengerName: onlinePlayers[socket.id]?.name });
    }
  });

  // ── CREATE ROOM (manual code) ──
  // ── INVITE PLAYER TO ROOM ──
  socket.on('room:invite', ({ targetSocketId, code }) => {
    const upper = (code || '').toUpperCase();
    const room  = rooms[upper];
    if (!room || room.started || room.finished) return;
    if (!room.players.find(p => p.socketId === socket.id)) return; // only room members can invite
    const inviter = onlinePlayers[socket.id] || { name: socket._playerName || 'Host' };
    io.to(targetSocketId).emit('room:inviteReceived', {
      code: upper,
      inviterName: inviter.name,
      maxPlayers: room.maxPlayers,
      format: room.format,
      role: room.role || null,
    });
  });

  // ── CREATE ROOM ──
  socket.on('room:create', ({ playerName, maxPlayers=2, format='ODI', role=null, isPublic=true }) => {
    const code = generateRoomCode();
    const room = createRoom(code, Math.min(Math.max(maxPlayers,2),5), format);
    room.role = role;
    room.isPublic = !!isPublic;
    room.keepWaiting = false;
    rooms[code] = room;
    room.players.push({ socketId: socket.id, name: playerName||'Player 1', score: 0 });
    socketToRoom[socket.id] = code;
    socket.join(code);
    socket.emit('room:created', { code, maxPlayers: room.maxPlayers });
    broadcastOpenRooms();

    // Multi-player rooms get a 120s auto-start countdown
    // Host can dismiss it via room:keepWaiting for unlimited wait
    if (room.maxPlayers > 2) {
      startFillTimer(room);
    }
  });

  // ── HOST KEEPS WAITING (dismisses auto-start) ──
  socket.on('room:keepWaiting', () => {
    const code = socketToRoom[socket.id];
    if (!code) return;
    const room = rooms[code];
    if (!room || room.started || room.finished) return;
    if (room.players[0]?.socketId !== socket.id) return; // host only
    room.keepWaiting = true;
    if (room.fillTimer) { clearInterval(room.fillTimer); room.fillTimer = null; }
    room.players.forEach(p => io.to(p.socketId).emit('room:waitingIndefinitely'));
  });

  // ── JOIN ROOM (manual code) ──
  socket.on('room:join', ({ playerName, code }) => {
    const upper = (code||'').toUpperCase();
    const room  = rooms[upper];
    if (!room)                               return socket.emit('room:error', { message: 'Room not found.' });
    if (room.players.length >= room.maxPlayers) return socket.emit('room:error', { message: 'Room is full.' });
    if (room.started)                        return socket.emit('room:error', { message: 'Game already started.' });

    const name = playerName || `Player ${room.players.length+1}`;
    room.players.push({ socketId: socket.id, name, score: 0 });
    socketToRoom[socket.id] = upper;
    socket.join(upper);

    const playerList = room.players.map(p => ({ name: p.name, socketId: p.socketId }));
    room.players.forEach(p => {
      io.to(p.socketId).emit('room:playerJoined', {
        players: playerList, maxPlayers: room.maxPlayers,
        canStart: room.players.length >= MIN_PLAYERS,
        // Tell joining player the room's format/role so client can sync
        format: room.format,
        role: room.role || null,
      });
    });
    broadcastOpenRooms();

    // If room is now full, clear fill timer and start immediately
    if (room.players.length >= room.maxPlayers) {
      if (room.fillTimer) { clearInterval(room.fillTimer); room.fillTimer = null; }
      // Brief pause so all clients see the full lobby before game starts
      setTimeout(() => {
        if (!room.started && !room.finished) startGame(room);
      }, 1500);
    }
  });

  // ── HOST STARTS GAME ──
  socket.on('room:start', () => {
    const code = socketToRoom[socket.id];
    if (!code) return;
    const room = rooms[code];
    if (!room || room.started) return;
    if (room.players[0].socketId !== socket.id) return;
    if (room.players.length < MIN_PLAYERS) return;
    if (room.fillTimer) { clearInterval(room.fillTimer); room.fillTimer = null; }
    startGame(room);
  });

  // ── LEGACY QUICK MATCH ──
  socket.on('matchmaking:join', ({ playerName, format='ODI' }) => {
    const staleIdx = matchmakingQueue.findIndex(s => !io.sockets.sockets.get(s.id));
    if (staleIdx !== -1) matchmakingQueue.splice(staleIdx, 1);
    if (matchmakingQueue.length > 0) {
      const opp  = matchmakingQueue.shift();
      const code = generateRoomCode();
      const room = createRoom(code, 2, format);
      rooms[code] = room;
      room.players.push({ socketId: opp.id,    name: opp._playerName||'Player 1', score: 0 });
      room.players.push({ socketId: socket.id, name: playerName||'Player 2',      score: 0 });
      socketToRoom[opp.id] = code; socketToRoom[socket.id] = code;
      opp.join(code); socket.join(code);
      io.to(opp.id).emit('matchmaking:matched',    { opponentName: playerName||'Player 2', code });
      io.to(socket.id).emit('matchmaking:matched', { opponentName: opp._playerName||'Player 1', code });
      startGame(room);
    } else {
      socket._playerName = playerName;
      matchmakingQueue.push(socket);
      socket.emit('matchmaking:waiting');
    }
  });

  socket.on('matchmaking:cancel', () => {
    const idx = matchmakingQueue.indexOf(socket);
    if (idx !== -1) matchmakingQueue.splice(idx, 1);
    socket.emit('matchmaking:cancelled');
  });

  // ── HAND ARRANGE READY ──
  socket.on('hand:reorder', ({ orderedCardIds }) => {
    const code = socketToRoom[socket.id];
    if (!code) return;
    const room = rooms[code];
    if (!room || !room.started) return;
    // Reorder this player's hand according to their arrangement
    if (Array.isArray(orderedCardIds) && room.hands[socket.id]) {
      const idMap = Object.fromEntries(room.hands[socket.id].map(c => [c.id, c]));
      const reordered = orderedCardIds.map(id => idMap[id]).filter(Boolean);
      if (reordered.length === room.hands[socket.id].length) {
        room.hands[socket.id] = reordered;
      }
    }
    room.arrangeAcks.add(socket.id);
    // Notify others that this player is ready
    room.players.forEach(p => {
      if (p.socketId !== socket.id) {
        io.to(p.socketId).emit('arrange:playerReady', { name: room.players.find(x => x.socketId === socket.id)?.name || 'Opponent' });
      }
    });
    // Once all players are ready, emit round:start for everyone
    if (room.arrangeAcks.size >= room.players.length) {
      room.arrangeAcks = new Set();
      emitRound(room);
    }
  });

  // ── SPECTATE ──
  socket.on('spectate:join', ({ spectatorName, code }) => {
    const upper = (code||'').toUpperCase();
    const room  = rooms[upper];
    if (!room) return socket.emit('room:error', { message: 'Room not found.' });
    if (!room.started) return socket.emit('room:error', { message: 'Game not started yet.' });

    const name = spectatorName || 'Spectator';
    room.spectators.push({ socketId: socket.id, name });
    socketToRoom[socket.id] = upper;
    socket.join(upper);

    // Send current game state to spectator
    const scores = Object.fromEntries(room.players.map(p => [p.socketId, p.score]));
    socket.emit('spectate:state', {
      players: room.players.map(p => ({ name: p.name, socketId: p.socketId, score: p.score })),
      round: room.round,
      totalRounds: TOTAL_ROUNDS,
      format: room.format,
      role: room.role || null,
      scores,
      pickerIndex: room.pickerIndex,
      pickerName: room.players[room.pickerIndex]?.name,
      roundPhase: room.roundPhase,
      roundStat: room.roundStat,
    });
    // Notify players
    room.players.forEach(p => io.to(p.socketId).emit('spectate:joined', { name }));
    console.log(`[spectate] ${name} joined room ${upper}`);
  });

  socket.on('spectate:leave', () => {
    const code = socketToRoom[socket.id];
    if (!code) return;
    const room = rooms[code];
    if (room) {
      room.spectators = room.spectators.filter(s => s.socketId !== socket.id);
    }
    delete socketToRoom[socket.id];
    socket.leave(code);
  });

  // ── TOSS READY (both press LET'S PLAY → go to arrange together) ──
  socket.on('toss:ready', () => {
    const code = socketToRoom[socket.id];
    if (!code) return;
    const room = rooms[code];
    if (!room || !room.started) return;
    room.tossReadyAcks.add(socket.id);
    if (room.tossReadyAcks.size >= room.players.length) {
      room.tossReadyAcks = new Set();
      room.players.forEach(p => io.to(p.socketId).emit('arrange:start'));
    }
  });

  // ── PICKER PICKS STAT ──
  socket.on('round:pick', ({ statKey }) => {
    const code = socketToRoom[socket.id];
    if (!code) return;
    const room = rooms[code];
    if (!room || room.finished || room.roundPhase !== 'pick') return;
    const picker = room.players[room.pickerIndex];
    if (socket.id !== picker.socketId) return;
    // Clear pick timer since picker responded in time
    if (room.pickTimer) { clearTimeout(room.pickTimer); room.pickTimer = null; }
    emitStatChosen(room, statKey);
  });

  // ── NON-PICKERS CONFIRM ──
  socket.on('round:confirm', () => {
    const code = socketToRoom[socket.id];
    if (!code) return;
    const room = rooms[code];
    if (!room || room.finished || room.roundPhase !== 'confirm') return;
    const picker = room.players[room.pickerIndex];
    if (socket.id === picker.socketId) return;
    room.confirmAcks.add(socket.id);
    const nonPickers = room.players.filter(p => p.socketId !== picker.socketId);
    if (room.confirmAcks.size >= nonPickers.length) {
      if (room.confirmTimer) { clearTimeout(room.confirmTimer); room.confirmTimer = null; }
      resolveRound(room);
    }
  });

  // ── NEXT ROUND ──
  socket.on('round:next', () => {
    const code = socketToRoom[socket.id];
    if (!code) return;
    const room = rooms[code];
    if (!room || room.finished) return;
    room.nextAcks.add(socket.id);
    if (room.nextAcks.size >= room.players.length) {
      room.nextAcks = new Set();
      room.round++;
      if (room.round >= TOTAL_ROUNDS) endGame(room, 'normal');
      else emitRound(room);
    }
  });

  // ── REMATCH ──
  socket.on('game:playAgain', () => {
    const code = socketToRoom[socket.id];
    if (!code) return;
    const room = rooms[code];
    if (!room) return;
    room.playAgainAcks.add(socket.id);
    if (room.playAgainAcks.size >= room.players.length) {
      // All players agreed — cancel any pending timeout and start new game
      if (room.playAgainTimer) { clearTimeout(room.playAgainTimer); room.playAgainTimer = null; }
      room.playAgainAcks = new Set();
      room.nextAcks = new Set();
      room.confirmAcks = new Set();
      room.finished = false; room.started = false;
      room.round = 0; room.pickerIndex = 0;
      room.roundStat = null; room.roundPhase = 'pick';
      room.players.forEach(p => { p.score = 0; });
      startGame(room);
    } else {
      // First/subsequent player to request rematch — notify ALL others and start 30s timeout
      room.players.forEach(p => {
        if (p.socketId !== socket.id) {
          io.to(p.socketId).emit('game:opponentWantsRematch', {
            name: room.players.find(x => x.socketId === socket.id)?.name || 'A player',
            readyCount: room.playAgainAcks.size,
            totalCount:  room.players.length,
          });
        }
      });
      if (room.playAgainTimer) clearTimeout(room.playAgainTimer);
      room.playAgainTimer = setTimeout(() => {
        if (!room || room.playAgainAcks.size < room.players.length) {
          // Timeout — notify all players that rematch was not accepted
          room.playAgainAcks = new Set();
          room.playAgainTimer = null;
          room.players.forEach(p => io.to(p.socketId).emit('game:rematchTimeout'));
        }
      }, 30000);
    }
  });

  // ── DISCONNECT ──
  socket.on('disconnect', () => {
    console.log(`[-] ${socket.id}`);

    // Clean up online lobby
    if (onlinePlayers[socket.id]) {
      delete onlinePlayers[socket.id];
      broadcastOnlinePlayers();
    }

    // Cancel any pending challenge
    if (pendingChallenges[socket.id]) {
      const { targetSocketId } = pendingChallenges[socket.id];
      setPlayerStatus(targetSocketId, 'lobby');
      io.to(targetSocketId).emit('challenge:cancelled', { challengerName: socket._playerName });
      delete pendingChallenges[socket.id];
    }
    // Also cancel challenges directed at this player
    for (const [cId, ch] of Object.entries(pendingChallenges)) {
      if (ch.targetSocketId === socket.id) {
        setPlayerStatus(cId, 'lobby');
        io.to(cId).emit('challenge:cancelled', { challengerName: 'Opponent' });
        delete pendingChallenges[cId];
      }
    }

    // Clean up matchmaking queue
    const mmIdx = matchmakingQueue.indexOf(socket);
    if (mmIdx !== -1) matchmakingQueue.splice(mmIdx, 1);

    // Clean up room
    const code = socketToRoom[socket.id];
    if (!code) return;
    delete socketToRoom[socket.id];
    const room = rooms[code];
    if (!room) return;

    const left = room.players.find(p => p.socketId === socket.id);
    const remaining = room.players.filter(p => p.socketId !== socket.id);

    if (room.started && !room.finished) {
      remaining.forEach(p => {
        io.to(p.socketId).emit('game:opponentDisconnected', { opponentName: left?.name || 'Opponent' });
        // Return remaining players to lobby
        if (onlinePlayers[p.socketId]) setPlayerStatus(p.socketId, 'lobby');
        delete socketToRoom[p.socketId];
      });
      endGame(room, 'disconnect');
    }
    delete rooms[code];
  });
});

server.listen(PORT, () => {
  console.log(`\n🏏 Superstar Cricket Cards server running on port ${PORT}`);
  console.log(`   Local: http://localhost:${PORT}\n`);
});


const ODI_CARDS = [
  { id:"sachin_tendulkar_odi", name:"Sachin Tendulkar", country:"India", role:"Batter", rarity:"Legendary", matches:463, runs:18426, fours:2016, sixes:195, fifties:96, hundreds:49, highestScore:200, strikeRate:86.23, bestBowlingWickets:5, bestBowlingRuns:32, economyRate:5.10, wickets:154, catches:140, stumpings:0 },
  { id:"ms_dhoni_odi", name:"MS Dhoni", country:"India", role:"Wicket-keeper", rarity:"Legendary", matches:350, runs:10773, fours:826, sixes:229, fifties:73, hundreds:10, highestScore:183, strikeRate:87.56, bestBowlingWickets:1, bestBowlingRuns:14, economyRate:5.93, wickets:1, catches:321, stumpings:123 },
  { id:"virat_kohli_odi", name:"Virat Kohli", country:"India", role:"Batter", rarity:"Legendary", matches:302, runs:14557, fours:1310, sixes:155, fifties:74, hundreds:54, highestScore:183, strikeRate:93.62, bestBowlingWickets:4, bestBowlingRuns:13, economyRate:6.39, wickets:4, catches:150, stumpings:0 },
  { id:"rohit_sharma_odi", name:"Rohit Sharma", country:"India", role:"Batter", rarity:"Legendary", matches:282, runs:11577, fours:1090, sixes:357, fifties:57, hundreds:32, highestScore:264, strikeRate:89.80, bestBowlingWickets:2, bestBowlingRuns:9, economyRate:5.42, wickets:8, catches:115, stumpings:0 },
  { id:"sourav_ganguly_odi", name:"Sourav Ganguly", country:"India", role:"All-rounder", rarity:"Epic", matches:311, runs:11363, fours:1122, sixes:190, fifties:72, hundreds:22, highestScore:183, strikeRate:73.70, bestBowlingWickets:5, bestBowlingRuns:16, economyRate:4.37, wickets:100, catches:100, stumpings:0 },
  { id:"yuvraj_singh_odi", name:"Yuvraj Singh", country:"India", role:"All-rounder", rarity:"Epic", matches:304, runs:8701, fours:779, sixes:284, fifties:52, hundreds:14, highestScore:150, strikeRate:87.66, bestBowlingWickets:5, bestBowlingRuns:31, economyRate:5.02, wickets:111, catches:89, stumpings:0 },
  { id:"jasprit_bumrah_odi", name:"Jasprit Bumrah", country:"India", role:"Bowler", rarity:"Legendary", matches:89, runs:65, fours:3, sixes:2, fifties:0, hundreds:0, highestScore:10, strikeRate:62.00, bestBowlingWickets:6, bestBowlingRuns:19, economyRate:4.60, wickets:149, catches:18, stumpings:0 },
  { id:"ricky_ponting_odi", name:"Ricky Ponting", country:"Australia", role:"Batter", rarity:"Legendary", matches:375, runs:13704, fours:1231, sixes:163, fifties:82, hundreds:30, highestScore:164, strikeRate:80.39, bestBowlingWickets:3, bestBowlingRuns:0, economyRate:4.73, wickets:3, catches:160, stumpings:0 },
  { id:"adam_gilchrist_odi", name:"Adam Gilchrist", country:"Australia", role:"Wicket-keeper", rarity:"Legendary", matches:287, runs:9619, fours:1000, sixes:149, fifties:55, hundreds:16, highestScore:172, strikeRate:96.94, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:417, stumpings:55 },
  { id:"brett_lee_odi", name:"Brett Lee", country:"Australia", role:"Bowler", rarity:"Epic", matches:221, runs:950, fours:59, sixes:32, fifties:2, hundreds:0, highestScore:52, strikeRate:83.04, bestBowlingWickets:5, bestBowlingRuns:22, economyRate:4.76, wickets:380, catches:49, stumpings:0 },
  { id:"shane_warne_odi", name:"Shane Warne", country:"Australia", role:"Bowler", rarity:"Legendary", matches:194, runs:1018, fours:78, sixes:8, fifties:1, hundreds:0, highestScore:55, strikeRate:68.92, bestBowlingWickets:5, bestBowlingRuns:33, economyRate:4.25, wickets:293, catches:80, stumpings:0 },
  { id:"mitchell_starc_odi", name:"Mitchell Starc", country:"Australia", role:"Bowler", rarity:"Epic", matches:130, runs:620, fours:35, sixes:18, fifties:0, hundreds:0, highestScore:52, strikeRate:91.00, bestBowlingWickets:6, bestBowlingRuns:28, economyRate:5.27, wickets:247, catches:26, stumpings:0 },
  { id:"steve_smith_odi", name:"Steve Smith", country:"Australia", role:"Batter", rarity:"Epic", matches:170, runs:5431, fours:439, sixes:67, fifties:36, hundreds:13, highestScore:164, strikeRate:86.55, bestBowlingWickets:3, bestBowlingRuns:26, economyRate:5.88, wickets:31, catches:83, stumpings:0 },
  { id:"david_warner_odi", name:"David Warner", country:"Australia", role:"Batter", rarity:"Epic", matches:161, runs:6932, fours:693, sixes:189, fifties:33, hundreds:22, highestScore:179, strikeRate:95.97, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:71, stumpings:0 },
  { id:"ben_stokes_odi", name:"Ben Stokes", country:"England", role:"All-rounder", rarity:"Epic", matches:114, runs:3463, fours:282, sixes:109, fifties:21, hundreds:3, highestScore:102, strikeRate:95.09, bestBowlingWickets:5, bestBowlingRuns:61, economyRate:6.19, wickets:74, catches:43, stumpings:0 },
  { id:"andrew_flintoff_odi", name:"Andrew Flintoff", country:"England", role:"All-rounder", rarity:"Epic", matches:141, runs:3394, fours:318, sixes:72, fifties:18, hundreds:3, highestScore:123, strikeRate:87.22, bestBowlingWickets:5, bestBowlingRuns:19, economyRate:4.89, wickets:169, catches:38, stumpings:0 },
  { id:"eoin_morgan_odi", name:"Eoin Morgan", country:"England", role:"Batter", rarity:"Rare", matches:248, runs:7701, fours:631, sixes:220, fifties:45, hundreds:13, highestScore:148, strikeRate:87.57, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:90, stumpings:0 },
  { id:"joe_root_odi", name:"Joe Root", country:"England", role:"Batter", rarity:"Epic", matches:174, runs:6977, fours:700, sixes:62, fifties:55, hundreds:16, highestScore:133, strikeRate:87.21, bestBowlingWickets:3, bestBowlingRuns:52, economyRate:5.71, wickets:20, catches:93, stumpings:0 },
  { id:"ab_devilliers_odi", name:"AB de Villiers", country:"South Africa", role:"Batter", rarity:"Legendary", matches:228, runs:9577, fours:839, sixes:204, fifties:53, hundreds:25, highestScore:176, strikeRate:101.10, bestBowlingWickets:1, bestBowlingRuns:47, economyRate:6.39, wickets:1, catches:232, stumpings:1 },
  { id:"shaun_pollock_odi", name:"Shaun Pollock", country:"South Africa", role:"All-rounder", rarity:"Epic", matches:303, runs:3519, fours:273, sixes:15, fifties:14, hundreds:0, highestScore:130, strikeRate:70.63, bestBowlingWickets:6, bestBowlingRuns:35, economyRate:3.67, wickets:393, catches:112, stumpings:0 },
  { id:"hashim_amla_odi", name:"Hashim Amla", country:"South Africa", role:"Batter", rarity:"Epic", matches:181, runs:8113, fours:835, sixes:64, fifties:48, hundreds:27, highestScore:159, strikeRate:88.93, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:60, stumpings:0 },
  { id:"jacques_kallis_odi", name:"Jacques Kallis", country:"South Africa", role:"All-rounder", rarity:"Legendary", matches:328, runs:11579, fours:1107, sixes:98, fifties:86, hundreds:17, highestScore:139, strikeRate:72.89, bestBowlingWickets:5, bestBowlingRuns:30, economyRate:4.06, wickets:273, catches:200, stumpings:0 },
  { id:"wasim_akram_odi", name:"Wasim Akram", country:"Pakistan", role:"Bowler", rarity:"Legendary", matches:356, runs:3717, fours:263, sixes:72, fifties:6, hundreds:3, highestScore:86, strikeRate:86.09, bestBowlingWickets:5, bestBowlingRuns:15, economyRate:3.89, wickets:502, catches:88, stumpings:0 },
  { id:"shahid_afridi_odi", name:"Shahid Afridi", country:"Pakistan", role:"All-rounder", rarity:"Legendary", matches:398, runs:8064, fours:687, sixes:351, fifties:39, hundreds:6, highestScore:124, strikeRate:117.00, bestBowlingWickets:7, bestBowlingRuns:12, economyRate:4.62, wickets:395, catches:125, stumpings:0 },
  { id:"babar_azam_odi", name:"Babar Azam", country:"Pakistan", role:"Batter", rarity:"Epic", matches:140, runs:6501, fours:601, sixes:68, fifties:43, hundreds:20, highestScore:158, strikeRate:87.89, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:46, stumpings:0 },
  { id:"waqar_younis_odi", name:"Waqar Younis", country:"Pakistan", role:"Bowler", rarity:"Epic", matches:262, runs:1010, fours:73, sixes:22, fifties:0, hundreds:0, highestScore:37, strikeRate:70.00, bestBowlingWickets:7, bestBowlingRuns:36, economyRate:4.68, wickets:416, catches:39, stumpings:0 },
  { id:"brian_lara_odi", name:"Brian Lara", country:"West Indies", role:"Batter", rarity:"Legendary", matches:299, runs:10405, fours:1058, sixes:97, fifties:63, hundreds:19, highestScore:169, strikeRate:79.29, bestBowlingWickets:4, bestBowlingRuns:37, economyRate:5.29, wickets:4, catches:120, stumpings:0 },
  { id:"chris_gayle_odi", name:"Chris Gayle", country:"West Indies", role:"Batter", rarity:"Legendary", matches:301, runs:10480, fours:1002, sixes:331, fifties:54, hundreds:25, highestScore:215, strikeRate:85.90, bestBowlingWickets:3, bestBowlingRuns:30, economyRate:5.05, wickets:167, catches:91, stumpings:0 },
  { id:"viv_richards_odi", name:"Viv Richards", country:"West Indies", role:"Batter", rarity:"Legendary", matches:187, runs:6721, fours:590, sixes:118, fifties:45, hundreds:11, highestScore:189, strikeRate:90.20, bestBowlingWickets:6, bestBowlingRuns:41, economyRate:4.98, wickets:118, catches:101, stumpings:0 },
  { id:"courtney_walsh_odi", name:"Courtney Walsh", country:"West Indies", role:"Bowler", rarity:"Rare", matches:205, runs:297, fours:14, sixes:2, fifties:0, hundreds:0, highestScore:30, strikeRate:44.67, bestBowlingWickets:5, bestBowlingRuns:1, economyRate:3.99, wickets:227, catches:32, stumpings:0 },
  { id:"brendon_mccullum_odi", name:"Brendon McCullum", country:"New Zealand", role:"Wicket-keeper", rarity:"Epic", matches:260, runs:6083, fours:537, sixes:200, fifties:30, hundreds:5, highestScore:166, strikeRate:96.98, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:377, stumpings:24 },
  { id:"kane_williamson_odi", name:"Kane Williamson", country:"New Zealand", role:"Batter", rarity:"Epic", matches:163, runs:6555, fours:610, sixes:63, fifties:46, hundreds:13, highestScore:148, strikeRate:81.30, bestBowlingWickets:4, bestBowlingRuns:22, economyRate:5.00, wickets:37, catches:67, stumpings:0 },
  { id:"trent_boult_odi", name:"Trent Boult", country:"New Zealand", role:"Bowler", rarity:"Rare", matches:114, runs:280, fours:20, sixes:7, fifties:0, hundreds:0, highestScore:26, strikeRate:63.02, bestBowlingWickets:7, bestBowlingRuns:34, economyRate:5.00, wickets:211, catches:38, stumpings:0 },
  { id:"kumar_sangakkara_odi", name:"Kumar Sangakkara", country:"Sri Lanka", role:"Wicket-keeper", rarity:"Legendary", matches:404, runs:14234, fours:1382, sixes:99, fifties:93, hundreds:25, highestScore:169, strikeRate:78.86, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:402, stumpings:99 },
  { id:"muttiah_muralitharan_odi", name:"Muttiah Muralitharan", country:"Sri Lanka", role:"Bowler", rarity:"Legendary", matches:350, runs:674, fours:45, sixes:4, fifties:0, hundreds:0, highestScore:33, strikeRate:58.98, bestBowlingWickets:7, bestBowlingRuns:30, economyRate:3.93, wickets:534, catches:131, stumpings:0 },
  { id:"lasith_malinga_odi", name:"Lasith Malinga", country:"Sri Lanka", role:"Bowler", rarity:"Epic", matches:226, runs:805, fours:49, sixes:29, fifties:0, hundreds:0, highestScore:56, strikeRate:91.39, bestBowlingWickets:6, bestBowlingRuns:38, economyRate:5.24, wickets:338, catches:34, stumpings:0 },
  { id:"sanath_jayasuriya_odi", name:"Sanath Jayasuriya", country:"Sri Lanka", role:"All-rounder", rarity:"Legendary", matches:445, runs:13430, fours:1500, sixes:270, fifties:68, hundreds:28, highestScore:189, strikeRate:91.20, bestBowlingWickets:6, bestBowlingRuns:29, economyRate:4.78, wickets:323, catches:123, stumpings:0 },
  { id:"shakib_al_hasan_odi", name:"Shakib Al Hasan", country:"Bangladesh", role:"All-rounder", rarity:"Epic", matches:247, runs:7570, fours:699, sixes:54, fifties:54, hundreds:9, highestScore:134, strikeRate:82.92, bestBowlingWickets:6, bestBowlingRuns:55, economyRate:4.45, wickets:299, catches:82, stumpings:0 },
  { id:"tamim_iqbal_odi", name:"Tamim Iqbal", country:"Bangladesh", role:"Batter", rarity:"Rare", matches:240, runs:8357, fours:906, sixes:107, fifties:56, hundreds:14, highestScore:158, strikeRate:80.68, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:63, stumpings:0 },
  { id:"rashid_khan_odi", name:"Rashid Khan", country:"Afghanistan", role:"Bowler", rarity:"Epic", matches:117, runs:1106, fours:104, sixes:37, fifties:3, hundreds:0, highestScore:60, strikeRate:103.50, bestBowlingWickets:7, bestBowlingRuns:18, economyRate:4.21, wickets:210, catches:28, stumpings:0 },

  // ── ADDITIONAL ODI PLAYERS ────────────────────────────────────────
  // Sources: myKhel, Wisden, ESPNcricinfo, cricket365 — May 2026

  // India
  { id:"rahul_dravid_odi", name:"Rahul Dravid", country:"India", role:"Batter", rarity:"Legendary", matches:344, runs:10889, fours:1146, sixes:42, fifties:83, hundreds:12, highestScore:153, strikeRate:71.19, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:196, stumpings:14 },
  { id:"kapil_dev_odi", name:"Kapil Dev", country:"India", role:"All-rounder", rarity:"Legendary", matches:225, runs:3783, fours:340, sixes:70, fifties:14, hundreds:1, highestScore:175, strikeRate:95.07, bestBowlingWickets:5, bestBowlingRuns:43, economyRate:5.56, wickets:253, catches:71, stumpings:0 },
  { id:"virender_sehwag_odi", name:"Virender Sehwag", country:"India", role:"Batter", rarity:"Epic", matches:251, runs:8273, fours:1000, sixes:186, fifties:38, hundreds:15, highestScore:219, strikeRate:104.33, bestBowlingWickets:3, bestBowlingRuns:17, economyRate:6.12, wickets:96, catches:96, stumpings:0 },
  { id:"sunil_gavaskar_odi", name:"Sunil Gavaskar", country:"India", role:"Batter", rarity:"Epic", matches:108, runs:3092, fours:273, sixes:1, fifties:27, hundreds:1, highestScore:103, strikeRate:62.33, bestBowlingWickets:1, bestBowlingRuns:9, economyRate:4.62, wickets:1, catches:22, stumpings:0 },
  { id:"zaheer_khan_odi", name:"Zaheer Khan", country:"India", role:"Bowler", rarity:"Epic", matches:200, runs:793, fours:58, sixes:17, fifties:0, hundreds:0, highestScore:39, strikeRate:71.28, bestBowlingWickets:5, bestBowlingRuns:42, economyRate:4.96, wickets:282, catches:38, stumpings:0 },
  { id:"harbhajan_singh_odi", name:"Harbhajan Singh", country:"India", role:"Bowler", rarity:"Epic", matches:236, runs:1237, fours:84, sixes:16, fifties:1, hundreds:0, highestScore:47, strikeRate:79.37, bestBowlingWickets:5, bestBowlingRuns:31, economyRate:4.61, wickets:269, catches:61, stumpings:0 },
  { id:"shubman_gill_odi", name:"Shubman Gill", country:"India", role:"Batter", rarity:"Epic", matches:62, runs:3127, fours:294, sixes:90, fifties:16, hundreds:9, highestScore:208, strikeRate:104.64, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:22, stumpings:0 },

  // Australia
  { id:"michael_clarke_odi", name:"Michael Clarke", country:"Australia", role:"Batter", rarity:"Epic", matches:245, runs:7981, fours:769, sixes:70, fifties:58, hundreds:8, highestScore:130, strikeRate:73.50, bestBowlingWickets:6, bestBowlingRuns:9, economyRate:4.87, wickets:58, catches:105, stumpings:0 },
  { id:"matthew_hayden_odi", name:"Matthew Hayden", country:"Australia", role:"Batter", rarity:"Epic", matches:161, runs:6133, fours:614, sixes:103, fifties:36, hundreds:10, highestScore:181, strikeRate:80.08, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:69, stumpings:0 },
  { id:"mark_waugh_odi", name:"Mark Waugh", country:"Australia", role:"Batter", rarity:"Epic", matches:244, runs:8500, fours:921, sixes:109, fifties:50, hundreds:18, highestScore:173, strikeRate:76.08, bestBowlingWickets:5, bestBowlingRuns:24, economyRate:5.30, wickets:85, catches:111, stumpings:0 },
  { id:"ian_healy_odi", name:"Ian Healy", country:"Australia", role:"Wicket-keeper", rarity:"Rare", matches:168, runs:1764, fours:155, sixes:10, fifties:4, hundreds:0, highestScore:58, strikeRate:59.71, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:194, stumpings:39 },
  { id:"nathan_lyon_odi", name:"Nathan Lyon", country:"Australia", role:"Bowler", rarity:"Rare", matches:28, runs:62, fours:4, sixes:0, fifties:0, hundreds:0, highestScore:17, strikeRate:56.36, bestBowlingWickets:4, bestBowlingRuns:23, economyRate:5.17, wickets:56, catches:14, stumpings:0 },
  { id:"pat_cummins_odi", name:"Pat Cummins", country:"Australia", role:"Bowler", rarity:"Epic", matches:106, runs:479, fours:33, sixes:14, fifties:0, hundreds:0, highestScore:40, strikeRate:94.86, bestBowlingWickets:5, bestBowlingRuns:28, economyRate:5.82, wickets:161, catches:30, stumpings:0 },

  // England
  { id:"andrew_strauss_odi", name:"Andrew Strauss", country:"England", role:"Batter", rarity:"Rare", matches:127, runs:4205, fours:422, sixes:48, fifties:25, hundreds:6, highestScore:158, strikeRate:74.75, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:64, stumpings:0 },
  { id:"kevin_pietersen_odi", name:"Kevin Pietersen", country:"England", role:"Batter", rarity:"Epic", matches:136, runs:4796, fours:452, sixes:105, fifties:25, hundreds:9, highestScore:130, strikeRate:86.93, bestBowlingWickets:3, bestBowlingRuns:20, economyRate:5.49, wickets:7, catches:72, stumpings:0 },
  { id:"marcus_trescothick_odi", name:"Marcus Trescothick", country:"England", role:"Batter", rarity:"Rare", matches:123, runs:4335, fours:467, sixes:61, fifties:21, hundreds:12, highestScore:137, strikeRate:85.79, bestBowlingWickets:4, bestBowlingRuns:36, economyRate:6.19, wickets:4, catches:56, stumpings:0 },
  { id:"darren_gough_odi", name:"Darren Gough", country:"England", role:"Bowler", rarity:"Rare", matches:159, runs:773, fours:72, sixes:14, fifties:0, hundreds:0, highestScore:29, strikeRate:77.15, bestBowlingWickets:5, bestBowlingRuns:44, economyRate:5.14, wickets:235, catches:33, stumpings:0 },

  // South Africa
  { id:"jonty_rhodes_odi", name:"Jonty Rhodes", country:"South Africa", role:"Batter", rarity:"Epic", matches:245, runs:5935, fours:528, sixes:62, fifties:33, hundreds:2, highestScore:121, strikeRate:72.77, bestBowlingWickets:2, bestBowlingRuns:27, economyRate:5.88, wickets:6, catches:105, stumpings:0 },
  { id:"lance_klusener_odi", name:"Lance Klusener", country:"South Africa", role:"All-rounder", rarity:"Epic", matches:171, runs:3576, fours:312, sixes:107, fifties:19, hundreds:0, highestScore:103, strikeRate:89.92, bestBowlingWickets:6, bestBowlingRuns:49, economyRate:4.71, wickets:192, catches:56, stumpings:0 },
  { id:"mark_boucher_odi", name:"Mark Boucher", country:"South Africa", role:"Wicket-keeper", rarity:"Epic", matches:295, runs:4686, fours:450, sixes:82, fifties:24, hundreds:5, highestScore:147, strikeRate:80.27, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:403, stumpings:22 },
  { id:"herschelle_gibbs_odi", name:"Herschelle Gibbs", country:"South Africa", role:"Batter", rarity:"Epic", matches:248, runs:8094, fours:876, sixes:122, fifties:37, hundreds:21, highestScore:175, strikeRate:82.73, bestBowlingWickets:2, bestBowlingRuns:17, economyRate:6.36, wickets:8, catches:109, stumpings:0 },

  // Pakistan
  { id:"saeed_anwar_odi", name:"Saeed Anwar", country:"Pakistan", role:"Batter", rarity:"Legendary", matches:247, runs:8824, fours:1063, sixes:90, fifties:43, hundreds:20, highestScore:194, strikeRate:80.18, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:60, stumpings:0 },
  { id:"inzamam_ul_haq_odi", name:"Inzamam-ul-Haq", country:"Pakistan", role:"Batter", rarity:"Legendary", matches:378, runs:11739, fours:971, sixes:144, fifties:83, hundreds:10, highestScore:137, strikeRate:74.24, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:121, stumpings:0 },
  { id:"javed_miandad_odi", name:"Javed Miandad", country:"Pakistan", role:"Batter", rarity:"Legendary", matches:233, runs:7381, fours:574, sixes:22, fifties:50, hundreds:8, highestScore:119, strikeRate:67.18, bestBowlingWickets:3, bestBowlingRuns:6, economyRate:3.89, wickets:7, catches:57, stumpings:1 },
  { id:"imran_khan_odi", name:"Imran Khan", country:"Pakistan", role:"All-rounder", rarity:"Legendary", matches:175, runs:3709, fours:330, sixes:36, fifties:19, hundreds:1, highestScore:102, strikeRate:72.73, bestBowlingWickets:6, bestBowlingRuns:14, economyRate:3.89, wickets:182, catches:30, stumpings:0 },
  { id:"shoaib_akhtar_odi", name:"Shoaib Akhtar", country:"Pakistan", role:"Bowler", rarity:"Epic", matches:163, runs:544, fours:39, sixes:18, fifties:0, hundreds:0, highestScore:43, strikeRate:74.83, bestBowlingWickets:6, bestBowlingRuns:16, economyRate:4.94, wickets:247, catches:26, stumpings:0 },
  { id:"amir_sohail_odi", name:"Aamir Sohail", country:"Pakistan", role:"Batter", rarity:"Rare", matches:156, runs:4958, fours:547, sixes:46, fifties:30, hundreds:7, highestScore:134, strikeRate:71.25, bestBowlingWickets:4, bestBowlingRuns:40, economyRate:4.63, wickets:39, catches:42, stumpings:0 },

  // Sri Lanka
  { id:"mahela_jayawardene_odi", name:"Mahela Jayawardene", country:"Sri Lanka", role:"Batter", rarity:"Legendary", matches:448, runs:12650, fours:1119, sixes:76, fifties:77, hundreds:19, highestScore:144, strikeRate:78.96, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:5.69, wickets:8, catches:218, stumpings:0 },
  { id:"tillakaratne_dilshan_odi", name:"T Dilshan", country:"Sri Lanka", role:"All-rounder", rarity:"Epic", matches:330, runs:10290, fours:1172, sixes:152, fifties:47, hundreds:22, highestScore:161, strikeRate:86.43, bestBowlingWickets:5, bestBowlingRuns:44, economyRate:6.47, wickets:106, catches:110, stumpings:7 },
  { id:"chaminda_vaas_odi", name:"Chaminda Vaas", country:"Sri Lanka", role:"Bowler", rarity:"Epic", matches:322, runs:2025, fours:152, sixes:29, fifties:2, hundreds:0, highestScore:50, strikeRate:64.12, bestBowlingWickets:8, bestBowlingRuns:19, economyRate:4.18, wickets:400, catches:63, stumpings:0 },
  { id:"arjuna_ranatunga_odi", name:"Arjuna Ranatunga", country:"Sri Lanka", role:"Batter", rarity:"Epic", matches:269, runs:7456, fours:689, sixes:49, fifties:49, hundreds:4, highestScore:131, strikeRate:71.77, bestBowlingWickets:2, bestBowlingRuns:13, economyRate:5.21, wickets:30, catches:61, stumpings:0 },
  { id:"aravinda_de_silva_odi", name:"Aravinda de Silva", country:"Sri Lanka", role:"Batter", rarity:"Legendary", matches:308, runs:9284, fours:942, sixes:121, fifties:64, hundreds:11, highestScore:145, strikeRate:80.45, bestBowlingWickets:5, bestBowlingRuns:20, economyRate:5.46, wickets:106, catches:103, stumpings:0 },

  // West Indies
  { id:"desmond_haynes_odi", name:"Desmond Haynes", country:"West Indies", role:"Batter", rarity:"Epic", matches:238, runs:8648, fours:902, sixes:65, fifties:57, hundreds:17, highestScore:152, strikeRate:67.05, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:77, stumpings:0 },
  { id:"carl_hooper_odi", name:"Carl Hooper", country:"West Indies", role:"All-rounder", rarity:"Rare", matches:227, runs:5761, fours:532, sixes:78, fifties:29, hundreds:7, highestScore:113, strikeRate:66.67, bestBowlingWickets:4, bestBowlingRuns:34, economyRate:4.50, wickets:193, catches:120, stumpings:0 },
  { id:"clive_lloyd_odi", name:"Clive Lloyd", country:"West Indies", role:"Batter", rarity:"Epic", matches:87, runs:1977, fours:195, sixes:53, fifties:10, hundreds:1, highestScore:102, strikeRate:74.80, bestBowlingWickets:2, bestBowlingRuns:22, economyRate:4.12, wickets:3, catches:41, stumpings:0 },

  // New Zealand
  { id:"stephen_fleming_odi", name:"Stephen Fleming", country:"New Zealand", role:"Batter", rarity:"Rare", matches:280, runs:8007, fours:791, sixes:54, fifties:49, hundreds:8, highestScore:134, strikeRate:70.91, bestBowlingWickets:1, bestBowlingRuns:4, economyRate:4.67, wickets:1, catches:133, stumpings:0 },
  { id:"ross_taylor_odi", name:"Ross Taylor", country:"New Zealand", role:"Batter", rarity:"Epic", matches:236, runs:8607, fours:804, sixes:165, fifties:55, hundreds:21, highestScore:181, strikeRate:83.19, bestBowlingWickets:2, bestBowlingRuns:15, economyRate:6.38, wickets:8, catches:131, stumpings:0 },
  { id:"chris_harris_odi", name:"Chris Harris", country:"New Zealand", role:"All-rounder", rarity:"Rare", matches:250, runs:4379, fours:358, sixes:36, fifties:25, hundreds:4, highestScore:130, strikeRate:61.13, bestBowlingWickets:7, bestBowlingRuns:19, economyRate:4.20, wickets:203, catches:84, stumpings:0 },
  { id:"daniel_vettori_odi", name:"Daniel Vettori", country:"New Zealand", role:"All-rounder", rarity:"Epic", matches:295, runs:2253, fours:167, sixes:15, fifties:8, hundreds:0, highestScore:79, strikeRate:69.05, bestBowlingWickets:5, bestBowlingRuns:7, economyRate:4.17, wickets:305, catches:110, stumpings:0 },
  { id:"chris_cairns_odi", name:"Chris Cairns", country:"New Zealand", role:"All-rounder", rarity:"Epic", matches:215, runs:4950, fours:465, sixes:143, fifties:26, hundreds:4, highestScore:115, strikeRate:74.45, bestBowlingWickets:5, bestBowlingRuns:42, economyRate:4.83, wickets:201, catches:74, stumpings:0 },

  // Zimbabwe / Other
  { id:"andy_flower_odi", name:"Andy Flower", country:"Zimbabwe", role:"Wicket-keeper", rarity:"Epic", matches:213, runs:6786, fours:611, sixes:71, fifties:55, hundreds:4, highestScore:145, strikeRate:72.44, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:141, stumpings:32 },
  { id:"heath_streak_odi", name:"Heath Streak", country:"Zimbabwe", role:"All-rounder", rarity:"Rare", matches:189, runs:2943, fours:247, sixes:36, fifties:15, hundreds:1, highestScore:77, strikeRate:68.98, bestBowlingWickets:5, bestBowlingRuns:32, economyRate:4.11, wickets:239, catches:53, stumpings:0 },
  { id:"mohammad_nabi_odi", name:"Mohammad Nabi", country:"Afghanistan", role:"All-rounder", rarity:"Rare", matches:141, runs:2488, fours:205, sixes:66, fifties:15, hundreds:1, highestScore:116, strikeRate:87.50, bestBowlingWickets:5, bestBowlingRuns:21, economyRate:4.47, wickets:167, catches:47, stumpings:0 },
  { id:"paul_collingwood_odi", name:"Paul Collingwood", country:"England", role:"All-rounder", rarity:"Rare", matches:197, runs:5092, fours:436, sixes:72, fifties:26, hundreds:5, highestScore:130, strikeRate:72.58, bestBowlingWickets:6, bestBowlingRuns:31, economyRate:5.17, wickets:40, catches:100, stumpings:0 },
  { id:"dinesh_chandimal_odi", name:"Dinesh Chandimal", country:"Sri Lanka", role:"Wicket-keeper", rarity:"Rare", matches:152, runs:4073, fours:360, sixes:74, fifties:27, hundreds:5, highestScore:119, strikeRate:77.70, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:117, stumpings:16 },
  { id:"angelo_mathews_odi", name:"Angelo Mathews", country:"Sri Lanka", role:"All-rounder", rarity:"Epic", matches:228, runs:7231, fours:603, sixes:90, fifties:52, hundreds:7, highestScore:139, strikeRate:76.81, bestBowlingWickets:4, bestBowlingRuns:43, economyRate:5.56, wickets:106, catches:83, stumpings:0 },
  { id:"imad_wasim_odi", name:"Imad Wasim", country:"Pakistan", role:"All-rounder", rarity:"Rare", matches:58, runs:724, fours:51, sixes:23, fifties:2, hundreds:0, highestScore:57, strikeRate:88.63, bestBowlingWickets:5, bestBowlingRuns:14, economyRate:4.80, wickets:75, catches:20, stumpings:0 },
  { id:"jason_holder_odi", name:"Jason Holder", country:"West Indies", role:"All-rounder", rarity:"Rare", matches:134, runs:1877, fours:143, sixes:52, fifties:8, hundreds:0, highestScore:99, strikeRate:84.43, bestBowlingWickets:5, bestBowlingRuns:27, economyRate:5.30, wickets:149, catches:46, stumpings:0 },
  { id:"martin_guptill_odi", name:"Martin Guptill", country:"New Zealand", role:"Batter", rarity:"Epic", matches:198, runs:7346, fours:674, sixes:207, fifties:40, hundreds:16, highestScore:237, strikeRate:87.56, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:77, stumpings:0 },
  { id:"dwayne_bravo_odi", name:"Dwayne Bravo", country:"West Indies", role:"All-rounder", rarity:"Epic", matches:164, runs:2200, fours:173, sixes:78, fifties:7, hundreds:0, highestScore:97, strikeRate:88.53, bestBowlingWickets:6, bestBowlingRuns:35, economyRate:5.76, wickets:199, catches:67, stumpings:0 },
  { id:"shoaib_malik_odi", name:"Shoaib Malik", country:"Pakistan", role:"All-rounder", rarity:"Rare", matches:287, runs:7534, fours:700, sixes:131, fifties:44, hundreds:9, highestScore:143, strikeRate:83.38, bestBowlingWickets:4, bestBowlingRuns:19, economyRate:5.18, wickets:158, catches:97, stumpings:0 },
  { id:"michael_hussey_odi", name:"Michael Hussey", country:"Australia", role:"Batter", rarity:"Epic", matches:185, runs:5442, fours:488, sixes:104, fifties:31, hundreds:3, highestScore:109, strikeRate:85.32, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:65, stumpings:0 },
  { id:"andrew_symonds_odi", name:"Andrew Symonds", country:"Australia", role:"All-rounder", rarity:"Epic", matches:198, runs:5088, fours:462, sixes:118, fifties:30, hundreds:6, highestScore:156, strikeRate:92.43, bestBowlingWickets:5, bestBowlingRuns:18, economyRate:5.34, wickets:133, catches:112, stumpings:0 },
  { id:"upul_tharanga_odi", name:"Upul Tharanga", country:"Sri Lanka", role:"Batter", rarity:"Rare", matches:235, runs:6951, fours:807, sixes:82, fifties:41, hundreds:14, highestScore:174, strikeRate:78.98, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:72, stumpings:0 },
  { id:"abdur_razzak_odi", name:"Abdur Razzak", country:"Bangladesh", role:"Bowler", rarity:"Common", matches:153, runs:478, fours:32, sixes:12, fifties:0, hundreds:0, highestScore:42, strikeRate:70.10, bestBowlingWickets:5, bestBowlingRuns:29, economyRate:4.52, wickets:207, catches:42, stumpings:0 },
  { id:"richard_hadlee_odi", name:"Richard Hadlee", country:"New Zealand", role:"All-rounder", rarity:"Legendary", matches:115, runs:1751, fours:157, sixes:32, fifties:8, hundreds:0, highestScore:79, strikeRate:79.27, bestBowlingWickets:5, bestBowlingRuns:25, economyRate:3.90, wickets:158, catches:22, stumpings:0 },
  { id:"waqar_younis_odi2", name:"Waqar Younis", country:"Pakistan", role:"Bowler", rarity:"Epic", matches:262, runs:1010, fours:73, sixes:22, fifties:0, hundreds:0, highestScore:37, strikeRate:70.00, bestBowlingWickets:7, bestBowlingRuns:36, economyRate:4.68, wickets:416, catches:39, stumpings:0 },
  { id:"shaun_pollock_odi2", name:"Shaun Pollock", country:"South Africa", role:"All-rounder", rarity:"Epic", matches:303, runs:3519, fours:273, sixes:15, fifties:14, hundreds:0, highestScore:130, strikeRate:70.63, bestBowlingWickets:6, bestBowlingRuns:35, economyRate:3.67, wickets:393, catches:112, stumpings:0 },
  { id:"peter_ingram_odi", name:"Jacob Oram", country:"New Zealand", role:"All-rounder", rarity:"Rare", matches:160, runs:3676, fours:313, sixes:74, fifties:20, hundreds:1, highestScore:101, strikeRate:75.61, bestBowlingWickets:5, bestBowlingRuns:26, economyRate:4.77, wickets:147, catches:52, stumpings:0 },
  { id:"kieron_pollard_odi", name:"Kieron Pollard", country:"West Indies", role:"All-rounder", rarity:"Epic", matches:101, runs:1896, fours:130, sixes:117, fifties:8, hundreds:0, highestScore:119, strikeRate:91.58, bestBowlingWickets:4, bestBowlingRuns:39, economyRate:5.78, wickets:56, catches:36, stumpings:0 },
];

const IPL_CARDS = [

  // ── TOP RUN SCORERS ───────────────────────────────────────────────
  { id:"virat_kohli_ipl", name:"Virat Kohli", country:"India", role:"Batter", rarity:"Legendary",
    team:"RCB", avatarUrl:null, avatarAlt:null,
    matches:281, runs:9012, fours:785, sixes:297,
    fifties:67, hundreds:8, highestScore:113,
    strikeRate:134.39,
    bestBowlingWickets:1, bestBowlingRuns:13, economyRate:8.10, wickets:4, catches:141, stumpings:0 },

  { id:"rohit_sharma_ipl", name:"Rohit Sharma", country:"India", role:"Batter", rarity:"Legendary",
    team:"MI", avatarUrl:null, avatarAlt:null,
    matches:276, runs:7183, fours:651, sixes:309,
    fifties:49, hundreds:2, highestScore:109,
    strikeRate:133.01,
    bestBowlingWickets:2, bestBowlingRuns:14, economyRate:8.20, wickets:15, catches:110, stumpings:0 },

  { id:"shikhar_dhawan_ipl", name:"Shikhar Dhawan", country:"India", role:"Batter", rarity:"Epic",
    team:"DC/SRH/PBKS", avatarUrl:null, avatarAlt:null,
    matches:222, runs:6769, fours:768, sixes:152,
    fifties:51, hundreds:2, highestScore:106,
    strikeRate:127.14,
    bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:88, stumpings:0 },

  { id:"david_warner_ipl", name:"David Warner", country:"Australia", role:"Batter", rarity:"Legendary",
    team:"SRH/DC", avatarUrl:null, avatarAlt:null,
    matches:184, runs:6565, fours:663, sixes:236,
    fifties:57, hundreds:4, highestScore:126,
    strikeRate:139.77,
    bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:71, stumpings:0 },

  { id:"suresh_raina_ipl", name:"Suresh Raina", country:"India", role:"Batter", rarity:"Legendary",
    team:"CSK/GL", avatarUrl:null, avatarAlt:null,
    matches:205, runs:5528, fours:564, sixes:185,
    fifties:38, hundreds:1, highestScore:100,
    strikeRate:136.76,
    bestBowlingWickets:3, bestBowlingRuns:12, economyRate:8.32, wickets:36, catches:109, stumpings:0 },

  { id:"ms_dhoni_ipl", name:"MS Dhoni", country:"India", role:"Wicket-keeper", rarity:"Legendary",
    team:"CSK", avatarUrl:null, avatarAlt:null,
    matches:278, runs:5439, fours:383, sixes:264,
    fifties:27, hundreds:0, highestScore:84,
    strikeRate:136.08,
    bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:175, stumpings:47 },

  { id:"ab_devilliers_ipl", name:"AB de Villiers", country:"South Africa", role:"Batter", rarity:"Legendary",
    team:"RCB", avatarUrl:null, avatarAlt:null,
    matches:184, runs:5162, fours:392, sixes:251,
    fifties:36, hundreds:3, highestScore:133,
    strikeRate:151.68,
    bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:147, stumpings:0 },

  { id:"kl_rahul_ipl", name:"KL Rahul", country:"India", role:"Wicket-keeper", rarity:"Epic",
    team:"RCB/PBKS/LSG", avatarUrl:null, avatarAlt:null,
    matches:132, runs:4683, fours:428, sixes:154,
    fifties:42, hundreds:4, highestScore:132,
    strikeRate:136.47,
    bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:105, stumpings:27 },

  { id:"chris_gayle_ipl", name:"Chris Gayle", country:"West Indies", role:"Batter", rarity:"Legendary",
    team:"KKR/RCB/PBKS", avatarUrl:null, avatarAlt:null,
    matches:142, runs:4965, fours:437, sixes:357,
    fifties:30, hundreds:6, highestScore:175,
    strikeRate:149.72,
    bestBowlingWickets:3, bestBowlingRuns:15, economyRate:7.81, wickets:22, catches:52, stumpings:0 },

  { id:"ambati_rayudu_ipl", name:"Ambati Rayudu", country:"India", role:"Batter", rarity:"Rare",
    team:"MI/CSK", avatarUrl:null, avatarAlt:null,
    matches:188, runs:4350, fours:382, sixes:165,
    fifties:30, hundreds:2, highestScore:100,
    strikeRate:131.20,
    bestBowlingWickets:2, bestBowlingRuns:14, economyRate:8.60, wickets:8, catches:75, stumpings:6 },

  { id:"gautam_gambhir_ipl", name:"Gautam Gambhir", country:"India", role:"Batter", rarity:"Epic",
    team:"DC/KKR", avatarUrl:null, avatarAlt:null,
    matches:154, runs:4217, fours:503, sixes:82,
    fifties:36, hundreds:0, highestScore:93,
    strikeRate:123.88,
    bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:55, stumpings:0 },

  { id:"ajinkya_rahane_ipl", name:"Ajinkya Rahane", country:"India", role:"Batter", rarity:"Rare",
    team:"RR/RPS/PBKS/KKR/CSK/DC", avatarUrl:null, avatarAlt:null,
    matches:167, runs:4173, fours:431, sixes:61,
    fifties:30, hundreds:1, highestScore:105,
    strikeRate:120.92,
    bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:82, stumpings:0 },

  { id:"rishabh_pant_ipl", name:"Rishabh Pant", country:"India", role:"Wicket-keeper", rarity:"Epic",
    team:"DC/LSG", avatarUrl:null, avatarAlt:null,
    matches:111, runs:3284, fours:265, sixes:153,
    fifties:18, hundreds:1, highestScore:128,
    strikeRate:147.95,
    bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:96, stumpings:17 },

  { id:"faf_du_plessis_ipl", name:"Faf du Plessis", country:"South Africa", role:"Batter", rarity:"Epic",
    team:"CSK/RPS/RCB", avatarUrl:null, avatarAlt:null,
    matches:143, runs:4263, fours:398, sixes:123,
    fifties:27, hundreds:3, highestScore:96,
    strikeRate:131.77,
    bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:71, stumpings:0 },

  { id:"shane_watson_ipl", name:"Shane Watson", country:"Australia", role:"All-rounder", rarity:"Epic",
    team:"RR/CSK", avatarUrl:null, avatarAlt:null,
    matches:145, runs:3874, fours:417, sixes:143,
    fifties:26, hundreds:4, highestScore:117,
    strikeRate:137.69,
    bestBowlingWickets:4, bestBowlingRuns:20, economyRate:8.24, wickets:92, catches:68, stumpings:0 },

  { id:"dinesh_karthik_ipl", name:"Dinesh Karthik", country:"India", role:"Wicket-keeper", rarity:"Rare",
    team:"DC/KKR/PBKS/MIM/RCB", avatarUrl:null, avatarAlt:null,
    matches:257, runs:4843, fours:441, sixes:200,
    fifties:25, hundreds:0, highestScore:83,
    strikeRate:134.67,
    bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:166, stumpings:28 },

  { id:"virender_sehwag_ipl", name:"Virender Sehwag", country:"India", role:"Batter", rarity:"Epic",
    team:"DC/KXIP", avatarUrl:null, avatarAlt:null,
    matches:104, runs:2728, fours:336, sixes:94,
    fifties:13, hundreds:1, highestScore:122,
    strikeRate:153.78,
    bestBowlingWickets:3, bestBowlingRuns:9, economyRate:8.78, wickets:11, catches:45, stumpings:0 },

  { id:"ishan_kishan_ipl", name:"Ishan Kishan", country:"India", role:"Wicket-keeper", rarity:"Rare",
    team:"MI/GT", avatarUrl:null, avatarAlt:null,
    matches:105, runs:2644, fours:222, sixes:131,
    fifties:17, hundreds:1, highestScore:99,
    strikeRate:136.21,
    bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:68, stumpings:22 },

  { id:"shubman_gill_ipl", name:"Shubman Gill", country:"India", role:"Batter", rarity:"Epic",
    team:"KKR/GT", avatarUrl:null, avatarAlt:null,
    matches:101, runs:3080, fours:286, sixes:79,
    fifties:23, hundreds:3, highestScore:129,
    strikeRate:135.46,
    bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:33, stumpings:0 },

  { id:"quinton_de_kock_ipl", name:"Quinton de Kock", country:"South Africa", role:"Wicket-keeper", rarity:"Epic",
    team:"RCB/MI/LSG", avatarUrl:null, avatarAlt:null,
    matches:107, runs:3386, fours:340, sixes:115,
    fifties:23, hundreds:3, highestScore:140,
    strikeRate:137.06,
    bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:86, stumpings:20 },

  { id:"jos_buttler_ipl", name:"Jos Buttler", country:"England", role:"Wicket-keeper", rarity:"Legendary",
    team:"MI/RR", avatarUrl:null, avatarAlt:null,
    matches:111, runs:3582, fours:302, sixes:168,
    fifties:26, hundreds:7, highestScore:124,
    strikeRate:148.79,
    bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:76, stumpings:29 },

  { id:"ruturaj_gaikwad_ipl", name:"Ruturaj Gaikwad", country:"India", role:"Batter", rarity:"Epic",
    team:"CSK", avatarUrl:null, avatarAlt:null,
    matches:87, runs:2760, fours:278, sixes:80,
    fifties:20, hundreds:3, highestScore:108,
    strikeRate:135.16,
    bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:36, stumpings:0 },

  { id:"sanju_samson_ipl", name:"Sanju Samson", country:"India", role:"Wicket-keeper", rarity:"Epic",
    team:"RR/DC", avatarUrl:null, avatarAlt:null,
    matches:175, runs:4832, fours:408, sixes:189,
    fifties:32, hundreds:4, highestScore:119,
    strikeRate:138.82,
    bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:122, stumpings:29 },

  { id:"devdutt_padikkal_ipl", name:"Devdutt Padikkal", country:"India", role:"Batter", rarity:"Rare",
    team:"RCB/RR/LSG/DC", avatarUrl:null, avatarAlt:null,
    matches:75, runs:1857, fours:184, sixes:55,
    fifties:14, hundreds:2, highestScore:101,
    strikeRate:130.63,
    bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:29, stumpings:0 },

  { id:"suryakumar_yadav_ipl", name:"Suryakumar Yadav", country:"India", role:"Batter", rarity:"Epic",
    team:"KKR/MI", avatarUrl:null, avatarAlt:null,
    matches:177, runs:4166, fours:355, sixes:201,
    fifties:26, hundreds:2, highestScore:103,
    strikeRate:144.13,
    bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:79, stumpings:0 },

  { id:"glenn_maxwell_ipl", name:"Glenn Maxwell", country:"Australia", role:"All-rounder", rarity:"Epic",
    team:"DC/MI/PBKS/RCB", avatarUrl:null, avatarAlt:null,
    matches:120, runs:2760, fours:212, sixes:151,
    fifties:14, hundreds:1, highestScore:95,
    strikeRate:154.26,
    bestBowlingWickets:4, bestBowlingRuns:27, economyRate:8.21, wickets:30, catches:52, stumpings:0 },

  // ── ALL-ROUNDERS ──────────────────────────────────────────────────
  { id:"hardik_pandya_ipl", name:"Hardik Pandya", country:"India", role:"All-rounder", rarity:"Legendary",
    team:"MI/GT", avatarUrl:null, avatarAlt:null,
    matches:148, runs:2800, fours:214, sixes:159,
    fifties:14, hundreds:0, highestScore:91,
    strikeRate:147.24,
    bestBowlingWickets:4, bestBowlingRuns:24, economyRate:9.07, wickets:80, catches:59, stumpings:0 },

  { id:"andre_russell_ipl", name:"Andre Russell", country:"West Indies", role:"All-rounder", rarity:"Legendary",
    team:"KKR", avatarUrl:null, avatarAlt:null,
    matches:125, runs:2836, fours:175, sixes:249,
    fifties:10, hundreds:0, highestScore:88,
    strikeRate:177.84,
    bestBowlingWickets:5, bestBowlingRuns:15, economyRate:9.34, wickets:91, catches:42, stumpings:0 },

  { id:"sunil_narine_ipl", name:"Sunil Narine", country:"West Indies", role:"All-rounder", rarity:"Legendary",
    team:"KKR", avatarUrl:null, avatarAlt:null,
    matches:179, runs:1798, fours:142, sixes:106,
    fifties:8, hundreds:1, highestScore:109,
    strikeRate:162.83,
    bestBowlingWickets:5, bestBowlingRuns:19, economyRate:6.78, wickets:192, catches:78, stumpings:0 },

  { id:"kieron_pollard_ipl", name:"Kieron Pollard", country:"West Indies", role:"All-rounder", rarity:"Legendary",
    team:"MI", avatarUrl:null, avatarAlt:null,
    matches:189, runs:3412, fours:219, sixes:223,
    fifties:16, hundreds:0, highestScore:87,
    strikeRate:147.32,
    bestBowlingWickets:4, bestBowlingRuns:22, economyRate:9.21, wickets:69, catches:75, stumpings:0 },

  { id:"ravindra_jadeja_ipl", name:"Ravindra Jadeja", country:"India", role:"All-rounder", rarity:"Epic",
    team:"RR/CSK", avatarUrl:null, avatarAlt:null,
    matches:254, runs:2777, fours:198, sixes:99,
    fifties:3, hundreds:0, highestScore:62,
    strikeRate:127.84,
    bestBowlingWickets:5, bestBowlingRuns:16, economyRate:7.67, wickets:170, catches:110, stumpings:0 },

  { id:"dwayne_bravo_ipl", name:"Dwayne Bravo", country:"West Indies", role:"All-rounder", rarity:"Epic",
    team:"CSK/GL/MI", avatarUrl:null, avatarAlt:null,
    matches:161, runs:1452, fours:96, sixes:73,
    fifties:2, hundreds:0, highestScore:68,
    strikeRate:130.89,
    bestBowlingWickets:4, bestBowlingRuns:22, economyRate:8.38, wickets:183, catches:53, stumpings:0 },

  { id:"mitchell_marsh_ipl", name:"Mitchell Marsh", country:"Australia", role:"All-rounder", rarity:"Rare",
    team:"PBKS/SRH/DC", avatarUrl:null, avatarAlt:null,
    matches:77, runs:1614, fours:148, sixes:79,
    fifties:9, hundreds:1, highestScore:89,
    strikeRate:139.66,
    bestBowlingWickets:3, bestBowlingRuns:14, economyRate:9.42, wickets:27, catches:28, stumpings:0 },

  { id:"irfan_pathan_ipl", name:"Irfan Pathan", country:"India", role:"All-rounder", rarity:"Rare",
    team:"KKR/RPS/SRH", avatarUrl:null, avatarAlt:null,
    matches:94, runs:977, fours:89, sixes:30,
    fifties:2, hundreds:0, highestScore:54,
    strikeRate:127.32,
    bestBowlingWickets:4, bestBowlingRuns:14, economyRate:8.22, wickets:65, catches:34, stumpings:0 },

  { id:"ben_stokes_ipl", name:"Ben Stokes", country:"England", role:"All-rounder", rarity:"Epic",
    team:"RR/CSK", avatarUrl:null, avatarAlt:null,
    matches:43, runs:920, fours:74, sixes:51,
    fifties:5, hundreds:1, highestScore:107,
    strikeRate:136.70,
    bestBowlingWickets:2, bestBowlingRuns:20, economyRate:9.44, wickets:28, catches:16, stumpings:0 },

  { id:"moeen_ali_ipl", name:"Moeen Ali", country:"England", role:"All-rounder", rarity:"Rare",
    team:"CSK/RCB", avatarUrl:null, avatarAlt:null,
    matches:75, runs:1080, fours:78, sixes:66,
    fifties:4, hundreds:0, highestScore:93,
    strikeRate:160.47,
    bestBowlingWickets:3, bestBowlingRuns:12, economyRate:7.61, wickets:53, catches:26, stumpings:0 },

  { id:"marcus_stoinis_ipl", name:"Marcus Stoinis", country:"Australia", role:"All-rounder", rarity:"Rare",
    team:"RCB/DC/LSG", avatarUrl:null, avatarAlt:null,
    matches:101, runs:1771, fours:142, sixes:84,
    fifties:8, hundreds:1, highestScore:65,
    strikeRate:138.36,
    bestBowlingWickets:4, bestBowlingRuns:23, economyRate:8.91, wickets:35, catches:37, stumpings:0 },

  { id:"sam_curran_ipl", name:"Sam Curran", country:"England", role:"All-rounder", rarity:"Rare",
    team:"CSK/PBKS", avatarUrl:null, avatarAlt:null,
    matches:57, runs:484, fours:32, sixes:27,
    fifties:1, hundreds:0, highestScore:55,
    strikeRate:137.10,
    bestBowlingWickets:5, bestBowlingRuns:10, economyRate:8.94, wickets:60, catches:14, stumpings:0 },

  { id:"krishnappa_gowtham_ipl", name:"K Gowtham", country:"India", role:"All-rounder", rarity:"Common",
    team:"RR/CSK/PBKS", avatarUrl:null, avatarAlt:null,
    matches:49, runs:421, fours:27, sixes:26,
    fifties:1, hundreds:0, highestScore:72,
    strikeRate:168.40,
    bestBowlingWickets:3, bestBowlingRuns:9, economyRate:8.88, wickets:35, catches:11, stumpings:0 },

  // ── BOWLERS ───────────────────────────────────────────────────────
  { id:"yuzvendra_chahal_ipl", name:"Yuzvendra Chahal", country:"India", role:"Bowler", rarity:"Legendary",
    team:"RCB/RR/MI/PBKS", avatarUrl:null, avatarAlt:null,
    matches:175, runs:115, fours:5, sixes:3,
    fifties:0, hundreds:0, highestScore:18,
    strikeRate:91.27,
    bestBowlingWickets:5, bestBowlingRuns:40, economyRate:7.84, wickets:221, catches:44, stumpings:0 },

  { id:"jasprit_bumrah_ipl", name:"Jasprit Bumrah", country:"India", role:"Bowler", rarity:"Legendary",
    team:"MI", avatarUrl:null, avatarAlt:null,
    matches:145, runs:55, fours:2, sixes:1,
    fifties:0, hundreds:0, highestScore:7,
    strikeRate:55.00,
    bestBowlingWickets:5, bestBowlingRuns:10, economyRate:7.40, wickets:183, catches:45, stumpings:0 },

  { id:"bhuvneshwar_kumar_ipl", name:"Bhuvneshwar Kumar", country:"India", role:"Bowler", rarity:"Epic",
    team:"SRH/PWI", avatarUrl:null, avatarAlt:null,
    matches:177, runs:300, fours:18, sixes:5,
    fifties:0, hundreds:0, highestScore:23,
    strikeRate:89.02,
    bestBowlingWickets:5, bestBowlingRuns:19, economyRate:7.71, wickets:198, catches:39, stumpings:0 },

  { id:"piyush_chawla_ipl", name:"Piyush Chawla", country:"India", role:"Bowler", rarity:"Epic",
    team:"CSK/KKR/PBKS/MI", avatarUrl:null, avatarAlt:null,
    matches:192, runs:312, fours:17, sixes:8,
    fifties:0, hundreds:0, highestScore:20,
    strikeRate:100.32,
    bestBowlingWickets:4, bestBowlingRuns:17, economyRate:7.96, wickets:192, catches:52, stumpings:0 },

  { id:"lasith_malinga_ipl", name:"Lasith Malinga", country:"Sri Lanka", role:"Bowler", rarity:"Legendary",
    team:"MI", avatarUrl:null, avatarAlt:null,
    matches:122, runs:161, fours:9, sixes:5,
    fifties:0, hundreds:0, highestScore:18,
    strikeRate:91.47,
    bestBowlingWickets:5, bestBowlingRuns:13, economyRate:7.14, wickets:170, catches:27, stumpings:0 },

  { id:"amit_mishra_ipl", name:"Amit Mishra", country:"India", role:"Bowler", rarity:"Epic",
    team:"DC/SRH/LSG", avatarUrl:null, avatarAlt:null,
    matches:162, runs:142, fours:6, sixes:2,
    fifties:0, hundreds:0, highestScore:21,
    strikeRate:87.65,
    bestBowlingWickets:5, bestBowlingRuns:17, economyRate:7.37, wickets:174, catches:38, stumpings:0 },

  { id:"rashid_khan_ipl", name:"Rashid Khan", country:"Afghanistan", role:"Bowler", rarity:"Legendary",
    team:"SRH/GT", avatarUrl:null, avatarAlt:null,
    matches:118, runs:420, fours:23, sixes:18,
    fifties:0, hundreds:0, highestScore:40,
    strikeRate:148.94,
    bestBowlingWickets:4, bestBowlingRuns:7, economyRate:6.33, wickets:158, catches:41, stumpings:0 },

  { id:"harbhajan_singh_ipl", name:"Harbhajan Singh", country:"India", role:"Bowler", rarity:"Epic",
    team:"MI/CSK/KKR", avatarUrl:null, avatarAlt:null,
    matches:163, runs:542, fours:34, sixes:11,
    fifties:1, hundreds:0, highestScore:61,
    strikeRate:118.34,
    bestBowlingWickets:5, bestBowlingRuns:18, economyRate:7.05, wickets:150, catches:41, stumpings:0 },

  { id:"ravichandran_ashwin_ipl", name:"R Ashwin", country:"India", role:"Bowler", rarity:"Epic",
    team:"CSK/PBKS/DC/RR", avatarUrl:null, avatarAlt:null,
    matches:221, runs:642, fours:41, sixes:11,
    fifties:0, hundreds:0, highestScore:46,
    strikeRate:109.02,
    bestBowlingWickets:4, bestBowlingRuns:34, economyRate:7.20, wickets:187, catches:64, stumpings:0 },

  { id:"kagiso_rabada_ipl", name:"Kagiso Rabada", country:"South Africa", role:"Bowler", rarity:"Epic",
    team:"DC/PBKS/GT", avatarUrl:null, avatarAlt:null,
    matches:94, runs:88, fours:4, sixes:2,
    fifties:0, hundreds:0, highestScore:10,
    strikeRate:60.27,
    bestBowlingWickets:4, bestBowlingRuns:21, economyRate:8.68, wickets:130, catches:23, stumpings:0 },

  { id:"trent_boult_ipl", name:"Trent Boult", country:"New Zealand", role:"Bowler", rarity:"Epic",
    team:"MI/SRH/RR/GT", avatarUrl:null, avatarAlt:null,
    matches:86, runs:40, fours:1, sixes:1,
    fifties:0, hundreds:0, highestScore:8,
    strikeRate:50.63,
    bestBowlingWickets:4, bestBowlingRuns:18, economyRate:8.26, wickets:105, catches:19, stumpings:0 },

  { id:"alzarri_joseph_ipl", name:"Alzarri Joseph", country:"West Indies", role:"Bowler", rarity:"Rare",
    team:"MI/GT", avatarUrl:null, avatarAlt:null,
    matches:48, runs:42, fours:2, sixes:1,
    fifties:0, hundreds:0, highestScore:9,
    strikeRate:84.00,
    bestBowlingWickets:6, bestBowlingRuns:12, economyRate:8.80, wickets:58, catches:11, stumpings:0 },

  { id:"harshal_patel_ipl", name:"Harshal Patel", country:"India", role:"Bowler", rarity:"Epic",
    team:"RCB/SRH", avatarUrl:null, avatarAlt:null,
    matches:103, runs:145, fours:7, sixes:3,
    fifties:0, hundreds:0, highestScore:19,
    strikeRate:96.67,
    bestBowlingWickets:5, bestBowlingRuns:27, economyRate:8.80, wickets:140, catches:24, stumpings:0 },

  { id:"deepak_chahar_ipl", name:"Deepak Chahar", country:"India", role:"Bowler", rarity:"Rare",
    team:"CSK/RR", avatarUrl:null, avatarAlt:null,
    matches:108, runs:198, fours:11, sixes:4,
    fifties:0, hundreds:0, highestScore:26,
    strikeRate:95.65,
    bestBowlingWickets:4, bestBowlingRuns:13, economyRate:7.72, wickets:100, catches:22, stumpings:0 },

  { id:"prasidh_krishna_ipl", name:"Prasidh Krishna", country:"India", role:"Bowler", rarity:"Rare",
    team:"KKR/RR/GT", avatarUrl:null, avatarAlt:null,
    matches:75, runs:62, fours:2, sixes:1,
    fifties:0, hundreds:0, highestScore:8,
    strikeRate:62.00,
    bestBowlingWickets:4, bestBowlingRuns:30, economyRate:9.04, wickets:93, catches:14, stumpings:0 },

  { id:"mitchell_starc_ipl", name:"Mitchell Starc", country:"Australia", role:"Bowler", rarity:"Epic",
    team:"KKR", avatarUrl:null, avatarAlt:null,
    matches:13, runs:12, fours:0, sixes:0,
    fifties:0, hundreds:0, highestScore:7,
    strikeRate:85.71,
    bestBowlingWickets:3, bestBowlingRuns:14, economyRate:8.94, wickets:17, catches:4, stumpings:0 },

  { id:"umesh_yadav_ipl", name:"Umesh Yadav", country:"India", role:"Bowler", rarity:"Rare",
    team:"DC/KKR/MI/RCB", avatarUrl:null, avatarAlt:null,
    matches:109, runs:88, fours:4, sixes:2,
    fifties:0, hundreds:0, highestScore:11,
    strikeRate:62.41,
    bestBowlingWickets:4, bestBowlingRuns:20, economyRate:8.92, wickets:101, catches:17, stumpings:0 },

  { id:"sandeep_sharma_ipl", name:"Sandeep Sharma", country:"India", role:"Bowler", rarity:"Common",
    team:"PBKS/SRH/RR", avatarUrl:null, avatarAlt:null,
    matches:106, runs:62, fours:2, sixes:1,
    fifties:0, hundreds:0, highestScore:8,
    strikeRate:49.60,
    bestBowlingWickets:5, bestBowlingRuns:18, economyRate:8.18, wickets:108, catches:15, stumpings:0 },

  { id:"andrew_tye_ipl", name:"Andrew Tye", country:"Australia", role:"Bowler", rarity:"Rare",
    team:"PBKS/GT", avatarUrl:null, avatarAlt:null,
    matches:39, runs:28, fours:1, sixes:1,
    fifties:0, hundreds:0, highestScore:6,
    strikeRate:58.33,
    bestBowlingWickets:5, bestBowlingRuns:17, economyRate:8.84, wickets:57, catches:8, stumpings:0 },

  { id:"imran_tahir_ipl", name:"Imran Tahir", country:"South Africa", role:"Bowler", rarity:"Epic",
    team:"CSK/DC", avatarUrl:null, avatarAlt:null,
    matches:62, runs:28, fours:0, sixes:1,
    fifties:0, hundreds:0, highestScore:9,
    strikeRate:58.33,
    bestBowlingWickets:4, bestBowlingRuns:15, economyRate:7.47, wickets:89, catches:19, stumpings:0 },

  { id:"ravi_bopara_ipl", name:"Ravi Bopara", country:"England", role:"All-rounder", rarity:"Common",
    team:"PBKS/SRH", avatarUrl:null, avatarAlt:null,
    matches:40, runs:557, fours:41, sixes:18,
    fifties:2, hundreds:0, highestScore:55,
    strikeRate:138.16,
    bestBowlingWickets:3, bestBowlingRuns:17, economyRate:8.43, wickets:20, catches:14, stumpings:0 },

  { id:"axar_patel_ipl", name:"Axar Patel", country:"India", role:"All-rounder", rarity:"Rare",
    team:"PBKS/DC/GT", avatarUrl:null, avatarAlt:null,
    matches:133, runs:888, fours:54, sixes:35,
    fifties:1, hundreds:0, highestScore:42,
    strikeRate:127.73,
    bestBowlingWickets:4, bestBowlingRuns:21, economyRate:7.32, wickets:100, catches:47, stumpings:0 },

  { id:"washington_sundar_ipl", name:"Washington Sundar", country:"India", role:"All-rounder", rarity:"Rare",
    team:"RCB/SRH/GT", avatarUrl:null, avatarAlt:null,
    matches:97, runs:617, fours:39, sixes:17,
    fifties:1, hundreds:0, highestScore:51,
    strikeRate:120.19,
    bestBowlingWickets:4, bestBowlingRuns:12, economyRate:7.11, wickets:78, catches:27, stumpings:0 },

  // ── MORE BATTERS ──────────────────────────────────────────────────
  { id:"yuvraj_singh_ipl", name:"Yuvraj Singh", country:"India", role:"Batter", rarity:"Epic",
    team:"PBKS/RCB/MI/SRH", avatarUrl:null, avatarAlt:null,
    matches:132, runs:2750, fours:246, sixes:141,
    fifties:18, hundreds:1, highestScore:83,
    strikeRate:133.58,
    bestBowlingWickets:2, bestBowlingRuns:14, economyRate:8.83, wickets:17, catches:48, stumpings:0 },

  { id:"robin_uthappa_ipl", name:"Robin Uthappa", country:"India", role:"Wicket-keeper", rarity:"Rare",
    team:"RCB/PBKS/KKR/RR/CSK", avatarUrl:null, avatarAlt:null,
    matches:197, runs:4952, fours:525, sixes:160,
    fifties:27, hundreds:2, highestScore:88,
    strikeRate:131.19,
    bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:93, stumpings:28 },

  { id:"manish_pandey_ipl", name:"Manish Pandey", country:"India", role:"Batter", rarity:"Rare",
    team:"RCB/KKR/SRH/PBKS", avatarUrl:null, avatarAlt:null,
    matches:174, runs:3889, fours:341, sixes:90,
    fifties:25, hundreds:1, highestScore:114,
    strikeRate:122.64,
    bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:68, stumpings:0 },

  { id:"murali_vijay_ipl", name:"Murali Vijay", country:"India", role:"Batter", rarity:"Common",
    team:"CSK/PBKS/DC", avatarUrl:null, avatarAlt:null,
    matches:111, runs:2619, fours:297, sixes:66,
    fifties:16, hundreds:1, highestScore:127,
    strikeRate:120.91,
    bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:44, stumpings:0 },

  { id:"parthiv_patel_ipl", name:"Parthiv Patel", country:"India", role:"Wicket-keeper", rarity:"Common",
    team:"MI/RCB/CSK/SRH", avatarUrl:null, avatarAlt:null,
    matches:143, runs:2848, fours:333, sixes:75,
    fifties:9, hundreds:1, highestScore:100,
    strikeRate:128.64,
    bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:116, stumpings:26 },

  { id:"nicholas_pooran_ipl", name:"Nicholas Pooran", country:"West Indies", role:"Wicket-keeper", rarity:"Epic",
    team:"PBKS/SRH/LSG", avatarUrl:null, avatarAlt:null,
    matches:89, runs:1998, fours:132, sixes:120,
    fifties:13, hundreds:0, highestScore:77,
    strikeRate:154.88,
    bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:65, stumpings:15 },

  { id:"david_miller_ipl", name:"David Miller", country:"South Africa", role:"Batter", rarity:"Epic",
    team:"PBKS/GT/RR", avatarUrl:null, avatarAlt:null,
    matches:139, runs:3000, fours:208, sixes:155,
    fifties:20, hundreds:2, highestScore:101,
    strikeRate:141.43,
    bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:52, stumpings:0 },

  { id:"brendon_mccullum_ipl", name:"Brendon McCullum", country:"New Zealand", role:"Wicket-keeper", rarity:"Epic",
    team:"KKR/CSK/RCB", avatarUrl:null, avatarAlt:null,
    matches:109, runs:2880, fours:300, sixes:127,
    fifties:18, hundreds:2, highestScore:158,
    strikeRate:131.38,
    bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:64, stumpings:25 },

  { id:"aaron_finch_ipl", name:"Aaron Finch", country:"Australia", role:"Batter", rarity:"Rare",
    team:"RCB/MI/SRH/GT", avatarUrl:null, avatarAlt:null,
    matches:66, runs:1445, fours:134, sixes:60,
    fifties:9, hundreds:1, highestScore:96,
    strikeRate:130.88,
    bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:27, stumpings:0 },

  { id:"jason_roy_ipl", name:"Jason Roy", country:"England", role:"Batter", rarity:"Rare",
    team:"GT/DC", avatarUrl:null, avatarAlt:null,
    matches:30, runs:706, fours:72, sixes:34,
    fifties:5, hundreds:0, highestScore:73,
    strikeRate:146.57,
    bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:11, stumpings:0 },

  { id:"evin_lewis_ipl", name:"Evin Lewis", country:"West Indies", role:"Batter", rarity:"Rare",
    team:"MI/RR", avatarUrl:null, avatarAlt:null,
    matches:39, runs:944, fours:88, sixes:60,
    fifties:5, hundreds:1, highestScore:101,
    strikeRate:144.05,
    bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:14, stumpings:0 },

  { id:"alex_hales_ipl", name:"Alex Hales", country:"England", role:"Batter", rarity:"Rare",
    team:"SRH/PBKS/KKR/MI", avatarUrl:null, avatarAlt:null,
    matches:32, runs:793, fours:77, sixes:36,
    fifties:6, hundreds:1, highestScore:116,
    strikeRate:143.12,
    bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:9, stumpings:0 },

  { id:"mayank_agarwal_ipl", name:"Mayank Agarwal", country:"India", role:"Batter", rarity:"Rare",
    team:"KKR/PBKS/SRH", avatarUrl:null, avatarAlt:null,
    matches:118, runs:2971, fours:260, sixes:112,
    fifties:21, hundreds:3, highestScore:106,
    strikeRate:139.28,
    bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:33, stumpings:0 },

  { id:"prithvi_shaw_ipl", name:"Prithvi Shaw", country:"India", role:"Batter", rarity:"Rare",
    team:"DC", avatarUrl:null, avatarAlt:null,
    matches:76, runs:1936, fours:235, sixes:63,
    fifties:11, hundreds:1, highestScore:99,
    strikeRate:148.31,
    bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:23, stumpings:0 },

  { id:"abhishek_sharma_ipl", name:"Abhishek Sharma", country:"India", role:"All-rounder", rarity:"Epic",
    team:"PBKS/SRH", avatarUrl:null, avatarAlt:null,
    matches:57, runs:1458, fours:121, sixes:91,
    fifties:10, hundreds:2, highestScore:135,
    strikeRate:171.26,
    bestBowlingWickets:3, bestBowlingRuns:17, economyRate:8.48, wickets:21, catches:19, stumpings:0 },

  { id:"tim_david_ipl", name:"Tim David", country:"Singapore", role:"Batter", rarity:"Epic",
    team:"MI", avatarUrl:null, avatarAlt:null,
    matches:42, runs:979, fours:62, sixes:76,
    fifties:6, hundreds:0, highestScore:95,
    strikeRate:169.78,
    bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:15, stumpings:0 },

  { id:"rinku_singh_ipl", name:"Rinku Singh", country:"India", role:"Batter", rarity:"Rare",
    team:"KKR", avatarUrl:null, avatarAlt:null,
    matches:60, runs:1208, fours:79, sixes:72,
    fifties:7, hundreds:0, highestScore:74,
    strikeRate:159.68,
    bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:18, stumpings:0 },

  { id:"tilak_varma_ipl", name:"Tilak Varma", country:"India", role:"Batter", rarity:"Rare",
    team:"MI", avatarUrl:null, avatarAlt:null,
    matches:54, runs:1284, fours:98, sixes:63,
    fifties:8, hundreds:2, highestScore:111,
    strikeRate:141.97,
    bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:22, stumpings:0 },

  { id:"yashasvi_jaiswal_ipl", name:"Yashasvi Jaiswal", country:"India", role:"Batter", rarity:"Epic",
    team:"RR", avatarUrl:null, avatarAlt:null,
    matches:54, runs:1808, fours:166, sixes:89,
    fifties:14, hundreds:2, highestScore:124,
    strikeRate:162.34,
    bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:19, stumpings:0 },

  // ── MORE BOWLERS ──────────────────────────────────────────────────
  { id:"rp_singh_ipl", name:"RP Singh", country:"India", role:"Bowler", rarity:"Common",
    team:"DC/KKR/MI/SRH", avatarUrl:null, avatarAlt:null,
    matches:95, runs:122, fours:5, sixes:3,
    fifties:0, hundreds:0, highestScore:14,
    strikeRate:68.54,
    bestBowlingWickets:4, bestBowlingRuns:24, economyRate:8.04, wickets:97, catches:20, stumpings:0 },

  { id:"dhawal_kulkarni_ipl", name:"Dhawal Kulkarni", country:"India", role:"Bowler", rarity:"Common",
    team:"MI/RR/GT", avatarUrl:null, avatarAlt:null,
    matches:65, runs:44, fours:1, sixes:0,
    fifties:0, hundreds:0, highestScore:6,
    strikeRate:52.38,
    bestBowlingWickets:4, bestBowlingRuns:20, economyRate:7.82, wickets:65, catches:13, stumpings:0 },

  { id:"shahbaz_ahmed_ipl", name:"Shahbaz Ahmed", country:"India", role:"All-rounder", rarity:"Common",
    team:"RCB/SRH", avatarUrl:null, avatarAlt:null,
    matches:70, runs:803, fours:61, sixes:35,
    fifties:4, hundreds:0, highestScore:72,
    strikeRate:138.69,
    bestBowlingWickets:4, bestBowlingRuns:28, economyRate:7.96, wickets:47, catches:24, stumpings:0 },

  { id:"varun_chakravarthy_ipl", name:"Varun Chakravarthy", country:"India", role:"Bowler", rarity:"Rare",
    team:"KKR", avatarUrl:null, avatarAlt:null,
    matches:75, runs:35, fours:1, sixes:0,
    fifties:0, hundreds:0, highestScore:5,
    strikeRate:48.61,
    bestBowlingWickets:4, bestBowlingRuns:13, economyRate:7.19, wickets:96, catches:17, stumpings:0 },

  { id:"noor_ahmed_ipl", name:"Noor Ahmad", country:"Afghanistan", role:"Bowler", rarity:"Rare",
    team:"GT/CSK", avatarUrl:null, avatarAlt:null,
    matches:41, runs:42, fours:2, sixes:1,
    fifties:0, hundreds:0, highestScore:9,
    strikeRate:84.00,
    bestBowlingWickets:4, bestBowlingRuns:11, economyRate:7.21, wickets:52, catches:9, stumpings:0 },

  { id:"kuldeep_yadav_ipl", name:"Kuldeep Yadav", country:"India", role:"Bowler", rarity:"Epic",
    team:"KKR/DC/MI", avatarUrl:null, avatarAlt:null,
    matches:93, runs:96, fours:4, sixes:2,
    fifties:0, hundreds:0, highestScore:15,
    strikeRate:72.18,
    bestBowlingWickets:5, bestBowlingRuns:24, economyRate:8.08, wickets:112, catches:23, stumpings:0 },

  { id:"mohit_sharma_ipl", name:"Mohit Sharma", country:"India", role:"Bowler", rarity:"Rare",
    team:"CSK/SRH/GT", avatarUrl:null, avatarAlt:null,
    matches:78, runs:62, fours:2, sixes:1,
    fifties:0, hundreds:0, highestScore:8,
    strikeRate:60.19,
    bestBowlingWickets:5, bestBowlingRuns:16, economyRate:8.22, wickets:89, catches:12, stumpings:0 },

  { id:"arshdeep_singh_ipl", name:"Arshdeep Singh", country:"India", role:"Bowler", rarity:"Epic",
    team:"PBKS", avatarUrl:null, avatarAlt:null,
    matches:85, runs:70, fours:2, sixes:1,
    fifties:0, hundreds:0, highestScore:10,
    strikeRate:58.82,
    bestBowlingWickets:5, bestBowlingRuns:32, economyRate:8.64, wickets:108, catches:14, stumpings:0 },

  { id:"zaheer_khan_ipl", name:"Zaheer Khan", country:"India", role:"Bowler", rarity:"Epic",
    team:"MI/DC/RCB", avatarUrl:null, avatarAlt:null,
    matches:100, runs:120, fours:6, sixes:2,
    fifties:0, hundreds:0, highestScore:13,
    strikeRate:76.43,
    bestBowlingWickets:4, bestBowlingRuns:19, economyRate:7.69, wickets:102, catches:26, stumpings:0 },

  { id:"pragyan_ojha_ipl", name:"Pragyan Ojha", country:"India", role:"Bowler", rarity:"Common",
    team:"DC/MI/SRH", avatarUrl:null, avatarAlt:null,
    matches:100, runs:84, fours:3, sixes:1,
    fifties:0, hundreds:0, highestScore:12,
    strikeRate:84.00,
    bestBowlingWickets:4, bestBowlingRuns:20, economyRate:7.36, wickets:104, catches:24, stumpings:0 },

  { id:"morne_morkel_ipl", name:"Morne Morkel", country:"South Africa", role:"Bowler", rarity:"Rare",
    team:"DC/KKR/RR", avatarUrl:null, avatarAlt:null,
    matches:74, runs:82, fours:3, sixes:2,
    fifties:0, hundreds:0, highestScore:10,
    strikeRate:62.59,
    bestBowlingWickets:4, bestBowlingRuns:28, economyRate:7.96, wickets:81, catches:16, stumpings:0 },

  { id:"ishant_sharma_ipl", name:"Ishant Sharma", country:"India", role:"Bowler", rarity:"Rare",
    team:"KKR/DC/SRH/PBKS", avatarUrl:null, avatarAlt:null,
    matches:78, runs:62, fours:2, sixes:1,
    fifties:0, hundreds:0, highestScore:6,
    strikeRate:62.00,
    bestBowlingWickets:4, bestBowlingRuns:21, economyRate:8.68, wickets:75, catches:12, stumpings:0 },

  { id:"sohail_tanvir_ipl", name:"Sohail Tanvir", country:"Pakistan", role:"Bowler", rarity:"Rare",
    team:"RR/PBKS", avatarUrl:null, avatarAlt:null,
    matches:47, runs:98, fours:5, sixes:4,
    fifties:0, hundreds:0, highestScore:29,
    strikeRate:124.05,
    bestBowlingWickets:6, bestBowlingRuns:14, economyRate:8.10, wickets:64, catches:13, stumpings:0 },

  { id:"shaun_tait_ipl", name:"Shaun Tait", country:"Australia", role:"Bowler", rarity:"Rare",
    team:"RR/MI/SRH", avatarUrl:null, avatarAlt:null,
    matches:28, runs:28, fours:1, sixes:1,
    fifties:0, hundreds:0, highestScore:10,
    strikeRate:107.69,
    bestBowlingWickets:4, bestBowlingRuns:16, economyRate:8.72, wickets:38, catches:7, stumpings:0 },

  { id:"shivam_mavi_ipl", name:"Shivam Mavi", country:"India", role:"Bowler", rarity:"Common",
    team:"KKR/GT", avatarUrl:null, avatarAlt:null,
    matches:48, runs:78, fours:4, sixes:3,
    fifties:0, hundreds:0, highestScore:14,
    strikeRate:96.29,
    bestBowlingWickets:4, bestBowlingRuns:21, economyRate:8.86, wickets:47, catches:8, stumpings:0 },

  { id:"simarjeet_singh_ipl", name:"Simarjeet Singh", country:"India", role:"Bowler", rarity:"Common",
    team:"CSK/MI", avatarUrl:null, avatarAlt:null,
    matches:22, runs:14, fours:0, sixes:0,
    fifties:0, hundreds:0, highestScore:4,
    strikeRate:46.67,
    bestBowlingWickets:3, bestBowlingRuns:18, economyRate:8.50, wickets:24, catches:4, stumpings:0 },

  { id:"liam_livingstone_ipl", name:"Liam Livingstone", country:"England", role:"All-rounder", rarity:"Epic",
    team:"PBKS", avatarUrl:null, avatarAlt:null,
    matches:45, runs:1068, fours:72, sixes:79,
    fifties:5, hundreds:0, highestScore:94,
    strikeRate:174.63,
    bestBowlingWickets:4, bestBowlingRuns:26, economyRate:9.28, wickets:23, catches:17, stumpings:0 },

  { id:"krunal_pandya_ipl", name:"Krunal Pandya", country:"India", role:"All-rounder", rarity:"Rare",
    team:"MI/LSG/DC", avatarUrl:null, avatarAlt:null,
    matches:122, runs:1378, fours:87, sixes:63,
    fifties:4, hundreds:0, highestScore:86,
    strikeRate:129.28,
    bestBowlingWickets:3, bestBowlingRuns:10, economyRate:7.98, wickets:78, catches:42, stumpings:0 },

  { id:"shardul_thakur_ipl", name:"Shardul Thakur", country:"India", role:"All-rounder", rarity:"Rare",
    team:"CSK/DC/KKR/PBKS", avatarUrl:null, avatarAlt:null,
    matches:96, runs:608, fours:40, sixes:29,
    fifties:1, hundreds:0, highestScore:67,
    strikeRate:145.10,
    bestBowlingWickets:4, bestBowlingRuns:24, economyRate:9.42, wickets:91, catches:26, stumpings:0 },

  { id:"wriddhiman_saha_ipl", name:"Wriddhiman Saha", country:"India", role:"Wicket-keeper", rarity:"Common",
    team:"CSK/KKR/PBKS/SRH/GT", avatarUrl:null, avatarAlt:null,
    matches:164, runs:2427, fours:253, sixes:57,
    fifties:12, hundreds:1, highestScore:115,
    strikeRate:125.27,
    bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:155, stumpings:31 },

  { id:"naman_ojha_ipl", name:"Naman Ojha", country:"India", role:"Wicket-keeper", rarity:"Common",
    team:"SRH/DC/MI", avatarUrl:null, avatarAlt:null,
    matches:83, runs:1254, fours:130, sixes:28,
    fifties:6, hundreds:0, highestScore:89,
    strikeRate:116.74,
    bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:62, stumpings:12 },

  { id:"jaydev_unadkat_ipl", name:"Jaydev Unadkat", country:"India", role:"Bowler", rarity:"Common",
    team:"RR/CSK/MI", avatarUrl:null, avatarAlt:null,
    matches:96, runs:134, fours:7, sixes:3,
    fifties:0, hundreds:0, highestScore:17,
    strikeRate:83.23,
    bestBowlingWickets:5, bestBowlingRuns:7, economyRate:8.64, wickets:88, catches:20, stumpings:0 },

  { id:"chris_morris_ipl", name:"Chris Morris", country:"South Africa", role:"All-rounder", rarity:"Epic",
    team:"DC/CSK/RR", avatarUrl:null, avatarAlt:null,
    matches:70, runs:658, fours:39, sixes:41,
    fifties:1, hundreds:0, highestScore:82,
    strikeRate:184.87,
    bestBowlingWickets:4, bestBowlingRuns:23, economyRate:8.89, wickets:80, catches:23, stumpings:0 },

  { id:"shivam_dube_ipl", name:"Shivam Dube", country:"India", role:"All-rounder", rarity:"Epic",
    team:"MI/RCB/CSK", avatarUrl:null, avatarAlt:null,
    matches:91, runs:1618, fours:95, sixes:108,
    fifties:7, hundreds:0, highestScore:95,
    strikeRate:156.35,
    bestBowlingWickets:3, bestBowlingRuns:16, economyRate:9.73, wickets:30, catches:28, stumpings:0 },

  { id:"chris_jordan_ipl", name:"Chris Jordan", country:"England", role:"Bowler", rarity:"Rare",
    team:"PBKS/RCB/CSK/SRH/MI", avatarUrl:null, avatarAlt:null,
    matches:56, runs:176, fours:8, sixes:9,
    fifties:0, hundreds:0, highestScore:37,
    strikeRate:157.14,
    bestBowlingWickets:4, bestBowlingRuns:22, economyRate:9.29, wickets:64, catches:21, stumpings:0 },

  { id:"maheesh_theekshana_ipl", name:"Maheesh Theekshana", country:"Sri Lanka", role:"Bowler", rarity:"Rare",
    team:"CSK", avatarUrl:null, avatarAlt:null,
    matches:38, runs:28, fours:0, sixes:1,
    fifties:0, hundreds:0, highestScore:6,
    strikeRate:56.00,
    bestBowlingWickets:4, bestBowlingRuns:13, economyRate:7.42, wickets:46, catches:9, stumpings:0 },

  { id:"matheesha_pathirana_ipl", name:"Matheesha Pathirana", country:"Sri Lanka", role:"Bowler", rarity:"Epic",
    team:"CSK", avatarUrl:null, avatarAlt:null,
    matches:48, runs:18, fours:0, sixes:0,
    fifties:0, hundreds:0, highestScore:4,
    strikeRate:40.00,
    bestBowlingWickets:4, bestBowlingRuns:16, economyRate:7.65, wickets:60, catches:10, stumpings:0 },

];

const TEST_CARDS = [

  // ── INDIA ───────────────────────────────────────────────────────
  { id:"sachin_tendulkar_test", name:"Sachin Tendulkar", country:"India", role:"Batter", rarity:"Legendary", avatarUrl:null,
    matches:200, runs:15921, fours:2058, sixes:69, fifties:68, hundreds:51, highestScore:248,
    strikeRate:54.09, bestBowlingWickets:3, bestBowlingRuns:10, economyRate:2.57, wickets:46, catches:115, stumpings:0 },

  { id:"rahul_dravid_test", name:"Rahul Dravid", country:"India", role:"Batter", rarity:"Legendary", avatarUrl:null,
    matches:164, runs:13288, fours:1654, sixes:6, fifties:63, hundreds:36, highestScore:270,
    strikeRate:42.52, bestBowlingWickets:1, bestBowlingRuns:18, economyRate:3.07, wickets:1, catches:210, stumpings:0 },

  { id:"virat_kohli_test", name:"Virat Kohli", country:"India", role:"Batter", rarity:"Legendary", avatarUrl:null,
    matches:123, runs:9230, fours:1091, sixes:27, fifties:31, hundreds:30, highestScore:254,
    strikeRate:57.02, bestBowlingWickets:1, bestBowlingRuns:20, economyRate:4.01, wickets:1, catches:107, stumpings:0 },

  { id:"sunil_gavaskar_test", name:"Sunil Gavaskar", country:"India", role:"Batter", rarity:"Legendary", avatarUrl:null,
    matches:125, runs:10122, fours:1177, sixes:0, fifties:45, hundreds:34, highestScore:236,
    strikeRate:51.12, bestBowlingWickets:1, bestBowlingRuns:34, economyRate:1.74, wickets:1, catches:108, stumpings:0 },

  { id:"anil_kumble_test", name:"Anil Kumble", country:"India", role:"Bowler", rarity:"Legendary", avatarUrl:null,
    matches:132, runs:2506, fours:218, sixes:6, fifties:5, hundreds:0, highestScore:110,
    strikeRate:41.11, bestBowlingWickets:10, bestBowlingRuns:74, economyRate:2.69, wickets:619, catches:62, stumpings:0 },

  { id:"ravichandran_ashwin_test", name:"R Ashwin", country:"India", role:"Bowler", rarity:"Legendary", avatarUrl:null,
    matches:106, runs:3503, fours:391, sixes:14, fifties:14, hundreds:6, highestScore:124,
    strikeRate:52.24, bestBowlingWickets:9, bestBowlingRuns:72, economyRate:2.78, wickets:537, catches:84, stumpings:0 },

  { id:"ms_dhoni_test", name:"MS Dhoni", country:"India", role:"Wicket-keeper", rarity:"Epic", avatarUrl:null,
    matches:90, runs:4876, fours:436, sixes:78, fifties:33, hundreds:6, highestScore:224,
    strikeRate:59.45, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:256, stumpings:38 },

  { id:"virender_sehwag_test", name:"Virender Sehwag", country:"India", role:"Batter", rarity:"Legendary", avatarUrl:null,
    matches:104, runs:8586, fours:1195, sixes:91, fifties:32, hundreds:23, highestScore:319,
    strikeRate:82.23, bestBowlingWickets:4, bestBowlingRuns:35, economyRate:4.01, wickets:40, catches:91, stumpings:0 },

  { id:"kapil_dev_test", name:"Kapil Dev", country:"India", role:"All-rounder", rarity:"Legendary", avatarUrl:null,
    matches:131, runs:5248, fours:546, sixes:114, fifties:27, hundreds:8, highestScore:163,
    strikeRate:59.52, bestBowlingWickets:9, bestBowlingRuns:83, economyRate:2.92, wickets:434, catches:64, stumpings:0 },

  { id:"ravindra_jadeja_test", name:"Ravindra Jadeja", country:"India", role:"All-rounder", rarity:"Epic", avatarUrl:null,
    matches:77, runs:3201, fours:360, sixes:20, fifties:19, hundreds:4, highestScore:175,
    strikeRate:55.56, bestBowlingWickets:7, bestBowlingRuns:42, economyRate:2.52, wickets:298, catches:81, stumpings:0 },

  { id:"shubman_gill_test", name:"Shubman Gill", country:"India", role:"Batter", rarity:"Epic", avatarUrl:null,
    matches:34, runs:2560, fours:308, sixes:22, fifties:11, hundreds:6, highestScore:210,
    strikeRate:57.84, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:18, stumpings:0 },

  // ── AUSTRALIA ────────────────────────────────────────────────────
  { id:"ricky_ponting_test", name:"Ricky Ponting", country:"Australia", role:"Batter", rarity:"Legendary", avatarUrl:null,
    matches:168, runs:13378, fours:1496, sixes:73, fifties:62, hundreds:41, highestScore:257,
    strikeRate:58.77, bestBowlingWickets:1, bestBowlingRuns:0, economyRate:4.13, wickets:5, catches:196, stumpings:0 },

  { id:"steve_waugh_test", name:"Steve Waugh", country:"Australia", role:"Batter", rarity:"Legendary", avatarUrl:null,
    matches:168, runs:10927, fours:1073, sixes:46, fifties:50, hundreds:32, highestScore:200,
    strikeRate:49.01, bestBowlingWickets:5, bestBowlingRuns:28, economyRate:3.09, wickets:92, catches:112, stumpings:0 },

  { id:"shane_warne_test", name:"Shane Warne", country:"Australia", role:"Bowler", rarity:"Legendary", avatarUrl:null,
    matches:145, runs:3154, fours:272, sixes:57, fifties:12, hundreds:0, highestScore:99,
    strikeRate:54.60, bestBowlingWickets:8, bestBowlingRuns:71, economyRate:2.65, wickets:708, catches:125, stumpings:0 },

  { id:"glenn_mcgrath_test", name:"Glenn McGrath", country:"Australia", role:"Bowler", rarity:"Legendary", avatarUrl:null,
    matches:124, runs:641, fours:68, sixes:0, fifties:0, hundreds:0, highestScore:61,
    strikeRate:25.48, bestBowlingWickets:8, bestBowlingRuns:24, economyRate:2.49, wickets:563, catches:38, stumpings:0 },

  { id:"matthew_hayden_test", name:"Matthew Hayden", country:"Australia", role:"Batter", rarity:"Epic", avatarUrl:null,
    matches:103, runs:8625, fours:1040, sixes:85, fifties:29, hundreds:30, highestScore:380,
    strikeRate:59.56, bestBowlingWickets:1, bestBowlingRuns:0, economyRate:2.99, wickets:3, catches:128, stumpings:0 },

  { id:"adam_gilchrist_test", name:"Adam Gilchrist", country:"Australia", role:"Wicket-keeper", rarity:"Legendary", avatarUrl:null,
    matches:96, runs:5570, fours:594, sixes:100, fifties:26, hundreds:17, highestScore:204,
    strikeRate:81.95, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:379, stumpings:37 },

  { id:"nathan_lyon_test", name:"Nathan Lyon", country:"Australia", role:"Bowler", rarity:"Epic", avatarUrl:null,
    matches:135, runs:1374, fours:134, sixes:8, fifties:0, hundreds:0, highestScore:47,
    strikeRate:30.68, bestBowlingWickets:8, bestBowlingRuns:50, economyRate:2.94, wickets:530, catches:48, stumpings:0 },

  { id:"pat_cummins_test", name:"Pat Cummins", country:"Australia", role:"Bowler", rarity:"Epic", avatarUrl:null,
    matches:67, runs:1220, fours:107, sixes:14, fifties:2, hundreds:0, highestScore:66,
    strikeRate:45.52, bestBowlingWickets:7, bestBowlingRuns:23, economyRate:3.28, wickets:299, catches:26, stumpings:0 },

  // ── ENGLAND ──────────────────────────────────────────────────────
  { id:"joe_root_test", name:"Joe Root", country:"England", role:"Batter", rarity:"Legendary", avatarUrl:null,
    matches:150, runs:13943, fours:1604, sixes:71, fifties:66, hundreds:38, highestScore:254,
    strikeRate:54.91, bestBowlingWickets:5, bestBowlingRuns:8, economyRate:3.01, wickets:49, catches:162, stumpings:0 },

  { id:"alastair_cook_test", name:"Alastair Cook", country:"England", role:"Batter", rarity:"Legendary", avatarUrl:null,
    matches:161, runs:12472, fours:1484, sixes:9, fifties:57, hundreds:33, highestScore:294,
    strikeRate:46.44, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:175, stumpings:0 },

  { id:"james_anderson_test", name:"James Anderson", country:"England", role:"Bowler", rarity:"Legendary", avatarUrl:null,
    matches:188, runs:1369, fours:127, sixes:1, fifties:0, hundreds:0, highestScore:81,
    strikeRate:28.39, bestBowlingWickets:7, bestBowlingRuns:42, economyRate:2.79, wickets:704, catches:59, stumpings:0 },

  { id:"stuart_broad_test", name:"Stuart Broad", country:"England", role:"Bowler", rarity:"Legendary", avatarUrl:null,
    matches:167, runs:3662, fours:349, sixes:58, fifties:13, hundreds:1, highestScore:169,
    strikeRate:42.45, bestBowlingWickets:8, bestBowlingRuns:15, economyRate:2.94, wickets:604, catches:56, stumpings:0 },

  { id:"ben_stokes_test", name:"Ben Stokes", country:"England", role:"All-rounder", rarity:"Legendary", avatarUrl:null,
    matches:112, runs:7082, fours:793, sixes:119, fifties:40, hundreds:15, highestScore:258,
    strikeRate:58.55, bestBowlingWickets:6, bestBowlingRuns:22, economyRate:3.17, wickets:203, catches:117, stumpings:0 },

  // ── SOUTH AFRICA ─────────────────────────────────────────────────
  { id:"jacques_kallis_test", name:"Jacques Kallis", country:"South Africa", role:"All-rounder", rarity:"Legendary", avatarUrl:null,
    matches:166, runs:13289, fours:1231, sixes:97, fifties:58, hundreds:45, highestScore:224,
    strikeRate:46.57, bestBowlingWickets:6, bestBowlingRuns:54, economyRate:2.77, wickets:292, catches:200, stumpings:0 },

  { id:"hashim_amla_test", name:"Hashim Amla", country:"South Africa", role:"Batter", rarity:"Epic", avatarUrl:null,
    matches:124, runs:9282, fours:1059, sixes:31, fifties:46, hundreds:28, highestScore:311,
    strikeRate:52.31, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:82, stumpings:0 },

  { id:"graeme_smith_test", name:"Graeme Smith", country:"South Africa", role:"Batter", rarity:"Epic", avatarUrl:null,
    matches:117, runs:9265, fours:1116, sixes:32, fifties:38, hundreds:27, highestScore:277,
    strikeRate:47.85, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:104, stumpings:0 },

  { id:"dale_steyn_test", name:"Dale Steyn", country:"South Africa", role:"Bowler", rarity:"Legendary", avatarUrl:null,
    matches:93, runs:1189, fours:117, sixes:21, fifties:1, hundreds:0, highestScore:76,
    strikeRate:37.62, bestBowlingWickets:7, bestBowlingRuns:51, economyRate:3.24, wickets:439, catches:39, stumpings:0 },

  { id:"morne_morkel_test", name:"Morne Morkel", country:"South Africa", role:"Bowler", rarity:"Rare", avatarUrl:null,
    matches:86, runs:887, fours:78, sixes:16, fifties:1, hundreds:0, highestScore:52,
    strikeRate:28.79, bestBowlingWickets:6, bestBowlingRuns:23, economyRate:3.13, wickets:309, catches:24, stumpings:0 },

  // ── PAKISTAN ─────────────────────────────────────────────────────
  { id:"younis_khan_test", name:"Younis Khan", country:"Pakistan", role:"Batter", rarity:"Legendary", avatarUrl:null,
    matches:118, runs:10099, fours:1063, sixes:44, fifties:33, hundreds:34, highestScore:313,
    strikeRate:52.79, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:133, stumpings:0 },

  { id:"wasim_akram_test", name:"Wasim Akram", country:"Pakistan", role:"Bowler", rarity:"Legendary", avatarUrl:null,
    matches:104, runs:2898, fours:279, sixes:55, fifties:7, hundreds:3, highestScore:257,
    strikeRate:48.21, bestBowlingWickets:7, bestBowlingRuns:119, economyRate:2.76, wickets:414, catches:44, stumpings:0 },

  { id:"waqar_younis_test", name:"Waqar Younis", country:"Pakistan", role:"Bowler", rarity:"Epic", avatarUrl:null,
    matches:87, runs:1010, fours:101, sixes:9, fifties:1, hundreds:0, highestScore:45,
    strikeRate:38.71, bestBowlingWickets:7, bestBowlingRuns:76, economyRate:3.41, wickets:373, catches:19, stumpings:0 },

  { id:"babar_azam_test", name:"Babar Azam", country:"Pakistan", role:"Batter", rarity:"Epic", avatarUrl:null,
    matches:55, runs:3898, fours:444, sixes:21, fifties:23, hundreds:9, highestScore:196,
    strikeRate:50.21, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:40, stumpings:0 },

  // ── WEST INDIES ──────────────────────────────────────────────────
  { id:"brian_lara_test", name:"Brian Lara", country:"West Indies", role:"Batter", rarity:"Legendary", avatarUrl:null,
    matches:131, runs:11953, fours:1463, sixes:88, fifties:48, hundreds:34, highestScore:400,
    strikeRate:52.88, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:164, stumpings:0 },

  { id:"shivnarine_chanderpaul_test", name:"S Chanderpaul", country:"West Indies", role:"Batter", rarity:"Epic", avatarUrl:null,
    matches:164, runs:11867, fours:1287, sixes:60, fifties:66, hundreds:30, highestScore:203,
    strikeRate:43.02, bestBowlingWickets:2, bestBowlingRuns:27, economyRate:3.13, wickets:9, catches:115, stumpings:0 },

  { id:"curtly_ambrose_test", name:"Curtly Ambrose", country:"West Indies", role:"Bowler", rarity:"Legendary", avatarUrl:null,
    matches:98, runs:1439, fours:128, sixes:17, fifties:1, hundreds:0, highestScore:53,
    strikeRate:28.35, bestBowlingWickets:8, bestBowlingRuns:45, economyRate:2.52, wickets:405, catches:22, stumpings:0 },

  { id:"malcolm_marshall_test", name:"Malcolm Marshall", country:"West Indies", role:"Bowler", rarity:"Legendary", avatarUrl:null,
    matches:81, runs:1810, fours:164, sixes:24, fifties:6, hundreds:0, highestScore:92,
    strikeRate:48.22, bestBowlingWickets:7, bestBowlingRuns:22, economyRate:2.68, wickets:376, catches:25, stumpings:0 },

  // ── SRI LANKA ────────────────────────────────────────────────────
  { id:"kumar_sangakkara_test", name:"Kumar Sangakkara", country:"Sri Lanka", role:"Wicket-keeper", rarity:"Legendary", avatarUrl:null,
    matches:134, runs:12400, fours:1420, sixes:52, fifties:52, hundreds:38, highestScore:319,
    strikeRate:57.40, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:182, stumpings:20 },

  { id:"muttiah_muralitharan_test", name:"Muttiah Muralitharan", country:"Sri Lanka", role:"Bowler", rarity:"Legendary", avatarUrl:null,
    matches:133, runs:1261, fours:91, sixes:10, fifties:0, hundreds:0, highestScore:67,
    strikeRate:24.64, bestBowlingWickets:9, bestBowlingRuns:51, economyRate:2.47, wickets:800, catches:72, stumpings:0 },

  { id:"mahela_jayawardene_test", name:"Mahela Jayawardene", country:"Sri Lanka", role:"Batter", rarity:"Legendary", avatarUrl:null,
    matches:149, runs:11814, fours:1358, sixes:59, fifties:50, hundreds:34, highestScore:374,
    strikeRate:56.03, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:205, stumpings:0 },

  // ── NEW ZEALAND ──────────────────────────────────────────────────
  { id:"kane_williamson_test", name:"Kane Williamson", country:"New Zealand", role:"Batter", rarity:"Epic", avatarUrl:null,
    matches:101, runs:8026, fours:893, sixes:26, fifties:41, hundreds:25, highestScore:251,
    strikeRate:52.43, bestBowlingWickets:4, bestBowlingRuns:44, economyRate:2.98, wickets:19, catches:93, stumpings:0 },

  { id:"richard_hadlee_test", name:"Richard Hadlee", country:"New Zealand", role:"All-rounder", rarity:"Legendary", avatarUrl:null,
    matches:86, runs:3124, fours:288, sixes:38, fifties:15, hundreds:2, highestScore:151,
    strikeRate:48.39, bestBowlingWickets:9, bestBowlingRuns:52, economyRate:2.65, wickets:431, catches:39, stumpings:0 },

  { id:"tim_southee_test", name:"Tim Southee", country:"New Zealand", role:"Bowler", rarity:"Epic", avatarUrl:null,
    matches:105, runs:1946, fours:195, sixes:39, fifties:4, hundreds:0, highestScore:77,
    strikeRate:44.22, bestBowlingWickets:7, bestBowlingRuns:33, economyRate:3.20, wickets:383, catches:40, stumpings:0 },

  // ── BANGLADESH ───────────────────────────────────────────────────
  { id:"shakib_al_hasan_test", name:"Shakib Al Hasan", country:"Bangladesh", role:"All-rounder", rarity:"Epic", avatarUrl:null,
    matches:70, runs:4413, fours:476, sixes:37, fifties:30, hundreds:8, highestScore:217,
    strikeRate:49.15, bestBowlingWickets:7, bestBowlingRuns:36, economyRate:2.78, wickets:242, catches:58, stumpings:0 },

  { id:"tamim_iqbal_test", name:"Tamim Iqbal", country:"Bangladesh", role:"Batter", rarity:"Rare", avatarUrl:null,
    matches:70, runs:5134, fours:605, sixes:36, fifties:31, hundreds:10, highestScore:206,
    strikeRate:52.68, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:52, stumpings:0 },

  // ── ZIMBABWE / OTHERS ────────────────────────────────────────────
  { id:"andy_flower_test", name:"Andy Flower", country:"Zimbabwe", role:"Wicket-keeper", rarity:"Epic", avatarUrl:null,
    matches:63, runs:4794, fours:498, sixes:31, fifties:27, hundreds:12, highestScore:232,
    strikeRate:49.35, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:151, stumpings:9 },

  { id:"garfield_sobers_test", name:"Garfield Sobers", country:"West Indies", role:"All-rounder", rarity:"Legendary", avatarUrl:null,
    matches:93, runs:8032, fours:891, sixes:72, fifties:26, hundreds:26, highestScore:365,
    strikeRate:57.61, bestBowlingWickets:6, bestBowlingRuns:73, economyRate:2.69, wickets:235, catches:109, stumpings:0 },

  { id:"don_bradman_test", name:"Don Bradman", country:"Australia", role:"Batter", rarity:"Legendary", avatarUrl:null,
    matches:52, runs:6996, fours:912, sixes:0, fifties:13, hundreds:29, highestScore:334,
    strikeRate:61.47, bestBowlingWickets:1, bestBowlingRuns:8, economyRate:0, wickets:2, catches:32, stumpings:0 },

  // ── ADDITIONAL TEST PLAYERS ───────────────────────────────────────
  // Sources: cricket365.com, cricjosh.in, sportskeeda.com — May 2026

  // India
  { id:"vvs_laxman_test", name:"VVS Laxman", country:"India", role:"Batter", rarity:"Epic", avatarUrl:null,
    matches:134, runs:8781, fours:996, sixes:37, fifties:56, hundreds:17, highestScore:281,
    strikeRate:51.67, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:135, stumpings:0 },
  { id:"cheteshwar_pujara_test", name:"Cheteshwar Pujara", country:"India", role:"Batter", rarity:"Epic", avatarUrl:null,
    matches:103, runs:7195, fours:851, sixes:6, fifties:35, hundreds:19, highestScore:206,
    strikeRate:46.64, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:104, stumpings:0 },
  { id:"dilip_vengsarkar_test", name:"Dilip Vengsarkar", country:"India", role:"Batter", rarity:"Rare", avatarUrl:null,
    matches:116, runs:6868, fours:766, sixes:12, fifties:35, hundreds:17, highestScore:166,
    strikeRate:45.52, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:57, stumpings:0 },
  { id:"gundappa_viswanath_test", name:"GR Viswanath", country:"India", role:"Batter", rarity:"Epic", avatarUrl:null,
    matches:91, runs:6080, fours:674, sixes:17, fifties:35, hundreds:14, highestScore:222,
    strikeRate:47.96, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:46, stumpings:0 },
  { id:"bishan_bedi_test", name:"Bishan Bedi", country:"India", role:"Bowler", rarity:"Epic", avatarUrl:null,
    matches:67, runs:656, fours:52, sixes:2, fifties:0, hundreds:0, highestScore:50,
    strikeRate:31.74, bestBowlingWickets:7, bestBowlingRuns:98, economyRate:2.35, wickets:266, catches:26, stumpings:0 },
  { id:"rohit_sharma_test", name:"Rohit Sharma", country:"India", role:"Batter", rarity:"Legendary", avatarUrl:null,
    matches:67, runs:4301, fours:453, sixes:84, fifties:20, hundreds:12, highestScore:212,
    strikeRate:60.56, bestBowlingWickets:1, bestBowlingRuns:6, economyRate:3.84, wickets:5, catches:58, stumpings:0 },

  // Australia
  { id:"justin_langer_test", name:"Justin Langer", country:"Australia", role:"Batter", rarity:"Rare", avatarUrl:null,
    matches:105, runs:7696, fours:893, sixes:39, fifties:30, hundreds:23, highestScore:250,
    strikeRate:50.79, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:78, stumpings:0 },
  { id:"michael_clarke_test", name:"Michael Clarke", country:"Australia", role:"Batter", rarity:"Epic", avatarUrl:null,
    matches:115, runs:8643, fours:1007, sixes:43, fifties:27, hundreds:28, highestScore:329,
    strikeRate:57.22, bestBowlingWickets:6, bestBowlingRuns:9, economyRate:3.07, wickets:31, catches:100, stumpings:0 },
  { id:"mark_taylor_test", name:"Mark Taylor", country:"Australia", role:"Batter", rarity:"Epic", avatarUrl:null,
    matches:104, runs:7525, fours:871, sixes:18, fifties:40, hundreds:19, highestScore:334,
    strikeRate:47.72, bestBowlingWickets:2, bestBowlingRuns:11, economyRate:2.57, wickets:3, catches:157, stumpings:0 },
  { id:"ian_chappell_test", name:"Ian Chappell", country:"Australia", role:"Batter", rarity:"Legendary", avatarUrl:null,
    matches:75, runs:5345, fours:599, sixes:44, fifties:26, hundreds:14, highestScore:196,
    strikeRate:52.14, bestBowlingWickets:2, bestBowlingRuns:21, economyRate:3.32, wickets:20, catches:105, stumpings:0 },
  { id:"greg_chappell_test", name:"Greg Chappell", country:"Australia", role:"Batter", rarity:"Legendary", avatarUrl:null,
    matches:87, runs:7110, fours:764, sixes:24, fifties:31, hundreds:24, highestScore:247,
    strikeRate:52.72, bestBowlingWickets:5, bestBowlingRuns:61, economyRate:2.58, wickets:47, catches:122, stumpings:0 },
  { id:"dennis_lillee_test", name:"Dennis Lillee", country:"Australia", role:"Bowler", rarity:"Legendary", avatarUrl:null,
    matches:70, runs:905, fours:74, sixes:4, fifties:0, hundreds:0, highestScore:73,
    strikeRate:26.92, bestBowlingWickets:7, bestBowlingRuns:83, economyRate:3.28, wickets:355, catches:23, stumpings:0 },
  { id:"jason_gillespie_test", name:"Jason Gillespie", country:"Australia", role:"Bowler", rarity:"Rare", avatarUrl:null,
    matches:71, runs:1218, fours:109, sixes:17, fifties:1, hundreds:1, highestScore:201,
    strikeRate:38.84, bestBowlingWickets:8, bestBowlingRuns:141, economyRate:3.11, wickets:259, catches:16, stumpings:0 },

  // England
  { id:"graham_gooch_test", name:"Graham Gooch", country:"England", role:"Batter", rarity:"Legendary", avatarUrl:null,
    matches:118, runs:8900, fours:980, sixes:23, fifties:46, hundreds:20, highestScore:333,
    strikeRate:49.43, bestBowlingWickets:3, bestBowlingRuns:39, economyRate:3.82, wickets:23, catches:103, stumpings:0 },
  { id:"david_gower_test", name:"David Gower", country:"England", role:"Batter", rarity:"Epic", avatarUrl:null,
    matches:117, runs:8231, fours:950, sixes:35, fifties:39, hundreds:18, highestScore:215,
    strikeRate:52.64, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:1, catches:74, stumpings:0 },
  { id:"ian_botham_test", name:"Ian Botham", country:"England", role:"All-rounder", rarity:"Legendary", avatarUrl:null,
    matches:102, runs:5200, fours:548, sixes:88, fifties:22, hundreds:14, highestScore:208,
    strikeRate:55.35, bestBowlingWickets:8, bestBowlingRuns:34, economyRate:3.01, wickets:383, catches:120, stumpings:0 },
  { id:"fred_trueman_test", name:"Fred Trueman", country:"England", role:"Bowler", rarity:"Legendary", avatarUrl:null,
    matches:67, runs:981, fours:88, sixes:6, fifties:1, hundreds:0, highestScore:39,
    strikeRate:29.46, bestBowlingWickets:8, bestBowlingRuns:31, economyRate:2.69, wickets:307, catches:64, stumpings:0 },
  { id:"kevin_pietersen_test", name:"Kevin Pietersen", country:"England", role:"Batter", rarity:"Epic", avatarUrl:null,
    matches:104, runs:8181, fours:907, sixes:90, fifties:35, hundreds:23, highestScore:227,
    strikeRate:62.03, bestBowlingWickets:3, bestBowlingRuns:52, economyRate:3.89, wickets:10, catches:71, stumpings:0 },
  { id:"monty_panesar_test", name:"Monty Panesar", country:"England", role:"Bowler", rarity:"Rare", avatarUrl:null,
    matches:50, runs:367, fours:30, sixes:4, fifties:0, hundreds:0, highestScore:26,
    strikeRate:25.91, bestBowlingWickets:6, bestBowlingRuns:37, economyRate:2.92, wickets:167, catches:14, stumpings:0 },

  // South Africa
  { id:"ab_devilliers_test", name:"AB de Villiers", country:"South Africa", role:"Batter", rarity:"Legendary", avatarUrl:null,
    matches:114, runs:8765, fours:834, sixes:89, fifties:46, hundreds:22, highestScore:278,
    strikeRate:60.60, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:220, stumpings:1 },
  { id:"shaun_pollock_test", name:"Shaun Pollock", country:"South Africa", role:"All-rounder", rarity:"Legendary", avatarUrl:null,
    matches:108, runs:3781, fours:372, sixes:17, fifties:16, hundreds:2, highestScore:111,
    strikeRate:52.06, bestBowlingWickets:7, bestBowlingRuns:87, economyRate:2.63, wickets:421, catches:72, stumpings:0 },
  { id:"barry_richards_test", name:"Barry Richards", country:"South Africa", role:"Batter", rarity:"Legendary", avatarUrl:null,
    matches:4, runs:508, fours:72, sixes:2, fifties:2, hundreds:2, highestScore:140,
    strikeRate:68.74, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:3, stumpings:0 },

  // Pakistan
  { id:"hanif_mohammad_test", name:"Hanif Mohammad", country:"Pakistan", role:"Batter", rarity:"Legendary", avatarUrl:null,
    matches:55, runs:3915, fours:420, sixes:2, fifties:15, hundreds:12, highestScore:337,
    strikeRate:36.46, bestBowlingWickets:1, bestBowlingRuns:1, economyRate:0, wickets:1, catches:40, stumpings:1 },
  { id:"imran_khan_test", name:"Imran Khan", country:"Pakistan", role:"All-rounder", rarity:"Legendary", avatarUrl:null,
    matches:88, runs:3807, fours:382, sixes:52, fifties:18, hundreds:6, highestScore:136,
    strikeRate:50.12, bestBowlingWickets:8, bestBowlingRuns:58, economyRate:2.93, wickets:362, catches:28, stumpings:0 },
  { id:"javed_miandad_test", name:"Javed Miandad", country:"Pakistan", role:"Batter", rarity:"Legendary", avatarUrl:null,
    matches:124, runs:8832, fours:882, sixes:40, fifties:43, hundreds:23, highestScore:280,
    strikeRate:50.07, bestBowlingWickets:3, bestBowlingRuns:30, economyRate:3.22, wickets:17, catches:93, stumpings:0 },
  { id:"mohammad_yousuf_test", name:"Mohammad Yousuf", country:"Pakistan", role:"Batter", rarity:"Epic", avatarUrl:null,
    matches:90, runs:7530, fours:838, sixes:28, fifties:33, hundreds:24, highestScore:223,
    strikeRate:49.86, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:58, stumpings:0 },
  { id:"saqlain_mushtaq_test", name:"Saqlain Mushtaq", country:"Pakistan", role:"Bowler", rarity:"Epic", avatarUrl:null,
    matches:49, runs:805, fours:61, sixes:10, fifties:1, hundreds:0, highestScore:79,
    strikeRate:43.84, bestBowlingWickets:8, bestBowlingRuns:164, economyRate:2.83, wickets:208, catches:28, stumpings:0 },

  // West Indies
  { id:"gordon_greenidge_test", name:"Gordon Greenidge", country:"West Indies", role:"Batter", rarity:"Legendary", avatarUrl:null,
    matches:108, runs:7558, fours:876, sixes:96, fifties:34, hundreds:19, highestScore:226,
    strikeRate:56.80, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:96, stumpings:0 },
  { id:"desmond_haynes_test", name:"Desmond Haynes", country:"West Indies", role:"Batter", rarity:"Epic", avatarUrl:null,
    matches:116, runs:7487, fours:862, sixes:60, fifties:39, hundreds:18, highestScore:184,
    strikeRate:48.70, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:65, stumpings:0 },
  { id:"joel_garner_test", name:"Joel Garner", country:"West Indies", role:"Bowler", rarity:"Epic", avatarUrl:null,
    matches:58, runs:672, fours:56, sixes:3, fifties:0, hundreds:0, highestScore:60,
    strikeRate:21.53, bestBowlingWickets:6, bestBowlingRuns:56, economyRate:2.67, wickets:259, catches:42, stumpings:0 },
  { id:"michael_holding_test", name:"Michael Holding", country:"West Indies", role:"Bowler", rarity:"Legendary", avatarUrl:null,
    matches:60, runs:910, fours:78, sixes:21, fifties:0, hundreds:0, highestScore:73,
    strikeRate:34.65, bestBowlingWickets:8, bestBowlingRuns:92, economyRate:2.72, wickets:249, catches:22, stumpings:0 },
  { id:"clive_lloyd_test", name:"Clive Lloyd", country:"West Indies", role:"Batter", rarity:"Legendary", avatarUrl:null,
    matches:110, runs:7515, fours:752, sixes:108, fifties:39, hundreds:19, highestScore:242,
    strikeRate:52.35, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:10, catches:90, stumpings:0 },

  // New Zealand
  { id:"martin_crowe_test", name:"Martin Crowe", country:"New Zealand", role:"Batter", rarity:"Legendary", avatarUrl:null,
    matches:77, runs:5444, fours:616, sixes:27, fifties:18, hundreds:17, highestScore:299,
    strikeRate:53.23, bestBowlingWickets:3, bestBowlingRuns:62, economyRate:2.83, wickets:14, catches:71, stumpings:0 },
  { id:"ross_taylor_test", name:"Ross Taylor", country:"New Zealand", role:"Batter", rarity:"Epic", avatarUrl:null,
    matches:112, runs:7683, fours:835, sixes:69, fifties:35, hundreds:19, highestScore:290,
    strikeRate:50.58, bestBowlingWickets:1, bestBowlingRuns:17, economyRate:3.51, wickets:2, catches:155, stumpings:0 },
  { id:"brendon_mccullum_test", name:"Brendon McCullum", country:"New Zealand", role:"Wicket-keeper", rarity:"Epic", avatarUrl:null,
    matches:101, runs:6453, fours:642, sixes:107, fifties:31, hundreds:12, highestScore:302,
    strikeRate:64.10, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:163, stumpings:14 },

  // Sri Lanka
  { id:"sanath_jayasuriya_test", name:"Sanath Jayasuriya", country:"Sri Lanka", role:"All-rounder", rarity:"Legendary", avatarUrl:null,
    matches:110, runs:6973, fours:925, sixes:79, fifties:31, hundreds:14, highestScore:340,
    strikeRate:65.53, bestBowlingWickets:6, bestBowlingRuns:52, economyRate:3.45, wickets:98, catches:78, stumpings:0 },
  { id:"chaminda_vaas_test", name:"Chaminda Vaas", country:"Sri Lanka", role:"Bowler", rarity:"Epic", avatarUrl:null,
    matches:111, runs:2025, fours:183, sixes:18, fifties:6, hundreds:0, highestScore:100,
    strikeRate:40.55, bestBowlingWickets:8, bestBowlingRuns:46, economyRate:2.91, wickets:355, catches:51, stumpings:0 },
  { id:"rangana_herath_test", name:"Rangana Herath", country:"Sri Lanka", role:"Bowler", rarity:"Epic", avatarUrl:null,
    matches:93, runs:1649, fours:149, sixes:13, fifties:2, hundreds:0, highestScore:52,
    strikeRate:41.20, bestBowlingWickets:9, bestBowlingRuns:127, economyRate:2.80, wickets:433, catches:45, stumpings:0 },

  // Bangladesh
  { id:"mushfiqur_rahim_test", name:"Mushfiqur Rahim", country:"Bangladesh", role:"Wicket-keeper", rarity:"Epic", avatarUrl:null,
    matches:90, runs:5849, fours:636, sixes:50, fifties:34, hundreds:10, highestScore:219,
    strikeRate:49.26, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:140, stumpings:21 },

  // Zimbabwe
  { id:"andrew_flintoff_test", name:"Andrew Flintoff", country:"England", role:"All-rounder", rarity:"Epic", avatarUrl:null, matches:79, runs:3845, fours:379, sixes:82, fifties:26, hundreds:5, highestScore:167, strikeRate:60.63, bestBowlingWickets:5, bestBowlingRuns:58, economyRate:3.22, wickets:226, catches:52, stumpings:0 },
  { id:"viv_richards_test", name:"Viv Richards", country:"West Indies", role:"Batter", rarity:"Legendary", avatarUrl:null, matches:121, runs:8540, fours:922, sixes:84, fifties:32, hundreds:24, highestScore:291, strikeRate:70.80, bestBowlingWickets:5, bestBowlingRuns:88, economyRate:3.84, wickets:32, catches:122, stumpings:0 },
  { id:"heath_streak_test", name:"Heath Streak", country:"Zimbabwe", role:"All-rounder", rarity:"Rare", avatarUrl:null,
    matches:65, runs:1990, fours:200, sixes:28, fifties:7, hundreds:1, highestScore:127,
    strikeRate:44.68, bestBowlingWickets:6, bestBowlingRuns:73, economyRate:2.87, wickets:216, catches:27, stumpings:0 },

  { id:"sunil_gavaskar_t", name:"Sunil Gavaskar", country:"India", role:"Batter", rarity:"Legendary", avatarUrl:null, matches:125, runs:10122, fours:1177, sixes:0, fifties:45, hundreds:34, highestScore:236, strikeRate:51.12, bestBowlingWickets:1, bestBowlingRuns:34, economyRate:1.74, wickets:1, catches:108, stumpings:0 },
  { id:"virender_sehwag_t", name:"Virender Sehwag", country:"India", role:"Batter", rarity:"Legendary", avatarUrl:null, matches:104, runs:8586, fours:1195, sixes:91, fifties:32, hundreds:23, highestScore:319, strikeRate:82.23, bestBowlingWickets:4, bestBowlingRuns:35, economyRate:4.01, wickets:40, catches:91, stumpings:0 },
  { id:"garry_sobers_t", name:"Garfield Sobers", country:"West Indies", role:"All-rounder", rarity:"Legendary", avatarUrl:null, matches:93, runs:8032, fours:891, sixes:72, fifties:26, hundreds:26, highestScore:365, strikeRate:57.61, bestBowlingWickets:6, bestBowlingRuns:73, economyRate:2.69, wickets:235, catches:109, stumpings:0 },
  { id:"viv_richards_t", name:"Viv Richards", country:"West Indies", role:"Batter", rarity:"Legendary", avatarUrl:null, matches:121, runs:8540, fours:922, sixes:84, fifties:32, hundreds:24, highestScore:291, strikeRate:70.80, bestBowlingWickets:5, bestBowlingRuns:88, economyRate:3.84, wickets:32, catches:122, stumpings:0 },
  { id:"ab_devilliers_t", name:"AB de Villiers", country:"South Africa", role:"Batter", rarity:"Legendary", avatarUrl:null, matches:114, runs:8765, fours:834, sixes:89, fifties:46, hundreds:22, highestScore:278, strikeRate:60.60, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:220, stumpings:1 },
  { id:"shaun_pollock_t", name:"Shaun Pollock", country:"South Africa", role:"All-rounder", rarity:"Legendary", avatarUrl:null, matches:108, runs:3781, fours:372, sixes:17, fifties:16, hundreds:2, highestScore:111, strikeRate:52.06, bestBowlingWickets:7, bestBowlingRuns:87, economyRate:2.63, wickets:421, catches:72, stumpings:0 },
  { id:"ms_dhoni_t", name:"MS Dhoni", country:"India", role:"Wicket-keeper", rarity:"Epic", avatarUrl:null, matches:90, runs:4876, fours:436, sixes:78, fifties:33, hundreds:6, highestScore:224, strikeRate:59.45, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:256, stumpings:38 },
  { id:"inzamam_test", name:"Inzamam-ul-Haq", country:"Pakistan", role:"Batter", rarity:"Epic", avatarUrl:null, matches:120, runs:8830, fours:859, sixes:36, fifties:46, hundreds:25, highestScore:329, strikeRate:52.96, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:100, stumpings:0 },
  { id:"graeme_smith_t", name:"Graeme Smith", country:"South Africa", role:"Batter", rarity:"Epic", avatarUrl:null, matches:117, runs:9265, fours:1116, sixes:32, fifties:38, hundreds:27, highestScore:277, strikeRate:47.85, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:104, stumpings:0 },
  { id:"curtly_ambrose_t", name:"Curtly Ambrose", country:"West Indies", role:"Bowler", rarity:"Legendary", avatarUrl:null, matches:98, runs:1439, fours:128, sixes:17, fifties:1, hundreds:0, highestScore:53, strikeRate:28.35, bestBowlingWickets:8, bestBowlingRuns:45, economyRate:2.52, wickets:405, catches:22, stumpings:0 },
];

const T20I_CARDS = [

  // ── INDIA ────────────────────────────────────────────────────────
  { id:"virat_kohli_t20i", name:"Virat Kohli", country:"India", role:"Batter", rarity:"Legendary", avatarUrl:null,
    matches:125, runs:4188, fours:336, sixes:93, fifties:38, hundreds:1, highestScore:122,
    strikeRate:137.04, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:41, stumpings:0 },

  { id:"rohit_sharma_t20i", name:"Rohit Sharma", country:"India", role:"Batter", rarity:"Legendary", avatarUrl:null,
    matches:159, runs:4231, fours:370, sixes:205, fifties:26, hundreds:5, highestScore:118,
    strikeRate:140.89, bestBowlingWickets:1, bestBowlingRuns:10, economyRate:7.14, wickets:1, catches:50, stumpings:0 },

  { id:"suryakumar_yadav_t20i", name:"Suryakumar Yadav", country:"India", role:"Batter", rarity:"Legendary", avatarUrl:null,
    matches:78, runs:3272, fours:278, sixes:175, fifties:22, hundreds:4, highestScore:117,
    strikeRate:170.05, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:30, stumpings:0 },

  { id:"jasprit_bumrah_t20i", name:"Jasprit Bumrah", country:"India", role:"Bowler", rarity:"Legendary", avatarUrl:null,
    matches:72, runs:12, fours:0, sixes:0, fifties:0, hundreds:0, highestScore:7,
    strikeRate:37.50, bestBowlingWickets:4, bestBowlingRuns:14, economyRate:6.29, wickets:89, catches:18, stumpings:0 },

  { id:"arshdeep_singh_t20i", name:"Arshdeep Singh", country:"India", role:"Bowler", rarity:"Epic", avatarUrl:null,
    matches:85, runs:48, fours:2, sixes:1, fifties:0, hundreds:0, highestScore:8,
    strikeRate:53.33, bestBowlingWickets:5, bestBowlingRuns:32, economyRate:7.78, wickets:125, catches:14, stumpings:0 },

  { id:"hardik_pandya_t20i", name:"Hardik Pandya", country:"India", role:"All-rounder", rarity:"Epic", avatarUrl:null,
    matches:120, runs:1858, fours:148, sixes:99, fifties:8, hundreds:0, highestScore:87,
    strikeRate:148.92, bestBowlingWickets:4, bestBowlingRuns:14, economyRate:8.89, wickets:79, catches:30, stumpings:0 },

  { id:"ms_dhoni_t20i", name:"MS Dhoni", country:"India", role:"Wicket-keeper", rarity:"Legendary", avatarUrl:null,
    matches:98, runs:1617, fours:116, sixes:52, fifties:2, hundreds:0, highestScore:56,
    strikeRate:126.13, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:57, stumpings:34 },

  { id:"yuvraj_singh_t20i", name:"Yuvraj Singh", country:"India", role:"All-rounder", rarity:"Epic", avatarUrl:null,
    matches:58, runs:1177, fours:82, sixes:80, fifties:8, hundreds:0, highestScore:77,
    strikeRate:147.33, bestBowlingWickets:3, bestBowlingRuns:17, economyRate:8.02, wickets:28, catches:18, stumpings:0 },

  { id:"ravindra_jadeja_t20i", name:"Ravindra Jadeja", country:"India", role:"All-rounder", rarity:"Rare", avatarUrl:null,
    matches:74, runs:515, fours:37, sixes:14, fifties:0, hundreds:0, highestScore:46,
    strikeRate:130.55, bestBowlingWickets:3, bestBowlingRuns:15, economyRate:7.03, wickets:54, catches:24, stumpings:0 },

  { id:"kl_rahul_t20i", name:"KL Rahul", country:"India", role:"Wicket-keeper", rarity:"Epic", avatarUrl:null,
    matches:72, runs:2265, fours:193, sixes:77, fifties:20, hundreds:2, highestScore:110,
    strikeRate:141.88, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:46, stumpings:22 },

  { id:"shikhar_dhawan_t20i", name:"Shikhar Dhawan", country:"India", role:"Batter", rarity:"Rare", avatarUrl:null,
    matches:68, runs:1759, fours:185, sixes:46, fifties:11, hundreds:0, highestScore:92,
    strikeRate:127.02, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:26, stumpings:0 },

  // ── PAKISTAN ─────────────────────────────────────────────────────
  { id:"babar_azam_t20i", name:"Babar Azam", country:"Pakistan", role:"Batter", rarity:"Legendary", avatarUrl:null,
    matches:124, runs:4429, fours:396, sixes:109, fifties:42, hundreds:3, highestScore:122,
    strikeRate:130.22, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:41, stumpings:0 },

  { id:"mohammad_rizwan_t20i", name:"Mohammad Rizwan", country:"Pakistan", role:"Wicket-keeper", rarity:"Epic", avatarUrl:null,
    matches:106, runs:3414, fours:258, sixes:119, fifties:29, hundreds:3, highestScore:104,
    strikeRate:135.27, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:95, stumpings:26 },

  { id:"shahid_afridi_t20i", name:"Shahid Afridi", country:"Pakistan", role:"All-rounder", rarity:"Legendary", avatarUrl:null,
    matches:99, runs:1416, fours:99, sixes:98, fifties:3, hundreds:0, highestScore:54,
    strikeRate:149.84, bestBowlingWickets:4, bestBowlingRuns:11, economyRate:6.59, wickets:98, catches:26, stumpings:0 },

  { id:"mohammad_hafeez_t20i", name:"Mohammad Hafeez", country:"Pakistan", role:"All-rounder", rarity:"Rare", avatarUrl:null,
    matches:119, runs:2514, fours:207, sixes:72, fifties:18, hundreds:1, highestScore:86,
    strikeRate:121.94, bestBowlingWickets:4, bestBowlingRuns:17, economyRate:6.88, wickets:61, catches:34, stumpings:0 },

  { id:"imad_wasim_t20i", name:"Imad Wasim", country:"Pakistan", role:"All-rounder", rarity:"Rare", avatarUrl:null,
    matches:82, runs:893, fours:63, sixes:29, fifties:2, hundreds:0, highestScore:57,
    strikeRate:114.46, bestBowlingWickets:5, bestBowlingRuns:14, economyRate:6.43, wickets:89, catches:22, stumpings:0 },

  // ── ENGLAND ──────────────────────────────────────────────────────
  { id:"jos_buttler_t20i", name:"Jos Buttler", country:"England", role:"Wicket-keeper", rarity:"Legendary", avatarUrl:null,
    matches:109, runs:2960, fours:253, sixes:118, fifties:22, hundreds:4, highestScore:101,
    strikeRate:143.73, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:71, stumpings:18 },

  { id:"alex_hales_t20i", name:"Alex Hales", country:"England", role:"Batter", rarity:"Rare", avatarUrl:null,
    matches:75, runs:1893, fours:173, sixes:88, fifties:14, hundreds:1, highestScore:116,
    strikeRate:136.64, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:28, stumpings:0 },

  { id:"eoin_morgan_t20i", name:"Eoin Morgan", country:"England", role:"Batter", rarity:"Epic", avatarUrl:null,
    matches:115, runs:2458, fours:179, sixes:123, fifties:14, hundreds:0, highestScore:91,
    strikeRate:136.33, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:44, stumpings:0 },

  { id:"liam_livingstone_t20i", name:"Liam Livingstone", country:"England", role:"All-rounder", rarity:"Epic", avatarUrl:null,
    matches:62, runs:1298, fours:89, sixes:88, fifties:8, hundreds:1, highestScore:103,
    strikeRate:163.12, bestBowlingWickets:3, bestBowlingRuns:13, economyRate:8.71, wickets:29, catches:26, stumpings:0 },

  { id:"adil_rashid_t20i", name:"Adil Rashid", country:"England", role:"Bowler", rarity:"Epic", avatarUrl:null,
    matches:107, runs:227, fours:15, sixes:8, fifties:0, hundreds:0, highestScore:27,
    strikeRate:110.68, bestBowlingWickets:4, bestBowlingRuns:2, economyRate:7.62, wickets:130, catches:27, stumpings:0 },

  // ── AUSTRALIA ────────────────────────────────────────────────────
  { id:"david_warner_t20i", name:"David Warner", country:"Australia", role:"Batter", rarity:"Epic", avatarUrl:null,
    matches:110, runs:3277, fours:278, sixes:151, fifties:27, hundreds:1, highestScore:100,
    strikeRate:141.13, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:46, stumpings:0 },

  { id:"aaron_finch_t20i", name:"Aaron Finch", country:"Australia", role:"Batter", rarity:"Epic", avatarUrl:null,
    matches:103, runs:3120, fours:266, sixes:128, fifties:20, hundreds:2, highestScore:172,
    strikeRate:144.47, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:35, stumpings:0 },

  { id:"mitchell_starc_t20i", name:"Mitchell Starc", country:"Australia", role:"Bowler", rarity:"Epic", avatarUrl:null,
    matches:58, runs:140, fours:8, sixes:4, fifties:0, hundreds:0, highestScore:18,
    strikeRate:71.79, bestBowlingWickets:4, bestBowlingRuns:8, economyRate:7.31, wickets:79, catches:11, stumpings:0 },

  { id:"adam_zampa_t20i", name:"Adam Zampa", country:"Australia", role:"Bowler", rarity:"Epic", avatarUrl:null,
    matches:96, runs:96, fours:5, sixes:2, fifties:0, hundreds:0, highestScore:13,
    strikeRate:72.72, bestBowlingWickets:5, bestBowlingRuns:19, economyRate:7.32, wickets:141, catches:22, stumpings:0 },

  { id:"matthew_wade_t20i", name:"Matthew Wade", country:"Australia", role:"Wicket-keeper", rarity:"Rare", avatarUrl:null,
    matches:93, runs:1722, fours:129, sixes:91, fifties:8, hundreds:1, highestScore:99,
    strikeRate:140.03, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:58, stumpings:13 },

  // ── SOUTH AFRICA ─────────────────────────────────────────────────
  { id:"quinton_de_kock_t20i", name:"Quinton de Kock", country:"South Africa", role:"Wicket-keeper", rarity:"Epic", avatarUrl:null,
    matches:78, runs:2375, fours:221, sixes:81, fifties:18, hundreds:1, highestScore:102,
    strikeRate:136.24, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:61, stumpings:17 },

  { id:"ab_devilliers_t20i", name:"AB de Villiers", country:"South Africa", role:"Batter", rarity:"Legendary", avatarUrl:null,
    matches:78, runs:1672, fours:119, sixes:97, fifties:10, hundreds:0, highestScore:79,
    strikeRate:150.54, bestBowlingWickets:1, bestBowlingRuns:8, economyRate:8.23, wickets:4, catches:50, stumpings:0 },

  { id:"kagiso_rabada_t20i", name:"Kagiso Rabada", country:"South Africa", role:"Bowler", rarity:"Epic", avatarUrl:null,
    matches:57, runs:118, fours:7, sixes:3, fifties:0, hundreds:0, highestScore:21,
    strikeRate:64.84, bestBowlingWickets:4, bestBowlingRuns:22, economyRate:8.23, wickets:82, catches:14, stumpings:0 },

  { id:"wanindu_hasaranga_t20i", name:"Wanindu Hasaranga", country:"Sri Lanka", role:"All-rounder", rarity:"Epic", avatarUrl:null,
    matches:95, runs:600, fours:40, sixes:26, fifties:1, hundreds:0, highestScore:71,
    strikeRate:128.20, bestBowlingWickets:6, bestBowlingRuns:5, economyRate:7.03, wickets:154, catches:28, stumpings:0 },

  // ── WEST INDIES ──────────────────────────────────────────────────
  { id:"chris_gayle_t20i", name:"Chris Gayle", country:"West Indies", role:"Batter", rarity:"Legendary", avatarUrl:null,
    matches:79, runs:1899, fours:136, sixes:124, fifties:13, hundreds:2, highestScore:117,
    strikeRate:146.72, bestBowlingWickets:4, bestBowlingRuns:0, economyRate:6.02, wickets:18, catches:26, stumpings:0 },

  { id:"kieron_pollard_t20i", name:"Kieron Pollard", country:"West Indies", role:"All-rounder", rarity:"Epic", avatarUrl:null,
    matches:101, runs:2048, fours:141, sixes:121, fifties:7, hundreds:0, highestScore:65,
    strikeRate:142.13, bestBowlingWickets:4, bestBowlingRuns:38, economyRate:8.43, wickets:62, catches:34, stumpings:0 },

  { id:"andre_russell_t20i", name:"Andre Russell", country:"West Indies", role:"All-rounder", rarity:"Legendary", avatarUrl:null,
    matches:74, runs:1113, fours:66, sixes:89, fifties:2, hundreds:0, highestScore:67,
    strikeRate:170.91, bestBowlingWickets:4, bestBowlingRuns:10, economyRate:9.81, wickets:70, catches:20, stumpings:0 },

  { id:"nicholas_pooran_t20i", name:"Nicholas Pooran", country:"West Indies", role:"Wicket-keeper", rarity:"Epic", avatarUrl:null,
    matches:92, runs:2228, fours:149, sixes:130, fifties:15, hundreds:0, highestScore:98,
    strikeRate:152.74, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:61, stumpings:22 },

  // ── NEW ZEALAND ──────────────────────────────────────────────────
  { id:"martin_guptill_t20i", name:"Martin Guptill", country:"New Zealand", role:"Batter", rarity:"Legendary", avatarUrl:null,
    matches:122, runs:3531, fours:307, sixes:170, fifties:21, hundreds:2, highestScore:105,
    strikeRate:134.72, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:36, stumpings:0 },

  { id:"tim_southee_t20i", name:"Tim Southee", country:"New Zealand", role:"Bowler", rarity:"Epic", avatarUrl:null,
    matches:126, runs:504, fours:37, sixes:22, fifties:0, hundreds:0, highestScore:44,
    strikeRate:90.86, bestBowlingWickets:5, bestBowlingRuns:18, economyRate:8.14, wickets:164, catches:37, stumpings:0 },

  { id:"ish_sodhi_t20i", name:"Ish Sodhi", country:"New Zealand", role:"Bowler", rarity:"Epic", avatarUrl:null,
    matches:125, runs:174, fours:9, sixes:7, fifties:0, hundreds:0, highestScore:18,
    strikeRate:101.75, bestBowlingWickets:5, bestBowlingRuns:26, economyRate:8.00, wickets:150, catches:25, stumpings:0 },

  { id:"kane_williamson_t20i", name:"Kane Williamson", country:"New Zealand", role:"Batter", rarity:"Epic", avatarUrl:null,
    matches:95, runs:2265, fours:183, sixes:60, fifties:14, hundreds:1, highestScore:95,
    strikeRate:116.79, bestBowlingWickets:1, bestBowlingRuns:15, economyRate:7.11, wickets:3, catches:35, stumpings:0 },

  // ── AFGHANISTAN ──────────────────────────────────────────────────
  { id:"rashid_khan_t20i", name:"Rashid Khan", country:"Afghanistan", role:"Bowler", rarity:"Legendary", avatarUrl:null,
    matches:100, runs:724, fours:55, sixes:32, fifties:1, hundreds:0, highestScore:60,
    strikeRate:138.93, bestBowlingWickets:5, bestBowlingRuns:3, economyRate:6.17, wickets:182, catches:26, stumpings:0 },

  { id:"mohammad_nabi_t20i", name:"Mohammad Nabi", country:"Afghanistan", role:"All-rounder", rarity:"Epic", avatarUrl:null,
    matches:132, runs:1774, fours:131, sixes:60, fifties:7, hundreds:0, highestScore:89,
    strikeRate:127.72, bestBowlingWickets:4, bestBowlingRuns:10, economyRate:6.81, wickets:153, catches:32, stumpings:0 },

  // ── SRI LANKA ────────────────────────────────────────────────────
  { id:"lasith_malinga_t20i", name:"Lasith Malinga", country:"Sri Lanka", role:"Bowler", rarity:"Legendary", avatarUrl:null,
    matches:84, runs:92, fours:4, sixes:3, fifties:0, hundreds:0, highestScore:12,
    strikeRate:71.32, bestBowlingWickets:5, bestBowlingRuns:6, economyRate:7.43, wickets:107, catches:14, stumpings:0 },

  { id:"tillakaratne_dilshan_t20i", name:"Tillakaratne Dilshan", country:"Sri Lanka", role:"Batter", rarity:"Epic", avatarUrl:null,
    matches:80, runs:1889, fours:201, sixes:69, fifties:12, hundreds:1, highestScore:104,
    strikeRate:125.73, bestBowlingWickets:4, bestBowlingRuns:4, economyRate:7.24, wickets:41, catches:40, stumpings:0 },

  // ── BANGLADESH ───────────────────────────────────────────────────
  { id:"shakib_al_hasan_t20i", name:"Shakib Al Hasan", country:"Bangladesh", role:"All-rounder", rarity:"Epic", avatarUrl:null,
    matches:129, runs:2472, fours:210, sixes:64, fifties:14, hundreds:0, highestScore:84,
    strikeRate:125.67, bestBowlingWickets:5, bestBowlingRuns:20, economyRate:7.07, wickets:149, catches:38, stumpings:0 },

  { id:"mustafizur_rahman_t20i", name:"Mustafizur Rahman", country:"Bangladesh", role:"Bowler", rarity:"Epic", avatarUrl:null,
    matches:109, runs:74, fours:2, sixes:1, fifties:0, hundreds:0, highestScore:9,
    strikeRate:54.81, bestBowlingWickets:6, bestBowlingRuns:10, economyRate:7.63, wickets:158, catches:20, stumpings:0 },

  // ── OTHERS ───────────────────────────────────────────────────────
  { id:"paul_stirling_t20i", name:"Paul Stirling", country:"Ireland", role:"Batter", rarity:"Rare", avatarUrl:null,
    matches:130, runs:3895, fours:398, sixes:126, fifties:23, hundreds:1, highestScore:115,
    strikeRate:131.58, bestBowlingWickets:3, bestBowlingRuns:4, economyRate:7.96, wickets:32, catches:38, stumpings:0 },

  { id:"sikandar_raza_t20i", name:"Sikandar Raza", country:"Zimbabwe", role:"All-rounder", rarity:"Rare", avatarUrl:null,
    matches:133, runs:3089, fours:266, sixes:91, fifties:20, hundreds:1, highestScore:82,
    strikeRate:130.37, bestBowlingWickets:5, bestBowlingRuns:11, economyRate:7.28, wickets:105, catches:41, stumpings:0 },

  { id:"hardus_viljoen_t20i", name:"David Wiese", country:"Namibia", role:"All-rounder", rarity:"Common", avatarUrl:null,
    matches:68, runs:878, fours:63, sixes:43, fifties:4, hundreds:0, highestScore:67,
    strikeRate:138.55, bestBowlingWickets:4, bestBowlingRuns:11, economyRate:8.01, wickets:74, catches:18, stumpings:0 },

  { id:"kusal_mendis_t20i", name:"Kusal Mendis", country:"Sri Lanka", role:"Wicket-keeper", rarity:"Rare", avatarUrl:null,
    matches:96, runs:2256, fours:198, sixes:89, fifties:15, hundreds:2, highestScore:112,
    strikeRate:144.23, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:68, stumpings:11 },

  { id:"pathum_nissanka_t20i", name:"Pathum Nissanka", country:"Sri Lanka", role:"Batter", rarity:"Rare", avatarUrl:null,
    matches:68, runs:1740, fours:171, sixes:46, fifties:12, hundreds:2, highestScore:107,
    strikeRate:134.88, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:22, stumpings:0 },

  { id:"sunil_narine_t20i", name:"Sunil Narine", country:"West Indies", role:"All-rounder", rarity:"Epic", avatarUrl:null,
    matches:57, runs:672, fours:55, sixes:42, fifties:1, hundreds:0, highestScore:67,
    strikeRate:152.04, bestBowlingWickets:4, bestBowlingRuns:12, economyRate:6.16, wickets:52, catches:17, stumpings:0 },

  { id:"dwayne_bravo_t20i", name:"Dwayne Bravo", country:"West Indies", role:"All-rounder", rarity:"Rare", avatarUrl:null,
    matches:90, runs:1142, fours:77, sixes:60, fifties:1, hundreds:0, highestScore:66,
    strikeRate:126.94, bestBowlingWickets:4, bestBowlingRuns:25, economyRate:8.50, wickets:78, catches:30, stumpings:0 },

  // ── ADDITIONAL T20I PLAYERS ───────────────────────────────────────
  // Sources: mykhel.com, cricket365.com, thecricscope.com — May 2026

  // India
  { id:"suresh_raina_t20i", name:"Suresh Raina", country:"India", role:"Batter", rarity:"Epic", avatarUrl:null,
    matches:78, runs:1605, fours:123, sixes:70, fifties:5, hundreds:1, highestScore:101,
    strikeRate:134.87, bestBowlingWickets:2, bestBowlingRuns:8, economyRate:8.44, wickets:15, catches:26, stumpings:0 },
  { id:"axar_patel_t20i", name:"Axar Patel", country:"India", role:"All-rounder", rarity:"Rare", avatarUrl:null,
    matches:71, runs:367, fours:23, sixes:16, fifties:0, hundreds:0, highestScore:38,
    strikeRate:128.32, bestBowlingWickets:4, bestBowlingRuns:7, economyRate:7.01, wickets:78, catches:25, stumpings:0 },
  { id:"bhuvneshwar_kumar_t20i", name:"Bhuvneshwar Kumar", country:"India", role:"Bowler", rarity:"Epic", avatarUrl:null,
    matches:88, runs:177, fours:11, sixes:2, fifties:0, hundreds:0, highestScore:15,
    strikeRate:78.66, bestBowlingWickets:4, bestBowlingRuns:14, economyRate:7.12, wickets:91, catches:18, stumpings:0 },
  { id:"yuzvendra_chahal_t20i", name:"Yuzvendra Chahal", country:"India", role:"Bowler", rarity:"Epic", avatarUrl:null,
    matches:80, runs:22, fours:1, sixes:0, fifties:0, hundreds:0, highestScore:5,
    strikeRate:44.00, bestBowlingWickets:6, bestBowlingRuns:25, economyRate:8.26, wickets:96, catches:16, stumpings:0 },
  { id:"dinesh_karthik_t20i", name:"Dinesh Karthik", country:"India", role:"Wicket-keeper", rarity:"Rare", avatarUrl:null,
    matches:60, runs:689, fours:52, sixes:34, fifties:0, hundreds:0, highestScore:55,
    strikeRate:135.50, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:37, stumpings:14 },
  { id:"rishabh_pant_t20i", name:"Rishabh Pant", country:"India", role:"Wicket-keeper", rarity:"Epic", avatarUrl:null,
    matches:66, runs:987, fours:76, sixes:52, fifties:3, hundreds:0, highestScore:65,
    strikeRate:126.57, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:52, stumpings:14 },
  { id:"shubman_gill_t20i", name:"Shubman Gill", country:"India", role:"Batter", rarity:"Epic", avatarUrl:null,
    matches:48, runs:1479, fours:132, sixes:52, fifties:9, hundreds:2, highestScore:126,
    strikeRate:148.94, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:16, stumpings:0 },

  // Pakistan
  { id:"shoaib_malik_t20i", name:"Shoaib Malik", country:"Pakistan", role:"All-rounder", rarity:"Epic", avatarUrl:null,
    matches:124, runs:2435, fours:178, sixes:86, fifties:16, hundreds:0, highestScore:75,
    strikeRate:124.30, bestBowlingWickets:3, bestBowlingRuns:14, economyRate:7.37, wickets:33, catches:39, stumpings:0 },
  { id:"umar_akmal_t20i", name:"Umar Akmal", country:"Pakistan", role:"Wicket-keeper", rarity:"Rare", avatarUrl:null,
    matches:84, runs:1692, fours:130, sixes:67, fifties:12, hundreds:0, highestScore:85,
    strikeRate:131.27, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:48, stumpings:15 },
  { id:"shadab_khan_t20i", name:"Shadab Khan", country:"Pakistan", role:"All-rounder", rarity:"Epic", avatarUrl:null,
    matches:104, runs:781, fours:47, sixes:36, fifties:0, hundreds:0, highestScore:49,
    strikeRate:131.47, bestBowlingWickets:5, bestBowlingRuns:8, economyRate:7.63, wickets:130, catches:34, stumpings:0 },
  { id:"haris_rauf_t20i", name:"Haris Rauf", country:"Pakistan", role:"Bowler", rarity:"Rare", avatarUrl:null,
    matches:69, runs:88, fours:4, sixes:3, fifties:0, hundreds:0, highestScore:14,
    strikeRate:67.18, bestBowlingWickets:4, bestBowlingRuns:7, economyRate:8.44, wickets:87, catches:14, stumpings:0 },

  // England
  { id:"jonny_bairstow_t20i", name:"Jonny Bairstow", country:"England", role:"Wicket-keeper", rarity:"Epic", avatarUrl:null,
    matches:97, runs:2380, fours:207, sixes:110, fifties:14, hundreds:1, highestScore:114,
    strikeRate:143.29, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:60, stumpings:16 },
  { id:"dawid_malan_t20i", name:"Dawid Malan", country:"England", role:"Batter", rarity:"Rare", avatarUrl:null,
    matches:61, runs:1733, fours:148, sixes:66, fifties:14, hundreds:1, highestScore:103,
    strikeRate:141.78, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:22, stumpings:0 },
  { id:"mark_wood_t20i", name:"Mark Wood", country:"England", role:"Bowler", rarity:"Rare", avatarUrl:null,
    matches:72, runs:176, fours:10, sixes:8, fifties:0, hundreds:0, highestScore:27,
    strikeRate:133.33, bestBowlingWickets:4, bestBowlingRuns:27, economyRate:8.71, wickets:94, catches:18, stumpings:0 },
  { id:"sam_curran_t20i", name:"Sam Curran", country:"England", role:"All-rounder", rarity:"Rare", avatarUrl:null,
    matches:69, runs:439, fours:29, sixes:22, fifties:1, hundreds:0, highestScore:55,
    strikeRate:133.02, bestBowlingWickets:5, bestBowlingRuns:10, economyRate:8.31, wickets:70, catches:18, stumpings:0 },

  // Australia
  { id:"pat_cummins_t20i", name:"Pat Cummins", country:"Australia", role:"Bowler", rarity:"Epic", avatarUrl:null,
    matches:60, runs:356, fours:24, sixes:18, fifties:0, hundreds:0, highestScore:35,
    strikeRate:141.07, bestBowlingWickets:4, bestBowlingRuns:18, economyRate:7.79, wickets:76, catches:14, stumpings:0 },
  { id:"travis_head_t20i", name:"Travis Head", country:"Australia", role:"Batter", rarity:"Epic", avatarUrl:null,
    matches:53, runs:1520, fours:136, sixes:71, fifties:10, hundreds:2, highestScore:109,
    strikeRate:155.73, bestBowlingWickets:2, bestBowlingRuns:14, economyRate:8.84, wickets:3, catches:19, stumpings:0 },
  { id:"mitchell_marsh_t20i", name:"Mitchell Marsh", country:"Australia", role:"All-rounder", rarity:"Rare", avatarUrl:null,
    matches:68, runs:1299, fours:108, sixes:63, fifties:7, hundreds:1, highestScore:79,
    strikeRate:139.55, bestBowlingWickets:3, bestBowlingRuns:12, economyRate:9.13, wickets:26, catches:22, stumpings:0 },
  { id:"josh_hazlewood_t20i", name:"Josh Hazlewood", country:"Australia", role:"Bowler", rarity:"Rare", avatarUrl:null,
    matches:55, runs:60, fours:2, sixes:2, fifties:0, hundreds:0, highestScore:12,
    strikeRate:75.00, bestBowlingWickets:4, bestBowlingRuns:12, economyRate:7.12, wickets:71, catches:12, stumpings:0 },
  { id:"marcus_stoinis_t20i", name:"Marcus Stoinis", country:"Australia", role:"All-rounder", rarity:"Rare", avatarUrl:null,
    matches:66, runs:1254, fours:94, sixes:59, fifties:7, hundreds:0, highestScore:78,
    strikeRate:130.96, bestBowlingWickets:4, bestBowlingRuns:15, economyRate:9.22, wickets:21, catches:20, stumpings:0 },

  // South Africa
  { id:"faf_du_plessis_t20i", name:"Faf du Plessis", country:"South Africa", role:"Batter", rarity:"Epic", avatarUrl:null,
    matches:50, runs:1265, fours:120, sixes:32, fifties:10, hundreds:0, highestScore:96,
    strikeRate:133.12, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:22, stumpings:0 },
  { id:"heinrich_klaasen_t20i", name:"Heinrich Klaasen", country:"South Africa", role:"Wicket-keeper", rarity:"Epic", avatarUrl:null,
    matches:74, runs:1892, fours:153, sixes:105, fifties:11, hundreds:1, highestScore:109,
    strikeRate:166.01, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:52, stumpings:11 },
  { id:"anrich_nortje_t20i", name:"Anrich Nortje", country:"South Africa", role:"Bowler", rarity:"Rare", avatarUrl:null,
    matches:49, runs:56, fours:3, sixes:2, fifties:0, hundreds:0, highestScore:12,
    strikeRate:62.22, bestBowlingWickets:4, bestBowlingRuns:10, economyRate:7.33, wickets:65, catches:10, stumpings:0 },

  // New Zealand
  { id:"devon_conway_t20i", name:"Devon Conway", country:"New Zealand", role:"Batter", rarity:"Epic", avatarUrl:null,
    matches:81, runs:2340, fours:210, sixes:71, fifties:18, hundreds:1, highestScore:99,
    strikeRate:132.39, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:43, stumpings:15 },
  { id:"trent_boult_t20i", name:"Trent Boult", country:"New Zealand", role:"Bowler", rarity:"Epic", avatarUrl:null,
    matches:61, runs:82, fours:4, sixes:2, fifties:0, hundreds:0, highestScore:12,
    strikeRate:60.29, bestBowlingWickets:4, bestBowlingRuns:18, economyRate:7.86, wickets:75, catches:13, stumpings:0 },
  { id:"daryl_mitchell_t20i", name:"Daryl Mitchell", country:"New Zealand", role:"All-rounder", rarity:"Rare", avatarUrl:null,
    matches:64, runs:1440, fours:115, sixes:61, fifties:9, hundreds:0, highestScore:72,
    strikeRate:133.46, bestBowlingWickets:4, bestBowlingRuns:17, economyRate:9.04, wickets:22, catches:24, stumpings:0 },

  // West Indies
  { id:"evin_lewis_t20i", name:"Evin Lewis", country:"West Indies", role:"Batter", rarity:"Rare", avatarUrl:null,
    matches:67, runs:1611, fours:137, sixes:92, fifties:10, hundreds:1, highestScore:125,
    strikeRate:148.07, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:24, stumpings:0 },
  { id:"shimron_hetmyer_t20i", name:"Shimron Hetmyer", country:"West Indies", role:"Batter", rarity:"Rare", avatarUrl:null,
    matches:82, runs:1681, fours:132, sixes:98, fifties:8, hundreds:0, highestScore:82,
    strikeRate:147.02, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:28, stumpings:0 },
  { id:"jason_holder_t20i", name:"Jason Holder", country:"West Indies", role:"All-rounder", rarity:"Rare", avatarUrl:null,
    matches:88, runs:652, fours:45, sixes:28, fifties:1, hundreds:0, highestScore:57,
    strikeRate:119.78, bestBowlingWickets:4, bestBowlingRuns:26, economyRate:8.87, wickets:64, catches:22, stumpings:0 },
  { id:"romario_shepherd_t20i", name:"Romario Shepherd", country:"West Indies", role:"All-rounder", rarity:"Rare", avatarUrl:null,
    matches:64, runs:786, fours:54, sixes:52, fifties:3, hundreds:0, highestScore:64,
    strikeRate:158.87, bestBowlingWickets:4, bestBowlingRuns:13, economyRate:9.12, wickets:58, catches:18, stumpings:0 },

  // Sri Lanka
  { id:"dhananjaya_de_silva_t20i", name:"Dhananjaya de Silva", country:"Sri Lanka", role:"All-rounder", rarity:"Rare", avatarUrl:null,
    matches:78, runs:1388, fours:118, sixes:53, fifties:7, hundreds:0, highestScore:74,
    strikeRate:128.64, bestBowlingWickets:4, bestBowlingRuns:4, economyRate:7.38, wickets:64, catches:32, stumpings:0 },
  { id:"charith_asalanka_t20i", name:"Charith Asalanka", country:"Sri Lanka", role:"Batter", rarity:"Rare", avatarUrl:null,
    matches:76, runs:1803, fours:155, sixes:71, fifties:13, hundreds:0, highestScore:80,
    strikeRate:137.21, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:27, stumpings:0 },
  { id:"maheesh_theekshana_t20i", name:"Maheesh Theekshana", country:"Sri Lanka", role:"Bowler", rarity:"Rare", avatarUrl:null,
    matches:62, runs:60, fours:2, sixes:1, fifties:0, hundreds:0, highestScore:7,
    strikeRate:50.00, bestBowlingWickets:4, bestBowlingRuns:10, economyRate:7.01, wickets:84, catches:14, stumpings:0 },

  // Bangladesh
  { id:"soumya_sarkar_t20i", name:"Soumya Sarkar", country:"Bangladesh", role:"Batter", rarity:"Common", avatarUrl:null,
    matches:83, runs:1626, fours:167, sixes:55, fifties:8, hundreds:0, highestScore:67,
    strikeRate:126.28, bestBowlingWickets:4, bestBowlingRuns:14, economyRate:8.16, wickets:14, catches:22, stumpings:0 },
  { id:"litton_das_t20i", name:"Litton Das", country:"Bangladesh", role:"Wicket-keeper", rarity:"Rare", avatarUrl:null,
    matches:80, runs:1682, fours:154, sixes:64, fifties:10, hundreds:1, highestScore:105,
    strikeRate:130.00, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:58, stumpings:14 },

  // Afghanistan
  { id:"hazratullah_zazai_t20i", name:"Hazratullah Zazai", country:"Afghanistan", role:"Batter", rarity:"Rare", avatarUrl:null,
    matches:51, runs:1069, fours:100, sixes:55, fifties:5, hundreds:1, highestScore:162,
    strikeRate:148.54, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:12, stumpings:0 },
  { id:"mujeeb_ur_rahman_t20i", name:"Mujeeb Ur Rahman", country:"Afghanistan", role:"Bowler", rarity:"Epic", avatarUrl:null,
    matches:79, runs:156, fours:10, sixes:4, fifties:0, hundreds:0, highestScore:18,
    strikeRate:88.63, bestBowlingWickets:5, bestBowlingRuns:14, economyRate:6.61, wickets:107, catches:15, stumpings:0 },
  { id:"gulbadin_naib_t20i", name:"Gulbadin Naib", country:"Afghanistan", role:"All-rounder", rarity:"Common", avatarUrl:null,
    matches:82, runs:960, fours:73, sixes:33, fifties:3, hundreds:0, highestScore:59,
    strikeRate:121.67, bestBowlingWickets:4, bestBowlingRuns:14, economyRate:8.33, wickets:68, catches:22, stumpings:0 },

  // Ireland & Zimbabwe
  { id:"kevin_o_brien_t20i", name:"Kevin O'Brien", country:"Ireland", role:"All-rounder", rarity:"Rare", avatarUrl:null,
    matches:104, runs:1498, fours:115, sixes:68, fifties:8, hundreds:0, highestScore:66,
    strikeRate:131.11, bestBowlingWickets:4, bestBowlingRuns:26, economyRate:8.54, wickets:60, catches:40, stumpings:0 },
  { id:"lorcan_tucker_t20i", name:"Lorcan Tucker", country:"Ireland", role:"Wicket-keeper", rarity:"Common", avatarUrl:null,
    matches:74, runs:1456, fours:121, sixes:44, fifties:8, hundreds:1, highestScore:108,
    strikeRate:124.05, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:52, stumpings:14 },


  { id:"akeal_hosein_t20i", name:"Akeal Hosein", country:"West Indies", role:"Bowler", rarity:"Common", avatarUrl:null, matches:64, runs:142, fours:8, sixes:4, fifties:0, hundreds:0, highestScore:22, strikeRate:98.61, bestBowlingWickets:5, bestBowlingRuns:27, economyRate:7.38, wickets:79, catches:16, stumpings:0 },
  { id:"rassie_van_der_dussen_t20i", name:"Rassie van der Dussen", country:"South Africa", role:"Batter", rarity:"Rare", avatarUrl:null, matches:64, runs:1641, fours:136, sixes:65, fifties:12, hundreds:1, highestScore:93, strikeRate:145.05, bestBowlingWickets:1, bestBowlingRuns:14, economyRate:9.12, wickets:2, catches:24, stumpings:0 },
  { id:"tamim_iqbal_t20i", name:"Tamim Iqbal", country:"Bangladesh", role:"Batter", rarity:"Rare", avatarUrl:null, matches:78, runs:1758, fours:189, sixes:42, fifties:8, hundreds:0, highestScore:103, strikeRate:116.24, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:28, stumpings:0 },
  { id:"shreyas_iyer_t20i", name:"Shreyas Iyer", country:"India", role:"Batter", rarity:"Rare", avatarUrl:null, matches:74, runs:1649, fours:132, sixes:67, fifties:10, hundreds:1, highestScore:93, strikeRate:142.12, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:27, stumpings:0 },
  { id:"phil_salt_t20i", name:"Phil Salt", country:"England", role:"Batter", rarity:"Rare", avatarUrl:null, matches:42, runs:1257, fours:122, sixes:56, fifties:8, hundreds:1, highestScore:119, strikeRate:162.79, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:18, stumpings:10 },
  { id:"will_jacks_t20i", name:"Will Jacks", country:"England", role:"All-rounder", rarity:"Rare", avatarUrl:null, matches:46, runs:992, fours:89, sixes:46, fifties:7, hundreds:0, highestScore:89, strikeRate:152.30, bestBowlingWickets:3, bestBowlingRuns:12, economyRate:8.41, wickets:28, catches:17, stumpings:0 },
  { id:"tim_david_t20i", name:"Tim David", country:"Singapore", role:"Batter", rarity:"Rare", avatarUrl:null, matches:36, runs:666, fours:40, sixes:49, fifties:4, hundreds:0, highestScore:75, strikeRate:167.50, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:12, stumpings:0 },

  { id:"rahmanullah_gurbaz_t20i", name:"Rahmanullah Gurbaz", country:"Afghanistan", role:"Wicket-keeper", rarity:"Rare", avatarUrl:null, matches:62, runs:1720, fours:157, sixes:70, fifties:10, hundreds:1, highestScore:118, strikeRate:153.44, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:44, stumpings:10 },
  { id:"sikandar_raza_t20i2", name:"Sikandar Raza", country:"Zimbabwe", role:"All-rounder", rarity:"Rare", avatarUrl:null, matches:85, runs:1956, fours:166, sixes:57, fifties:13, hundreds:0, highestScore:82, strikeRate:128.58, bestBowlingWickets:5, bestBowlingRuns:11, economyRate:7.11, wickets:69, catches:29, stumpings:0 },
];
