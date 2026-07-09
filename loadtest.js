"use strict";
/**
 * Capacity load test — proves the server handles many concurrent players.
 * Registers N accounts, connects them all over WebSocket, has each Find Match
 * (so they pair into ~N/2 live matches), then reports the server's status.
 *
 * Run:  npm i -D socket.io-client   (one time)
 *       node loadtest.js 300        (start the server first)
 */
const { io } = require("socket.io-client");
const BASE = process.env.BASE || "http://localhost:3000";
const N = parseInt(process.argv[2] || "300", 10);

async function tokenFor(u) {
  const opt = { method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ username: u, password: "testpass" }) };
  let r = await fetch(BASE + "/api/register", opt);
  if (r.status === 409) r = await fetch(BASE + "/api/login", opt);
  return (await r.json()).token;
}

(async () => {
  console.log(`Preparing ${N} accounts…`);
  const tokens = [];
  for (let i = 0; i < N; i += 25) {
    const batch = [];
    for (let j = i; j < Math.min(N, i + 25); j++) batch.push(tokenFor("lt_" + j));
    tokens.push(...await Promise.all(batch));
  }
  const good = tokens.filter(Boolean).length;
  console.log(`Got ${good} tokens. Connecting ${good} sockets…`);

  let connected = 0, errors = 0;
  const t0 = Date.now();
  tokens.forEach(t => {
    if (!t) return;
    const s = io(BASE, { auth: { token: t }, transports: ["websocket"], reconnection: false });
    s.on("connect", () => { connected++; s.emit("findMatch"); });
    s.on("connect_error", () => { errors++; });
  });

  setTimeout(async () => {
    const st = await (await fetch(BASE + "/status")).json();
    console.log("\n================ LOAD TEST RESULT ================");
    console.log(`clients connected : ${connected}`);
    console.log(`connect errors    : ${errors}`);
    console.log(`server online     : ${st.online}`);
    console.log(`players in world  : ${st.inWorld}`);
    console.log(`active maps       : ${st.maps} (capacity ${st.mapCapacity} each)`);
    console.log(`storage backend   : ${st.storage}`);
    console.log(`connect time      : ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log("=================================================");
    process.exit(0);
  }, 7000);
})();
