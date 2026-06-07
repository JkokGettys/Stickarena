// Canvas renderer. Uses generated sprites when available, vector placeholders
// otherwise, so the game is fully playable before any art exists.

const BASE_VIEW = 560; // world units visible vertically (smaller = more zoomed-in follow cam)

const COL = {
  oob: '#0e1018',
  floorA: '#39506e',
  floorB: '#35496485',
  wall: '#222a3b',
  wallTop: '#2d3850',
};

// cell type -> sprite key / fallback colour (indices match server map T codes).
// The active tileset is supplied per-map by setMap(); this is the city fallback.
const DEFAULT_TILESET = {
  floorSpr: ['grass', 'road', 'sidewalk', 'floor', 'wood', 'tilefloor'],
  floorCol: ['#3f7d3f', '#3a3d45', '#9a9a92', '#39506e', '#6e4a28', '#cdc8bc'],
  wallSpr: { 6: 'building', 7: 'wall' },
  wallCol: { 6: '#6b4a3a', 7: '#2d3850' },
};
let tileset = DEFAULT_TILESET;

// Multiplier on tile size for prop sprites (bigger = reads as a tall/large object).
const PROP_SCALE = {
  fountain: 2.1, palm: 2.2, tree: 1.6, car: 1.5,
  ruinpillar: 1.5, serverrack: 1.5, containment: 1.7, console: 1.2,
};
const PROP_COL = {
  chair: '#6b4a2e', table: '#8a5a34', couch: '#3f6b6b', tv: '#15171d',
  bookshelf: '#5a3f28', shelf: '#7a7a82', counter: '#9a8a6a', bed: '#7a6f9a',
  tree: '#3fae5a', car: '#c0504a', streetlight: '#4a4a52', bench: '#6b4a2e', hydrant: '#c0504a',
  fountain: '#7fb0d0', planter: '#5a7a3a',
  // desert + sci-fi prop fallback tints (used until the sprites are generated)
  amphora: '#b07a4a', cactus: '#3f8a4a', palm: '#3fae5a', ruinpillar: '#cdbfa0',
  serverrack: '#23262e', console: '#3a4a5a', containment: '#6fb6d6', canister: '#c08a3a',
};

let canvas = null;
let ctx = null;
let dpr = 1;
let W = 0;
let H = 0;

let cfg = null;
let grid = null; // 2D number array
let wallCorner = null; // 2D: rotation (radians) for building-corner tiles, -1 if not a corner
let props = [];
let lastCamX = 0; // last finite camera position (fallback if self pos goes bad)
let lastCamY = 0;

const images = {}; // key -> {img, loaded}
const tileCache = {}; // key -> offscreen canvas scaled to a tile

const feedSeen = new Map(); // kill id -> firstSeen ms

export function init(canvasEl) {
  canvas = canvasEl;
  ctx = canvas.getContext('2d');
  resize();
  window.addEventListener('resize', resize);
}

export function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
}

let assetsLoaded = false;
export function loadAssets(manifest) {
  if (assetsLoaded) return; // load the (combined, all-maps) manifest exactly once
  assetsLoaded = true;
  for (const [key, file] of Object.entries(manifest || {})) {
    const img = new Image();
    images[key] = { img, loaded: false };
    img.onload = () => {
      images[key].loaded = true;
    };
    img.onerror = () => {
      images[key].loaded = false;
    };
    img.src = '/assets/' + file;
  }
}

function spr(key) {
  const e = images[key];
  return e && e.loaded ? e.img : null;
}

// Global config (physics, weapons, assets, match/maps) — merged once on connect.
export function setConfig(c) {
  cfg = { ...(cfg || {}), ...c };
}

// Per-map state — called on connect and on every 'mapchange'. Rebuilds the grid,
// corner-rotation cache, prop world positions and tileset, and drops the tile
// cache (sprite art differs per map).
export function setMap(m) {
  cfg = { ...(cfg || {}), tile: m.tile, cols: m.cols, rows: m.rows, w: m.w, h: m.h, mapId: m.id, mapName: m.name };
  tileset = m.tileset || DEFAULT_TILESET;
  grid = m.grid.map((s) => s.split('').map(Number));
  wallCorner = grid.map((row, y) => row.map((cell, x) => (cell === 6 ? cornerRotation(x, y) : -1)));
  props = m.props.map((p) => ({
    type: p.type,
    x: (p.x + 0.5) * m.tile,
    y: (p.y + 0.5) * m.tile,
    rot: p.r || 0,
  }));
  for (const k in tileCache) delete tileCache[k];
}

// A building (exterior) wall cell is an outer corner when exactly two of its
// neighbours are walls and they're perpendicular. Returns the rotation for the
// corner sprite (whose coping defaults to the top-left / NW), or -1 if straight.
function cornerRotation(x, y) {
  const wall = (xx, yy) => xx >= 0 && yy >= 0 && xx < cfg.cols && yy < cfg.rows && grid[yy][xx] >= 6;
  const nN = wall(x, y - 1);
  const nS = wall(x, y + 1);
  const nE = wall(x + 1, y);
  const nW = wall(x - 1, y);
  if (nN + nS + nE + nW !== 2) return -1;
  if (!((nN || nS) && (nE || nW))) return -1; // not perpendicular
  if (nE && nS) return 0; // runs continue E+S -> outside is NW
  if (nW && nS) return Math.PI / 2; // outside NE
  if (nW && nN) return Math.PI; // outside SE
  if (nE && nN) return -Math.PI / 2; // outside SW
  return -1;
}

