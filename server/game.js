'use strict';

const C = require('./constants');
const { rand, clamp, dist2, angleDiff } = require('./util');
const { createMap, MAPS, MAP_IDS, DEFAULT_MAP } = require('./map');
const { Player, Pickup } = require('./entities');
const { botThink } = require('./bots');

const r1 = (v) => Math.round(v * 10) / 10;

const BOT_NAMES = [
  'Slash', 'Voodoo', 'Reaper', 'Ghost', 'Blaze', 'Havoc', 'Jinx', 'Riot', 'Mantis', 'Onyx',
  'Pyro', 'Quake', 'Razor', 'Saint', 'Tnt', 'Venom', 'Wisp', 'Yeti', 'Zero', 'Bandit', 'Crank',
];

class Game {
  constructor(targetBots = 7) {
    this.now = 0;
    this.tick = 0;
    this.targetBots = targetBots;

    this.currentMapId = DEFAULT_MAP;
    this.map = createMap(this.currentMapId);
    this.players = new Map();
    this.pickups = new Map();
    this.effects = [];
    this.feed = [];
    this._killId = 0;

    // --- match / round state ---
    this.phase = 'playing'; // 'playing' | 'intermission'
    this.matchEndsAt = this.now + C.MATCH_DURATION;
    this.intermissionEndsAt = 0;
    this.matchCount = 0;
    this.votes = new Map(); // playerId -> mapId (only during intermission)
    this.frozenStandings = []; // standings snapshot, frozen for the end screen
    this.frozenFeed = []; // kill feed frozen at match end
    this.mapChangeFlag = false; // set when a new match starts; index.js broadcasts 'mapchange'

    // Each weapon spawn refills its pickup after a delay once taken.
    this.spawnStates = this.map.weaponSpawns.map((s) => ({ spawn: s, pickupId: null, nextSpawn: 0 }));
    for (const st of this.spawnStates) this.createSpawnPickup(st);

    this.ensureBots(this.targetBots);
  }

  // ---- spawning --------------------------------------------------------
  createSpawnPickup(st) {
    const p = new Pickup(st.spawn.weapon, st.spawn.x, st.spawn.y, st, false);
    st.pickupId = p.id;
    this.pickups.set(p.id, p);
  }

  spawnPlayer(name, isBot) {
    const p = new Player(name, isBot);
    const spot = this.map.pickSpawn([...this.players.values()]);
    p.spawn(spot.x, spot.y, this.now);
    this.players.set(p.id, p);
    return p;
  }

  ensureBots(n) {
    let count = 0;
    for (const p of this.players.values()) if (p.isBot) count++;
    while (count < n) {
      this.spawnPlayer(this.uniqueBotName(), true);
      count++;
    }
  }

  uniqueBotName() {
    const used = new Set([...this.players.values()].map((p) => p.name));
    const avail = BOT_NAMES.filter((b) => !used.has(b));
    if (avail.length) return avail[Math.floor(Math.random() * avail.length)];
    const base = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
    let i = 2;
    while (used.has(base + i)) i++;
    return base + i;
  }

  removePlayer(id) {
    this.players.delete(id);
    this.votes.delete(id); // don't let a departed player's vote skew the tally
  }

  addEffect(e) {
    this.effects.push(e);
  }

  // ---- per-tick --------------------------------------------------------
  step(dt) {
    this.now += dt;
    this.tick++;
    this.effects.length = 0;

    if (this.phase === 'playing') {
      if (this.now >= this.matchEndsAt) {
        this.startIntermission();
        return; // freeze this tick; no further sim
      }
      this.simulate(dt);
    } else {
      // intermission: the world is frozen behind the end screen / voting overlay.
      if (this.now >= this.intermissionEndsAt) this.startMatch(this.tallyVotes());
    }
  }

  simulate(dt) {
    for (const p of this.players.values()) {
      if (p.isBot && !p.dead) botThink(p, this, dt);
    }

    for (const p of this.players.values()) {
      if (p.dead) {
        if (this.now >= p.respawnAt) {
          const spot = this.map.pickSpawn([...this.players.values()]);
          p.spawn(spot.x, spot.y, this.now);
        }
        continue;
      }
      this.updatePlayer(p, dt);
    }

    this.separatePlayers();
    this.handlePickups();
    this.refillSpawns();
    this.expireDrops();
  }

