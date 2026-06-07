'use strict';

// Small math / id helpers shared across the server.

let _idCounter = 1;
function nextId() {
  return _idCounter++;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function rand(lo, hi) {
  return lo + Math.random() * (hi - lo);
}

function randInt(lo, hi) {
  return Math.floor(rand(lo, hi + 1));
}

function dist2(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

// Shortest signed angular difference from a to b, in (-PI, PI].
function angleDiff(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

module.exports = { nextId, clamp, lerp, rand, randInt, dist2, angleDiff };
