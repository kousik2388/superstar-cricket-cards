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
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── CONSTANTS ─────────────────────────────────────────────────────────────────
const TOTAL_ROUNDS     = 10;
const BATTING_ROUNDS   = 5;   // rounds 0-4 = batting, 5-9 = bowling
const MAX_PLAYERS      = 4;
const MIN_PLAYERS      = 2;

const BATTING_STATS  = ['matches','runs','fours','sixes','fifties','hundreds','highestScore','strikeRate'];
const BOWLING_STATS  = ['bestBowling','economyRate','wickets','catches','stumpings'];

// Podium points: index = rank (0=1st, 1=2nd, 2=3rd, 3=4th)
const PODIUM_POINTS = [3, 2, 1, 0];

// 1v1: winner gets 1 round win, loser gets 0
// 3-4 players: podium points
function awardPoints(rank, totalPlayers) {
  if (totalPlayers <= 2) return rank === 0 ? 1 : 0;
  return PODIUM_POINTS[rank] ?? 0;
}

// ── STATE ─────────────────────────────────────────────────────────────────────
const rooms            = {};
const matchmakingQueue = [];  // for 2-player quick match only
const socketToRoom     = {};

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
    players: [],   // [{ socketId, name, score }]
    hands: {},
    round: 0,
    pickerIndex: 0,
    roundStat: null,
    roundPhase: 'pick',  // 'pick' | 'confirm' | 'result'
    confirmAcks: new Set(),
    nextAcks: new Set(),
    playAgainAcks: new Set(),
    started: false,
    finished: false,
  };
}

function currentPhase(round) {
  return round < BATTING_ROUNDS ? 'batting' : 'bowling';
}

function allowedStats(round) {
  return round < BATTING_ROUNDS ? BATTING_STATS : BOWLING_STATS;
}

function startGame(room) {
  room.started     = true;
  room.round       = 0;
  room.pickerIndex = 0;
  room.roundStat   = null;
  room.roundPhase  = 'pick';
  room.nextAcks    = new Set();
  room.confirmAcks = new Set();

  const deck = shuffle(ODI_CARDS);
  room.players.forEach((p, i) => {
    room.hands[p.socketId] = deck.slice(i * 10, (i+1) * 10);
  });

  room.players.forEach((p, i) => {
    io.to(p.socketId).emit('game:start', {
      yourHand:     room.hands[p.socketId],
      players:      room.players.map(x => ({ name: x.name, socketId: x.socketId })),
      yourIndex:    i,
      totalRounds:  TOTAL_ROUNDS,
      battingRounds: BATTING_ROUNDS,
      format:       room.format,
      maxPlayers:   room.maxPlayers,
    });
  });

  emitRound(room);
}

function emitRound(room) {
  room.roundStat   = null;
  room.roundPhase  = 'pick';
  room.confirmAcks = new Set();

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
    });
  });
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
    });
  });
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

  const sorted  = [...room.players].sort((a,b) => b.score - a.score);
  const scores  = Object.fromEntries(room.players.map(p => [p.socketId, p.score]));
  const payload = { reason, scores, finalRanking: sorted.map(p => ({ name: p.name, socketId: p.socketId, score: p.score })) };

  room.players.forEach((p, i) => {
    io.to(p.socketId).emit('game:over', { ...payload, yourIndex: i });
  });

  setTimeout(() => { delete rooms[room.code]; }, 30000);
}

