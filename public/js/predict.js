// Client-side prediction + server reconciliation for the LOCAL player only.
//
// The server is still authoritative. This module simulates *your own* movement
// locally so you see it instantly (no RTT + interpolation delay), then corrects
// against each server snapshot by replaying the inputs the server hasn't yet
// acknowledged. It mirrors server/game.js `updatePlayer` and
// server/map.js `resolveCircle` exactly — keep them in sync.

let cfg = null;
let solid = null; // 2D array of 0/1, or null if not provided
let TILE = 64;
let SPEED = 240;
let ACCEL = 14;
let RADIUS = 17;

let state = null; // { x, y, vx, vy, a } — authoritative-predicted truth, null until first snapshot
let pending = []; // unacknowledged inputs: [{ seq, inp, dt }]
let enabled = false; // false while dead / before first snapshot

// Smooth error correction: rather than snapping `state` to each reconciled
// position (which jitters the camera 30x/sec), we keep `state` as truth and
// carry the visual discrepancy in a decaying offset. The rendered position is
// state + error, and `error` eases to zero over a few frames.
let errX = 0;
let errY = 0;
let lastSampleT = 0;
const ERR_TAU = 0.07; // seconds — correction half-life-ish (smaller = snappier)
const SNAP_DIST = 160; // px — beyond this we hard-snap (teleport/respawn/big knockback)

export function setConfig(c) {
  cfg = c;
  TILE = c.tile;
  if (c.phys) {
    SPEED = c.phys.speed;
    ACCEL = c.phys.accel;
    RADIUS = c.phys.radius;
  }
  solid = c.solid ? c.solid.map((s) => s.split('').map(Number)) : null;
}

export function reset() {
  state = null;
  pending = [];
  enabled = false;
  errX = 0;
  errY = 0;
  lastSampleT = 0;
}

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

function isSolidTile(tx, ty) {
  // Mirror map.isSolidTile: out-of-bounds (and NaN) counts as solid.
  if (!(tx >= 0) || !(ty >= 0) || tx >= cfg.cols || ty >= cfg.rows) return true;
  return solid ? solid[ty][tx] === 1 : false;
}

// Mirror of server map.resolveCircle.
function resolveCircle(x, y, r) {
  for (let iter = 0; iter < 2; iter++) {
    const minTX = Math.floor((x - r) / TILE);
    const maxTX = Math.floor((x + r) / TILE);
    const minTY = Math.floor((y - r) / TILE);
    const maxTY = Math.floor((y + r) / TILE);
    for (let ty = minTY; ty <= maxTY; ty++) {
      for (let tx = minTX; tx <= maxTX; tx++) {
        if (!isSolidTile(tx, ty)) continue;
        const left = tx * TILE;
        const top = ty * TILE;
        const right = left + TILE;
        const bottom = top + TILE;
        const cx = clamp(x, left, right);
        const cy = clamp(y, top, bottom);
        const dx = x - cx;
        const dy = y - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 < r * r) {
          if (d2 > 1e-6) {
            const d = Math.sqrt(d2);
            const push = r - d;
            x += (dx / d) * push;
            y += (dy / d) * push;
          } else {
            const toL = x - left;
            const toR = right - x;
            const toT = y - top;
            const toB = bottom - y;
            const m = Math.min(toL, toR, toT, toB);
            if (m === toL) x = left - r;
            else if (m === toR) x = right + r;
            else if (m === toT) y = top - r;
            else y = bottom + r;
          }
        }
      }
    }
  }
  return { x, y };
}

// Mirror of server updatePlayer movement integration for one step.
function step(s, inp, dt) {
  const tx = (inp.r ? 1 : 0) - (inp.l ? 1 : 0);
  const ty = (inp.d ? 1 : 0) - (inp.u ? 1 : 0);
  const len = Math.hypot(tx, ty);
  let tvx = 0;
  let tvy = 0;
  if (len > 0) {
    tvx = (tx / len) * SPEED;
    tvy = (ty / len) * SPEED;
  }
  const k = Math.min(1, ACCEL * dt);
  s.vx += (tvx - s.vx) * k;
  s.vy += (tvy - s.vy) * k;
  s.x += s.vx * dt;
  s.y += s.vy * dt;
  const res = resolveCircle(s.x, s.y, RADIUS);
  s.x = res.x;
  s.y = res.y;
}

// Apply a freshly-sent input immediately and remember it for reconciliation.
export function pushInput(seq, inp, dt) {
  if (!enabled || !state) return;
  state.a = inp.a;
  step(state, inp, dt);
  pending.push({ seq, inp, dt });
  if (pending.length > 200) pending.shift(); // safety cap
}

// Reconcile against an authoritative self-snapshot from the server.
export function reconcile(self) {
  if (!self) return;
  if (!state) state = { x: self.x, y: self.y, vx: 0, vy: 0, a: self.a };

  // While dead, don't predict — follow the server exactly.
  if (self.dead) {
    state.x = self.x;
    state.y = self.y;
    state.vx = 0;
    state.vy = 0;
    pending = [];
    enabled = false;
    errX = 0;
    errY = 0;
    return;
  }
  const wasEnabled = enabled;
  enabled = true;

  // Where we're currently *showing* the player (truth + leftover offset).
  const shownX = state.x + errX;
  const shownY = state.y + errY;

  // Start from the authoritative state (captures knockback, separation, respawn).
  const base = {
    x: self.x,
    y: self.y,
    vx: self.vx !== undefined ? self.vx : state.vx,
    vy: self.vy !== undefined ? self.vy : state.vy,
    a: state.a,
  };

  // Drop inputs the server has already processed, then replay the rest.
  if (self.seq !== undefined) pending = pending.filter((p) => p.seq > self.seq);
  for (const p of pending) step(base, p.inp, p.dt);

  // New truth.
  state.x = base.x;
  state.y = base.y;
  state.vx = base.vx;
  state.vy = base.vy;

  // Re-express the offset so the *rendered* position is continuous: keep showing
  // shownX/Y this instant, then let the offset ease to zero over the next frames.
  if (wasEnabled) {
    errX = shownX - state.x;
    errY = shownY - state.y;
    // A correction this large isn't a prediction miss — it's a teleport/respawn.
    // Don't slide across the map; snap.
    if (errX * errX + errY * errY > SNAP_DIST * SNAP_DIST) {
      errX = 0;
      errY = 0;
    }
  } else {
    errX = 0;
    errY = 0;
  }
}

// Predicted local position (truth + decaying correction offset), or null when
// prediction is inactive. Called once per render frame; decays the offset by
// real elapsed time so smoothing is frame-rate independent.
export function getState() {
  if (!enabled || !state) return null;
  const now = performance.now();
  const dt = lastSampleT ? (now - lastSampleT) / 1000 : 0;
  lastSampleT = now;
  if (dt > 0 && (errX !== 0 || errY !== 0)) {
    const decay = Math.exp(-dt / ERR_TAU);
    errX *= decay;
    errY *= decay;
    if (errX * errX + errY * errY < 0.01) {
      errX = 0;
      errY = 0;
    }
  }
  return { x: state.x + errX, y: state.y + errY, vx: state.vx, vy: state.vy, a: state.a };
}
