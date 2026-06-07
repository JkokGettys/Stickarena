'use strict';

const { TILE } = require('./constants');
const { clamp, dist2 } = require('./util');

const COLS = 72;
const ROWS = 52;

// Cell type codes. Floors are < 6 (walkable); 6+ are solid walls.
const T = {
  GRASS: 0,
  ROAD: 1,
  SIDEWALK: 2,
  CARPET: 3,
  WOOD: 4,
  TILE: 5,
  BUILDING: 6, // exterior wall
  IWALL: 7, // interior wall
};

// Deterministic PRNG so the map is identical every server start.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ri = (rng, a, b) => a + Math.floor(rng() * (b - a + 1));

// Furniture weighting per building theme. plant is the only non-solid prop.
const THEME_PROPS = {
  office: [['desk', 0.34], ['chair', 0.24], ['bookshelf', 0.16], ['table', 0.1], ['plant', 0.09], ['cooler', 0.07]],
  lounge: [['couch', 0.3], ['table', 0.2], ['bookshelf', 0.18], ['tv', 0.12], ['plant', 0.12], ['chair', 0.08]],
  warehouse: [['shelf', 0.5], ['crate', 0.4], ['table', 0.06], ['plant', 0.04]],
  diner: [['table', 0.3], ['chair', 0.3], ['counter', 0.2], ['cooler', 0.1], ['plant', 0.1]],
  shop: [['shelf', 0.3], ['counter', 0.26], ['crate', 0.24], ['table', 0.1], ['plant', 0.1]],
};

// Furniture sprites are drawn with their "front" facing south; rotate to aim it.
const FACE = { S: 0, N: Math.PI, E: -Math.PI / 2, W: Math.PI / 2 };

class GameMap {
  constructor() {
    this.cols = COLS;
    this.rows = ROWS;
    this.tile = TILE;
    this.w = COLS * TILE;
    this.h = ROWS * TILE;

    this.type = Array.from({ length: ROWS }, () => new Array(COLS).fill(T.GRASS));
    this.solid = Array.from({ length: ROWS }, () => new Array(COLS).fill(false));
    this.props = [];
    this.doorCells = new Set();
    this.rooms = [];
    this.weaponSpawns = [];
    this.playerSpawns = [];

    this.build();
  }

  inb(x, y) {
    return x >= 0 && y >= 0 && x < COLS && y < ROWS;
  }
  fill(x, y, w, h, t) {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (this.inb(i, j)) this.type[j][i] = t;
  }
  setWall(x, y, t) {
    if (this.inb(x, y)) {
      this.type[y][x] = t;
      this.solid[y][x] = true;
    }
  }
  punchDoor(x, y, floorT) {
    if (!this.inb(x, y)) return;
    this.type[y][x] = floorT;
    this.solid[y][x] = false;
    this.doorCells.add(x + ',' + y);
  }
  doorAdj(x, y) {
    if (this.doorCells.has(x + ',' + y)) return true;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (this.doorCells.has(x + dx + ',' + (y + dy))) return true;
    return false;
  }

  // ---- city construction ----------------------------------------------
  build() {
    // --- road network: a main cross plus asymmetric side streets ---
    this.fill(34, 0, 3, ROWS, T.ROAD); // main avenue (vertical)
    this.fill(0, 24, COLS, 3, T.ROAD); // main street (horizontal)
    this.fill(16, 0, 2, 26, T.ROAD); // NW side street
    this.fill(52, 26, 2, ROWS - 26, T.ROAD); // SE side street
    this.fill(37, 12, COLS - 37, 2, T.ROAD); // NE side street
    this.fill(0, 40, 17, 2, T.ROAD); // SW side street

    // --- buildings: varied sizes/positions, some adjacent, not a 2x2 grid ---
    const B = [
      [2, 2, 13, 21, T.CARPET, 'office', 1337],
      [19, 2, 14, 9, T.TILE, 'shop', 2024],
      [19, 13, 14, 10, T.WOOD, 'lounge', 3310],
      [38, 2, 14, 9, T.TILE, 'diner', 4242],
      [55, 2, 16, 9, T.CARPET, 'office', 5151],
      [38, 15, 33, 8, T.WOOD, 'lounge', 6262],
      [2, 28, 13, 11, T.TILE, 'warehouse', 7007],
      [19, 28, 14, 12, T.TILE, 'diner', 8118],
      [38, 28, 13, 21, T.CARPET, 'office', 9229],
      [55, 28, 16, 21, T.WOOD, 'shop', 1010],
    ];
    for (const [x, y, w, h, floor, theme, seed] of B) this.building(x, y, w, h, floor, theme, seed);

    // --- fountain plaza (an open sidewalk square) ---
    this.fill(19, 42, 14, 8, T.SIDEWALK);

    this.addSidewalks();
    this.outdoor();
    this.repairConnectivity();
    this.placeSpawns();
  }

