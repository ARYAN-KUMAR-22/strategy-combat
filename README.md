# Strategy Combat — Online 1v1 (Multiplayer Prototype)

This is a **real-time, server-authoritative** version where **your enemy is another
online player**, not a bot. It has three unit types (scout, tank, artillery) and a
placeable turret.

---

## How it works (the important part)

A single HTML file cannot connect players to each other. Multiplayer needs a **server**
that both players connect to and that runs the one true copy of the match:

```
  Player 1 browser ─┐
                    ├──▶  Node.js server (server.js)  ──▶  runs the match, sends state back
  Player 2 browser ─┘        (the referee — clients can't cheat it)
```

The client only draws what the server sends and forwards your clicks as *intentions*
("move these units", "build a tank"). The server decides what actually happens.

---

## Run it locally (two players on one PC or same WiFi)

1. Install [Node.js](https://nodejs.org) (v18+).
2. Open a terminal in this folder and run:
   ```
   npm install
   npm start
   ```
3. You'll see: `Strategy Combat multiplayer running: http://localhost:3000`
4. Open **http://localhost:3000** in **two browser tabs**.
5. Click **Find Match** in both tabs — you'll be matched and the battle begins.

**Same-WiFi play with a friend:** find your PC's local IP (run `ipconfig`, look for
IPv4 e.g. `192.168.1.42`). Your friend opens `http://192.168.1.42:3000` on their device
while your server is running. Click Find Match on both.

---

## Play over the real internet (strangers / remote friends)

Local works only for people who can reach your PC. For true worldwide play you must
**deploy the server** to a host. Easiest free/cheap options:

- **Render.com** or **Railway.app**: connect this folder as a repo, it runs `npm start`.
- **Fly.io** / a small VPS (DigitalOcean droplet): same idea.

Socket.io works out of the box on all of them. Once deployed you get a public URL like
`https://your-app.onrender.com` that anyone can open and match through.

> Note: this prototype has **no accounts, no matchmaking rating, and no anti-abuse yet**
> — it just pairs the next two people who click Find Match. Those are Stage 3–4 items in
> `../STEP_BY_STEP_PLAN.md`.

---

## Controls

| Action | How |
|--------|-----|
| Select units | Left-drag a box, or click one |
| Move / attack | Right-click ground (move) or enemy (attack) |
| Build scout / tank / artillery | Buttons, or keys **1 / 2 / 3** |
| Place turret | Click the **Turret** button, then click near your HQ |
| Pan camera | **WASD** or arrow keys |
| Cancel placement | **Esc** |

## Units

| Unit | Speed | Range | Damage | Cost | Role |
|------|-------|-------|--------|------|------|
| Scout | fast | short | low | cheap | scouting, harassment, fodder |
| Tank | medium | medium | medium | medium | main battle line |
| Artillery | slow | **long** | **high** | expensive | siege from the back |

Win by destroying the enemy **HQ**.

---

## What this demonstrates from the plan

This is a working version of **Stage 3 (Go Online)** from `STEP_BY_STEP_PLAN.md`:
server-authoritative simulation, WebSocket sync, matchmaking of two players, and
validated commands — plus the **Stage 1 Steps 6–7** unit variety and buildings.

Next natural steps: accounts + login (Step 15), a rating/leaderboard (Step 20), and
deployment for public play.