// ---- helpers -------------------------------------------------------------
function rr(x, y, w, h, r) {
  if (w <= 0 || h <= 0) return;
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---- entry ---------------------------------------------------------------
export function draw(view, opts) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = COL.oob;
  ctx.fillRect(0, 0, W, H);
  if (!cfg || !grid) return;
  if (!view || !view.self) return;

  const self = view.self;
  const zoom = H / BASE_VIEW;
  const px = 1 / zoom;
  const halfWWorld = (W / 2) * px;
  const halfHWorld = (H / 2) * px;
  let camX = cfg.w <= halfWWorld * 2 ? cfg.w / 2 : clamp(self.x, halfWWorld, cfg.w - halfWWorld);
  let camY = cfg.h <= halfHWorld * 2 ? cfg.h / 2 : clamp(self.y, halfHWorld, cfg.h - halfHWorld);
  if (!Number.isFinite(camX)) camX = lastCamX;
  if (!Number.isFinite(camY)) camY = lastCamY;
  lastCamX = camX;
  lastCamY = camY;

  const time = performance.now() / 1000;

  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.scale(zoom, zoom);
  ctx.translate(-camX, -camY);

  const left = camX - halfWWorld;
  const right = camX + halfWWorld;
  const top = camY - halfHWorld;
  const bottom = camY + halfHWorld;

  drawFloorWalls(left, right, top, bottom, px);
  drawProps(px);
  // pickups, then players, then effects
  for (const e of view.ents) if (e.k === 'k') drawPickup(e, px, time);
  for (const e of view.ents) if (e.k === 'p') drawPlayer(e, false, px, null, opts.selfId);
  if (!self.dead) drawPlayer(self, true, px, opts.localAim, opts.selfId);
  drawEffects(px);
  // Local player's own gun effects: live clock, anchored to the predicted gun.
  if (!self.dead) drawSelfEffects(px, self, opts.localAim);

  ctx.restore();

  drawHUD(view, opts);
}

function tile(key) {
  // returns a TILE-sized offscreen canvas from a sprite, or null
  const img = spr(key);
  if (!img) return null;
  if (tileCache[key]) return tileCache[key];
  const t = cfg.tile;
  const oc = document.createElement('canvas');
  oc.width = t;
  oc.height = t;
  oc.getContext('2d').drawImage(img, 0, 0, t, t);
  tileCache[key] = oc;
  return oc;
}

function drawFloorWalls(left, right, top, bottom, px) {
  const t = cfg.tile;
  const tx0 = Math.max(0, Math.floor(left / t));
  const tx1 = Math.min(cfg.cols - 1, Math.floor(right / t));
  const ty0 = Math.max(0, Math.floor(top / t));
  const ty1 = Math.min(cfg.rows - 1, Math.floor(bottom / t));
  // floors first
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const c = grid[ty][tx];
      if (c >= 6) continue; // walls drawn in second pass
      const x = tx * t;
      const y = ty * t;
      const img = tile(tileset.floorSpr[c]);
      if (img) ctx.drawImage(img, x, y, t, t);
      else {
        ctx.fillStyle = tileset.floorCol[c] || COL.floorA;
        ctx.fillRect(x, y, t, t);
      }
    }
  }
  // walls on top
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const c = grid[ty][tx];
      if (c < 6) continue;
      const x = tx * t;
      const y = ty * t;
      // wallcorner.png is the city's brick coping; only use it on that tileset.
      const cornerImg = c === 6 && wallCorner[ty][tx] >= 0 && tileset.wallSpr[6] === 'building' ? tile('wallcorner') : null;
      const img = cornerImg || tile(tileset.wallSpr[c]);
      if (cornerImg) {
        ctx.save();
        ctx.translate(x + t / 2, y + t / 2);
        ctx.rotate(wallCorner[ty][tx]);
        ctx.drawImage(cornerImg, -t / 2, -t / 2, t, t);
        ctx.restore();
      } else if (img) {
        ctx.drawImage(img, x, y, t, t);
      } else {
        ctx.fillStyle = tileset.wallCol[c] || COL.wall;
        ctx.fillRect(x, y, t, t);
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        ctx.fillRect(x + 2 * px, y + 2 * px, t - 4 * px, t - 6 * px);
      }
    }
  }
}

