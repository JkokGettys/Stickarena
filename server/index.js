'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const C = require('./constants');
const { Game } = require('./game');
const { MAPS, MAP_IDS } = require('./map');

const PORT = process.env.PORT || process.argv[2] || 3000;
const PUBLIC = path.join(__dirname, '..', 'public');

// Never let a stray exception kill the game server (would freeze every client).
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e && e.stack ? e.stack : e));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e && e.stack ? e.stack : e));

// Asset manifest — the client tries to load each from /assets and falls back to
// vector placeholders if a file is missing.
const ASSETS = {
  stickman: 'stickman.png',
  pistol: 'pistol.png',
  shotgun: 'shotgun.png',
  uzi: 'uzi.png',
  rifle: 'rifle.png',
  sniper: 'sniper.png',
  bat: 'bat.png',
  katana: 'katana.png',
  floor: 'floor.png',
  wall: 'wall.png',
  desk: 'desk.png',
  cooler: 'cooler.png',
  crate: 'crate.png',
  plant: 'plant.png',
  crosshair: 'crosshair.png',
  // city tiles
  road: 'road.png',
  sidewalk: 'sidewalk.png',
  grass: 'grass.png',
  wood: 'wood.png',
  tilefloor: 'tilefloor.png',
  building: 'building.png',
  // city props
  chair: 'chair.png',
  table: 'table.png',
  couch: 'couch.png',
  tv: 'tv.png',
  bookshelf: 'bookshelf.png',
  shelf: 'shelf.png',
  counter: 'counter.png',
  tree: 'tree.png',
  car: 'car.png',
  streetlight: 'streetlight.png',
  bench: 'bench.png',
  hydrant: 'hydrant.png',
  fountain: 'fountain.png',
  planter: 'planter.png',
  wallcorner: 'wallcorner.png',
  // desert map (tiles kept opaque/tileable; props chroma-keyed)
  sand: 'sand.png',
  desertstone: 'desertstone.png',
  adobe: 'adobe.png',
  mudwall: 'mudwall.png',
  palm: 'palm.png',
  cactus: 'cactus.png',
  amphora: 'amphora.png',
  ruinpillar: 'ruinpillar.png',
  // sci-fi map
  metalfloor: 'metalfloor.png',
  hazardfloor: 'hazardfloor.png',
  hullwall: 'hullwall.png',
  glasswall: 'glasswall.png',
  serverrack: 'serverrack.png',
  console: 'console.png',
  containment: 'containment.png',
  canister: 'canister.png',
};

// ---- static server -------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    // Always revalidate code/markup so clients never run stale cached JS.
    if (ext === '.js' || ext === '.html' || ext === '.css') headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
    res.writeHead(200, headers);
    res.end(data);
  });
});

// ---- game + ws -----------------------------------------------------------
const game = new Game(7);
const clients = new Set();

const weaponsClient = {};
for (const [id, w] of Object.entries(C.WEAPONS)) {
  weaponsClient[id] = { name: w.name, kind: w.kind, ammo: w.ammo === Infinity ? -1 : w.ammo, sprite: w.sprite };
}

// Everything a client needs to render + mirror-simulate one map. Rebuilt for the
// current map on connect, and again (as a 'mapchange' message) whenever a new
// match swaps the map mid-session.
function buildMapPayload(map) {
  return {
    id: map.id,
    name: map.name,
    tile: C.TILE,
    cols: map.cols,
    rows: map.rows,
    w: map.w,
    h: map.h,
    grid: map.typeStrings(),
    // Authoritative solidity per cell (type>=6 OR a solid prop on a floor tile).
    // Sent so the client can mirror server collision for movement prediction.
    solid: map.solid.map((row) => row.map((b) => (b ? 1 : 0)).join('')),
    props: map.props.map((p) => ({ type: p.type, x: p.tx, y: p.ty, r: p.rot || 0 })),
    weaponSpawns: map.weaponSpawns.map((s) => ({ weapon: s.weapon, x: s.x, y: s.y })),
    tileset: map.tileset, // code -> sprite key + fallback colour
  };
}