  // ---- match lifecycle -------------------------------------------------
  // End of a match: snapshot the final standings + kill feed (so the end screen
  // is stable for the whole 30s), open voting, and seed bot votes for liveliness.
  startIntermission() {
    this.phase = 'intermission';
    this.intermissionEndsAt = this.now + C.INTERMISSION;
    this.frozenStandings = this.computeStandings();
    this.frozenFeed = this.feed.slice();
    this.votes.clear();
    for (const p of this.players.values()) {
      if (p.isBot) this.votes.set(p.id, MAP_IDS[Math.floor(Math.random() * MAP_IDS.length)]);
    }
  }

  // Highest-voted map wins; ties broken randomly; with no votes at all the maps
  // rotate so an empty server still cycles scenery.
  tallyVotes() {
    const tally = this.voteTally();
    let best = -1;
    let leaders = [];
    for (const id of MAP_IDS) {
      const c = tally[id] || 0;
      if (c > best) {
        best = c;
        leaders = [id];
      } else if (c === best) {
        leaders.push(id);
      }
    }
    if (best <= 0) return MAP_IDS[this.matchCount % MAP_IDS.length];
    return leaders[Math.floor(Math.random() * leaders.length)];
  }

  // Start a fresh match on `mapId`: swap the map, wipe pickups/feed/effects/votes,
  // zero every player's K/D and respawn them on the new map.
  startMatch(mapId) {
    this.currentMapId = MAPS[mapId] ? mapId : DEFAULT_MAP;
    this.map = createMap(this.currentMapId);

    this.pickups.clear();
    this.spawnStates = this.map.weaponSpawns.map((s) => ({ spawn: s, pickupId: null, nextSpawn: 0 }));
    for (const st of this.spawnStates) this.createSpawnPickup(st);

    for (const p of this.players.values()) {
      p.frags = 0;
      p.deaths = 0;
      p.streak = 0;
      p.killerName = null;
      const spot = this.map.pickSpawn([...this.players.values()]);
      p.spawn(spot.x, spot.y, this.now); // resets health/weapon/ammo/dead/respawn
    }

    this.feed = [];
    this.frozenFeed = [];
    this.frozenStandings = [];
    this.effects.length = 0;
    this.votes.clear();

    this.phase = 'playing';
    this.matchEndsAt = this.now + C.MATCH_DURATION;
    this.matchCount++;
    this.mapChangeFlag = true;

    this.ensureBots(this.targetBots);
  }

  // Record a player's map vote — only meaningful during intermission.
  recordVote(playerId, mapId) {
    if (this.phase !== 'intermission') return;
    if (!MAPS[mapId] || !this.players.has(playerId)) return;
    this.votes.set(playerId, mapId);
  }

  voteTally() {
    const tally = {};
    for (const id of this.votes.values()) {
      if (MAPS[id]) tally[id] = (tally[id] || 0) + 1;
    }
    return tally;
  }

  computeStandings() {
    const ranked = [...this.players.values()].sort((a, b) => b.frags - a.frags || a.deaths - b.deaths);
    return ranked.map((p) => ({ n: p.name, f: p.frags, d: p.deaths, id: p.id, bot: p.isBot ? 1 : 0 }));
  }

  // index.js calls this after each step; a true result means broadcast a 'mapchange'.
  consumeMapChange() {
    const v = this.mapChangeFlag;
    this.mapChangeFlag = false;
    return v;
  }

