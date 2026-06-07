'use strict';

// ---------------------------------------------------------------------------
// Global tuning for the stickman arena deathmatch.
// ---------------------------------------------------------------------------

const TICK_RATE = 30;
const DT = 1 / TICK_RATE;
const SNAPSHOT_EVERY = 1;

const TILE = 64; // world units per map tile

// --- match / round structure ----------------------------------------------
const MATCH_DURATION = 7 * 60; // seconds of play before the match ends
const INTERMISSION = 30; // seconds of end screen + map voting before the next match

// --- player ---------------------------------------------------------------
const PLAYER_RADIUS = 17;
const PLAYER_SPEED = 240; // max move speed (units/sec)
const PLAYER_ACCEL = 14; // how fast velocity chases the input target
const PLAYER_MAX_HEALTH = 100;
const SPAWN_PROTECT = 2.0; // seconds of invulnerability after spawning
const RESPAWN_DELAY = 2.2; // seconds dead before auto-respawn
const REGEN_DELAY = 6; // seconds without damage before health regenerates
const REGEN_RATE = 12; // hp per second once regen kicks in

// --- pickups --------------------------------------------------------------
const PICKUP_RADIUS = 20;
const PICKUP_RESPAWN = 9; // seconds before a taken weapon spawn refills
const DROP_LIFETIME = 12; // seconds a dropped weapon stays on the ground

// --- effects --------------------------------------------------------------
const DEFAULT_TRACER = '#ffe98a';

// ---------------------------------------------------------------------------
// Weapons. kind 'melee' swings an arc; kind 'gun' is hitscan (instant ray).
//   damage      per hit (per pellet for guns)
//   rate        seconds between attacks
//   ammo        magazine size (melee weapons are unlimited)
//   pellets     rays per shot (shotgun = many)
//   spread      random aim deviation per ray, radians
//   range       max reach (world units)
//   arc         melee half-angle, radians
//   knockback   impulse applied to the victim
//   tracer      tracer colour for guns
//   sprite      asset key (filled in when art is generated)
// ---------------------------------------------------------------------------
const WEAPONS = {
  fists: {
    name: 'Fists',
    kind: 'melee',
    damage: 16,
    rate: 0.4,
    ammo: Infinity,
    range: 48,
    arc: 0.7,
    knockback: 140,
    sprite: null,
  },
  bat: {
    name: 'Bat',
    kind: 'melee',
    damage: 36,
    rate: 0.55,
    ammo: Infinity,
    range: 76,
    arc: 0.8,
    knockback: 340,
    sprite: 'bat',
  },
  katana: {
    name: 'Katana',
    kind: 'melee',
    damage: 58,
    rate: 0.45,
    ammo: Infinity,
    range: 92,
    arc: 0.6,
    knockback: 260,
    sprite: 'katana',
  },
  pistol: {
    name: 'Pistol',
    kind: 'gun',
    damage: 22,
    rate: 0.3,
    ammo: 24,
    pellets: 1,
    spread: 0.02,
    range: 950,
    knockback: 70,
    tracer: '#ffe07a',
    sprite: 'pistol',
  },
  shotgun: {
    name: 'Shotgun',
    kind: 'gun',
    damage: 11,
    rate: 0.85,
    ammo: 8,
    pellets: 8,
    spread: 0.2,
    range: 540,
    knockback: 230,
    tracer: '#ffc46b',
    sprite: 'shotgun',
  },
  uzi: {
    name: 'Uzi',
    kind: 'gun',
    damage: 13,
    rate: 0.085,
    ammo: 50,
    pellets: 1,
    spread: 0.075,
    range: 720,
    knockback: 45,
    tracer: '#fff0a8',
    sprite: 'uzi',
  },
  rifle: {
    name: 'Rifle',
    kind: 'gun',
    damage: 18,
    rate: 0.12,
    ammo: 35,
    pellets: 1,
    spread: 0.035,
    range: 1150,
    knockback: 65,
    tracer: '#ffe07a',
    sprite: 'rifle',
  },
  sniper: {
    name: 'Sniper',
    kind: 'gun',
    damage: 95,
    rate: 1.15,
    ammo: 6,
    pellets: 1,
    spread: 0.0,
    range: 2200,
    knockback: 130,
    tracer: '#bfe9ff',
    sprite: 'sniper',
  },
};

const DEFAULT_WEAPON = 'fists';

module.exports = {
  TICK_RATE,
  DT,
  SNAPSHOT_EVERY,
  TILE,
  MATCH_DURATION,
  INTERMISSION,
  PLAYER_RADIUS,
  PLAYER_SPEED,
  PLAYER_ACCEL,
  PLAYER_MAX_HEALTH,
  SPAWN_PROTECT,
  RESPAWN_DELAY,
  REGEN_DELAY,
  REGEN_RATE,
  PICKUP_RADIUS,
  PICKUP_RESPAWN,
  DROP_LIFETIME,
  DEFAULT_TRACER,
  WEAPONS,
  DEFAULT_WEAPON,
};
