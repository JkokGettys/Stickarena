'use strict';

const C = require('./constants');
const { dist2 } = require('./util');

function nearestVisibleEnemy(p, game) {
  let best = null;
  let bestD = Infinity;
  for (const q of game.players.values()) {
    if (q === p || q.dead || q.isProtected(game.now)) continue;
    const d = dist2(p.x, p.y, q.x, q.y);
    if (d < bestD && game.map.lineClear(p.x, p.y, q.x, q.y)) {
      bestD = d;
      best = q;
    }
  }
  return best;
}

function nearestPickup(p, game) {
  let best = null;
  let bestScore = Infinity;
  for (const k of game.pickups.values()) {
    const wd = C.WEAPONS[k.weapon];
    const score = dist2(p.x, p.y, k.x, k.y) * (wd && wd.kind === 'gun' ? 1 : 1.6);
    if (score < bestScore) {
      bestScore = score;
      best = k;
    }
  }
  return best;
}

function setMove(p, vx, vy) {
  const m = Math.hypot(vx, vy) || 1;
  const nx = vx / m;
  const ny = vy / m;
  const T = 0.4;
  p.input.right = nx > T;
  p.input.left = nx < -T;
  p.input.down = ny > T;
  p.input.up = ny < -T;
}

function botThink(p, game, dt) {
  const ai =
    p.ai ||
    (p.ai = { timer: 0, strafe: Math.random() < 0.5 ? 1 : -1, wander: Math.random() * Math.PI * 2 });

  const w = C.WEAPONS[p.weapon];
  const hasGun = w.kind === 'gun';
  const lowAmmo = hasGun && p.ammo !== Infinity && p.ammo <= 2;
  const lowHP = p.health < 35;

  ai.timer -= dt;
  if (ai.timer <= 0) {
    ai.timer = 0.2 + Math.random() * 0.25;
    ai.enemy = nearestVisibleEnemy(p, game);
    ai.pickup = !hasGun || lowAmmo ? nearestPickup(p, game) : null;
    if (Math.random() < 0.1) ai.strafe *= -1;
    if (Math.random() < 0.15) ai.wander = Math.random() * Math.PI * 2;
  }

  const enemy =
    ai.enemy && game.players.has(ai.enemy.id) && !ai.enemy.dead ? ai.enemy : null;

  let aimAng = p.aim;
  let mvx = 0;
  let mvy = 0;
  let fire = false;

  if (enemy && game.map.lineClear(p.x, p.y, enemy.x, enemy.y)) {
    const dx = enemy.x - p.x;
    const dy = enemy.y - p.y;
    const d = Math.hypot(dx, dy);
    aimAng = Math.atan2(dy, dx) + (Math.random() * 2 - 1) * 0.06;
    const pref = w.kind === 'melee' ? 38 : w.range > 1400 ? 620 : 300;
    if (lowHP) {
      mvx = -dx;
      mvy = -dy;
    } else if (d > pref + 80) {
      mvx = dx;
      mvy = dy;
    } else if (d < pref - 80) {
      mvx = -dx;
      mvy = -dy;
    } else {
      mvx = -dy * ai.strafe;
      mvy = dx * ai.strafe;
    }
    fire = w.kind === 'melee' ? d < w.range + enemy.radius : d < w.range;
  } else if (ai.pickup && game.pickups.has(ai.pickup.id)) {
    const dx = ai.pickup.x - p.x;
    const dy = ai.pickup.y - p.y;
    aimAng = Math.atan2(dy, dx);
    mvx = dx;
    mvy = dy;
  } else if (enemy) {
    const dx = enemy.x - p.x;
    const dy = enemy.y - p.y;
    aimAng = Math.atan2(dy, dx);
    mvx = dx;
    mvy = dy;
  } else {
    mvx = Math.cos(ai.wander);
    mvy = Math.sin(ai.wander);
    aimAng = ai.wander;
  }

  // wall avoidance
  if (Math.hypot(mvx, mvy) > 0.01) {
    let moveAng = Math.atan2(mvy, mvx);
    if (game.map.raycast(p.x, p.y, moveAng, 84) < 68) {
      moveAng += ai.strafe * 1.2;
      if (Math.random() < 0.05) ai.strafe *= -1;
    }
    mvx = Math.cos(moveAng);
    mvy = Math.sin(moveAng);
  }

  setMove(p, mvx, mvy);
  p.input.aim = aimAng;
  p.input.firing = fire;
}

module.exports = { botThink };
