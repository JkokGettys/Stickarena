'use strict';

const C = require('./constants');
const { nextId } = require('./util');

const r0 = (v) => Math.round(v);
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

class Player {
  constructor(name, isBot = false) {
    this.id = nextId();
    this.kind = 'player';
    this.name = name || (isBot ? 'Bot' : 'Player');
    this.isBot = isBot;

    this.x = 0;
    this.y = 0;
    this.vx = 0;
    this.vy = 0;
    this.aim = 0;
    this.radius = C.PLAYER_RADIUS;

    this.maxHealth = C.PLAYER_MAX_HEALTH;
    this.health = this.maxHealth;
    this.weapon = C.DEFAULT_WEAPON;
    this.ammo = Infinity;
    this.cooldown = 0;
    this.attackT = 0; // remaining attack-animation time (drives swing/recoil on clients)

    this.frags = 0;
    this.deaths = 0;
    this.streak = 0;

    this.dead = false;
    this.respawnAt = 0;
    this.spawnTime = -999;
    this.lastDamage = -999;
    this.killerName = null;

    this.input = { up: false, down: false, left: false, right: false, aim: 0, firing: false };
    this.ai = null;
  }

  spawn(x, y, now) {
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    this.health = this.maxHealth;
    this.weapon = C.DEFAULT_WEAPON;
    this.ammo = Infinity;
    this.cooldown = 0;
    this.attackT = 0;
    this.dead = false;
    this.spawnTime = now;
    this.killerName = null;
  }

  equip(weaponId) {
    const w = C.WEAPONS[weaponId];
    if (!w) return;
    this.weapon = weaponId;
    this.ammo = w.ammo;
    this.cooldown = Math.max(this.cooldown, 0.08);
  }

  isProtected(now) {
    return now - this.spawnTime < C.SPAWN_PROTECT;
  }

  net(now) {
    return {
      id: this.id,
      k: 'p',
      x: r0(this.x),
      y: r0(this.y),
      a: r3(this.aim),
      hp: r2(this.health / this.maxHealth),
      w: this.weapon,
      n: this.name,
      bot: this.isBot ? 1 : 0,
      pr: this.isProtected(now) ? 1 : 0,
      at: r2(this.attackT),
    };
  }

  selfState(now) {
    return {
      id: this.id,
      x: r2(this.x),
      y: r2(this.y),
      a: r3(this.aim),
      health: r0(this.health),
      maxHealth: this.maxHealth,
      weapon: this.weapon,
      ammo: this.ammo === Infinity ? -1 : this.ammo,
      frags: this.frags,
      deaths: this.deaths,
      dead: this.dead,
      respawnIn: this.dead ? Math.max(0, r2(this.respawnAt - now)) : 0,
      protected: this.isProtected(now) ? 1 : 0,
      pr: this.isProtected(now) ? 1 : 0,
      at: r2(this.attackT),
      w: this.weapon,
      killerName: this.killerName,
    };
  }
}

class Pickup {
  constructor(weapon, x, y, spawnRef = null, isDrop = false) {
    this.id = nextId();
    this.kind = 'pickup';
    this.weapon = weapon;
    this.x = x;
    this.y = y;
    this.spawnRef = spawnRef; // weapon-spawn this belongs to (for refill), null for drops
    this.isDrop = isDrop;
    this.expireAt = 0; // for dropped weapons
  }

  net() {
    return {
      id: this.id,
      k: 'k',
      x: r0(this.x),
      y: r0(this.y),
      w: this.weapon,
      drop: this.isDrop ? 1 : 0,
    };
  }
}

module.exports = { Player, Pickup };
