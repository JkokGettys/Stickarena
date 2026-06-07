// Orchestration: connect, manage start/playing phases, pump input, render loop.

import * as net from './net.js';
import * as input from './input.js';
import * as render from './render.js';
import * as predict from './predict.js';
import * as endscreen from './endscreen.js';

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
  render.setMap(msg.map);
  predict.setMap(msg.map);
  render.loadAssets(msg.assets);
  endscreen.init(msg.maps, (mapId) => net.send({ t: 'vote', m: mapId }));
  configReady = true;
  playBtn.disabled = false;
  statusEl.classList.remove('err');
  if (phase === 'playing' && selfName) {
    // reconnected mid-game — resume automatically without the menu (input + the
    // end-screen overlay are driven each frame by the server match phase below)
    net.spawn(selfName);
    startScreen.classList.add('hidden');
  } else {
    statusEl.textContent = 'Connected — ready to play';
  }
});
// A new match swapped the map: rebuild render + prediction before the next
// snapshot (which carries the new map's positions) arrives.
net.on('mapchange', (mapPayload) => {
  render.setMap(mapPayload);
  predict.setMap(mapPayload);
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
  setInputActive(false);
  endscreen.hide();
  startScreen.classList.remove('hidden');
  statusEl.classList.add('err');
  statusEl.textContent = phase === 'playing' ? 'Connection lost — reconnecting…' : 'Disconnected — reconnecting…';
});

// Input activation is idempotent-tracked so the frame loop can assert it cheaply.
let inputActive = false;
function setInputActive(v) {
  if (v === inputActive) return;
  inputActive = v;
  input.setActive(v);
}

function play() {
  if (!configReady) return;
  selfName = (nameInput.value || '').trim() || randomName();
  startScreen.classList.add('hidden');
  net.spawn(selfName);
  phase = 'playing'; // input + overlay are toggled by the frame loop from server phase
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

    const view = net.sample();
    const connected = net.isConnected();
    const serverPhase = view && view.phase ? view.phase : 'playing';
    const inMatch = phase === 'playing' && connected;
    const playing = inMatch && serverPhase === 'playing';

    // Drive input + the end-screen overlay from the authoritative match phase.
    setInputActive(playing);
    if (inMatch && serverPhase === 'intermission' && view) {
      endscreen.show();
      endscreen.update({
        standings: view.standings,
        votes: view.votes,
        myVote: view.vote,
        timeLeft: view.timeLeft,
        selfId: net.getSelfId(),
      });
    } else {
      endscreen.hide();
    }

    // Integrate local prediction at the display refresh rate for smooth motion
    // (only while actually fighting — the world is frozen during intermission).
    if (playing) predict.advance(input.getInput(), dt / 1000);

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
