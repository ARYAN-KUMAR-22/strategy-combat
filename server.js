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

const app = express();
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const io = new Server(server);

// ---- World / balance constants ---------------------------------------------
const WORLD = { w: 2000, h: 1400 };

const UNIT_TYPES = {
  scout:     { hp: 60,  speed: 150, range: 90,  dmg: 7,  cd: 0.5, cost: { steel: 20, fuel: 15 }, r: 9 },
  tank:      { hp: 130, speed: 90,  range: 130, dmg: 14, cd: 0.7, cost: { steel: 50, fuel: 30 }, r: 12 },
  artillery: { hp: 80,  speed: 55,  range: 240, dmg: 30, cd: 1.6, cost: { steel: 80, fuel: 55 }, r: 12 },
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
  for (let i = 0; i < 4; i++) match.entities.push(makeUnit("tank", 340 + (i % 2) * 40, WORLD.h - 340 + ((i / 2) | 0) * 40, "A"));
  for (let i = 0; i < 4; i++) match.entities.push(makeUnit("tank", WORLD.w - 340 - (i % 2) * 40, 340 + ((i / 2) | 0) * 40, "B"));

  matches.set(id, match);
  a.data.matchId = id; a.data.team = "A";
  b.data.matchId = id; b.data.team = "B";
  a.join(id); b.join(id);

  const payload = (team) => ({ matchId: id, yourTeam: team, world: WORLD,
                               unitTypes: UNIT_TYPES, buildings: BUILDINGS });
  a.emit("matchStart", payload("A"));
  b.emit("matchStart", payload("B"));
  console.log(`Match ${id} started: ${a.id} (A) vs ${b.id} (B)`);
  return match;
}

function endMatch(match, winnerTeam, reason) {
  if (match.over) return;
  match.over = true;
  io.to(match.id).emit("gameOver", { winner: winnerTeam, reason });
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
io.on("connection", (socket) => {
  console.log("connected:", socket.id);

  socket.on("findMatch", () => {
    if (socket.data.matchId) return;
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
    console.log("disconnected:", socket.id);
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