function drawProps(px) {
  const t = cfg.tile;
  for (const p of props) {
    const img = spr(p.type);
    if (img) {
      const s = (PROP_SCALE[p.type] || 1.1) * t;
      if (p.rot) {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.drawImage(img, -s / 2, -s / 2, s, s);
        ctx.restore();
      } else {
        ctx.drawImage(img, p.x - s / 2, p.y - s / 2, s, s);
      }
      continue;
    }
    // placeholders
    if (p.type === 'desk') {
      ctx.fillStyle = '#6b4f33';
      rr(p.x - t * 0.46, p.y - t * 0.34, t * 0.92, t * 0.68, 4);
      ctx.fill();
      ctx.fillStyle = '#222';
      rr(p.x - t * 0.16, p.y - t * 0.22, t * 0.32, t * 0.26, 2);
      ctx.fill();
    } else if (p.type === 'cooler') {
      ctx.fillStyle = '#cfe8f5';
      rr(p.x - t * 0.26, p.y - t * 0.4, t * 0.52, t * 0.8, 5);
      ctx.fill();
      ctx.fillStyle = '#6fb6d6';
      ctx.beginPath();
      ctx.arc(p.x, p.y - t * 0.18, t * 0.18, 0, 7);
      ctx.fill();
    } else if (p.type === 'crate') {
      ctx.fillStyle = '#a9763e';
      rr(p.x - t * 0.42, p.y - t * 0.42, t * 0.84, t * 0.84, 4);
      ctx.fill();
      ctx.strokeStyle = '#6e4a25';
      ctx.lineWidth = 3 * px;
      ctx.beginPath();
      ctx.moveTo(p.x - t * 0.42, p.y - t * 0.42);
      ctx.lineTo(p.x + t * 0.42, p.y + t * 0.42);
      ctx.moveTo(p.x + t * 0.42, p.y - t * 0.42);
      ctx.lineTo(p.x - t * 0.42, p.y + t * 0.42);
      ctx.stroke();
    } else if (p.type === 'plant') {
      ctx.fillStyle = '#5a3a22';
      rr(p.x - t * 0.16, p.y + t * 0.04, t * 0.32, t * 0.26, 3);
      ctx.fill();
      ctx.fillStyle = '#3fae5a';
      ctx.beginPath();
      ctx.arc(p.x, p.y - t * 0.12, t * 0.3, 0, 7);
      ctx.fill();
    } else if (p.type === 'tree' || p.type === 'palm') {
      ctx.fillStyle = '#5a3a22';
      rr(p.x - t * 0.12, p.y + t * 0.05, t * 0.24, t * 0.3, 3);
      ctx.fill();
      ctx.fillStyle = p.type === 'palm' ? '#4fbf6a' : '#3fae5a';
      ctx.beginPath();
      ctx.arc(p.x, p.y - t * 0.1, t * (p.type === 'palm' ? 0.5 : 0.46), 0, 7);
      ctx.fill();
    } else if (p.type === 'cactus') {
      ctx.fillStyle = '#3f8a4a';
      rr(p.x - t * 0.1, p.y - t * 0.4, t * 0.2, t * 0.8, 5);
      ctx.fill();
      rr(p.x - t * 0.32, p.y - t * 0.1, t * 0.22, t * 0.16, 5);
      ctx.fill();
      rr(p.x + t * 0.1, p.y - t * 0.2, t * 0.22, t * 0.16, 5);
      ctx.fill();
    } else if (p.type === 'containment') {
      ctx.fillStyle = 'rgba(120,200,230,0.35)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, t * 0.42, 0, 7);
      ctx.fill();
      ctx.strokeStyle = '#9fe0f5';
      ctx.lineWidth = 2 * px;
      ctx.stroke();
    } else if (p.type === 'serverrack') {
      ctx.fillStyle = '#23262e';
      rr(p.x - t * 0.34, p.y - t * 0.44, t * 0.68, t * 0.88, 4);
      ctx.fill();
      ctx.fillStyle = '#46e06a';
      for (let i = 0; i < 4; i++) ctx.fillRect(p.x - t * 0.26, p.y - t * 0.34 + i * t * 0.2, t * 0.52, t * 0.05);
    } else {
      // generic placeholder for props whose sprite hasn't been generated yet
      ctx.fillStyle = PROP_COL[p.type] || '#8a6a4a';
      rr(p.x - t * 0.42, p.y - t * 0.42, t * 0.84, t * 0.84, 5);
      ctx.fill();
    }
  }
}

function drawPickup(e, px, time) {
  const bob = Math.sin(time * 3 + e.x * 0.05) * 4;
  // glowing pad
  ctx.beginPath();
  ctx.arc(e.x, e.y, 22, 0, 7);
  ctx.fillStyle = e.drop ? 'rgba(255,200,120,0.18)' : 'rgba(110,220,255,0.20)';
  ctx.fill();
  ctx.lineWidth = 2 * px;
  ctx.strokeStyle = e.drop ? 'rgba(255,200,120,0.5)' : 'rgba(110,220,255,0.6)';
  ctx.stroke();
  drawPickupWeapon(e.x, e.y + bob, 16, e.w);
}

function gripFor(wid) {
  if (wid === 'fists') return 'fists';
  if (wid === 'pistol') return 'pistol';
  if (wid === 'uzi') return 'smg';
  if (wid === 'bat' || wid === 'katana') return 'melee';
  return 'rifle'; // shotgun, rifle, sniper
}

