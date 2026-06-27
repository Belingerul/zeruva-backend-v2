// The Void Arena — server-authoritative real-time stakes game.
//
// Players stake SOL (their "bounty") from the ge_balances ledger, fly an alien
// cell, eat orbs to grow, and devour smaller players to absorb their bounty.
// Cash out anytime; get eaten and your bounty goes to the killer (minus the
// treasury cut). All movement/collision runs server-side — the client only
// sends a direction vector, so it cannot cheat positions or eats.

const { Server } = require("socket.io");
const crypto = require("crypto");

// World / physics
const WORLD = 2400;
const TICK_MS = 50;
const SNAPSHOT_MS = 50; // 20 snapshots/sec (matches the tick) → smoother client interpolation
const FOOD_COUNT = 160;
const FOOD_MASS = 1.5;
const START_MASS = 30;
const EAT_RATIO = 1.15;       // must be 15% heavier to devour
const MAX_MASS = 800;

// Economy
const MIN_STAKE_SOL = 0.01;
const MAX_STAKE_SOL = 5;
const KILL_KEEP = 1.0;        // killer absorbs 100% of victim bounty
const CASHOUT_FEE = 0.10;     // 10% dev fee on every cashout (no treasury)
const CASHOUT_CHANNEL_MS = 3000; // cashout channel: frozen + killable for 3s
const DISCONNECT_GRACE_MS = 10_000; // cell stays killable after disconnect

// Cosmetic NPC drones (zero bounty, mass snacks)
const DRONE_COUNT = 4;

const radiusOf = (mass) => 4 * Math.sqrt(mass);
const speedOf = (mass) => 260 / (1 + mass / 150); // px per second
const rand = (n) => Math.random() * n;

