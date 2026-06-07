// End-screen overlay: map voting (top) + match-summary leaderboard (K/D/ratio).
// Driven each frame from intermission snapshots; the structure is built once and
// patched in place so the vote buttons keep their click handlers.

let root = null;
let voteRow = null;
let tbody = null;
let countdownEl = null;
let maps = [];
let onVote = null;
let visible = false;
const voteButtons = {};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function init(mapsMenu, voteCb) {
  maps = mapsMenu || [];
  onVote = voteCb;
  root = document.getElementById('endscreen');
  voteRow = document.getElementById('vote-row');
  tbody = document.getElementById('standings-body');
  countdownEl = document.getElementById('end-countdown');
  buildVoteButtons();
}

function buildVoteButtons() {
  if (!voteRow) return;
  voteRow.innerHTML = '';
  for (const k of Object.keys(voteButtons)) delete voteButtons[k];
  for (const m of maps) {
    const btn = document.createElement('button');
    btn.className = 'vote-btn';
    btn.type = 'button';
    btn.innerHTML =
      `<span class="vote-name">${escapeHtml(m.name)}</span>` +
      `<span class="vote-size">${m.cols}×${m.rows}</span>` +
      `<span class="vote-count">0</span>`;
    btn.addEventListener('click', () => onVote && onVote(m.id));
    voteRow.appendChild(btn);
    voteButtons[m.id] = btn;
  }
}

export function show() {
  if (!root || visible) return;
  visible = true;
  root.classList.remove('hidden');
}

export function hide() {
  if (!root || !visible) return;
  visible = false;
  root.classList.add('hidden');
}

export function update(data) {
  if (!root) return;
  // countdown to the next match
  if (countdownEl) countdownEl.textContent = `Next match in ${Math.max(0, Math.ceil(data.timeLeft || 0))}s`;

  // live vote tallies — highlight the current leader and the player's own pick
  const votes = data.votes || {};
  let leader = null;
  let leaderN = 0;
  for (const m of maps) {
    const c = votes[m.id] || 0;
    if (c > leaderN) {
      leaderN = c;
      leader = m.id;
    }
  }
  for (const m of maps) {
    const btn = voteButtons[m.id];
    if (!btn) continue;
    btn.querySelector('.vote-count').textContent = votes[m.id] || 0;
    btn.classList.toggle('leader', leaderN > 0 && m.id === leader);
    btn.classList.toggle('mine', data.myVote === m.id);
  }

  // standings (frozen for the intermission; cheap to repaint)
  const standings = data.standings || [];
  let html = '';
  standings.forEach((p, i) => {
    const kd = (p.f / Math.max(1, p.d)).toFixed(2);
    const cls = `${p.id === data.selfId ? 'self ' : ''}${p.bot ? 'bot' : ''}`.trim();
    html +=
      `<tr${cls ? ` class="${cls}"` : ''}>` +
      `<td class="rk">${i + 1}</td>` +
      `<td class="nm">${escapeHtml(p.n)}</td>` +
      `<td>${p.f}</td><td>${p.d}</td><td class="kd">${kd}</td></tr>`;
  });
  if (tbody) tbody.innerHTML = html;
}