// Weapon drawn at origin pointing +x (rear/grip at origin). Sizes in r units.
function drawWeaponShape(wid, r) {
  switch (wid) {
    case 'pistol':
      ctx.fillStyle = '#2b2f3a';
      ctx.fillRect(0, -0.13 * r, 0.8 * r, 0.26 * r);
      ctx.fillRect(0.55 * r, -0.08 * r, 0.42 * r, 0.16 * r);
      break;
    case 'uzi':
      ctx.fillStyle = '#23262e';
      ctx.fillRect(-0.1 * r, -0.16 * r, 0.75 * r, 0.32 * r);
      ctx.fillRect(0.6 * r, -0.08 * r, 0.45 * r, 0.16 * r);
      ctx.fillStyle = '#16181d';
      ctx.fillRect(0.02 * r, 0.16 * r, 0.16 * r, 0.34 * r);
      break;
    case 'shotgun':
      ctx.fillStyle = '#6e4a28';
      ctx.fillRect(-0.55 * r, -0.12 * r, 0.55 * r, 0.24 * r);
      ctx.fillStyle = '#23262e';
      ctx.fillRect(0, -0.11 * r, 1.55 * r, 0.22 * r);
      ctx.fillStyle = '#3a3f4a';
      ctx.fillRect(0.75 * r, -0.15 * r, 0.32 * r, 0.3 * r);
      break;
    case 'rifle':
      ctx.fillStyle = '#6e4a28';
      ctx.fillRect(-0.5 * r, -0.1 * r, 0.5 * r, 0.2 * r);
      ctx.fillStyle = '#20232c';
      ctx.fillRect(0, -0.1 * r, 1.65 * r, 0.2 * r);
      ctx.fillStyle = '#15171d';
      ctx.fillRect(0.45 * r, 0.1 * r, 0.18 * r, 0.4 * r);
      break;
    case 'sniper':
      ctx.fillStyle = '#1e2a24';
      ctx.fillRect(-0.4 * r, -0.1 * r, 0.4 * r, 0.2 * r);
      ctx.fillStyle = '#202830';
      ctx.fillRect(0, -0.085 * r, 2.0 * r, 0.17 * r);
      ctx.fillStyle = '#0e1116';
      ctx.fillRect(0.5 * r, -0.2 * r, 0.45 * r, 0.14 * r);
      break;
    case 'bat':
      ctx.fillStyle = '#b07a3a';
      ctx.beginPath();
      ctx.moveTo(0, -0.08 * r);
      ctx.lineTo(1.3 * r, -0.2 * r);
      ctx.lineTo(1.42 * r, 0);
      ctx.lineTo(1.3 * r, 0.2 * r);
      ctx.lineTo(0, 0.08 * r);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#5a3a1c';
      ctx.fillRect(-0.05 * r, -0.09 * r, 0.28 * r, 0.18 * r);
      break;
    case 'katana':
      ctx.fillStyle = '#15171f';
      ctx.fillRect(-0.28 * r, -0.07 * r, 0.4 * r, 0.14 * r);
      ctx.fillStyle = '#3a3f4a';
      ctx.fillRect(0.1 * r, -0.13 * r, 0.06 * r, 0.26 * r);
      ctx.fillStyle = '#e4ebf2';
      ctx.fillRect(0.16 * r, -0.055 * r, 1.6 * r, 0.11 * r);
      break;
  }
}

// Pickup icon on the ground — uses the detailed generated sprite (vector fallback).
function drawPickupWeapon(x, y, r, wid) {
  if (wid === 'fists') return;
  const img = spr(wid);
  if (img) {
    const s = r * 2.6;
    ctx.drawImage(img, x - s / 2, y - s / 2, s, s);
    return;
  }
  ctx.save();
  ctx.translate(x - r * 0.55, y);
  drawWeaponShape(wid, r);
  ctx.restore();
}