// ── SOCKET HANDLERS ───────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log(`[+] ${socket.id}`);

  // ── CREATE ROOM ──
  socket.on('room:create', ({ playerName, maxPlayers=2, format='ODI' }) => {
    const code = generateRoomCode();
    const room = createRoom(code, Math.min(Math.max(maxPlayers,2),4), format);
    rooms[code] = room;
    room.players.push({ socketId: socket.id, name: playerName||'Player 1', score: 0 });
    socketToRoom[socket.id] = code;
    socket.join(code);
    socket.emit('room:created', { code, maxPlayers: room.maxPlayers });
  });

  // ── JOIN ROOM ──
  socket.on('room:join', ({ playerName, code }) => {
    const upper = (code||'').toUpperCase();
    const room  = rooms[upper];
    if (!room)                          return socket.emit('room:error', { message: 'Room not found.' });
    if (room.players.length >= room.maxPlayers) return socket.emit('room:error', { message: 'Room is full.' });
    if (room.started)                   return socket.emit('room:error', { message: 'Game already started.' });

    const name = playerName || `Player ${room.players.length+1}`;
    room.players.push({ socketId: socket.id, name, score: 0 });
    socketToRoom[socket.id] = upper;
    socket.join(upper);

    const playerList = room.players.map(p => ({ name: p.name, socketId: p.socketId }));
    room.players.forEach(p => {
      io.to(p.socketId).emit('room:playerJoined', {
        players:    playerList,
        maxPlayers: room.maxPlayers,
        canStart:   room.players.length >= MIN_PLAYERS,
      });
    });
  });

  // ── HOST STARTS GAME ──
  socket.on('room:start', () => {
    const code = socketToRoom[socket.id];
    if (!code) return;
    const room = rooms[code];
    if (!room || room.started) return;
    if (room.players[0].socketId !== socket.id) return; // only host
    if (room.players.length < MIN_PLAYERS) return;
    startGame(room);
  });

  // ── QUICK MATCH (2-player only) ──
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
      socketToRoom[opp.id]    = code;
      socketToRoom[socket.id] = code;
      opp.join(code); socket.join(code);
      const [p1,p2] = room.players;
      io.to(p1.socketId).emit('matchmaking:matched', { opponentName: p2.name, code });
      io.to(p2.socketId).emit('matchmaking:matched', { opponentName: p1.name, code });
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

  // ── PICKER PICKS STAT ──
  socket.on('round:pick', ({ statKey }) => {
    const code = socketToRoom[socket.id];
    if (!code) return;
    const room = rooms[code];
    if (!room || room.finished || room.roundPhase !== 'pick') return;
    const picker = room.players[room.pickerIndex];
    if (socket.id !== picker.socketId) return;
    // Validate stat is allowed for current phase
    if (!allowedStats(room.round).includes(statKey) && statKey !== 'bestBowling') return;
    emitStatChosen(room, statKey);
  });

  // ── NON-PICKERS CONFIRM ──
  socket.on('round:confirm', () => {
    const code = socketToRoom[socket.id];
    if (!code) return;
    const room = rooms[code];
    if (!room || room.finished || room.roundPhase !== 'confirm') return;
    const picker = room.players[room.pickerIndex];
    if (socket.id === picker.socketId) return; // picker doesn't confirm

    room.confirmAcks.add(socket.id);
    const nonPickers = room.players.filter(p => p.socketId !== picker.socketId);
    if (room.confirmAcks.size >= nonPickers.length) {
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
      room.playAgainAcks = new Set();
      room.nextAcks      = new Set();
      room.confirmAcks   = new Set();
      room.finished      = false;
      room.started       = false;
      room.round         = 0;
      room.pickerIndex   = 0;
      room.roundStat     = null;
      room.roundPhase    = 'pick';
      room.players.forEach(p => { p.score = 0; });
      startGame(room);
    } else {
      const other = room.players.find(p => p.socketId !== socket.id);
      if (other) io.to(other.socketId).emit('game:opponentWantsRematch');
    }
  });

  // ── DISCONNECT ──
  socket.on('disconnect', () => {
    console.log(`[-] ${socket.id}`);
    const mmIdx = matchmakingQueue.indexOf(socket);
    if (mmIdx !== -1) matchmakingQueue.splice(mmIdx, 1);
    const code = socketToRoom[socket.id];
    if (!code) return;
    delete socketToRoom[socket.id];
    const room = rooms[code];
    if (!room || room.finished) return;
    const left = room.players.find(p => p.socketId === socket.id);
    if (room.started) {
      room.players.filter(p => p.socketId !== socket.id).forEach(p => {
        io.to(p.socketId).emit('game:opponentDisconnected', { opponentName: left?.name || 'A player' });
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


// ═══════════════════════════════════════════════════════════════════════════════
// ODI CARDS — 40 cards for 4-player support (10 each)
// Snapshot: May 2026 | Sources: ESPNcricinfo, myKhel, Wisden, Cricbuzz
// ═══════════════════════════════════════════════════════════════════════════════
const ODI_CARDS = [
  // INDIA
  { id:"sachin_tendulkar_odi", name:"Sachin Tendulkar", country:"India", role:"Batter", rarity:"Legendary", matches:463, runs:18426, fours:2016, sixes:195, fifties:96, hundreds:49, highestScore:200, strikeRate:86.23, bestBowlingWickets:5, bestBowlingRuns:32, economyRate:5.10, wickets:154, catches:140, stumpings:0 },
  { id:"ms_dhoni_odi", name:"MS Dhoni", country:"India", role:"Wicket-keeper", rarity:"Legendary", matches:350, runs:10773, fours:826, sixes:229, fifties:73, hundreds:10, highestScore:183, strikeRate:87.56, bestBowlingWickets:1, bestBowlingRuns:14, economyRate:5.93, wickets:1, catches:321, stumpings:123 },
  { id:"virat_kohli_odi", name:"Virat Kohli", country:"India", role:"Batter", rarity:"Legendary", matches:302, runs:14557, fours:1310, sixes:155, fifties:74, hundreds:54, highestScore:183, strikeRate:93.62, bestBowlingWickets:4, bestBowlingRuns:13, economyRate:6.39, wickets:4, catches:150, stumpings:0 },
  { id:"rohit_sharma_odi", name:"Rohit Sharma", country:"India", role:"Batter", rarity:"Legendary", matches:282, runs:11577, fours:1090, sixes:357, fifties:57, hundreds:32, highestScore:264, strikeRate:89.80, bestBowlingWickets:2, bestBowlingRuns:9, economyRate:5.42, wickets:8, catches:115, stumpings:0 },
  { id:"sourav_ganguly_odi", name:"Sourav Ganguly", country:"India", role:"All-rounder", rarity:"Epic", matches:311, runs:11363, fours:1122, sixes:190, fifties:72, hundreds:22, highestScore:183, strikeRate:73.70, bestBowlingWickets:5, bestBowlingRuns:16, economyRate:4.37, wickets:100, catches:100, stumpings:0 },
  { id:"yuvraj_singh_odi", name:"Yuvraj Singh", country:"India", role:"All-rounder", rarity:"Epic", matches:304, runs:8701, fours:779, sixes:284, fifties:52, hundreds:14, highestScore:150, strikeRate:87.66, bestBowlingWickets:5, bestBowlingRuns:31, economyRate:5.02, wickets:111, catches:89, stumpings:0 },
  { id:"jasprit_bumrah_odi", name:"Jasprit Bumrah", country:"India", role:"Bowler", rarity:"Legendary", matches:89, runs:65, fours:3, sixes:2, fifties:0, hundreds:0, highestScore:10, strikeRate:62.00, bestBowlingWickets:6, bestBowlingRuns:19, economyRate:4.60, wickets:149, catches:18, stumpings:0 },
  // AUSTRALIA
  { id:"ricky_ponting_odi", name:"Ricky Ponting", country:"Australia", role:"Batter", rarity:"Legendary", matches:375, runs:13704, fours:1231, sixes:163, fifties:82, hundreds:30, highestScore:164, strikeRate:80.39, bestBowlingWickets:3, bestBowlingRuns:0, economyRate:4.73, wickets:3, catches:160, stumpings:0 },
  { id:"adam_gilchrist_odi", name:"Adam Gilchrist", country:"Australia", role:"Wicket-keeper", rarity:"Legendary", matches:287, runs:9619, fours:1000, sixes:149, fifties:55, hundreds:16, highestScore:172, strikeRate:96.94, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:417, stumpings:55 },
  { id:"brett_lee_odi", name:"Brett Lee", country:"Australia", role:"Bowler", rarity:"Epic", matches:221, runs:950, fours:59, sixes:32, fifties:2, hundreds:0, highestScore:52, strikeRate:83.04, bestBowlingWickets:5, bestBowlingRuns:22, economyRate:4.76, wickets:380, catches:49, stumpings:0 },
  { id:"shane_warne_odi", name:"Shane Warne", country:"Australia", role:"Bowler", rarity:"Legendary", matches:194, runs:1018, fours:78, sixes:8, fifties:1, hundreds:0, highestScore:55, strikeRate:68.92, bestBowlingWickets:5, bestBowlingRuns:33, economyRate:4.25, wickets:293, catches:80, stumpings:0 },
  { id:"mitchell_starc_odi", name:"Mitchell Starc", country:"Australia", role:"Bowler", rarity:"Epic", matches:130, runs:620, fours:35, sixes:18, fifties:0, hundreds:0, highestScore:52, strikeRate:91.00, bestBowlingWickets:6, bestBowlingRuns:28, economyRate:5.27, wickets:247, catches:26, stumpings:0 },
  { id:"steve_smith_odi", name:"Steve Smith", country:"Australia", role:"Batter", rarity:"Epic", matches:170, runs:5431, fours:439, sixes:67, fifties:36, hundreds:13, highestScore:164, strikeRate:86.55, bestBowlingWickets:3, bestBowlingRuns:26, economyRate:5.88, wickets:31, catches:83, stumpings:0 },
  { id:"david_warner_odi", name:"David Warner", country:"Australia", role:"Batter", rarity:"Epic", matches:161, runs:6932, fours:693, sixes:189, fifties:33, hundreds:22, highestScore:179, strikeRate:95.97, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:71, stumpings:0 },
  // ENGLAND
  { id:"ben_stokes_odi", name:"Ben Stokes", country:"England", role:"All-rounder", rarity:"Epic", matches:114, runs:3463, fours:282, sixes:109, fifties:21, hundreds:3, highestScore:102, strikeRate:95.09, bestBowlingWickets:5, bestBowlingRuns:61, economyRate:6.19, wickets:74, catches:43, stumpings:0 },
  { id:"andrew_flintoff_odi", name:"Andrew Flintoff", country:"England", role:"All-rounder", rarity:"Epic", matches:141, runs:3394, fours:318, sixes:72, fifties:18, hundreds:3, highestScore:123, strikeRate:87.22, bestBowlingWickets:5, bestBowlingRuns:19, economyRate:4.89, wickets:169, catches:38, stumpings:0 },
  { id:"eoin_morgan_odi", name:"Eoin Morgan", country:"England", role:"Batter", rarity:"Rare", matches:248, runs:7701, fours:631, sixes:220, fifties:45, hundreds:13, highestScore:148, strikeRate:87.57, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:90, stumpings:0 },
  { id:"joe_root_odi", name:"Joe Root", country:"England", role:"Batter", rarity:"Epic", matches:174, runs:6977, fours:700, sixes:62, fifties:55, hundreds:16, highestScore:133, strikeRate:87.21, bestBowlingWickets:3, bestBowlingRuns:52, economyRate:5.71, wickets:20, catches:93, stumpings:0 },
  // SOUTH AFRICA
  { id:"ab_devilliers_odi", name:"AB de Villiers", country:"South Africa", role:"Batter", rarity:"Legendary", matches:228, runs:9577, fours:839, sixes:204, fifties:53, hundreds:25, highestScore:176, strikeRate:101.10, bestBowlingWickets:1, bestBowlingRuns:47, economyRate:6.39, wickets:1, catches:232, stumpings:1 },
  { id:"shaun_pollock_odi", name:"Shaun Pollock", country:"South Africa", role:"All-rounder", rarity:"Epic", matches:303, runs:3519, fours:273, sixes:15, fifties:14, hundreds:0, highestScore:130, strikeRate:70.63, bestBowlingWickets:6, bestBowlingRuns:35, economyRate:3.67, wickets:393, catches:112, stumpings:0 },
  { id:"hashim_amla_odi", name:"Hashim Amla", country:"South Africa", role:"Batter", rarity:"Epic", matches:181, runs:8113, fours:835, sixes:64, fifties:48, hundreds:27, highestScore:159, strikeRate:88.93, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:60, stumpings:0 },
  { id:"jacques_kallis_odi", name:"Jacques Kallis", country:"South Africa", role:"All-rounder", rarity:"Legendary", matches:328, runs:11579, fours:1107, sixes:98, fifties:86, hundreds:17, highestScore:139, strikeRate:72.89, bestBowlingWickets:5, bestBowlingRuns:30, economyRate:4.06, wickets:273, catches:200, stumpings:0 },
  // PAKISTAN
  { id:"wasim_akram_odi", name:"Wasim Akram", country:"Pakistan", role:"Bowler", rarity:"Legendary", matches:356, runs:3717, fours:263, sixes:72, fifties:6, hundreds:3, highestScore:86, strikeRate:86.09, bestBowlingWickets:5, bestBowlingRuns:15, economyRate:3.89, wickets:502, catches:88, stumpings:0 },
  { id:"shahid_afridi_odi", name:"Shahid Afridi", country:"Pakistan", role:"All-rounder", rarity:"Legendary", matches:398, runs:8064, fours:687, sixes:351, fifties:39, hundreds:6, highestScore:124, strikeRate:117.00, bestBowlingWickets:7, bestBowlingRuns:12, economyRate:4.62, wickets:395, catches:125, stumpings:0 },
  { id:"babar_azam_odi", name:"Babar Azam", country:"Pakistan", role:"Batter", rarity:"Epic", matches:140, runs:6501, fours:601, sixes:68, fifties:43, hundreds:20, highestScore:158, strikeRate:87.89, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:46, stumpings:0 },
  { id:"waqar_younis_odi", name:"Waqar Younis", country:"Pakistan", role:"Bowler", rarity:"Epic", matches:262, runs:1010, fours:73, sixes:22, fifties:0, hundreds:0, highestScore:37, strikeRate:70.00, bestBowlingWickets:7, bestBowlingRuns:36, economyRate:4.68, wickets:416, catches:39, stumpings:0 },
  // WEST INDIES
  { id:"brian_lara_odi", name:"Brian Lara", country:"West Indies", role:"Batter", rarity:"Legendary", matches:299, runs:10405, fours:1058, sixes:97, fifties:63, hundreds:19, highestScore:169, strikeRate:79.29, bestBowlingWickets:4, bestBowlingRuns:37, economyRate:5.29, wickets:4, catches:120, stumpings:0 },
  { id:"chris_gayle_odi", name:"Chris Gayle", country:"West Indies", role:"Batter", rarity:"Legendary", matches:301, runs:10480, fours:1002, sixes:331, fifties:54, hundreds:25, highestScore:215, strikeRate:85.90, bestBowlingWickets:3, bestBowlingRuns:30, economyRate:5.05, wickets:167, catches:91, stumpings:0 },
  { id:"courtney_walsh_odi", name:"Courtney Walsh", country:"West Indies", role:"Bowler", rarity:"Rare", matches:205, runs:297, fours:14, sixes:2, fifties:0, hundreds:0, highestScore:30, strikeRate:44.67, bestBowlingWickets:5, bestBowlingRuns:1, economyRate:3.99, wickets:227, catches:32, stumpings:0 },
  { id:"viv_richards_odi", name:"Viv Richards", country:"West Indies", role:"Batter", rarity:"Legendary", matches:187, runs:6721, fours:590, sixes:118, fifties:45, hundreds:11, highestScore:189, strikeRate:90.20, bestBowlingWickets:6, bestBowlingRuns:41, economyRate:4.98, wickets:118, catches:101, stumpings:0 },
  // NEW ZEALAND
  { id:"brendon_mccullum_odi", name:"Brendon McCullum", country:"New Zealand", role:"Wicket-keeper", rarity:"Epic", matches:260, runs:6083, fours:537, sixes:200, fifties:30, hundreds:5, highestScore:166, strikeRate:96.98, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:377, stumpings:24 },
  { id:"kane_williamson_odi", name:"Kane Williamson", country:"New Zealand", role:"Batter", rarity:"Epic", matches:163, runs:6555, fours:610, sixes:63, fifties:46, hundreds:13, highestScore:148, strikeRate:81.30, bestBowlingWickets:4, bestBowlingRuns:22, economyRate:5.00, wickets:37, catches:67, stumpings:0 },
  { id:"trent_boult_odi", name:"Trent Boult", country:"New Zealand", role:"Bowler", rarity:"Rare", matches:114, runs:280, fours:20, sixes:7, fifties:0, hundreds:0, highestScore:26, strikeRate:63.02, bestBowlingWickets:7, bestBowlingRuns:34, economyRate:5.00, wickets:211, catches:38, stumpings:0 },
  // SRI LANKA
  { id:"kumar_sangakkara_odi", name:"Kumar Sangakkara", country:"Sri Lanka", role:"Wicket-keeper", rarity:"Legendary", matches:404, runs:14234, fours:1382, sixes:99, fifties:93, hundreds:25, highestScore:169, strikeRate:78.86, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:402, stumpings:99 },
  { id:"muttiah_muralitharan_odi", name:"Muttiah Muralitharan", country:"Sri Lanka", role:"Bowler", rarity:"Legendary", matches:350, runs:674, fours:45, sixes:4, fifties:0, hundreds:0, highestScore:33, strikeRate:58.98, bestBowlingWickets:7, bestBowlingRuns:30, economyRate:3.93, wickets:534, catches:131, stumpings:0 },
  { id:"lasith_malinga_odi", name:"Lasith Malinga", country:"Sri Lanka", role:"Bowler", rarity:"Epic", matches:226, runs:805, fours:49, sixes:29, fifties:0, hundreds:0, highestScore:56, strikeRate:91.39, bestBowlingWickets:6, bestBowlingRuns:38, economyRate:5.24, wickets:338, catches:34, stumpings:0 },
  { id:"sanath_jayasuriya_odi", name:"Sanath Jayasuriya", country:"Sri Lanka", role:"All-rounder", rarity:"Legendary", matches:445, runs:13430, fours:1500, sixes:270, fifties:68, hundreds:28, highestScore:189, strikeRate:91.20, bestBowlingWickets:6, bestBowlingRuns:29, economyRate:4.78, wickets:323, catches:123, stumpings:0 },
  // BANGLADESH
  { id:"shakib_al_hasan_odi", name:"Shakib Al Hasan", country:"Bangladesh", role:"All-rounder", rarity:"Epic", matches:247, runs:7570, fours:699, sixes:54, fifties:54, hundreds:9, highestScore:134, strikeRate:82.92, bestBowlingWickets:6, bestBowlingRuns:55, economyRate:4.45, wickets:299, catches:82, stumpings:0 },
  { id:"tamim_iqbal_odi", name:"Tamim Iqbal", country:"Bangladesh", role:"Batter", rarity:"Rare", matches:240, runs:8357, fours:906, sixes:107, fifties:56, hundreds:14, highestScore:158, strikeRate:80.68, bestBowlingWickets:0, bestBowlingRuns:0, economyRate:0, wickets:0, catches:63, stumpings:0 },
  // AFGHANISTAN
  { id:"rashid_khan_odi", name:"Rashid Khan", country:"Afghanistan", role:"Bowler", rarity:"Epic", matches:117, runs:1106, fours:104, sixes:37, fifties:3, hundreds:0, highestScore:60, strikeRate:103.50, bestBowlingWickets:7, bestBowlingRuns:18, economyRate:4.21, wickets:210, catches:28, stumpings:0 },
];
