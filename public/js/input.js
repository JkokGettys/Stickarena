// Keyboard + mouse input → {u,d,l,r,a,f} packets.

const moves = { up: false, down: false, left: false, right: false };
let mouseX = window.innerWidth / 2;
let mouseY = window.innerHeight / 2;
let mouseFire = false;
let spaceFire = false;
let active = false;

function isTyping() {
  const el = document.activeElement;
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
}

function setMove(key, val) {
  switch (key) {
    case 'w':
    case 'arrowup':
      moves.up = val;
      return true;
    case 's':
    case 'arrowdown':
      moves.down = val;
      return true;
    case 'a':
    case 'arrowleft':
      moves.left = val;
      return true;
    case 'd':
    case 'arrowright':
      moves.right = val;
      return true;
  }
  return false;
}

function clearKeys() {
  moves.up = moves.down = moves.left = moves.right = false;
  mouseFire = spaceFire = false;
}

export function init() {
  window.addEventListener('keydown', (e) => {
    if (isTyping() || !active) return;
    const k = e.key.toLowerCase();
    if (k === ' ') {
      spaceFire = true;
      e.preventDefault();
      return;
    }
    if (setMove(k, true)) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (k === ' ') spaceFire = false;
    setMove(k, false);
  });
  window.addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
  });
  window.addEventListener('mousedown', (e) => {
    if (e.button === 0 && active) mouseFire = true;
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button === 0) mouseFire = false;
  });
  window.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('blur', clearKeys);
}

export function setActive(v) {
  active = v;
  if (!v) clearKeys();
  // Hide the OS cursor while playing (canvas draws its own crosshair); show it
  // again on menus / the end screen so vote buttons are clickable.
  document.body.style.cursor = v ? 'none' : 'auto';
}
export function getAim() {
  return Math.atan2(mouseY - window.innerHeight / 2, mouseX - window.innerWidth / 2);
}
export function getMouse() {
  return { x: mouseX, y: mouseY };
}
export function getInput() {
  return {
    u: moves.up,
    d: moves.down,
    l: moves.left,
    r: moves.right,
    a: getAim(),
    f: active && (mouseFire || spaceFire),
  };
}