  updatePlayer(p, dt) {
    const inp = p.input;
    let tx = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
    let ty = (inp.down ? 1 : 0) - (inp.up ? 1 : 0);
    const len = Math.hypot(tx, ty);
    let targetVx = 0;
    let targetVy = 0;
    if (len > 0) {
      targetVx = (tx / len) * C.PLAYER_SPEED;
      targetVy = (ty / len) * C.PLAYER_SPEED;
    }
    const k = Math.min(1, C.PLAYER_ACCEL * dt);
    p.vx += (targetVx - p.vx) * k;
    p.vy += (targetVy - p.vy) * k;

    p.x += p.vx * dt;
    p.y += p.vy * dt;
    const res = this.map.resolveCircle(p.x, p.y, p.radius);
    p.x = res.x;
    p.y = res.y;
    // Never let a position/velocity go non-finite (would blank the client camera).
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.vx) || !Number.isFinite(p.vy)) {
      console.error('[sanitize] non-finite player', p.name, { x: p.x, y: p.y, vx: p.vx, vy: p.vy });
      const sp = this.map.pickSpawn([...this.players.values()]);
      p.x = sp.x;
      p.y = sp.y;
      p.vx = 0;
      p.vy = 0;
    }

    p.aim = inp.aim;

    if (!p.isProtected(this.now) && this.now - p.lastDamage > C.REGEN_DELAY && p.health < p.maxHealth) {
      p.health = Math.min(p.maxHealth, p.health + C.REGEN_RATE * dt);
    }

    if (p.attackT > 0) p.attackT = Math.max(0, p.attackT - dt);
    if (p.cooldown > 0) p.cooldown -= dt;
    if (inp.firing && p.cooldown <= 0) this.fire(p);
  }

  separatePlayers() {
    const alive = [];
    for (const p of this.players.values()) if (!p.dead) alive.push(p);
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i];
        const b = alive[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const sumR = a.radius + b.radius;
        const d2 = dx * dx + dy * dy;
        if (d2 >= sumR * sumR || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const overlap = (sumR - d) / 2;
        const nx = dx / d;
        const ny = dy / d;
        a.x += nx * overlap;
        a.y += ny * overlap;
        b.x -= nx * overlap;
        b.y -= ny * overlap;
      }
    }
    // keep them out of walls after pushing
    for (const p of alive) {
      const res = this.map.resolveCircle(p.x, p.y, p.radius);
      p.x = res.x;
      p.y = res.y;
    }
  }

  handlePickups() {
    for (const p of this.players.values()) {
      if (p.dead) continue;
      for (const k of this.pickups.values()) {
        const rr = p.radius + C.PICKUP_RADIUS;
        if (dist2(p.x, p.y, k.x, k.y) <= rr * rr) {
          p.equip(k.weapon);
          this.addEffect({ e: 'p', x: k.x, y: k.y });
          if (k.spawnRef) {
            k.spawnRef.pickupId = null;
            k.spawnRef.nextSpawn = this.now + C.PICKUP_RESPAWN;
          }
          this.pickups.delete(k.id);
          break;
        }
      }
    }
  }

  refillSpawns() {
    for (const st of this.spawnStates) {
      if (st.pickupId === null && this.now >= st.nextSpawn) this.createSpawnPickup(st);
    }
  }

  expireDrops() {
    for (const [id, k] of this.pickups) {
      if (k.isDrop && this.now >= k.expireAt) this.pickups.delete(id);
    }
  }

  // ---- combat ----------------------------------------------------------
  fire(p) {
    const w = C.WEAPONS[p.weapon];
    if (!w) return;
    p.cooldown = w.rate;
    p.attackT = w.kind === 'melee' ? 0.22 : 0.1;
    p.spawnTime = -999; // committing an attack ends spawn protection

    if (w.kind === 'melee') {
      this.melee(p, w);
      return;
    }

    const ca = Math.cos(p.aim);
    const sa = Math.sin(p.aim);
    const ox = p.x + ca * (p.radius + 8);
    const oy = p.y + sa * (p.radius + 8);
    const pellets = w.pellets || 1;

    for (let i = 0; i < pellets; i++) {
      const ang = p.aim + (Math.random() * 2 - 1) * w.spread;
      const cos = Math.cos(ang);
      const sin = Math.sin(ang);
      const wallDist = this.map.raycast(ox, oy, ang, w.range);
      const maxd = Math.min(wallDist, w.range);
      const hit = this.nearestPlayerAlongRay(p, ox, oy, cos, sin, maxd);
      const endd = hit ? hit.dist : maxd;
      const ex = ox + cos * endd;
      const ey = oy + sin * endd;
      this.addEffect({ e: 't', x1: Math.round(ox), y1: Math.round(oy), x2: Math.round(ex), y2: Math.round(ey), c: w.tracer || C.DEFAULT_TRACER, o: p.id });
      if (hit) {
        this.applyDamage(hit.p, w.damage, p);
        hit.p.vx += cos * w.knockback;
        hit.p.vy += sin * w.knockback;
        this.addEffect({ e: 'h', x: Math.round(ex), y: Math.round(ey) });
      }
    }
    this.addEffect({ e: 'f', x: Math.round(ox), y: Math.round(oy), a: p.aim, c: w.tracer || C.DEFAULT_TRACER, o: p.id });

    if (p.ammo !== Infinity) {
      p.ammo--;
      if (p.ammo <= 0) p.equip(C.DEFAULT_WEAPON);
    }
  }

  melee(p, w) {
    this.addEffect({ e: 'm', x: Math.round(p.x), y: Math.round(p.y), a: p.aim, r: w.range });
    for (const q of this.players.values()) {
      if (q === p || q.dead || q.isProtected(this.now)) continue;
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const reach = w.range + q.radius;
      if (dx * dx + dy * dy > reach * reach) continue;
      const ang = Math.atan2(dy, dx);
      if (Math.abs(angleDiff(p.aim, ang)) > w.arc) continue;
      if (!this.map.lineClear(p.x, p.y, q.x, q.y)) continue; // melee respects walls
      this.applyDamage(q, w.damage, p);
      q.vx += Math.cos(p.aim) * w.knockback;
      q.vy += Math.sin(p.aim) * w.knockback;
    }
  }

  nearestPlayerAlongRay(shooter, ox, oy, dx, dy, maxd) {
    let best = null;
    let bestT = maxd;
    for (const q of this.players.values()) {
      if (q === shooter || q.dead || q.isProtected(this.now)) continue;
      const ex = q.x - ox;
      const ey = q.y - oy;
      const r = q.radius;
      const distC2 = ex * ex + ey * ey;
      if (distC2 <= r * r) {
        // muzzle already inside the target: point-blank hit at distance 0
        bestT = 0;
        best = q;
        continue;
      }
      const tProj = ex * dx + ey * dy;
      if (tProj < 0) continue;
      const perp2 = distC2 - tProj * tProj;
      if (perp2 > r * r) continue;
      const tHit = tProj - Math.sqrt(r * r - perp2);
      if (tHit >= 0 && tHit <= bestT) {
        bestT = tHit;
        best = q;
      }
    }
    return best ? { p: best, dist: bestT } : null;
  }

  applyDamage(victim, dmg, attacker) {
    if (victim.dead || victim.isProtected(this.now)) return;
    victim.health -= dmg;
    victim.lastDamage = this.now;
    if (victim.health <= 0) this.kill(victim, attacker);
  }

  kill(victim, attacker) {
    victim.dead = true;
    victim.deaths++;
    victim.streak = 0;
    victim.respawnAt = this.now + C.RESPAWN_DELAY;
    const credited = attacker && attacker !== victim && !attacker.dead;
    victim.killerName = credited ? attacker.name : null;
    if (credited) {
      attacker.frags++;
      attacker.streak++;
    }
    this.feed.push({
      id: ++this._killId,
      killer: credited ? attacker.name : null,
      victim: victim.name,
      weapon: credited ? attacker.weapon : (victim.weapon || 'fists'),
    });
    if (this.feed.length > 8) this.feed.shift();
    this.addEffect({ e: 'd', x: Math.round(victim.x), y: Math.round(victim.y) });

    // Drop the victim's weapon (if it was a real one) for others to grab.
    if (victim.weapon && victim.weapon !== C.DEFAULT_WEAPON) {
      const drop = new Pickup(victim.weapon, victim.x, victim.y, null, true);
      drop.expireAt = this.now + C.DROP_LIFETIME;
      this.pickups.set(drop.id, drop);
    }
  }

  // ---- networking ------------------------------------------------------
  // Viewer-independent data, computed once per tick and shared across clients.
  buildShared() {
    const ranked = [...this.players.values()].sort((a, b) => b.frags - a.frags || a.deaths - b.deaths);
    const rankById = new Map();
    ranked.forEach((p, i) => rankById.set(p.id, i + 1));
    const lb = ranked
      .slice(0, 8)
      .map((p) => ({ n: p.name, f: p.frags, d: p.deaths, id: p.id, bot: p.isBot ? 1 : 0 }));

    const allEnts = [];
    let humans = 0;
    for (const q of this.players.values()) {
      if (!q.isBot) humans++;
      if (!q.dead) allEnts.push(q.net(this.now));
    }
    for (const k of this.pickups.values()) allEnts.push(k.net());

    const intermission = this.phase === 'intermission';
    const timeLeft = r1(Math.max(0, (intermission ? this.intermissionEndsAt : this.matchEndsAt) - this.now));

    return {
      allEnts,
      fx: this.effects,
      lb,
      feed: intermission ? this.frozenFeed.slice(-6) : this.feed.slice(-6),
      humans,
      rankById,
      total: ranked.length,
      mapId: this.currentMapId,
      phase: this.phase,
      timeLeft,
      standings: intermission ? this.frozenStandings : null,
      votes: intermission ? this.voteTally() : null,
    };
  }

  buildSnapshot(viewer, shared) {
    const ents = [];
    for (const e of shared.allEnts) if (e.id !== viewer.id) ents.push(e);
    const snap = {
      t: 'u',
      self: viewer.selfState(this.now),
      ents,
      fx: shared.fx,
      lb: shared.lb,
      feed: shared.feed,
      humans: shared.humans,
      rank: shared.rankById.get(viewer.id) || 0,
      total: shared.total,
      mapId: shared.mapId,
      phase: shared.phase,
      timeLeft: shared.timeLeft,
    };
    if (shared.phase === 'intermission') {
      snap.standings = shared.standings;
      snap.votes = shared.votes;
      snap.vote = this.votes.get(viewer.id) || null;
    }
    return snap;
  }
}

module.exports = { Game };