// Procedural top-down figure: head + rigged arms posed per weapon, animated by
// ap (1 = just attacked → 0 = idle). Drawn in the player's local frame (+x = aim).
function drawFigure(r, grip, wid, ap, isSelf) {
  const limbCol = '#15171f';
  const bodyCol = '#262a34';
  const headCol = '#2c313d';
  const outline = isSelf ? '#7fd8ff' : '#ff8088';
  const shoulderY = r * 0.48;

  let hLx;
  let hLy;
  let hRx;
  let hRy;
  let wTx = 0;
  let wTy = 0;
  let wAng = 0;
  let drawW = wid !== 'fists';

  if (grip === 'pistol') {
    const k = ap * 0.22 * r;
    hRx = 1.15 * r - k;
    hRy = 0.16 * r;
    hLx = 0.55 * r - k * 0.5;
    hLy = -0.3 * r;
    wTx = hRx - 0.15 * r;
    wTy = hRy;
  } else if (grip === 'smg') {
    const k = ap * 0.18 * r;
    hRx = 0.78 * r - k;
    hRy = 0.16 * r;
    hLx = 1.0 * r - k;
    hLy = 0;
    wTx = 0.6 * r - k;
    wTy = 0.12 * r;
  } else if (grip === 'rifle') {
    const k = ap * 0.16 * r;
    const front = (wid === 'sniper' ? 1.7 : 1.45) * r;
    hRx = 0.68 * r - k;
    hRy = 0.2 * r;
    hLx = front - k;
    hLy = 0.02 * r;
    wTx = 0.5 * r - k;
    wTy = 0.1 * r;
  } else if (grip === 'melee') {
    const sw = ap > 0 ? -1.15 + (1 - ap) * 2.4 : -0.55;
    const pivX = 0.45 * r;
    const pivY = 0.12 * r;
    wTx = pivX;
    wTy = pivY;
    wAng = sw;
    const c = Math.cos(sw);
    const s = Math.sin(sw);
    hRx = pivX + c * 0.28 * r;
    hRy = pivY + s * 0.28 * r;
    hLx = pivX + c * 0.06 * r;
    hLy = pivY + s * 0.06 * r - 0.16 * r;
  } else {
    const punch = ap * 0.5 * r;
    hRx = 0.92 * r + punch;
    hRy = 0.3 * r;
    hLx = 0.9 * r;
    hLy = -0.3 * r;
    drawW = false;
  }

  // arms (under the body)
  ctx.lineCap = 'round';
  ctx.lineWidth = r * 0.27;
  ctx.strokeStyle = limbCol;
  ctx.beginPath();
  ctx.moveTo(0.02 * r, shoulderY);
  ctx.lineTo(hRx, hRy);
  ctx.moveTo(0.02 * r, -shoulderY);
  ctx.lineTo(hLx, hLy);
  ctx.stroke();

  // head (single circular head, per the stickman look)
  ctx.beginPath();
  ctx.arc(r * 0.06, 0, r * 0.62, 0, 7);
  ctx.fillStyle = headCol;
  ctx.fill();
  ctx.lineWidth = r * 0.16;
  ctx.strokeStyle = outline;
  ctx.stroke();

  // held weapon (over the body, at the hands)
  if (drawW) {
    ctx.save();
    ctx.translate(wTx, wTy);
    ctx.rotate(wAng);
    drawWeaponShape(wid, r);
    ctx.restore();
  }

  // hands gripping (on top)
  ctx.fillStyle = limbCol;
  ctx.beginPath();
  ctx.arc(hRx, hRy, r * 0.17, 0, 7);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(hLx, hLy, r * 0.17, 0, 7);
  ctx.fill();
}

