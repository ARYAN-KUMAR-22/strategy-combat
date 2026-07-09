"use strict";
/**
 * Strategy Combat — multiplayer server (server-authoritative 1v1).
 *
 * Responsibilities:
 *   - Serve the client from /public
 *   - Match two waiting players into a game
 *   - Run the ONE true simulation for each match (clients only draw + send intent)
 *   - Validate every command so a hacked client cannot cheat
 *   - Broadcast the game state ~15x/second
 *
 * Run:  npm install  &&  npm start   (then open http://localhost:3000 in two tabs)
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const JWT_SECRET = process.env.JWT_SECRET || "dev-insecure-secret-change-in-production";
if (JWT_SECRET.startsWith("dev-")) console.warn("[warn] Using an insecure default JWT_SECRET. Set JWT_SECRET in production.");
const MAX_PLAYERS = parseInt(process.env.MAX_PLAYERS || "300", 10);

// ---- User store (accounts + win/loss), persisted to a JSON file -------------
// Reads/writes are infrequent (register, login, match end) so a file is fine for
// a few-hundred-player prototype. Swap for Postgres for real scale / persistence
// on ephemeral hosts (see DEPLOY.md).
const USERS_FILE = path.join(__dirname, "users.json");
let users = {};                              // { username: { hash, wins, losses, created } }
try { users = JSON.parse(fs.readFileSync(USERS_FILE, "utf8")); } catch { users = {}; }

let saveQueued = false;
function saveUsers() {                        // debounced atomic write (temp + rename)
  if (saveQueued) return;
  saveQueued = true;
  setTimeout(() => {
    saveQueued = false;
    try {
      const tmp = USERS_FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(users));
      fs.renameSync(tmp, USERS_FILE);
    } catch (e) { console.error("saveUsers failed:", e.message); }
  }, 200);
}
function recordResult(username, didWin) {
  const u = users[username];
  if (!u) return;
  if (didWin) u.wins++; else u.losses++;
  saveUsers();
}

const online = new Map();                     // username -> live connection count
function onlineAdd(u) { online.set(u, (online.get(u) || 0) + 1); }
function onlineRemove(u) { const c = (online.get(u) || 0) - 1; if (c <= 0) online.delete(u); else online.set(u, c); }

function validName(n) { return typeof n === "string" && /^[A-Za-z0-9_]{3,16}$/.test(n); }

// ---- Auth routes ------------------------------------------------------------
app.post("/api/register", async (req, res) => {
  const { username, password } = req.body || {};
  if (!validName(username)) return res.status(400).json({ error: "Username must be 3–16 letters/numbers/underscore." });
  if (typeof password !== "string" || password.length < 4) return res.status(400).json({ error: "Password must be at least 4 characters." });
  if (users[username]) return res.status(409).json({ error: "That username is already taken." });
  const hash = await bcrypt.hash(password, 10);
  users[username] = { hash, wins: 0, losses: 0, created: Date.now() };
  saveUsers();
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ token, username });
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body || {};
  const u = users[username];
  if (!u || !(await bcrypt.compare(String(password || ""), u.hash)))
    return res.status(401).json({ error: "Wrong username or password." });
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ token, username });
});

// Public stats for the lobby screen.
app.get("/leaderboard", (_req, res) => {
  const top = Object.entries(users)
    .map(([name, s]) => ({ name, wins: s.wins || 0, losses: s.losses || 0 }))
    .sort((a, b) => b.wins - a.wins || a.losses - b.losses)
    .slice(0, 10);
  res.json(top);
});
app.get("/status", (_req, res) => {
  res.json({ online: online.size, capacity: MAX_PLAYERS, matches: matches.size, players: Object.keys(users).length });
});

const server = http.createServer(app);
const io = new Server(server);

// ---- World / balance constants ---------------------------------------------
const WORLD = { w: 2000, h: 1400 };

// Troops progress from Ancient -> Modern, each stronger (and costlier) than the last.
// cls drives the 3D model + role; flying units are drawn elevated.
const UNIT_TYPES = {
  warrior:    { era: "Ancient",     cls: "melee",   hp: 70,  speed: 70,  range: 24,  dmg: 10, cd: 0.6, cost: { steel: 15,  fuel: 5 },              r: 9,  label: "Warrior" },
  archer:     { era: "Ancient",     cls: "ranged",  hp: 55,  speed: 75,  range: 120, dmg: 9,  cd: 0.8, cost: { steel: 25,  fuel: 10 },             r: 9,  label: "Archer" },
  knight:     { era: "Medieval",    cls: "cavalry", hp: 160, speed: 110, range: 28,  dmg: 18, cd: 0.6, cost: { steel: 55,  fuel: 20 },             r: 11, label: "Knight" },
  catapult:   { era: "Medieval",    cls: "siege",   hp: 90,  speed: 45,  range: 230, dmg: 34, cd: 1.8, cost: { steel: 80,  fuel: 40 },             r: 13, label: "Catapult" },
  musketeer:  { era: "Renaissance", cls: "ranged",  hp: 90,  speed: 80,  range: 150, dmg: 16, cd: 0.9, cost: { steel: 70,  fuel: 35 },             r: 9,  label: "Musketeer" },
  cannon:     { era: "Industrial",  cls: "siege",   hp: 120, speed: 50,  range: 240, dmg: 40, cd: 1.6, cost: { steel: 110, fuel: 55 },             r: 13, label: "Cannon" },
  rifleman:   { era: "Modern",      cls: "ranged",  hp: 120, speed: 85,  range: 170, dmg: 22, cd: 0.7, cost: { steel: 90,  fuel: 45, gold: 10 },   r: 9,  label: "Rifleman" },
  tank:       { era: "Modern",      cls: "armored", hp: 240, speed: 90,  range: 150, dmg: 30, cd: 0.8, cost: { steel: 150, fuel: 70, gold: 20 },   r: 13, label: "Tank" },
  artillery:  { era: "Modern",      cls: "siege",   hp: 110, speed: 55,  range: 300, dmg: 55, cd: 1.6, cost: { steel: 180, fuel: 90, gold: 30 },   r: 13, label: "Artillery" },
  helicopter: { era: "Modern",      cls: "air",     hp: 160, speed: 160, range: 160, dmg: 34, cd: 0.7, cost: { steel: 160, fuel: 120, gold: 40 }, r: 12, flying: true, label: "Helicopter" },
};

const BUILDINGS = {
  turret: { hp: 300, range: 230, dmg: 24, cd: 1.0, cost: { steel: 120, fuel: 40 }, r: 18 },
};

const BASE = { hp: 1200, r: 34 };
const TICK_HZ = 20;                 // simulation steps per second
const SNAPSHOT_EVERY = 2;           // broadcast every 2 ticks (~10/s)

// ---- Match management -------------------------------------------------------
let waiting = null;                 // a socket waiting for an opponent
const matches = new Map();          // matchId -> match
let nextId = 1;

function newId() { return nextId++; }

function makeUnit(type, x, y, team) {
  const t = UNIT_TYPES[type];
  return { id: newId(), kind: "unit", type, team, x, y, r: t.r,
           hp: t.hp, maxHp: t.hp, cooldown: 0, tx: x, ty: y, targetId: null };
}
function makeBase(x, y, team) {
  return { id: newId(), kind: "base", team, x, y, r: BASE.r,
           hp: BASE.hp, maxHp: BASE.hp, cooldown: 0 };
}
function makeBuilding(type, x, y, team) {
  const b = BUILDINGS[type];
  return { id: newId(), kind: "building", type, team, x, y, r: b.r,
           hp: b.hp, maxHp: b.hp, cooldown: 0 };
}

function createMatch(a, b) {
  const id = "m" + newId();
  // team "A" (bottom-left) and team "B" (top-right)
  const match = {
    id,
    sockets: { A: a, B: b },
    names: { A: a.data.name || "Player A", B: b.data.name || "Player B" },
    resources: {
      A: { gold: 100, steel: 200, fuel: 150 },
      B: { gold: 100, steel: 200, fuel: 150 },
    },
    entities: [],
    bullets: [],
    tick: 0,
    over: false,
  };

  match.entities.push(makeBase(240, WORLD.h - 240, "A"));
  match.entities.push(makeBase(WORLD.w - 240, 240, "B"));
  const startUnits = ["warrior", "warrior", "warrior", "archer"];
  startUnits.forEach((t, i) => match.entities.push(makeUnit(t, 340 + (i % 2) * 40, WORLD.h - 340 + ((i / 2) | 0) * 40, "A")));
  startUnits.forEach((t, i) => match.entities.push(makeUnit(t, WORLD.w - 340 - (i % 2) * 40, 340 + ((i / 2) | 0) * 40, "B")));

  matches.set(id, match);
  a.data.matchId = id; a.data.team = "A";
  b.data.matchId = id; b.data.team = "B";
  a.join(id); b.join(id);

  const payload = (team) => ({ matchId: id, yourTeam: team, world: WORLD,
                               unitTypes: UNIT_TYPES, buildings: BUILDINGS,
                               yourName: match.names[team],
                               opponentName: match.names[team === "A" ? "B" : "A"] });
  a.emit("matchStart", payload("A"));
  b.emit("matchStart", payload("B"));
  console.log(`Match ${id} started: ${a.id} (A) vs ${b.id} (B)`);
  return match;
}

function endMatch(match, winnerTeam, reason) {
  if (match.over) return;
  match.over = true;
  const loserTeam = winnerTeam === "A" ? "B" : "A";
  recordResult(match.names[winnerTeam], true);
  recordResult(match.names[loserTeam], false);
  io.to(match.id).emit("gameOver", { winner: winnerTeam, reason,
                                     winnerName: match.names[winnerTeam] });
  setTimeout(() => matches.delete(match.id), 2000);
  console.log(`Match ${match.id} over — ${winnerTeam} wins (${reason})`);
}

// ---- Simulation helpers -----------------------------------------------------
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function entById(match, id) { return match.entities.find(e => e.id === id); }

function nearestEnemy(match, e) {
  let best = null, bd = Infinity;
  for (const o of match.entities) {
    if (o.team === e.team || o.hp <= 0) continue;
    const d = dist(e, o);
    if (d < bd) { bd = d; best = o; }
  }
  return best;
}

function statsFor(e) {
  if (e.kind === "unit") return UNIT_TYPES[e.type];
  if (e.kind === "building") return BUILDINGS[e.type];
  if (e.kind === "base") return { range: 220, dmg: 22, cd: 1.1, speed: 0 };
  return null;
}

// ---- The tick: advance one match by dt --------------------------------------
function stepMatch(match, dt) {
  if (match.over) return;

  // economy: each player's base(s) produce resources
  for (const team of ["A", "B"]) {
    const hasBase = match.entities.some(e => e.kind === "base" && e.team === team && e.hp > 0);
    if (hasBase) {
      const r = match.resources[team];
      r.gold += 6 * dt; r.steel += 10 * dt; r.fuel += 8 * dt;
    }
  }

  // movement + combat for every entity that can act
  for (const e of match.entities) {
    if (e.hp <= 0) continue;
    const s = statsFor(e);
    e.cooldown = Math.max(0, e.cooldown - dt);

    // acquire target
    let target = e.targetId ? entById(match, e.targetId) : null;
    if (!target || target.hp <= 0) {
      target = null; e.targetId = null;
      const near = nearestEnemy(match, e);
      // units chase only if commanded-idle; bases/buildings auto-fire nearby
      if (near) {
        if (e.kind === "unit") { if (dist(e, near) < s.range + 80) { target = near; e.targetId = near.id; } }
        else if (dist(e, near) < s.range) { target = near; }
      }
    }

    // act
    if (e.kind === "unit") {
      let dest = { x: e.tx, y: e.ty };
      if (target && target.hp > 0) {
        if (dist(e, target) <= s.range) {
          dest = null;
          if (e.cooldown === 0) { fire(match, e, target, s); e.cooldown = s.cd; }
        } else { dest = { x: target.x, y: target.y }; }
      }
      if (dest) {
        const dx = dest.x - e.x, dy = dest.y - e.y, m = Math.hypot(dx, dy);
        if (m > 2) { e.x += (dx / m) * s.speed * dt; e.y += (dy / m) * s.speed * dt; }
      }
      e.x = clamp(e.x, 10, WORLD.w - 10);
      e.y = clamp(e.y, 10, WORLD.h - 10);
    } else {
      // base or building: stationary auto-fire
      if (target && target.hp > 0 && dist(e, target) <= s.range && e.cooldown === 0) {
        fire(match, e, target, s); e.cooldown = s.cd;
      }
    }
  }

  // resolve bullets
  for (const bl of match.bullets) {
    bl.life -= dt;
    if (bl.life <= 0) {
      const t = entById(match, bl.targetId);
      if (t && t.hp > 0) t.hp -= bl.dmg;
    }
  }
  match.bullets = match.bullets.filter(b => b.life > 0);

  // remove dead, check for destroyed bases
  const deadBases = match.entities.filter(e => e.kind === "base" && e.hp <= 0);
  match.entities = match.entities.filter(e => e.hp > 0);
  for (const b of deadBases) endMatch(match, b.team === "A" ? "B" : "A", "base destroyed");
}

function fire(match, from, to, stats) {
  match.bullets.push({ x: from.x, y: from.y, targetId: to.id,
                       dmg: stats.dmg, team: from.team, life: 0.35 });
}

// ---- Command handling (validated) -------------------------------------------
function canAfford(res, cost) {
  return res.steel >= (cost.steel || 0) && res.fuel >= (cost.fuel || 0) && res.gold >= (cost.gold || 0);
}
function pay(res, cost) {
  res.steel -= cost.steel || 0; res.fuel -= cost.fuel || 0; res.gold -= cost.gold || 0;
}

function handleBuild(match, team, type) {
  if (!UNIT_TYPES[type]) return;
  const res = match.resources[team];
  const cost = UNIT_TYPES[type].cost;
  if (!canAfford(res, cost)) return;
  const base = match.entities.find(e => e.kind === "base" && e.team === team && e.hp > 0);
  if (!base) return;
  pay(res, cost);
  const ang = Math.random() * Math.PI * 2;
  match.entities.push(makeUnit(type, base.x + Math.cos(ang) * 55, base.y + Math.sin(ang) * 55, team));
}

function handlePlaceBuilding(match, team, type, x, y) {
  if (!BUILDINGS[type]) return;
  const res = match.resources[team];
  const cost = BUILDINGS[type].cost;
  if (!canAfford(res, cost)) return;
  const base = match.entities.find(e => e.kind === "base" && e.team === team && e.hp > 0);
  if (!base) return;
  // must build within 400px of your own base — prevents dropping turrets on the enemy
  if (dist(base, { x, y }) > 400) return;
  pay(res, cost);
  match.entities.push(makeBuilding(type, clamp(x, 20, WORLD.w - 20), clamp(y, 20, WORLD.h - 20), team));
}

function handleCommand(match, team, unitIds, x, y, targetId) {
  const target = targetId ? entById(match, targetId) : null;
  const valid = target && target.team !== team ? target : null;
  const ids = new Set(unitIds);
  const chosen = match.entities.filter(e => e.kind === "unit" && e.team === team && ids.has(e.id));
  chosen.forEach((u, i) => {
    u.targetId = valid ? valid.id : null;
    const ang = (i / Math.max(1, chosen.length)) * Math.PI * 2;
    const spread = chosen.length > 1 ? 24 : 0;
    u.tx = clamp(x + Math.cos(ang) * spread, 10, WORLD.w - 10);
    u.ty = clamp(y + Math.sin(ang) * spread, 10, WORLD.h - 10);
  });
}

// ---- Snapshot (what clients draw) -------------------------------------------
function snapshot(match, team) {
  return {
    tick: match.tick,
    you: team,
    resources: match.resources[team],
    entities: match.entities.map(e => ({
      id: e.id, kind: e.kind, type: e.type || null, team: e.team,
      x: Math.round(e.x), y: Math.round(e.y), r: e.r,
      hp: Math.max(0, Math.round(e.hp)), maxHp: e.maxHp,
    })),
    bullets: match.bullets.map(b => {
      const t = entById(match, b.targetId);
      return { x: Math.round(b.x), y: Math.round(b.y),
               tx: t ? Math.round(t.x) : b.x, ty: t ? Math.round(t.y) : b.y, team: b.team };
    }),
  };
}

// ---- Socket wiring ----------------------------------------------------------
// Every socket must present a valid JWT (from register/login) before connecting.
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload || !users[payload.username]) return next(new Error("auth"));
    socket.data.username = payload.username;
    next();
  } catch { next(new Error("auth")); }
});

io.on("connection", (socket) => {
  // capacity guard — protects the server at the target player ceiling
  if (online.size >= MAX_PLAYERS && !online.has(socket.data.username)) {
    socket.emit("serverFull", { capacity: MAX_PLAYERS });
    return socket.disconnect(true);
  }
  onlineAdd(socket.data.username);
  io.emit("online", online.size);
  console.log(`connected: ${socket.data.username} (${online.size} online, ${matches.size} matches)`);

  socket.on("findMatch", () => {
    if (socket.data.matchId) return;
    socket.data.name = socket.data.username;
    if (waiting && waiting.id !== socket.id && waiting.connected) {
      const opp = waiting; waiting = null;
      createMatch(opp, socket);
    } else {
      waiting = socket;
      socket.emit("waiting");
    }
  });

  socket.on("build", ({ type }) => {
    const m = matches.get(socket.data.matchId);
    if (m && !m.over) handleBuild(m, socket.data.team, type);
  });

  socket.on("placeBuilding", ({ type, x, y }) => {
    const m = matches.get(socket.data.matchId);
    if (m && !m.over) handlePlaceBuilding(m, socket.data.team, type, x, y);
  });

  socket.on("command", ({ unitIds, x, y, targetId }) => {
    const m = matches.get(socket.data.matchId);
    if (m && !m.over && Array.isArray(unitIds))
      handleCommand(m, socket.data.team, unitIds.slice(0, 500), x, y, targetId);
  });

  socket.on("disconnect", () => {
    onlineRemove(socket.data.username);
    io.emit("online", online.size);
    console.log(`disconnected: ${socket.data.username} (${online.size} online)`);
    if (waiting && waiting.id === socket.id) waiting = null;
    const m = matches.get(socket.data.matchId);
    if (m && !m.over) endMatch(m, socket.data.team === "A" ? "B" : "A", "opponent left");
  });
});

// ---- Global simulation loop -------------------------------------------------
const dt = 1 / TICK_HZ;
setInterval(() => {
  for (const match of matches.values()) {
    if (match.over) continue;
    match.tick++;
    stepMatch(match, dt);
    if (match.tick % SNAPSHOT_EVERY === 0) {
      const A = match.sockets.A, B = match.sockets.B;
      if (A && A.connected) A.emit("state", snapshot(match, "A"));
      if (B && B.connected) B.emit("state", snapshot(match, "B"));
    }
  }
}, 1000 / TICK_HZ);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Strategy Combat multiplayer running:  http://localhost:${PORT}`);
  console.log("Open it in TWO browser tabs and click 'Find Match' in both.");
});
