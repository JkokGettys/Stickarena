// Client-side prediction + server reconciliation for the LOCAL player only.
//
// The server is still authoritative. This module simulates *your own* movement
// locally so you see it instantly (no RTT + interpolation delay), then corrects
// against each server snapshot by replaying the inputs the server hasn't yet
// acknowledged. It mirrors server/game.js `updatePlayer` and
// server/map.js `resolveCircle`.
//
// Smoothness: the predicted position is integrated EVERY RENDER FRAME with the
// live input and real frame delta-time (via advance()), not at the 30Hz network
// send rate. That keeps your own character + camera buttery at any refresh rate.
// Network corrections arrive at 30Hz and are folded into a decaying visual
// offset so they never snap the camera. This trades a little physics fidelity vs
// the server for visual smoothness — a deliberate choice.

let cfg = null;
let solid = null; // 2D array of 0/1, or null if not provided
let TILE = 64;
let SPEED = 240;
let ACCEL = 14;
let RADIUS = 17;

const SERVER_DT = 1 / 30; // server fixed timestep (for input replay during reconciliation)

let state = null; // { x, y, vx, vy, a } — predicted truth, null until first snapshot
let lastInput = { u: false, d: false, l: false, r: false, a: 0, f: false };
let pending = []; // unacknowledged inputs, for reconciliation replay: [{ seq, inp }]
let enabled = false; // false while dead / before first snapshot

// Smooth error correction: rather than snapping `state` to each reconciled
// position (which jitters the camera 30x/sec), we keep `state` as truth and
// carry the visual discrepancy in a decaying offset. The rendered position is
// state + error, and `error` eases to zero over a few frames.
let errX = 0;
let errY = 0;
const ERR_TAU = 0.08; // seconds — correction half-life-ish (smaller = snappier)
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
  lastInput = { u: false, d: false, l: false, r: false, a: 0, f: false };
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

// Record an input we just sent to the server (called at the 30Hz send rate).
// Stored only for reconciliation replay — it does NOT advance the position;
// that happens per render frame in advance().
export function recordSent(seq, inp) {
  lastInput = inp;
  if (!enabled || !state) return;
  pending.push({ seq, inp });
  if (pending.length > 200) pending.shift(); // safety cap
}

// Integrate the predicted player one render frame using the live input and the
// real elapsed time. This is what makes motion smooth at the display refresh
// rate instead of the 30Hz network rate. Also decays the correction offset.
export function advance(inp, dt) {
  if (!enabled || !state || !(dt > 0)) return;
  if (inp) lastInput = inp;
  // Clamp dt so a tab-switch / GC hitch can't fling the prediction across the map.
  const d = Math.min(dt, 0.05);
  state.a = lastInput.a;
  step(state, lastInput, d);
  if (errX !== 0 || errY !== 0) {
    const decay = Math.exp(-d / ERR_TAU);
    errX *= decay;
    errY *= decay;
    if (errX * errX + errY * errY < 0.01) {
      errX = 0;
      errY = 0;
    }
  }
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

  // Drop inputs the server has already processed, then replay the rest at the
  // server's fixed timestep to project the authoritative state forward to "now".
  if (self.seq !== undefined) pending = pending.filter((p) => p.seq > self.seq);
  for (const p of pending) step(base, p.inp, SERVER_DT);

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
// prediction is inactive. Pure read — advance() does the integration/decay.
export function getState() {
  if (!enabled || !state) return null;
  return { x: state.x + errX, y: state.y + errY, vx: state.vx, vy: state.vy, a: state.a };
}