function drawPlayer(e, isSelf, px, aimOverride, selfId) {
  const ang = aimOverride != null ? aimOverride : e.a || 0;
  const r = 17;

  // ground shadow
  ctx.beginPath();
  ctx.ellipse(e.x, e.y + r * 0.25, r * 0.95, r * 0.78, 0, 0, 7);
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.fill();

  // team / self ring
  if (isSelf) {
    ctx.beginPath();
    ctx.arc(e.x, e.y, r + 5 * px, 0, 7);
    ctx.lineWidth = 2.5 * px;
    ctx.strokeStyle = '#46e06a';
    ctx.stroke();
  }
  // spawn protection shield
  if (e.pr) {
    ctx.beginPath();
    ctx.arc(e.x, e.y, r + 8 * px, 0, 7);
    ctx.fillStyle = 'rgba(120,180,255,0.18)';
    ctx.fill();
  }

  // rigged vector figure (head + posed/animated arms + held weapon)
  const winfo = cfg.weapons[e.w] || { kind: 'melee' };
  const grip = gripFor(e.w || 'fists');
  const dur = winfo.kind === 'melee' ? 0.22 : 0.1;
  const ap = e.at > 0 ? Math.min(1, e.at / dur) : 0; // 1 = just attacked, 0 = idle
  ctx.save();
  ctx.translate(e.x, e.y);
  ctx.rotate(ang);
  drawFigure(r, grip, e.w || 'fists', ap, isSelf);
  ctx.restore();

  // name + health bar for others
  if (!isSelf && e.n) {
    ctx.font = `bold ${12 * px}px 'Trebuchet MS', sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 3 * px;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.fillStyle = e.bot ? '#ffd7a0' : '#ffffff';
    const ny = e.y - r - 12 * px;
    ctx.strokeText(e.n, e.x, ny);
    ctx.fillText(e.n, e.x, ny);
    if (e.hp !== undefined && e.hp < 0.999) {
      const bw = r * 2.2;
      const bx = e.x - bw / 2;
      const by = e.y - r - 9 * px;
      rr(bx, by, bw, 4 * px, 2 * px);
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fill();
      rr(bx, by, bw * Math.max(0, e.hp), 4 * px, 2 * px);
      ctx.fillStyle = e.hp > 0.5 ? '#5fdc5f' : e.hp > 0.25 ? '#e8c14a' : '#e2544a';
      ctx.fill();
    }
  }
}

// Stylized muzzle flash: a hot core, a tapered flame cone along `ang`, and a
// couple of star spikes. `a` is remaining life (1 = fresh). Drawn additively.
function drawMuzzleFlash(x, y, ang, a, color, px) {
  if (a <= 0) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  ctx.globalCompositeOperation = 'lighter';
  const grow = 0.75 + a * 0.25;
  const L = 36 * grow; // flame length
  const Wd = 13 * grow; // flame half-width at the muzzle

  // main flame cone, fading to transparent at the tip
  const g = ctx.createLinearGradient(0, 0, L, 0);
  g.addColorStop(0, `rgba(255,247,210,${0.9 * a})`);
  g.addColorStop(0.35, `rgba(255,178,70,${0.75 * a})`);
  g.addColorStop(1, 'rgba(255,110,30,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(0, -Wd * 0.7);
  ctx.quadraticCurveTo(L * 0.55, -Wd, L, 0);
  ctx.quadraticCurveTo(L * 0.55, Wd, 0, Wd * 0.7);
  ctx.closePath();
  ctx.fill();

  // star spikes for a punchy flash
  ctx.strokeStyle = `rgba(255,236,170,${0.55 * a})`;
  ctx.lineWidth = 2 * px;
  const spike = Wd * 1.6;
  ctx.beginPath();
  ctx.moveTo(-spike * 0.35, 0);
  ctx.lineTo(L * 0.55, 0);
  ctx.moveTo(Wd * 0.5, -spike);
  ctx.lineTo(Wd * 0.5, spike);
  ctx.stroke();

  // hot bright core
  ctx.fillStyle = `rgba(255,255,240,${a})`;
  ctx.beginPath();
  ctx.arc(Wd * 0.3, 0, Wd * 0.6 * (0.8 + a * 0.2), 0, 7);
  ctx.fill();

  ctx.restore();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
}

// Local player's own gun effects, rendered on the LIVE clock (no interpolation
// delay) so they line up with the predicted character instead of trailing it.
function drawSelfEffects(px, self, localAim) {
  const now = performance.now();

  // bullet tracers (world-locked; prediction offset already baked in net.js)
  for (const fx of NET.getSelfTracers()) {
    const age = now - fx.birth;
    const ttl = 80;
    if (age < 0 || age > ttl) continue;
    const a = 1 - age / ttl;
    ctx.strokeStyle = fx.c || '#ffe98a';
    ctx.globalAlpha = a;
    ctx.lineWidth = 2.5 * px;
    ctx.beginPath();
    ctx.moveTo(fx.x1, fx.y1);
    ctx.lineTo(fx.x2, fx.y2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // muzzle flashes, anchored live to the predicted gun barrel
  const r = (cfg.phys && cfg.phys.radius) || 17;
  const mx = self.x + Math.cos(localAim) * (r + 8);
  const my = self.y + Math.sin(localAim) * (r + 8);
  for (const fx of NET.getSelfFlashes()) {
    const age = now - fx.birth;
    const ttl = 90;
    if (age < 0 || age > ttl) continue;
    drawMuzzleFlash(mx, my, localAim, 1 - age / ttl, fx.c, px);
  }
}

function drawEffects(px) {
  const now = performance.now() - 100; // age vs the interpolated render clock (INTERP_DELAY)
  for (const fx of NET.getEffects()) {
    const age = now - fx.birth;
    if (age < 0) continue; // not due yet on the delayed render clock (avoids negative radii)
    if (fx.e === 't') {
      const ttl = 80;
      if (age > ttl) continue;
      const a = 1 - age / ttl;
      ctx.strokeStyle = fx.c || '#ffe98a';
      ctx.globalAlpha = a;
      ctx.lineWidth = 2.5 * px;
      ctx.beginPath();
      ctx.moveTo(fx.x1, fx.y1);
      ctx.lineTo(fx.x2, fx.y2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    } else if (fx.e === 'f') {
      const ttl = 90;
      if (age > ttl) continue;
      drawMuzzleFlash(fx.x, fx.y, fx.a || 0, 1 - age / ttl, fx.c, px);
    } else if (fx.e === 'h') {
      const ttl = 220;
      if (age > ttl) continue;
      const a = 1 - age / ttl;
      ctx.globalAlpha = a;
      ctx.fillStyle = '#ffd36b';
      for (let i = 0; i < 4; i++) {
        const ang = (i / 4) * Math.PI * 2 + age * 0.02;
        const d = 4 + age * 0.05;
        ctx.beginPath();
        ctx.arc(fx.x + Math.cos(ang) * d, fx.y + Math.sin(ang) * d, 2.2, 0, 7);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    } else if (fx.e === 'm') {
      const ttl = 170;
      if (age > ttl) continue;
      const a = 1 - age / ttl;
      ctx.globalAlpha = a * 0.8;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3 * px;
      ctx.beginPath();
      ctx.arc(fx.x, fx.y, fx.r, fx.a - 0.8 + age * 0.012, fx.a + 0.8 + age * 0.012);
      ctx.stroke();
      ctx.globalAlpha = 1;
    } else if (fx.e === 'd') {
      const ttl = 600;
      if (age > ttl) continue;
      const a = 1 - age / ttl;
      ctx.globalAlpha = a * 0.7;
      ctx.fillStyle = '#b3303a';
      for (let i = 0; i < 6; i++) {
        const ang = (i / 6) * Math.PI * 2 + fx.x;
        const d = (age / ttl) * 26;
        ctx.beginPath();
        ctx.arc(fx.x + Math.cos(ang) * d, fx.y + Math.sin(ang) * d, 5 - (age / ttl) * 3, 0, 7);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    } else if (fx.e === 'p') {
      const ttl = 280;
      if (age > ttl) continue;
      const a = 1 - age / ttl;
      ctx.globalAlpha = a;
      ctx.strokeStyle = '#8fe8ff';
      ctx.lineWidth = 2 * px;
      ctx.beginPath();
      ctx.arc(fx.x, fx.y, 8 + (age / ttl) * 24, 0, 7);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
}

// ---- HUD -----------------------------------------------------------------
function drawHUD(view, opts) {
  const self = view.self;

  // health (top-left)
  const hbW = 230;
  const hbX = 16;
  const hbY = 16;
  const frac = Math.max(0, self.health / self.maxHealth);
  rr(hbX, hbY, hbW, 26, 7);
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fill();
  rr(hbX + 3, hbY + 3, (hbW - 6) * frac, 20, 5);
  ctx.fillStyle = frac > 0.5 ? '#4fd35a' : frac > 0.25 ? '#e8c14a' : '#e2544a';
  ctx.fill();
  ctx.font = "bold 13px 'Trebuchet MS', sans-serif";
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${self.health} HP`, hbX + 10, hbY + 13);
  ctx.textAlign = 'right';
  ctx.fillText(`${opts.selfName}  ·  ${self.frags} frags`, hbX + hbW - 10, hbY + 13);

  // match timer (top-center) during play, then rank + headcount below it
  let topY = 12;
  if (view.phase === 'playing' && typeof view.timeLeft === 'number') {
    drawMatchTimer(view.timeLeft);
    topY = 40;
  }
  const rank = view.rank > 0 ? ordinal(view.rank) : '-';
  ctx.font = "bold 26px 'Trebuchet MS', sans-serif";
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fillText(rank, W / 2, topY);
  ctx.font = "12px 'Trebuchet MS', sans-serif";
  ctx.fillStyle = 'rgba(220,225,255,0.6)';
  ctx.fillText(`${view.humans} online · ${view.total} fighters`, W / 2, topY + 28);

  // weapon + ammo (bottom-left)
  const wid = self.weapon;
  const wInfo = cfg.weapons[wid] || { name: wid };
  const wy = H - 58;
  rr(16, wy, 210, 44, 8);
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fill();
  drawWeaponIconHUD(46, wy + 22, wid);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = "bold 15px 'Trebuchet MS', sans-serif";
  ctx.fillStyle = '#fff';
  ctx.fillText(wInfo.name, 78, wy + 16);
  ctx.font = "13px 'Trebuchet MS', sans-serif";
  ctx.fillStyle = 'rgba(220,225,255,0.85)';
  const ammoText = self.ammo < 0 ? '∞' : `${self.ammo}`;
  ctx.fillText(`Ammo: ${ammoText}`, 78, wy + 32);

  drawLeaderboard(view, opts.selfId);
  drawMinimap(view, opts.selfId);
  drawKillFeed(view);
  drawCrosshair(opts.mouse);

  if (self.dead) drawRespawn(self, opts);

  // fps
  ctx.font = "11px 'Trebuchet MS', sans-serif";
  ctx.fillStyle = 'rgba(220,225,255,0.4)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`${opts.fps | 0} fps`, 16, H - 64);
}

