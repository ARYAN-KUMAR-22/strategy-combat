"use strict";
/**
 * Strategy Combat — multiplayer server (single shared world, server-authoritative).
 *
 *   - Serves the client from /public
 *   - Accounts: register / login (JWT), storage via Postgres or a local file
 *   - ONE shared free-for-all world: every player spawns their own HQ + troops on
 *     the same large map and can fight anyone. Destroy an enemy HQ to eliminate them.
 *   - Interest management: each client only receives entities near its view, so the
 *     world scales to hundreds of concurrent players.
 *
 * Run:  npm install  &&  npm start
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const JWT_SECRET = process.env.JWT_SECRET || "dev-insecure-secret-change-in-production";
if (JWT_SECRET.startsWith("dev-")) console.warn("[warn] Using an insecure default JWT_SECRET. Set JWT_SECRET in production.");
const MAX_PLAYERS = parseInt(process.env.MAX_PLAYERS || "300", 10);

// ---- Storage: Postgres when DATABASE_URL is set, else a local JSON file ------
const store = require("./store");

const online = new Map();                     // username -> live connection count
function onlineAdd(u) { online.set(u, (online.get(u) || 0) + 1); }
function onlineRemove(u) { const c = (online.get(u) || 0) - 1; if (c <= 0) online.delete(u); else online.set(u, c); }

function validName(n) { return typeof n === "string" && /^[A-Za-z0-9_]{3,16}$/.test(n); }

// ---- Auth routes ------------------------------------------------------------
app.post("/api/register", async (req, res) => {
  const { username, password } = req.body || {};
  if (!validName(username)) return res.status(400).json({ error: "Username must be 3–16 letters/numbers/underscore." });
  if (typeof password !== "string" || password.length < 4) return res.status(400).json({ error: "Password must be at least 4 characters." });
  const hash = await bcrypt.hash(password, 10);
  const created = await store.createUser(username, hash);
  if (!created) return res.status(409).json({ error: "That username is already taken." });
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ token, username });
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body || {};
  const u = await store.getUser(username);
  if (!u || !(await bcrypt.compare(String(password || ""), u.hash)))
    return res.status(401).json({ error: "Wrong username or password." });
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ token, username });
});

// Public stats for the lobby screen.
app.get("/leaderboard", async (_req, res) => {
  try { res.json(await store.topPlayers(10)); } catch { res.json([]); }
});
app.get("/status", async (_req, res) => {
  let players = 0; try { players = await store.countPlayers(); } catch {}
  res.json({ online: online.size, capacity: MAX_PLAYERS, players,
             inWorld: world.players.size, entities: world.entities.size, storage: store.backendName() });
});

const server = http.createServer(app);
const io = new Server(server);

// ---- Balance / world constants ---------------------------------------------
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
const BUILDINGS = { turret: { hp: 300, range: 230, dmg: 24, cd: 1.0, cost: { steel: 120, fuel: 40 }, r: 18 } };
const BASE = { hp: 1200, r: 34 };

const TICK_HZ = 20;                 // simulation steps per second
const SNAPSHOT_EVERY = 2;           // broadcast every 2 ticks (~10/s)

// One shared map, sized to comfortably fit every player's territory.
const SLOT = 440;                                    // spacing between player HQs (larger map)
const COLS = Math.ceil(Math.sqrt(MAX_PLAYERS));
const ROWS = Math.ceil(MAX_PLAYERS / COLS);
const WORLD = { w: COLS * SLOT, h: ROWS * SLOT };
const CELL = 220;                                    // spatial-grid cell size
const VIEW = 1100;                                   // interest radius sent to each client
const SHIELD_MS = 15000;                             // spawn protection duration (until you attack)
const CAP_RADIUS = 150;                              // how close units must be to capture a node
const CAP_TIME = 6;                                  // seconds of uncontested presence to flip a node
const NODE_STEEL = 5, NODE_FUEL = 4, NODE_GOLD = 3;  // bonus resources/sec per owned node

// ---- Shared world state -----------------------------------------------------
const world = {
  entities: new Map(),                               // id -> entity
  bullets: [],
  players: new Map(),                                // username -> player record
  nodes: [],                                         // capturable resource points
  tick: 0,
};
const freeSlots = [];
for (let i = 0; i < COLS * ROWS; i++) freeSlots.push(i);
function slotCenter(slot) {
  const col = slot % COLS, row = (slot / COLS) | 0;
  return { x: col * SLOT + SLOT / 2, y: row * SLOT + SLOT / 2 };
}
// Resource nodes sit on the borders between territories — natural contested points.
let nodeId = 1;
for (let c = 1; c < COLS; c++)
  for (let r = 1; r < ROWS; r++)
    world.nodes.push({ id: nodeId++, x: c * SLOT, y: r * SLOT, owner: null, cap: 0, capBy: null });

let nextId = 1;
const newId = () => nextId++;
let pendingDeaths = [];                               // deaths this snapshot window (for FX)

// Spawn as far as possible from existing players so newcomers aren't dropped into a war.
function pickSpawnSlot() {
  if (world.players.size === 0) return freeSlots[(Math.random() * freeSlots.length) | 0];
  let best = freeSlots[0], bestD = -1;
  for (const s of freeSlots) {
    const c = slotCenter(s);
    let mind = Infinity;
    for (const p of world.players.values()) {
      const b = world.entities.get(p.baseId); if (!b) continue;
      const d = dist(c, b); if (d < mind) mind = d;
    }
    if (mind > bestD) { bestD = mind; best = s; }
  }
  return best;
}
function isShielded(team) { const p = world.players.get(team); return !!(p && p.shieldUntil > Date.now()); }
function releaseNodes(username) {
  for (const nd of world.nodes) if (nd.owner === username) { nd.owner = null; nd.cap = 0; nd.capBy = null; }
}
// Capture: a node flips to a team after CAP_TIME seconds of uncontested presence.
function updateNodes(dt, grid) {
  for (const nd of world.nodes) {
    const cx = (nd.x / CELL) | 0, cy = (nd.y / CELL) | 0, rc = Math.ceil(CAP_RADIUS / CELL);
    const teams = new Set();
    for (let gx = cx - rc; gx <= cx + rc; gx++)
      for (let gy = cy - rc; gy <= cy + rc; gy++) {
        const arr = grid.get(gx + "," + gy); if (!arr) continue;
        for (const e of arr) if (e.kind === "unit" && dist(e, nd) <= CAP_RADIUS) teams.add(e.team);
      }
    if (teams.size !== 1) continue;                  // 0 = idle, >1 = contested → frozen
    const t = [...teams][0];
    if (t === nd.owner) { nd.cap = 100; nd.capBy = t; continue; }
    if (nd.capBy !== t) { nd.capBy = t; nd.cap = 0; } // a new challenger restarts the capture
    nd.cap += (100 / CAP_TIME) * dt;
    if (nd.cap >= 100) { nd.owner = t; nd.cap = 100; }
  }
}

function makeUnit(type, x, y, team) {
  const t = UNIT_TYPES[type];
  const e = { id: newId(), kind: "unit", type, team, x, y, r: t.r,
              hp: t.hp, maxHp: t.hp, cooldown: 0, tx: x, ty: y, targetId: null };
  world.entities.set(e.id, e); return e;
}
function makeBase(x, y, team) {
  const e = { id: newId(), kind: "base", team, x, y, r: BASE.r,
              hp: BASE.hp, maxHp: BASE.hp, cooldown: 0, lastHitBy: null };
  world.entities.set(e.id, e); return e;
}
function makeBuilding(type, x, y, team) {
  const b = BUILDINGS[type];
  const e = { id: newId(), kind: "building", type, team, x, y, r: b.r,
              hp: b.hp, maxHp: b.hp, cooldown: 0 };
  world.entities.set(e.id, e); return e;
}

// ---- Join / leave / elimination --------------------------------------------
function spawnPlayer(socket) {
  const username = socket.data.username;
  let p = world.players.get(username);
  if (p) {                                            // already in world (reconnect / new tab)
    p.socket = socket; socket.data.inWorld = true;
    const base = world.entities.get(p.baseId);
    const c = base ? { x: base.x, y: base.y } : slotCenter(p.slot);
    emitStart(socket, username, c);
    return p;
  }
  if (!freeSlots.length) { socket.emit("serverFull", { capacity: MAX_PLAYERS }); return null; }
  const slot = pickSpawnSlot();
  freeSlots.splice(freeSlots.indexOf(slot), 1);
  const c = slotCenter(slot);
  const base = makeBase(c.x, c.y, username);
  ["warrior", "warrior", "warrior", "archer"].forEach((t, i) =>
    makeUnit(t, c.x + (i % 2 ? 42 : -42), c.y + 55 + ((i / 2) | 0) * 30, username));
  p = { socket, res: { gold: 100, steel: 200, fuel: 150 }, baseId: base.id,
        viewX: c.x, viewY: c.y, slot, shieldUntil: Date.now() + SHIELD_MS };
  world.players.set(username, p);
  socket.data.inWorld = true;
  emitStart(socket, username, c);
  console.log(`spawned: ${username} at slot ${slot} (${world.players.size} in world)`);
  return p;
}
function emitStart(socket, username, c) {
  socket.emit("matchStart", { world: WORLD, unitTypes: UNIT_TYPES, buildings: BUILDINGS,
                              yourTeam: username, yourName: username, opponentName: "Free-for-all",
                              spawnX: c.x, spawnY: c.y });
}
function removeEntitiesOf(username) {
  for (const [id, e] of world.entities) if (e.team === username) world.entities.delete(id);
}
function cleanupPlayer(username) {                    // on disconnect — no loss recorded
  const p = world.players.get(username);
  if (!p) return;
  removeEntitiesOf(username);
  releaseNodes(username);
  freeSlots.push(p.slot);
  world.players.delete(username);
}
function eliminatePlayer(username, killer) {          // HQ destroyed — record result
  const p = world.players.get(username);
  if (!p) return;
  removeEntitiesOf(username);
  releaseNodes(username);
  freeSlots.push(p.slot);
  world.players.delete(username);
  if (killer && killer !== username) store.recordResult(killer, true).catch(() => {});
  store.recordResult(username, false).catch(() => {});
  if (p.socket && p.socket.connected) {
    p.socket.data.inWorld = false;
    p.socket.emit("gameOver", { winner: killer || "", winnerName: killer || "an enemy",
                                reason: "your HQ was destroyed" });
  }
  console.log(`eliminated: ${username} by ${killer || "?"} (${world.players.size} left)`);
}

// ---- Simulation helpers -----------------------------------------------------
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function statsFor(e) {
  if (e.kind === "unit") return UNIT_TYPES[e.type];
  if (e.kind === "building") return BUILDINGS[e.type];
  if (e.kind === "base") return { range: 220, dmg: 22, cd: 1.1, speed: 0 };
  return null;
}
function buildGrid() {
  const grid = new Map();
  for (const e of world.entities.values()) {
    if (e.hp <= 0) continue;
    const key = ((e.x / CELL) | 0) + "," + ((e.y / CELL) | 0);
    let arr = grid.get(key); if (!arr) grid.set(key, arr = []);
    arr.push(e);
  }
  return grid;
}
function nearestEnemyGrid(grid, e, searchR) {
  const cx = (e.x / CELL) | 0, cy = (e.y / CELL) | 0, rc = Math.max(1, Math.ceil(searchR / CELL));
  let best = null, bd = Infinity;
  for (let gx = cx - rc; gx <= cx + rc; gx++)
    for (let gy = cy - rc; gy <= cy + rc; gy++) {
      const arr = grid.get(gx + "," + gy); if (!arr) continue;
      for (const o of arr) {
        if (o.team === e.team || o.hp <= 0) continue;
        const d = dist(e, o); if (d < bd) { bd = d; best = o; }
      }
    }
  return best;
}
function fire(from, to, stats) {
  const ap = world.players.get(from.team);
  if (ap && ap.shieldUntil > Date.now()) ap.shieldUntil = 0;   // attacking ends spawn protection
  world.bullets.push({ x: from.x, y: from.y, targetId: to.id, dmg: stats.dmg, team: from.team, life: 0.35 });
}

// ---- The tick: advance the whole world by dt, return the spatial grid -------
function step(dt) {
  world.tick++;

  for (const p of world.players.values()) { p.res.gold += 6 * dt; p.res.steel += 10 * dt; p.res.fuel += 8 * dt; }

  const grid = buildGrid();
  updateNodes(dt, grid);
  for (const nd of world.nodes) if (nd.owner) {      // captured nodes pay their owner
    const p = world.players.get(nd.owner);
    if (p) { p.res.steel += NODE_STEEL * dt; p.res.fuel += NODE_FUEL * dt; p.res.gold += NODE_GOLD * dt; }
  }

  for (const e of world.entities.values()) {
    if (e.hp <= 0) continue;
    const s = statsFor(e);
    e.cooldown = Math.max(0, e.cooldown - dt);

    let target = e.targetId ? world.entities.get(e.targetId) : null;
    if (!target || target.hp <= 0) {
      target = null; e.targetId = null;
      const searchR = e.kind === "unit" ? s.range + 80 : s.range;
      const near = nearestEnemyGrid(grid, e, searchR);
      if (near) {
        if (e.kind === "unit") { if (dist(e, near) < s.range + 80) { target = near; e.targetId = near.id; } }
        else if (dist(e, near) <= s.range) target = near;
      }
    }

    if (e.kind === "unit") {
      let dest = { x: e.tx, y: e.ty };
      if (target && target.hp > 0) {
        if (dist(e, target) <= s.range) { dest = null; if (e.cooldown === 0) { fire(e, target, s); e.cooldown = s.cd; } }
        else dest = { x: target.x, y: target.y };
      }
      if (dest) {
        const dx = dest.x - e.x, dy = dest.y - e.y, m = Math.hypot(dx, dy);
        if (m > 2) { e.x += (dx / m) * s.speed * dt; e.y += (dy / m) * s.speed * dt; }
      }
      e.x = clamp(e.x, 10, WORLD.w - 10); e.y = clamp(e.y, 10, WORLD.h - 10);
    } else if (target && target.hp > 0 && dist(e, target) <= s.range && e.cooldown === 0) {
      fire(e, target, s); e.cooldown = s.cd;
    }
  }

  for (const bl of world.bullets) {
    bl.life -= dt;
    if (bl.life <= 0) {
      const t = world.entities.get(bl.targetId);
      if (t && t.hp > 0 && !isShielded(t.team)) { t.hp -= bl.dmg; if (t.kind === "base") t.lastHitBy = bl.team; }
    }
  }
  world.bullets = world.bullets.filter(b => b.life > 0);

  const deadBases = [];
  for (const [id, e] of world.entities) {
    if (e.hp <= 0) {
      pendingDeaths.push({ x: Math.round(e.x), y: Math.round(e.y), big: e.kind === "base" });
      if (e.kind === "base") deadBases.push(e);
      world.entities.delete(id);
    }
  }
  for (const b of deadBases) eliminatePlayer(b.team, b.lastHitBy);

  return grid;
}

// ---- Commands (validated against the acting player) -------------------------
function canAfford(res, cost) { return res.steel >= (cost.steel || 0) && res.fuel >= (cost.fuel || 0) && res.gold >= (cost.gold || 0); }
function pay(res, cost) { res.steel -= cost.steel || 0; res.fuel -= cost.fuel || 0; res.gold -= cost.gold || 0; }

function handleBuild(username, type) {
  if (!UNIT_TYPES[type]) return;
  const p = world.players.get(username); if (!p) return;
  const cost = UNIT_TYPES[type].cost;
  if (!canAfford(p.res, cost)) return;
  const base = world.entities.get(p.baseId); if (!base || base.hp <= 0) return;
  pay(p.res, cost);
  const ang = Math.random() * Math.PI * 2;
  makeUnit(type, base.x + Math.cos(ang) * 55, base.y + Math.sin(ang) * 55, username);
}
function handlePlaceBuilding(username, type, x, y) {
  if (!BUILDINGS[type]) return;
  const p = world.players.get(username); if (!p) return;
  const cost = BUILDINGS[type].cost;
  if (!canAfford(p.res, cost)) return;
  const base = world.entities.get(p.baseId); if (!base || base.hp <= 0) return;
  if (dist(base, { x, y }) > 400) return;             // only near your own HQ
  pay(p.res, cost);
  makeBuilding(type, clamp(x, 20, WORLD.w - 20), clamp(y, 20, WORLD.h - 20), username);
}
function handleCommand(username, unitIds, x, y, targetId) {
  const p = world.players.get(username); if (!p) return;
  const target = targetId ? world.entities.get(targetId) : null;
  const valid = target && target.team !== username && target.hp > 0 ? target : null;
  const ids = new Set(unitIds);
  const chosen = [];
  for (const id of ids) { const e = world.entities.get(id); if (e && e.kind === "unit" && e.team === username) chosen.push(e); }
  chosen.forEach((u, i) => {
    u.targetId = valid ? valid.id : null;
    const ang = (i / Math.max(1, chosen.length)) * Math.PI * 2, spread = chosen.length > 1 ? 24 : 0;
    u.tx = clamp(x + Math.cos(ang) * spread, 10, WORLD.w - 10);
    u.ty = clamp(y + Math.sin(ang) * spread, 10, WORLD.h - 10);
  });
}

// ---- Per-player snapshot (only what's near their view) ----------------------
function snapshotFor(username, p, grid, shielded) {
  const cx = p.viewX, cy = p.viewY;
  const gcx = (cx / CELL) | 0, gcy = (cy / CELL) | 0, rc = Math.ceil(VIEW / CELL);
  const entities = [];
  for (let gx = gcx - rc; gx <= gcx + rc; gx++)
    for (let gy = gcy - rc; gy <= gcy + rc; gy++) {
      const arr = grid.get(gx + "," + gy); if (!arr) continue;
      for (const e of arr) {
        entities.push({ id: e.id, kind: e.kind, type: e.type || null, team: e.team,
                        x: Math.round(e.x), y: Math.round(e.y), r: e.r,
                        hp: Math.max(0, Math.round(e.hp)), maxHp: e.maxHp,
                        shield: shielded.has(e.team) });
      }
    }
  const bullets = [];
  for (const b of world.bullets) {
    if (Math.abs(b.x - cx) > VIEW || Math.abs(b.y - cy) > VIEW) continue;
    const t = world.entities.get(b.targetId);
    bullets.push({ x: Math.round(b.x), y: Math.round(b.y),
                   tx: t ? Math.round(t.x) : b.x, ty: t ? Math.round(t.y) : b.y, team: b.team });
  }
  const deaths = pendingDeaths.filter(d => Math.abs(d.x - cx) <= VIEW && Math.abs(d.y - cy) <= VIEW);
  const nodes = [];
  for (const nd of world.nodes) {
    if (Math.abs(nd.x - cx) > VIEW || Math.abs(nd.y - cy) > VIEW) continue;
    nodes.push({ id: nd.id, x: nd.x, y: nd.y, owner: nd.owner, cap: Math.round(nd.cap), capBy: nd.capBy });
  }
  let myNodes = 0; for (const nd of world.nodes) if (nd.owner === username) myNodes++;
  return { you: username, world: WORLD, resources: p.res, entities, bullets, deaths, nodes, alive: true,
           playersInWorld: world.players.size, youShielded: shielded.has(username), myNodes };
}

// ---- Socket wiring ----------------------------------------------------------
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload || !store.hasUserCached(payload.username)) return next(new Error("auth"));
    socket.data.username = payload.username;
    next();
  } catch { next(new Error("auth")); }
});

io.on("connection", (socket) => {
  if (online.size >= MAX_PLAYERS && !online.has(socket.data.username)) {
    socket.emit("serverFull", { capacity: MAX_PLAYERS });
    return socket.disconnect(true);
  }
  onlineAdd(socket.data.username);
  io.emit("online", online.size);

  socket.on("findMatch", () => { spawnPlayer(socket); });   // join the shared world

  socket.on("view", ({ x, y }) => {                          // interest-management viewport
    const p = world.players.get(socket.data.username);
    if (p && typeof x === "number" && typeof y === "number") {
      p.viewX = clamp(x, 0, WORLD.w); p.viewY = clamp(y, 0, WORLD.h);
    }
  });

  socket.on("build", ({ type }) => { if (socket.data.inWorld) handleBuild(socket.data.username, type); });
  socket.on("placeBuilding", ({ type, x, y }) => { if (socket.data.inWorld) handlePlaceBuilding(socket.data.username, type, x, y); });
  socket.on("command", ({ unitIds, x, y, targetId }) => {
    if (socket.data.inWorld && Array.isArray(unitIds)) handleCommand(socket.data.username, unitIds.slice(0, 500), x, y, targetId);
  });

  socket.on("disconnect", () => {
    onlineRemove(socket.data.username);
    io.emit("online", online.size);
    // only clean up if this socket still owns the player (avoid nuking a reconnected tab)
    const p = world.players.get(socket.data.username);
    if (p && p.socket === socket) cleanupPlayer(socket.data.username);
  });
});

// ---- Global simulation loop -------------------------------------------------
const dt = 1 / TICK_HZ;
setInterval(() => {
  const grid = step(dt);
  if (world.tick % SNAPSHOT_EVERY === 0) {
    const now = Date.now();
    const shielded = new Set();
    for (const [u, pp] of world.players) if (pp.shieldUntil > now) shielded.add(u);
    for (const [username, p] of world.players) {
      if (p.socket && p.socket.connected) p.socket.emit("state", snapshotFor(username, p, grid, shielded));
    }
    pendingDeaths.length = 0;                    // consumed by this snapshot
  }
}, 1000 / TICK_HZ);

const PORT = process.env.PORT || 3000;
store.init().then(() => {
  server.listen(PORT, () => {
    console.log(`Strategy Combat running: http://localhost:${PORT}`);
    console.log(`Shared world ${WORLD.w}x${WORLD.h}, capacity ${MAX_PLAYERS} players.`);
  });
}).catch(err => { console.error("Store init failed:", err); process.exit(1); });
