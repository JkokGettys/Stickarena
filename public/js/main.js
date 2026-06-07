// Orchestration: connect, manage start/playing phases, pump input, render loop.

import * as net from './net.js';
import * as input from './input.js';
import * as render from './render.js';
import * as predict from './predict.js';

const SEND_RATE = 30;
let inputSeq = 0;

const startScreen = document.getElementById('start');
const nameInput = document.getElementById('name');
const playBtn = document.getElementById('play');
const statusEl = document.getElementById('status');
const canvas = document.getElementById('game');

let phase = 'start';
let configReady = false;
let selfName = '';
let lastFrame = performance.now();
let fps = 0;

const RANDOM = ['Slick', 'Dash', 'Nova', 'Spike', 'Zip', 'Ace', 'Bolt'];
function randomName() {
  return RANDOM[Math.floor(Math.random() * RANDOM.length)] + Math.floor(Math.random() * 100);
}

render.init(canvas);
render.setNet(net);
input.init();

net.on('config', (msg) => {
  render.setConfig(msg);
  predict.setConfig(msg);
  render.loadAssets(msg.assets);
  configReady = true;
  playBtn.disabled = false;
  statusEl.classList.remove('err');
  if (phase === 'playing' && selfName) {
    // reconnected mid-game — resume automatically without the menu
    net.spawn(selfName);
    input.setActive(true);
    startScreen.classList.add('hidden');
  } else {
    statusEl.textContent = 'Connected — ready to play';
  }
});
net.on('spawned', () => {
  predict.reset(); // start fresh prediction for the new life
});
net.on('open', () => {
  if (phase !== 'playing') statusEl.textContent = 'Connected';
});
net.on('close', () => {
  configReady = false;
  playBtn.disabled = true;
  input.setActive(false);
  startScreen.classList.remove('hidden');
  statusEl.classList.add('err');
  statusEl.textContent = phase === 'playing' ? 'Connection lost — reconnecting…' : 'Disconnected — reconnecting…';
});

function play() {
  if (!configReady) return;
  selfName = (nameInput.value || '').trim() || randomName();
  startScreen.classList.add('hidden');
  net.spawn(selfName);
  input.setActive(true);
  phase = 'playing';
}

playBtn.addEventListener('click', play);
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') play();
});

setInterval(() => {
  if (phase === 'playing' && net.isConnected()) {
    const inp = input.getInput();
    const seq = ++inputSeq;
    net.send({ t: 'input', ...inp, seq });
    predict.recordSent(seq, inp); // remember for reconciliation; motion is integrated per-frame
  }
}, 1000 / SEND_RATE);

function frame() {
  try {
    const now = performance.now();
    const dt = now - lastFrame;
    lastFrame = now;
    fps = fps * 0.9 + (1000 / Math.max(1, dt)) * 0.1;

    // Integrate local prediction at the display refresh rate for smooth motion.
    if (phase === 'playing') predict.advance(input.getInput(), dt / 1000);

    const view = net.sample();
    // Replace the interpolated (laggy) self position with the locally predicted
    // one so your own movement responds instantly. Other entities stay interpolated.
    const pred = predict.getState();
    if (view && view.self && pred) {
      view.self = { ...view.self, x: pred.x, y: pred.y };
    }

    render.draw(view, {
      selfId: net.getSelfId(),
      selfName,
      localAim: input.getAim(),
      mouse: input.getMouse(),
      fps,
    });
  } catch (e) {
    console.error('[frame]', e && e.stack ? e.stack : e);
  }
  requestAnimationFrame(frame); // keep the loop alive even if a frame throws
}

playBtn.disabled = true;
nameInput.focus();
net.connect();
requestAnimationFrame(frame);