function drawWeaponIconHUD(cx, cy, wid) {
  const img = spr(wid);
  if (img) {
    ctx.drawImage(img, cx - 18, cy - 18, 36, 36);
    return;
  }
  ctx.save();
  ctx.translate(cx, cy);
  const melee = wid === 'bat' || wid === 'katana';
  if (wid === 'fists') {
    ctx.fillStyle = '#e8c9a0';
    ctx.beginPath();
    ctx.arc(0, 0, 8, 0, 7);
    ctx.fill();
  } else if (melee) {
    ctx.fillStyle = wid === 'katana' ? '#e4ebf2' : '#b07a3a';
    ctx.fillRect(-16, -3, 32, 6);
  } else {
    ctx.fillStyle = '#cdd3e0';
    ctx.fillRect(-15, -5, 26, 10);
    ctx.fillRect(6, -3, 12, 6);
  }
  ctx.restore();
}

function drawLeaderboard(view, selfId) {
  const w = 200;
  const x = W - w - 14;
  const y = 14;
  ctx.font = "bold 13px 'Trebuchet MS', sans-serif";
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(220,225,255,0.85)';
  ctx.fillText('FRAGS', x + w / 2, y);

  const barH = 18;
  const gap = 4;
  const top = y + 20;
  const lb = view.lb;
  for (let i = 0; i < lb.length; i++) {
    const e = lb[i];
    const by = top + i * (barH + gap);
    const isSelf = e.id === selfId;
    rr(x, by, w, barH, 5);
    ctx.fillStyle = isSelf ? 'rgba(90,169,255,0.5)' : 'rgba(0,0,0,0.4)';
    ctx.fill();
    ctx.font = "11px 'Trebuchet MS', sans-serif";
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = e.bot ? '#ffd7a0' : '#fff';
    ctx.fillText(`${i + 1}. ${e.n}`, x + 7, by + barH / 2);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#fff';
    ctx.fillText(`${e.f}`, x + w - 8, by + barH / 2);
  }
}

