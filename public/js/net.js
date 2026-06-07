// WebSocket connection, snapshot interpolation, and ephemeral effects.

const INTERP_DELAY = 100; // ms render delay
const MAX_SNAPS = 30;

const listeners = {};
let ws = null;
let selfId = null;
let connected = false;
let reconnectTimer = null;
const snaps = []; // { time, self, ents:Map, lb, feed, humans }
const effects = []; // { ...fx, birth }

export function on(ev, cb) {
  listeners[ev] = cb;
}
function emit(ev, data) {
  if (listeners[ev]) listeners[ev](data);
}
export function getSelfId() {
  return selfId;
}
export function isConnected() {
  return connected;
}

export function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => {
    connected = true;
    emit('open');
  };
  ws.onclose = () => {
    connected = false;
    emit('close');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => connect(), 1000); // auto-reconnect on drop/restart
  };
  ws.onerror = () => emit('error');
  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch (_) {
      return;
    }
    try {
      handle(msg);
    } catch (err) {
      console.error('[net handle]', err && err.stack ? err.stack : err);
    }
  };
}

function handle(msg) {
  switch (msg.t) {
    case 'config':
      emit('config', msg);
      break;
    case 'spawned':
      selfId = msg.id;
      snaps.length = 0; // drop stale interpolation from a previous connection/life
      emit('spawned', msg);
      break;
    case 'u':
      pushSnap(msg);
      break;
  }
}

function pushSnap(msg) {
  const ents = new Map();
  for (const e of msg.ents) ents.set(e.id, e);
  snaps.push({ time: performance.now(), self: msg.self, ents, lb: msg.lb, feed: msg.feed, humans: msg.humans, rank: msg.rank, total: msg.total });
  if (snaps.length > MAX_SNAPS) snaps.shift();

  const now = performance.now();
  if (msg.fx) for (const fx of msg.fx) effects.push({ ...fx, birth: now });
  // prune old effects (>1s)
  while (effects.length && now - effects[0].birth > 1000) effects.shift();
}

export function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
export function spawn(name) {
  send({ t: 'spawn', name });
}

export function getEffects() {
  return effects;
}

// ---- interpolation -------------------------------------------------------
function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function angLerp(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
function lerpEnt(a, b, t) {
  const out = { ...b, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  if (a.a !== undefined && b.a !== undefined) out.a = angLerp(a.a, b.a, t);
  return out;
}
function lerpSelf(a, b, t) {
  if (!a || !b) return b || a;
  return { ...b, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, a: angLerp(a.a, b.a, t) };
}

export function sample() {
  if (snaps.length === 0) return null;
  const renderTime = performance.now() - INTERP_DELAY;

  let s0 = null;
  let s1 = null;
  for (let i = snaps.length - 1; i >= 0; i--) {
    if (snaps[i].time <= renderTime) {
      s0 = snaps[i];
      s1 = snaps[i + 1] || snaps[i];
      break;
    }
  }
  if (!s0) {
    s0 = snaps[0];
    s1 = snaps[1] || snaps[0];
  }

  const span = s1.time - s0.time;
  const t = span > 0 ? clamp01((renderTime - s0.time) / span) : 0;

  const ents = [];
  for (const [id, e1] of s1.ents) {
    const e0 = s0.ents.get(id);
    ents.push(e0 ? lerpEnt(e0, e1, t) : e1);
  }

  return { self: lerpSelf(s0.self, s1.self, t), ents, lb: s1.lb, feed: s1.feed, humans: s1.humans, rank: s1.rank, total: s1.total };
}