const MAP_MENU = MAP_IDS.map((id) => ({ id, name: MAPS[id].name, cols: MAPS[id].cols, rows: MAPS[id].rows }));

// Built per-connection (the live map changes over a session).
function buildConfigMsg() {
  return JSON.stringify({
    t: 'config',
    // Movement tuning the client needs to reproduce server physics exactly.
    phys: { speed: C.PLAYER_SPEED, accel: C.PLAYER_ACCEL, radius: C.PLAYER_RADIUS, tickRate: C.TICK_RATE },
    weapons: weaponsClient,
    assets: ASSETS,
    maxHealth: C.PLAYER_MAX_HEALTH,
    match: { duration: C.MATCH_DURATION, intermission: C.INTERMISSION },
    maps: MAP_MENU,
    mapId: game.currentMapId,
    map: buildMapPayload(game.map),
  });
}

function sanitizeName(raw) {
  if (typeof raw !== 'string') return 'Stick';
  const clean = raw
    .normalize('NFC')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '') // C0 + DEL + C1 controls
    .replace(/[​-‏‪-‮⁠-⁤﻿]/g, '') // zero-width + bidi overrides
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16);
  return clean.length ? clean : 'Stick';
}

function send(client, obj) {
  if (client.ws.readyState !== WebSocket.OPEN) return;
  try {
    client.ws.send(JSON.stringify(obj));
  } catch (e) {
    /* ignore */
  }
}

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  const client = { ws, entity: null };
  clients.add(client);
  ws.send(buildConfigMsg());

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;

    switch (msg.t) {
      case 'spawn': {
        if (client.entity) break; // already in game (auto-respawns)
        client.entity = game.spawnPlayer(sanitizeName(msg.name), false);
        send(client, { t: 'spawned', id: client.entity.id });
        break;
      }
      case 'input': {
        const e = client.entity;
        if (!e) break;
        const inp = e.input;
        inp.up = !!msg.u;
        inp.down = !!msg.d;
        inp.left = !!msg.l;
        inp.right = !!msg.r;
        inp.firing = !!msg.f;
        if (typeof msg.a === 'number' && isFinite(msg.a)) inp.aim = msg.a;
        if (typeof msg.seq === 'number' && msg.seq > e.lastInputSeq) e.lastInputSeq = msg.seq;
        break;
      }
      case 'vote': {
        if (client.entity && typeof msg.m === 'string') game.recordVote(client.entity.id, msg.m);
        break;
      }
    }
  });

  ws.on('close', () => {
    if (client.entity) game.removePlayer(client.entity.id);
    clients.delete(client);
  });
  ws.on('error', () => {});
});

// ---- simulation + broadcast ---------------------------------------------
setInterval(() => {
  try {
    game.step(C.DT);
  } catch (e) {
    console.error('[tick] step:', e && e.stack ? e.stack : e);
    return;
  }
  // A new match just swapped the map: tell every client to rebuild before the
  // next snapshot (which carries the new map's entities/positions) arrives.
  if (game.consumeMapChange()) {
    const mc = JSON.stringify({ t: 'mapchange', map: buildMapPayload(game.map) });
    for (const client of clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        try {
          client.ws.send(mc);
        } catch (e) {
          /* ignore */
        }
      }
    }
  }
  if (game.tick % C.SNAPSHOT_EVERY !== 0) return;
  let shared;
  try {
    shared = game.buildShared();
  } catch (e) {
    console.error('[tick] buildShared:', e && e.stack ? e.stack : e);
    return;
  }
  for (const client of clients) {
    if (client.ws.readyState !== WebSocket.OPEN || !client.entity) continue;
    try {
      send(client, game.buildSnapshot(client.entity, shared));
    } catch (e) {
      console.error('[tick] snapshot:', e && e.stack ? e.stack : e);
    }
  }
}, 1000 / C.TICK_RATE);

server.listen(PORT, () => {
  console.log(`Stick Arena running at http://localhost:${PORT}  (tick ${C.TICK_RATE}Hz, ${game.targetBots} bots)`);
});