function drawMinimap(view, selfId) {
  const size = 150;
  const x = W - size - 14;
  const y = H - size - 14;
  const sx = size / cfg.w;
  const sy = size / cfg.h;

  rr(x, y, size, size, 8);
  ctx.fillStyle = 'rgba(8,10,18,0.7)';
  ctx.fill();
  // walls
  ctx.fillStyle = 'rgba(150,170,210,0.35)';
  for (let ty = 0; ty < cfg.rows; ty++) {
    for (let tx = 0; tx < cfg.cols; tx++) {
      if (grid[ty][tx] >= 6) ctx.fillRect(x + tx * cfg.tile * sx, y + ty * cfg.tile * sy, cfg.tile * sx + 0.5, cfg.tile * sy + 0.5);
    }
  }
  // pickups
  for (const e of view.ents) {
    if (e.k !== 'k') continue;
    ctx.fillStyle = e.drop ? '#ffc46b' : '#6ee0ff';
    ctx.fillRect(x + e.x * sx - 1.5, y + e.y * sy - 1.5, 3, 3);
  }
  // players
  for (const e of view.ents) {
    if (e.k !== 'p') continue;
    ctx.fillStyle = '#e2544a';
    ctx.beginPath();
    ctx.arc(x + e.x * sx, y + e.y * sy, 2.5, 0, 7);
    ctx.fill();
  }
  ctx.fillStyle = '#46e06a';
  ctx.beginPath();
  ctx.arc(x + view.self.x * sx, y + view.self.y * sy, 3.5, 0, 7);
  ctx.fill();
}

function drawKillFeed(view) {
  const now = performance.now();
  for (const f of view.feed) feedSeen.set(f.id, feedSeen.get(f.id) || now);
  if (feedSeen.size > 64) for (const [id, ts] of feedSeen) if (now - ts > 8000) feedSeen.delete(id);

  const x = 16;
  let y = 54;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.font = "12px 'Trebuchet MS', sans-serif";
  // newest first
  const recent = view.feed.filter((f) => now - feedSeen.get(f.id) < 4500).slice().reverse();
  for (const f of recent) {
    const age = now - feedSeen.get(f.id);
    ctx.globalAlpha = age > 3800 ? Math.max(0, 1 - (age - 3800) / 700) : 1;
    const killer = f.killer || 'world';
    const wname = (cfg.weapons[f.weapon] && cfg.weapons[f.weapon].name) || f.weapon || '';
    ctx.fillStyle = '#9fd0ff';
    const kw = ctx.measureText(killer).width;
    ctx.fillText(killer, x, y);
    ctx.fillStyle = 'rgba(220,225,255,0.65)';
    ctx.fillText(` «${wname}» `, x + kw, y);
    const mw = ctx.measureText(` «${wname}» `).width;
    ctx.fillStyle = '#ff9aa3';
    ctx.fillText(f.victim, x + kw + mw, y);
    y += 18;
  }
  ctx.globalAlpha = 1;
}

function drawCrosshair(mouse) {
  if (!mouse) return;
  const img = spr('crosshair');
  if (img) {
    ctx.drawImage(img, mouse.x - 16, mouse.y - 16, 32, 32);
    return;
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(mouse.x, mouse.y, 9, 0, 7);
  ctx.moveTo(mouse.x - 14, mouse.y);
  ctx.lineTo(mouse.x - 4, mouse.y);
  ctx.moveTo(mouse.x + 4, mouse.y);
  ctx.lineTo(mouse.x + 14, mouse.y);
  ctx.moveTo(mouse.x, mouse.y - 14);
  ctx.lineTo(mouse.x, mouse.y - 4);
  ctx.moveTo(mouse.x, mouse.y + 4);
  ctx.lineTo(mouse.x, mouse.y + 14);
  ctx.stroke();
}

function drawRespawn(self, opts) {
  ctx.fillStyle = 'rgba(8,10,18,0.55)';
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = "bold 34px 'Trebuchet MS', sans-serif";
  ctx.fillStyle = '#ff7a86';
  ctx.fillText('FRAGGED', W / 2, H / 2 - 30);
  ctx.font = "16px 'Trebuchet MS', sans-serif";
  ctx.fillStyle = '#dfe6ff';
  const by = self.killerName ? `by ${self.killerName}` : 'you died';
  ctx.fillText(by, W / 2, H / 2 + 6);
  ctx.fillStyle = 'rgba(220,225,255,0.7)';
  ctx.fillText(`Respawning in ${Math.ceil(self.respawnIn)}…`, W / 2, H / 2 + 34);
}

function drawMatchTimer(timeLeft) {
  const s = Math.max(0, Math.ceil(timeLeft));
  const mm = Math.floor(s / 60);
  const ss = (s % 60).toString().padStart(2, '0');
  ctx.font = "bold 22px 'Trebuchet MS', sans-serif";
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = s <= 30 ? '#ff8a72' : 'rgba(255,255,255,0.95)'; // warn in the final 30s
  ctx.fillText(`${mm}:${ss}`, W / 2, 8);
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// net is injected to avoid a circular import in module init order
let NET = { getEffects: () => [] };
export function setNet(net) {
  NET = net;
}