function initArena({ httpServer, isAllowedOrigin, jwt, jwtSecret, query, devGuest, alienCount, devFeeWallet }) {
  const io = new Server(httpServer, {
    path: "/arena-io",
    cors: {
      origin: (origin, cb) => cb(null, isAllowedOrigin(origin)),
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  // ===== Ledger helpers (ge_balances is the single source of truth) =====
  async function debitStake(wallet, sol) {
    const r = await query(
      `UPDATE ge_balances SET balance = balance - $2, updated_at = NOW()
       WHERE wallet = $1 AND balance >= $2 RETURNING balance`,
      [wallet, sol]
    );
    return r.rowCount > 0;
  }

  async function credit(wallet, sol) {
    if (!(sol > 0)) return;
    await query(
      `INSERT INTO ge_balances (wallet, balance) VALUES ($1, $2)
       ON CONFLICT (wallet) DO UPDATE SET balance = ge_balances.balance + EXCLUDED.balance, updated_at = NOW()`,
      [wallet, sol]
    );
  }

  // All fees go to the dev wallet's ledger (no treasury split).
  const creditDevFee = (sol) => credit(devFeeWallet || "__dev__", sol);

  // ===== Game state =====
  const players = new Map(); // socketId -> player
  const byWallet = new Map(); // wallet -> socketId
  let food = Array.from({ length: FOOD_COUNT }, () => spawnFood());
  let drones = Array.from({ length: DRONE_COUNT }, () => spawnDrone());

  function spawnFood() {
    return { x: rand(WORLD), y: rand(WORLD) };
  }

  function spawnDrone() {
    return {
      id: `drone-${crypto.randomInt(1e9)}`,
      x: rand(WORLD),
      y: rand(WORLD),
      mass: 18 + rand(22),
      dirX: Math.random() - 0.5,
      dirY: Math.random() - 0.5,
      alienId: 1 + crypto.randomInt(0, alienCount),
      turnAt: Date.now() + 1500 + rand(3000),
    };
  }

  function spawnPlayer(socket, { stake, alienId, name }) {
    return {
      id: socket.id,
      wallet: socket.data.wallet,
      name: String(name || "").slice(0, 16) || socket.data.wallet.slice(0, 4),
      alienId,
      x: 200 + rand(WORLD - 400),
      y: 200 + rand(WORLD - 400),
      dirX: 0,
      dirY: 0,
      mass: START_MASS,
      bounty: stake,
      kills: 0,
      joinedAt: Date.now(),
      disconnectedAt: null,
      cashoutAt: null, // when set, the player is channeling: frozen + killable
    };
  }

  async function removeAndCredit(p, solAmount, reason) {
    players.delete(p.id);
    if (byWallet.get(p.wallet) === p.id) byWallet.delete(p.wallet);
    if (solAmount > 0) {
      try {
        await credit(p.wallet, solAmount);
      } catch (e) {
        console.error("[arena] credit failed", p.wallet, solAmount, e.message);
      }
    }
    console.log(`[arena] ${reason}: ${p.wallet} bounty=${p.bounty.toFixed(4)} credited=${solAmount.toFixed(4)}`);
  }

  // ===== Socket auth =====
  io.use((socket, next) => {
    const { token, devWallet } = socket.handshake.auth || {};
    if (token) {
      try {
        const payload = jwt.verify(token, jwtSecret);
        socket.data.wallet = payload.wallet;
        return next();
      } catch {
        return next(new Error("invalid token"));
      }
    }
    if (devGuest() && typeof devWallet === "string" && devWallet.trim()) {
      socket.data.wallet = devWallet.trim();
      return next();
    }
    return next(new Error("auth required"));
  });

  io.on("connection", (socket) => {
    socket.on("join", async (payload, ack) => {
      try {
        if (typeof ack !== "function") return;
        const wallet = socket.data.wallet;
        if (players.has(socket.id)) return ack({ error: "already in arena" });

        // One cell per wallet. If the wallet has a lingering disconnected cell,
        // let the new connection take it over (reconnect support).
        const existingId = byWallet.get(wallet);
        if (existingId && players.has(existingId)) {
          const existing = players.get(existingId);
          if (existing.disconnectedAt) {
            players.delete(existingId);
            existing.id = socket.id;
            existing.disconnectedAt = null;
            players.set(socket.id, existing);
            byWallet.set(wallet, socket.id);
            return ack({ ok: true, reconnected: true, world: WORLD, you: publicPlayer(existing) });
          }
          return ack({ error: "wallet already playing" });
        }

        const stake = Number(payload?.stake);
        if (!Number.isFinite(stake) || stake < MIN_STAKE_SOL || stake > MAX_STAKE_SOL) {
          return ack({ error: `Stake must be ${MIN_STAKE_SOL}–${MAX_STAKE_SOL} SOL` });
        }
        let alienId = Number(payload?.alienId);
        if (!Number.isInteger(alienId) || alienId < 1 || alienId > alienCount) {
          alienId = 1 + crypto.randomInt(0, alienCount);
        }

        const okDebit = await debitStake(wallet, stake);
        if (!okDebit) return ack({ error: "Insufficient arena balance. Deposit first." });

        const p = spawnPlayer(socket, { stake, alienId, name: payload?.name });
        players.set(socket.id, p);
        byWallet.set(wallet, socket.id);
        ack({ ok: true, world: WORLD, you: publicPlayer(p) });
      } catch (e) {
        console.error("[arena] join failed", e);
        ack({ error: "join failed" });
      }
    });

    socket.on("input", (d) => {
      const p = players.get(socket.id);
      if (!p || p.cashoutAt) return; // frozen while channeling cashout
      const dx = Number(d?.dx) || 0;
      const dy = Number(d?.dy) || 0;
      const len = Math.hypot(dx, dy);
      if (len > 0.001) {
        p.dirX = dx / len;
        p.dirY = dy / len;
      } else {
        p.dirX = 0;
        p.dirY = 0;
      }
    });

    // Cashout is a 3-second channel: the cell freezes in place and stays
    // killable. Survive the channel and the bounty (minus the dev fee) is
    // credited; get eaten during it and the killer takes everything.
    socket.on("cashout", (ack) => {
      const p = players.get(socket.id);
      if (!p) return typeof ack === "function" && ack({ error: "not playing" });
      if (p.cashoutAt) return typeof ack === "function" && ack({ error: "already channeling" });
      p.cashoutAt = Date.now() + CASHOUT_CHANNEL_MS;
      p.dirX = 0;
      p.dirY = 0;
      if (typeof ack === "function") ack({ ok: true, channelMs: CASHOUT_CHANNEL_MS });
    });

    socket.on("cancel_cashout", (ack) => {
      const p = players.get(socket.id);
      if (p) p.cashoutAt = null;
      if (typeof ack === "function") ack({ ok: true });
    });

    socket.on("disconnect", () => {
      const p = players.get(socket.id);
      if (!p) return;
      // The cell stays in the arena (killable) for a grace window so pulling
      // the plug can't save you from being eaten. Survive it → auto-cashout.
      p.disconnectedAt = Date.now();
    });
  });

  const publicPlayer = (p) => ({
    id: p.id,
    x: Math.round(p.x),
    y: Math.round(p.y),
    m: Math.round(p.mass),
    b: Number(p.bounty.toFixed(4)),
    n: p.name,
    a: p.alienId,
    k: p.kills,
    d: p.disconnectedAt ? 1 : 0,
    // cashout channel progress: ms remaining (0 = not channeling)
    c: p.cashoutAt ? Math.max(0, p.cashoutAt - Date.now()) : 0,
  });

  // ===== Game loop =====
  setInterval(async () => {
    const dt = TICK_MS / 1000;
    const now = Date.now();

    // Move players
    for (const p of players.values()) {
      const sp = speedOf(p.mass);
      p.x = Math.max(0, Math.min(WORLD, p.x + p.dirX * sp * dt));
      p.y = Math.max(0, Math.min(WORLD, p.y + p.dirY * sp * dt));

      // Eat food
      const r = radiusOf(p.mass);
      for (let i = food.length - 1; i >= 0; i--) {
        const f = food[i];
        if ((p.x - f.x) ** 2 + (p.y - f.y) ** 2 < r * r) {
          p.mass = Math.min(MAX_MASS, p.mass + FOOD_MASS);
          food[i] = spawnFood();
        }
      }
    }

    // Move drones, let players eat them
    for (const d of drones) {
      if (now > d.turnAt) {
        d.dirX = Math.random() - 0.5;
        d.dirY = Math.random() - 0.5;
        d.turnAt = now + 1500 + rand(3000);
      }
      const len = Math.hypot(d.dirX, d.dirY) || 1;
      const sp = speedOf(d.mass) * 0.5;
      d.x = Math.max(0, Math.min(WORLD, d.x + (d.dirX / len) * sp * dt));
      d.y = Math.max(0, Math.min(WORLD, d.y + (d.dirY / len) * sp * dt));
    }
    for (const p of players.values()) {
      const r = radiusOf(p.mass);
      for (let i = 0; i < drones.length; i++) {
        const d = drones[i];
        if (p.mass > d.mass * EAT_RATIO && (p.x - d.x) ** 2 + (p.y - d.y) ** 2 < r * r) {
          p.mass = Math.min(MAX_MASS, p.mass + d.mass * 0.5);
          drones[i] = spawnDrone();
        }
      }
    }

    // PvP devour
    const list = [...players.values()];
    for (const a of list) {
      if (!players.has(a.id)) continue;
      for (const b of list) {
        if (a.id === b.id || !players.has(a.id) || !players.has(b.id)) continue;
        if (a.mass <= b.mass * EAT_RATIO) continue;
        const r = radiusOf(a.mass);
        if ((a.x - b.x) ** 2 + (a.y - b.y) ** 2 < r * r * 0.64) {
          // a devours b — killer absorbs the full bounty
          const absorbed = b.bounty * KILL_KEEP;
          a.bounty += absorbed;
          a.mass = Math.min(MAX_MASS, a.mass + b.mass * 0.6);
          a.kills += 1;
          players.delete(b.id);
          if (byWallet.get(b.wallet) === b.id) byWallet.delete(b.wallet);
          io.to(b.id).emit("dead", {
            by: a.name,
            bountyLost: Number(b.bounty.toFixed(4)),
          });
          io.emit("kill", {
            killer: a.name,
            victim: b.name,
            bounty: Number(absorbed.toFixed(4)),
            duringCashout: !!b.cashoutAt,
          });
          io.sockets.sockets.get(b.id)?.disconnect(true);
          console.log(`[arena] kill: ${a.wallet} ate ${b.wallet} (+${absorbed.toFixed(4)} SOL)`);
        }
      }
    }

    // Completed cashout channels → pay out (10% dev fee)
    for (const p of [...players.values()]) {
      if (p.cashoutAt && now >= p.cashoutAt) {
        const fee = p.bounty * CASHOUT_FEE;
        const out = p.bounty - fee;
        await removeAndCredit(p, out, "cashout");
        creditDevFee(fee).catch(() => {});
        io.to(p.id).emit("cashed_out", { credited: Number(out.toFixed(4)), fee: Number(fee.toFixed(4)) });
        io.sockets.sockets.get(p.id)?.disconnect(true);
      }
    }

    // Disconnect grace expiry → auto-cashout survivors
    for (const p of [...players.values()]) {
      if (p.disconnectedAt && now - p.disconnectedAt > DISCONNECT_GRACE_MS) {
        const fee = p.bounty * CASHOUT_FEE;
        await removeAndCredit(p, p.bounty - fee, "disconnect-cashout");
        creditDevFee(fee).catch(() => {});
      }
    }
  }, TICK_MS);

  // ===== Snapshots =====
  setInterval(() => {
    if (io.engine.clientsCount === 0) return;
    const ps = [...players.values()].map(publicPlayer);
    const top = [...ps].sort((x, y) => y.b - x.b).slice(0, 5).map((p) => ({ n: p.n, b: p.b, k: p.k }));
    io.emit("snapshot", {
      t: Date.now(),
      players: ps,
      drones: drones.map((d) => ({ id: d.id, x: Math.round(d.x), y: Math.round(d.y), m: Math.round(d.mass), a: d.alienId })),
      food: food.map((f) => [Math.round(f.x), Math.round(f.y)]),
      top,
    });
  }, SNAPSHOT_MS);

  // Stats for the hub / arena lobby
  function getStats() {
    let totalBounty = 0;
    for (const p of players.values()) totalBounty += p.bounty;
    return {
      players: players.size,
      total_bounty_sol: Number(totalBounty.toFixed(4)),
      world: WORLD,
      min_stake_sol: MIN_STAKE_SOL,
      max_stake_sol: MAX_STAKE_SOL,
      kill_keep: KILL_KEEP,
      cashout_fee: CASHOUT_FEE,
      cashout_channel_ms: CASHOUT_CHANNEL_MS,
    };
  }

  // Live leaderboard for the arena lobby (current hunters, richest first)
  function getLeaderboard(n = 10) {
    return [...players.values()]
      .sort((a, b) => b.bounty - a.bounty)
      .slice(0, n)
      .map((p) => ({
        name: p.name,
        bounty: Number((p.bounty || 0).toFixed(4)),
        kills: p.kills || 0,
        alienId: p.alienId || null,
      }));
  }

  console.log("⚔️  Void Arena engine running (path /arena-io)");
  return { io, getStats, getLeaderboard };
}

module.exports = { initArena };