  // Guarantee the whole map is one connected space: flood from the road, and
  // punch a doorway through any wall that bridges a reachable and an
  // unreachable area. Catches BSP doors that happened to land on a child wall.
  repairConnectivity() {
    for (let guard = 0; guard < 400; guard++) {
      const reach = this.reachable(30, 22);
      let hasUnreached = false;
      for (let y = 0; y < ROWS && !hasUnreached; y++) {
        for (let x = 0; x < COLS; x++) {
          if (!this.solid[y][x] && !reach.has(x + ',' + y)) {
            hasUnreached = true;
            break;
          }
        }
      }
      if (!hasUnreached) return;

      let bridged = false;
      for (const wallType of [T.IWALL, T.BUILDING]) {
        for (let y = 0; y < ROWS && !bridged; y++) {
          for (let x = 0; x < COLS; x++) {
            if (this.type[y][x] !== wallType) continue;
            let nearReach = false;
            let nearUnreach = false;
            let floorT = T.CARPET;
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const nx = x + dx;
              const ny = y + dy;
              if (!this.inb(nx, ny) || this.solid[ny][nx]) continue;
              floorT = this.type[ny][nx];
              if (reach.has(nx + ',' + ny)) nearReach = true;
              else nearUnreach = true;
            }
            if (nearReach && nearUnreach) {
              this.punchDoor(x, y, floorT);
              bridged = true;
              break;
            }
          }
        }
        if (bridged) break;
      }
      if (!bridged) return;
    }
  }

  building(bx, by, bw, bh, floorT, theme, seed) {
    const rng = makeRng(seed);
    this.fill(bx, by, bw, bh, floorT);
    const x2 = bx + bw - 1;
    const y2 = by + bh - 1;
    for (let i = bx; i <= x2; i++) {
      this.setWall(i, by, T.BUILDING);
      this.setWall(i, y2, T.BUILDING);
    }
    for (let j = by; j <= y2; j++) {
      this.setWall(bx, j, T.BUILDING);
      this.setWall(x2, j, T.BUILDING);
    }

    const rooms = [];
    this.bsp(bx + 1, by + 1, x2 - 1, y2 - 1, floorT, rng, rooms, 0);
    this.makeEntrances(bx, by, bw, bh, floorT, rng);
    for (const r of rooms) {
      r.theme = theme;
      r.cx = (r.x0 + r.x1) >> 1;
      r.cy = (r.y0 + r.y1) >> 1;
      this.furnishRoom(r, theme, rng);
      this.rooms.push(r);
    }
  }

  // Recursive binary split. Every dividing wall gets one door, so the room
  // adjacency graph is a tree -> the interior is always fully connected.
  bsp(x0, y0, x1, y1, floorT, rng, rooms, depth) {
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    const MIN = 3;
    const canV = w >= MIN * 2 + 1;
    const canH = h >= MIN * 2 + 1;
    if ((!canV && !canH) || depth >= 4 || (depth >= 2 && rng() < 0.35)) {
      rooms.push({ x0, y0, x1, y1 });
      return;
    }
    const vert = canV && canH ? (w > h ? true : h > w ? false : rng() < 0.5) : canV;
    if (vert) {
      const wx = ri(rng, x0 + MIN, x1 - MIN);
      for (let y = y0; y <= y1; y++) this.setWall(wx, y, T.IWALL);
      this.punchDoor(wx, ri(rng, y0, y1), floorT);
      this.bsp(x0, y0, wx - 1, y1, floorT, rng, rooms, depth + 1);
      this.bsp(wx + 1, y0, x1, y1, floorT, rng, rooms, depth + 1);
    } else {
      const wy = ri(rng, y0 + MIN, y1 - MIN);
      for (let x = x0; x <= x1; x++) this.setWall(x, wy, T.IWALL);
      this.punchDoor(ri(rng, x0, x1), wy, floorT);
      this.bsp(x0, y0, x1, wy - 1, floorT, rng, rooms, depth + 1);
      this.bsp(x0, wy + 1, x1, y1, floorT, rng, rooms, depth + 1);
    }
  }

  makeEntrances(bx, by, bw, bh, floorT, rng) {
    const x2 = bx + bw - 1;
    const y2 = by + bh - 1;
    const sides = ['N', 'S', 'E', 'W'];
    for (let i = sides.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [sides[i], sides[j]] = [sides[j], sides[i]];
    }
    const count = 2 + (rng() < 0.6 ? 1 : 0);
    for (let k = 0; k < count; k++) {
      const side = sides[k];
      let x;
      let y;
      let dx = 0;
      let dy = 0;
      if (side === 'N') {
        x = ri(rng, bx + 2, x2 - 3);
        y = by;
        dy = 1;
      } else if (side === 'S') {
        x = ri(rng, bx + 2, x2 - 3);
        y = y2;
        dy = -1;
      } else if (side === 'W') {
        x = bx;
        y = ri(rng, by + 2, y2 - 3);
        dx = 1;
      } else {
        x = x2;
        y = ri(rng, by + 2, y2 - 3);
        dx = -1;
      }
      // 2-wide doorway
      const cells = side === 'N' || side === 'S' ? [[x, y], [x + 1, y]] : [[x, y], [x, y + 1]];
      for (const [sx, sy] of cells) {
        this.punchDoor(sx, sy, floorT);
        // carve through any interior wall directly behind the door (up to 2 cells)
        let cx = sx + dx;
        let cy = sy + dy;
        let steps = 0;
        while (this.inb(cx, cy) && this.type[cy][cx] === T.IWALL && steps < 2) {
          this.punchDoor(cx, cy, floorT);
          cx += dx;
          cy += dy;
          steps++;
        }
      }
    }
  }

  pickProp(theme, rng) {
    const list = THEME_PROPS[theme] || THEME_PROPS.office;
    let r = rng();
    let acc = 0;
    for (const [type, wt] of list) {
      acc += wt;
      if (r <= acc) return { type, solid: type !== 'plant' };
    }
    return { type: list[0][0], solid: list[0][0] !== 'plant' };
  }

  // Intentional per-theme room layouts: furniture lines the walls (oriented to
  // face into the room) in coherent groupings; every solid piece is kept only if
  // the room stays traversable.
  furnishRoom(r, theme, rng) {
    const x0 = r.x0;
    const y0 = r.y0;
    const x1 = r.x1;
    const y1 = r.y1;
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;

    const free = (x, y) =>
      x >= x0 && x <= x1 && y >= y0 && y <= y1 && !this.solid[y][x] && !(x === r.cx && y === r.cy) && !this.doorAdj(x, y);

    const put = (type, x, y, rot, solid = true) => {
      if (!free(x, y)) return false;
      if (solid) {
        this.solid[y][x] = true;
        if (!this.roomConnected(r)) {
          this.solid[y][x] = false;
          return false;
        }
      }
      this.props.push({ type, tx: x, ty: y, rot });
      return true;
    };

    if (theme === 'office' || theme === 'shop') {
      // a row of desks (or display shelves) against the top wall, chairs facing them
      const deskType = theme === 'office' ? 'desk' : 'shelf';
      for (let x = x0; x <= x1; x++) {
        if (put(deskType, x, y0, FACE.S) && theme === 'office' && h >= 3) put('chair', x, y0 + 1, FACE.N);
      }
      // bookshelves/shelving along the bottom wall once there's a walkway between
      if (h >= 4) for (let x = x0; x <= x1; x++) put(theme === 'office' ? 'bookshelf' : 'shelf', x, y1, FACE.N);
      put('plant', x1, y1, FACE.S, false);
      if (theme === 'office') put('cooler', x0, y1, FACE.S);
      else put('counter', x0, y0 + (h >> 1), FACE.E);
    } else if (theme === 'lounge') {
      // couches along the bottom wall facing the room; TV centred on the top wall
      for (let x = x0; x <= x1; x++) put('couch', x, y1, FACE.N);
      put('tv', x0 + (w >> 1), y0, FACE.S);
      if (w >= 4) for (let y = y0; y <= y1; y++) put('bookshelf', x0, y, FACE.E);
      put('table', r.cx, r.cy + 1 <= y1 ? r.cy + 1 : r.cy - 1, FACE.S);
      put('plant', x1, y0, FACE.S, false);
    } else if (theme === 'warehouse') {
      // shelving in parallel aisles (every other column)
      for (let x = x0; x <= x1; x += 2) for (let y = y0; y <= y1; y++) put('shelf', x, y, FACE.E);
      put('crate', x1, y0, FACE.S);
      put('crate', x1, y1, FACE.S);
    } else if (theme === 'diner') {
      // counter along the top wall; tables with a chair either side below it
      for (let x = x0; x <= x1; x++) put('counter', x, y0, FACE.S);
      for (let y = y0 + 2; y <= y1; y += 2) {
        for (let x = x0 + 1; x <= x1; x += 3) {
          if (put('table', x, y, FACE.S)) {
            put('chair', x - 1, y, FACE.E);
            put('chair', x + 1, y, FACE.W);
          }
        }
      }
      put('plant', x1, y1, FACE.S, false);
    } else {
      for (let x = x0; x <= x1; x++) put('shelf', x, y0, FACE.S);
    }
  }

  roomConnected(r) {
    const cells = [];
    for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) if (!this.solid[y][x]) cells.push([x, y]);
    if (cells.length <= 1) return true;
    const seen = new Set();
    const stack = [cells[0]];
    seen.add(cells[0][0] + ',' + cells[0][1]);
    while (stack.length) {
      const [x, y] = stack.pop();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < r.x0 || nx > r.x1 || ny < r.y0 || ny > r.y1) continue;
        if (this.solid[ny][nx] || seen.has(nx + ',' + ny)) continue;
        seen.add(nx + ',' + ny);
        stack.push([nx, ny]);
      }
    }
    return seen.size === cells.length;
  }

  addSidewalks() {
    for (let pass = 0; pass < 2; pass++) {
      const snap = this.type.map((r) => r.slice());
      const add = [];
      for (let y = 0; y < ROWS; y++) {
        for (let x = 0; x < COLS; x++) {
          if (snap[y][x] !== T.GRASS) continue;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = x + dx;
            const ny = y + dy;
            if (this.inb(nx, ny) && (snap[ny][nx] === T.ROAD || snap[ny][nx] === T.BUILDING || snap[ny][nx] === T.SIDEWALK)) {
              add.push([x, y]);
              break;
            }
          }
        }
      }
      for (const [x, y] of add) this.type[y][x] = T.SIDEWALK;
    }
  }

  outdoor() {
    // --- fountain plaza: fountain centre, benches facing it, planters at the corners ---
    const fx = 25;
    const fy = 45;
    this.addProp('fountain', fx, fy, true);
    this.addProp('bench', fx, fy - 3, true, FACE.S);
    this.addProp('bench', fx, fy + 3, true, FACE.N);
    this.addProp('bench', fx - 3, fy, true, FACE.E);
    this.addProp('bench', fx + 3, fy, true, FACE.W);
    for (const [dx, dy] of [[-3, -3], [3, -3], [-3, 3], [3, 3]]) this.addProp('planter', fx + dx, fy + dy, true);

    // --- orderly street furniture on a lattice over open sidewalk cells ---
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        if (this.type[y][x] !== T.SIDEWALK || this.solid[y][x]) continue;
        let open = 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx;
          const ny = y + dy;
          if (this.inb(nx, ny) && !this.solid[ny][nx] && this.type[ny][nx] < 6) open++;
        }
        if (open < 3) continue;
        if (x % 7 === 3 && y % 5 === 2) this.addProp('streetlight', x, y, true);
        else if (x % 6 === 0 && y % 6 === 3) this.addProp('tree', x, y, true);
        else if (x % 11 === 5 && y % 7 === 4) this.addProp('planter', x, y, true);
        else if (x % 13 === 8 && y % 9 === 6) this.addProp('hydrant', x, y, true);
      }
    }

    // --- parked cars on the roads ---
    this.addProp('car', 35, 33, true, FACE.S);
    this.addProp('car', 35, 9, true, FACE.N);
    this.addProp('car', 8, 25, true, FACE.E);
  }
  addProp(type, tx, ty, solid = true, rot = 0) {
    this.props.push({ type, tx, ty, rot });
    if (solid && this.inb(tx, ty)) this.solid[ty][tx] = true;
  }

  placeSpawns() {
    const rng = makeRng(777);
    const rooms = this.rooms.slice();
    for (let i = rooms.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [rooms[i], rooms[j]] = [rooms[j], rooms[i]];
    }
    let idx = 0;
    const nextRoom = () => {
      while (idx < rooms.length) {
        const r = rooms[idx++];
        if (!this.solid[r.cy][r.cx]) return r;
      }
      return null;
    };

    // every weapon type appears multiple times so variety is guaranteed
    const weapons = ['pistol', 'pistol', 'pistol', 'shotgun', 'shotgun', 'uzi', 'uzi', 'rifle', 'rifle', 'sniper', 'sniper', 'bat', 'bat', 'katana', 'katana'];
    for (const w of weapons) {
      const r = nextRoom();
      const cell = r ? { tx: r.cx, ty: r.cy } : this.findFree(35, 24);
      this.weaponSpawns.push({ weapon: w, tx: cell.tx, ty: cell.ty, x: (cell.tx + 0.5) * TILE, y: (cell.ty + 0.5) * TILE });
    }
    for (const [w, tx, ty] of [['pistol', 35, 10], ['uzi', 35, 38], ['shotgun', 8, 25]]) {
      const f = this.findFree(tx, ty);
      this.weaponSpawns.push({ weapon: w, tx: f.tx, ty: f.ty, x: (f.tx + 0.5) * TILE, y: (f.ty + 0.5) * TILE });
    }

    while (idx < rooms.length && this.playerSpawns.length < 10) {
      const r = rooms[idx++];
      if (!this.solid[r.cy][r.cx]) this.playerSpawns.push({ x: (r.cx + 0.5) * TILE, y: (r.cy + 0.5) * TILE });
    }
    for (const [tx, ty] of [[35, 2], [35, 50], [2, 25], [69, 25], [35, 25], [25, 45]]) {
      const f = this.findFree(tx, ty);
      this.playerSpawns.push({ x: (f.tx + 0.5) * TILE, y: (f.ty + 0.5) * TILE });
    }
  }

  findFree(tx, ty) {
    for (let r = 0; r < 10; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const x = tx + dx;
          const y = ty + dy;
          if (this.inb(x, y) && !this.solid[y][x]) return { tx: x, ty: y };
        }
      }
    }
    return { tx, ty };
  }

  // Flood fill from a seed tile over all non-solid cells (used to validate).
  reachable(sx, sy) {
    const seen = new Set();
    if (!this.inb(sx, sy) || this.solid[sy][sx]) return seen;
    const stack = [[sx, sy]];
    seen.add(sx + ',' + sy);
    while (stack.length) {
      const [x, y] = stack.pop();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (!this.inb(nx, ny) || this.solid[ny][nx] || seen.has(nx + ',' + ny)) continue;
        seen.add(nx + ',' + ny);
        stack.push([nx, ny]);
      }
    }
    return seen;
  }

  // ---- collision API ---------------------------------------------------
  isSolidTile(tx, ty) {
    // `!(>=0)` also rejects NaN, so a bad coordinate is treated as solid rather than throwing.
    if (!(tx >= 0) || !(ty >= 0) || tx >= this.cols || ty >= this.rows) return true;
    return this.solid[ty][tx];
  }

  resolveCircle(x, y, r) {
    for (let iter = 0; iter < 2; iter++) {
      const minTX = Math.floor((x - r) / TILE);
      const maxTX = Math.floor((x + r) / TILE);
      const minTY = Math.floor((y - r) / TILE);
      const maxTY = Math.floor((y + r) / TILE);
      for (let ty = minTY; ty <= maxTY; ty++) {
        for (let tx = minTX; tx <= maxTX; tx++) {
          if (!this.isSolidTile(tx, ty)) continue;
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

  raycast(x, y, ang, maxDist) {
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    let tx = Math.floor(x / TILE);
    let ty = Math.floor(y / TILE);
    if (this.isSolidTile(tx, ty)) return 0;
    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    const tDeltaX = dx !== 0 ? Math.abs(TILE / dx) : Infinity;
    const tDeltaY = dy !== 0 ? Math.abs(TILE / dy) : Infinity;
    const nextX = dx > 0 ? (tx + 1) * TILE : tx * TILE;
    const nextY = dy > 0 ? (ty + 1) * TILE : ty * TILE;
    let tMaxX = dx !== 0 ? Math.abs((nextX - x) / dx) : Infinity;
    let tMaxY = dy !== 0 ? Math.abs((nextY - y) / dy) : Infinity;
    let dist = 0;
    while (dist <= maxDist) {
      if (tMaxX < tMaxY) {
        dist = tMaxX;
        tMaxX += tDeltaX;
        tx += stepX;
      } else {
        dist = tMaxY;
        tMaxY += tDeltaY;
        ty += stepY;
      }
      if (this.isSolidTile(tx, ty)) return Math.min(dist, maxDist);
    }
    return maxDist;
  }

  lineClear(x0, y0, x1, y1) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 1e-3) return true;
    return this.raycast(x0, y0, Math.atan2(dy, dx), len) >= len - 0.001;
  }

  pickSpawn(players) {
    let best = null;
    let bestScore = -1;
    for (const s of this.playerSpawns) {
      let nearest = Infinity;
      for (const p of players) {
        if (p.dead) continue;
        const d = dist2(s.x, s.y, p.x, p.y);
        if (d < nearest) nearest = d;
      }
      const score = nearest === Infinity ? Math.random() * 1e9 : nearest + Math.random() * 40000;
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    return best || { x: this.w / 2, y: this.h / 2 };
  }

  typeStrings() {
    return this.type.map((row) => row.join(''));
  }
}

module.exports = { GameMap };
