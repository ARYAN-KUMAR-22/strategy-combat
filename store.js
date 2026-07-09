"use strict";
/**
 * Pluggable storage for accounts + win/loss records.
 *
 *   - If DATABASE_URL is set  -> Postgres (durable, scales, survives redeploys)
 *   - Otherwise               -> local users.json file (zero-config, offline dev)
 *
 * Both backends implement the same async interface, so server.js doesn't care
 * which one is active. A small in-memory Set of known usernames lets the socket
 * auth middleware do a synchronous existence check on every connection.
 */
const fs = require("fs");
const path = require("path");

let backend = null;            // "pg" | "file"
let pool = null;               // pg Pool (pg backend)
let users = {};                // { username: { hash, wins, losses, created } } (file backend)
const USERS_FILE = path.join(__dirname, "users.json");
const known = new Set();       // usernames that exist (both backends keep this current)

async function init() {
  if (process.env.DATABASE_URL) {
    const { Pool } = require("pg");
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // Most managed Postgres (Render, Neon, Supabase, Heroku) require SSL.
      ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
    });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        hash     TEXT NOT NULL,
        wins     INTEGER NOT NULL DEFAULT 0,
        losses   INTEGER NOT NULL DEFAULT 0,
        created  BIGINT  NOT NULL DEFAULT 0
      )`);
    const res = await pool.query("SELECT username FROM users");
    res.rows.forEach(r => known.add(r.username));
    backend = "pg";
    console.log(`[store] Postgres connected — ${known.size} existing users.`);
  } else {
    try { users = JSON.parse(fs.readFileSync(USERS_FILE, "utf8")); } catch { users = {}; }
    Object.keys(users).forEach(u => known.add(u));
    backend = "file";
    console.log(`[store] Local file store (${known.size} users). Set DATABASE_URL to use Postgres.`);
  }
}

function backendName() { return backend; }
function hasUserCached(username) { return known.has(username); }

async function getUser(username) {
  if (backend === "pg") {
    const r = await pool.query("SELECT username, hash, wins, losses FROM users WHERE username = $1", [username]);
    return r.rows[0] || null;
  }
  const u = users[username];
  return u ? { username, hash: u.hash, wins: u.wins, losses: u.losses } : null;
}

async function createUser(username, hash) {
  if (backend === "pg") {
    try {
      await pool.query("INSERT INTO users(username, hash, created) VALUES($1, $2, $3)", [username, hash, Date.now()]);
    } catch (e) {
      if (e.code === "23505") return false;   // unique_violation → name taken
      throw e;
    }
  } else {
    if (users[username]) return false;
    users[username] = { hash, wins: 0, losses: 0, created: Date.now() };
    saveFile();
  }
  known.add(username);
  return true;
}

async function recordResult(username, didWin) {
  if (backend === "pg") {
    await pool.query("UPDATE users SET wins = wins + $2, losses = losses + $3 WHERE username = $1",
      [username, didWin ? 1 : 0, didWin ? 0 : 1]);
  } else {
    const u = users[username];
    if (!u) return;
    if (didWin) u.wins++; else u.losses++;
    saveFile();
  }
}

async function topPlayers(limit) {
  if (backend === "pg") {
    const r = await pool.query(
      "SELECT username AS name, wins, losses FROM users ORDER BY wins DESC, losses ASC LIMIT $1", [limit]);
    return r.rows;
  }
  return Object.entries(users)
    .map(([name, s]) => ({ name, wins: s.wins || 0, losses: s.losses || 0 }))
    .sort((a, b) => b.wins - a.wins || a.losses - b.losses)
    .slice(0, limit);
}

async function countPlayers() {
  if (backend === "pg") {
    const r = await pool.query("SELECT COUNT(*)::int AS c FROM users");
    return r.rows[0].c;
  }
  return Object.keys(users).length;
}

// Debounced atomic file write (temp file + rename) for the file backend.
let saveQueued = false;
function saveFile() {
  if (saveQueued) return;
  saveQueued = true;
  setTimeout(() => {
    saveQueued = false;
    try {
      const tmp = USERS_FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(users));
      fs.renameSync(tmp, USERS_FILE);
    } catch (e) { console.error("[store] saveFile failed:", e.message); }
  }, 200);
}

module.exports = { init, backendName, hasUserCached, getUser, createUser, recordResult, topPlayers, countPlayers };
