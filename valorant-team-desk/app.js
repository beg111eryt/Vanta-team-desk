"use strict";

let STORAGE_KEY = "vanta-team-desk-v2";
let LEGACY_STORAGE_KEY = "vanta-team-desk-v1";
const STORAGE_KEY_PREFIX = "vanta-team-desk-v2-team-";
const FOCUS_AREAS = ["Communication", "Utility", "Trading", "Economy", "Positioning", "Composure"];
const MAPS = ["Ascent", "Bind", "Breeze", "Fracture", "Haven", "Icebox", "Lotus", "Pearl", "Split", "Sunset", "Other"];
const MATCH_FORMATS = ["Single map", "BO1", "BO2", "BO3", "BO5"];
const PHASES = ["Pistol", "Anti-eco", "Default", "Execute", "Retake", "Post-plant", "Other"];
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const VIEW_TITLES = { dashboard: "Overview", live: "Live scrim", players: "Players", availability: "Availability", matches: "Match log", playbook: "Playbook", review: "Team review", roster: "Team roster", coach: "Coach hub", chat: "Team chats" };

const dom = {
  nav: [...document.querySelectorAll(".nav-item")],
  views: [...document.querySelectorAll(".view")],
  section: document.querySelector("#current-section"),
  matchCount: document.querySelector("#match-count"),
  playCount: document.querySelector("#play-count"),
  stats: document.querySelector("#dashboard-stats"),
  recent: document.querySelector("#recent-matches"),
  focusSummary: document.querySelector("#focus-summary"),
  playPreview: document.querySelector("#play-preview"),
  matchList: document.querySelector("#match-list"),
  matchTotal: document.querySelector("#match-total"),
  livePanel: document.querySelector("#live-panel"),
  playersPanel: document.querySelector("#players-panel"),
  availabilityPanel: document.querySelector("#availability-panel"),
  playbookList: document.querySelector("#playbook-list"),
  review: document.querySelector("#review-content"),
  modal: document.querySelector("#modal-backdrop"),
  modalContent: document.querySelector("#modal-content"),
  toastRegion: document.querySelector("#toast-region"),
  appShell: document.querySelector("#app-shell")
};

function emptyWorkspace() {
  return {
    version: 3,
    matches: [],
    plays: [],
    players: [],
    availability: {},
    liveSession: null,
    settings: { theme: "ember", font: "system", fontSize: "standard" }
  };
}

function isValidPlayer(player) {
  return player && typeof player.id === "string" && typeof player.name === "string" &&
    typeof player.role === "string" && typeof player.rank === "string" &&
    typeof player.agents === "string" && typeof player.goal === "string" &&
    typeof player.notes === "string" && player.name.length <= 40 && player.rank.length <= 32 &&
    player.agents.length <= 120 && player.goal.length <= 140 && player.notes.length <= 500;
}

function isValidLiveSession(session) {
  return session && typeof session.id === "string" && typeof session.startedAt === "string" &&
    typeof session.opponent === "string" && typeof session.map === "string" &&
    Number.isInteger(session.round) && session.round >= 1 &&
    Number.isInteger(session.scoreFor) && session.scoreFor >= 0 &&
    Number.isInteger(session.scoreAgainst) && session.scoreAgainst >= 0;
}

function normalizeLiveSession(session) {
  if (!isValidLiveSession(session)) return null;
  return {
    id: session.id,
    startedAt: session.startedAt,
    opponent: session.opponent,
    map: session.map,
    side: typeof session.side === "string" ? session.side : "",
    focus: typeof session.focus === "string" ? session.focus : "",
    notes: typeof session.notes === "string" ? session.notes : "",
    round: session.round,
    scoreFor: session.scoreFor,
    scoreAgainst: session.scoreAgainst
  };
}

function normalizeSettings(settings) {
  const themes = ["ember", "ocean", "forest", "violet", "light"];
  const fonts = ["system", "rounded", "serif", "mono"];
  const fontSizes = ["compact", "standard", "large"];
  return {
    theme: themes.includes(settings?.theme) ? settings.theme : "ember",
    font: fonts.includes(settings?.font) ? settings.font : "system",
    fontSize: fontSizes.includes(settings?.fontSize) ? settings.fontSize : "standard"
  };
}

function loadWorkspace(saved = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY)) {
  try {
    if (!saved) return emptyWorkspace();
    const parsed = JSON.parse(saved);
    if (![1, 2, 3].includes(parsed?.version) || !Array.isArray(parsed.matches) || !Array.isArray(parsed.plays)) {
      throw new Error("Saved workspace format is not supported.");
    }
    const players = Array.isArray(parsed.players) ? parsed.players.filter(isValidPlayer) : [];
    const availability = {};
    if (parsed.availability && typeof parsed.availability === "object" && !Array.isArray(parsed.availability)) {
      for (const player of players) {
        const slots = parsed.availability[player.id];
        availability[player.id] = Array.isArray(slots)
          ? Array.from({ length: 168 }, (_, index) => slots[index] === true)
          : Array(168).fill(false);
      }
    }
    const liveSession = normalizeLiveSession(parsed.liveSession);
    return {
      version: 3,
      matches: parsed.matches.filter(isValidMatch).map(match => {
        const cleanMatch = { ...match };
        delete cleanMatch.playerStats;
        return { ...cleanMatch, format: cleanMatch.format || "Single map" };
      }),
      plays: parsed.plays.filter(isValidPlay),
      players,
      availability,
      liveSession,
      settings: normalizeSettings(parsed.settings)
    };
  } catch (error) {
    console.error("Unable to load the saved workspace.", error);
    return emptyWorkspace();
  }
}

let workspace = emptyWorkspace();
let activeFilter = "all";
let editingPlayId = null;
let editingPlayerId = null;
let availabilityPlayerId = "";
let liveClockTimer = null;
function saveWorkspace() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace));
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    document.querySelector("#save-label").textContent = "Saved on this device";
  } catch (error) {
    console.error("Unable to save the local workspace.", error);
    showToast("Couldn't save your workspace on this device.", "error");
  }
}

function showApp() {
  dom.appShell.hidden = false;
  document.querySelector("#save-label").textContent = "Saved on this device";
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function isValidMatch(match) {
  return match && typeof match.id === "string" && typeof match.date === "string" &&
    typeof match.opponent === "string" && typeof match.map === "string" &&
    (!match.format || MATCH_FORMATS.includes(match.format)) &&
    ["win", "loss", "draw"].includes(match.result) &&
    Number.isInteger(match.scoreFor) && Number.isInteger(match.scoreAgainst) &&
    match.scoreFor >= 0 && match.scoreAgainst >= 0 &&
    typeof match.notes === "string" && typeof match.focus === "string";
}

function isValidPlay(play) {
  return play && typeof play.id === "string" && typeof play.title === "string" &&
    typeof play.map === "string" && typeof play.side === "string" &&
    typeof play.phase === "string" && typeof play.description === "string" &&
    typeof play.agents === "string";
}

function formatDate(dateString) {
  const date = new Date(`${dateString}T12:00:00`);
  return Number.isNaN(date.getTime()) ? "Date not set" : new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", year: "numeric"
  }).format(date);
}

function localDateISO(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function navigate(viewName) {
  if (!VIEW_TITLES[viewName]) return;
  dom.nav.forEach(button => button.classList.toggle("active", button.dataset.view === viewName));
  dom.views.forEach(view => view.classList.toggle("active", view.id === `view-${viewName}`));
  dom.section.textContent = VIEW_TITLES[viewName];
  if (viewName === "matches") renderMatches();
  if (viewName === "live") renderLivePanel();
  if (viewName === "players") renderPlayers();
  if (viewName === "availability") renderAvailability();
  if (viewName === "playbook") renderPlaybook();
  if (viewName === "review") renderReview();
  if (viewName === "dashboard" || viewName === "review") renderDashboard();
  if (["roster", "coach", "chat"].includes(viewName)) window.vantaTeam?.render(viewName);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function setWorkspaceScope(teamId) {
  const scopedKey = `${STORAGE_KEY_PREFIX}${teamId}`;
  const scopedValue = localStorage.getItem(scopedKey);
  const oldValue = localStorage.getItem("vanta-team-desk-v2") || localStorage.getItem("vanta-team-desk-v1");
  STORAGE_KEY = scopedKey;
  LEGACY_STORAGE_KEY = `${scopedKey}-legacy`;
  workspace = loadWorkspace(scopedValue || (oldValue && !scopedValue ? oldValue : null));
  if (!scopedValue && oldValue) {
    localStorage.removeItem("vanta-team-desk-v2");
    localStorage.removeItem("vanta-team-desk-v1");
    saveWorkspace();
  }
}

function showToast(message, type = "success") {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  if (type === "error") toast.style.borderLeftColor = "var(--accent)";
  dom.toastRegion.append(toast);
  window.setTimeout(() => toast.remove(), 3300);
}

function emptyState(icon, title, copy, actionLabel, action) {
  const button = actionLabel
    ? `<button class="button button-quiet empty-action" data-action="${action}" type="button">${escapeHTML(actionLabel)}</button>`
    : "";
  return `<div class="empty-state"><span class="empty-icon">${escapeHTML(icon)}</span><strong>${escapeHTML(title)}</strong><p>${escapeHTML(copy)}</p>${button}</div>`;
}

function renderDashboard() {
  const matches = [...workspace.matches].sort((a, b) => b.date.localeCompare(a.date));
  const wins = matches.filter(match => match.result === "win").length;
  const losses = matches.filter(match => match.result === "loss").length;
  const draws = matches.filter(match => match.result === "draw").length;
  const winRate = matches.length ? `${Math.round((wins / matches.length) * 100)}%` : "—";
  const series = matches.filter(match => match.format && match.format !== "Single map");
  const seriesMapsWon = series.reduce((total, match) => total + match.scoreFor, 0);
  const seriesMapsLost = series.reduce((total, match) => total + match.scoreAgainst, 0);
  const recent = matches.slice(0, 5);
  const focusCounts = countFocusAreas(matches);
  const mostPracticed = Object.entries(focusCounts).sort((a, b) => b[1] - a[1])[0];

  const stats = [
    { label: "MATCHES LOGGED", value: matches.length, caption: matches.length ? "Results in your team log" : "Start your scrim history", mark: "▤" },
    { label: "WIN RATE", value: winRate, caption: matches.length ? `${wins}W · ${draws}D · ${losses}L` : "Based on logged matches", mark: "↗" },
    { label: "SERIES MAP RECORD", value: series.length ? `${seriesMapsWon}–${seriesMapsLost}` : "—", caption: series.length ? `Across ${series.length} best-of series` : "Log a BO1, BO2, BO3, or BO5", mark: "◎" },
    { label: "TOP PRACTICE FOCUS", value: mostPracticed?.[1] ? mostPracticed[0] : "Choose one", caption: mostPracticed?.[1] ? `${mostPracticed[1]} match${mostPracticed[1] === 1 ? "" : "es"}` : "Log a match to track focus", mark: "✳" }
  ];
  dom.stats.innerHTML = stats.map(stat => `
    <article class="stat-card">
      <div class="stat-topline"><span>${escapeHTML(stat.label)}</span><span class="stat-mark">${escapeHTML(stat.mark)}</span></div>
      <div class="stat-value">${escapeHTML(stat.value)}</div>
      <div class="stat-caption">${escapeHTML(stat.caption)}</div>
    </article>`).join("");

  dom.recent.innerHTML = recent.length ? recent.map(match => `
    <div class="recent-row">
      <span class="result-badge ${match.result}">${resultLetter(match.result)}</span>
      <div class="recent-match-copy"><strong>${escapeHTML(match.opponent)} <span class="muted-dot">·</span> ${escapeHTML(match.map)}</strong><small>${escapeHTML(match.format || "Single map")} · ${escapeHTML(formatDate(match.date))}</small></div>
      <span class="recent-score">${match.scoreFor} : ${match.scoreAgainst}</span>
    </div>`).join("") : emptyState("＋", "Your first match starts here", "Log a scrim result and one takeaway to begin building a useful team history.", "Log a match", "add-match");

  if (!matches.length) {
    dom.focusSummary.innerHTML = `<div class="focus-content"><h3 class="focus-summary-title">Pick one thing to improve.</h3><p class="focus-summary-copy">After each match, note the team's main practice focus. Over time, this helps you review where your attention has been going.</p></div>`;
  } else {
    const topFocuses = Object.entries(focusCounts).sort((a, b) => b[1] - a[1]).slice(0, 4);
    dom.focusSummary.innerHTML = `<div class="focus-content"><h3 class="focus-summary-title">${escapeHTML(mostPracticed?.[0] || "Keep exploring")}</h3><p class="focus-summary-copy">Your most logged focus across ${matches.length} match${matches.length === 1 ? "" : "es"}. The review page breaks down outcomes by focus.</p><div class="focus-progress">${topFocuses.map(([focus, count]) => `
      <div class="focus-progress-row"><span>${escapeHTML(focus)}</span><span class="progress-track"><span class="progress-fill" style="width:${Math.max(8, Math.round(count / matches.length * 100))}%"></span></span><small>${count}</small></div>`).join("")}</div></div>`;
  }
  const plays = workspace.plays.slice(0, 2);
  dom.playPreview.innerHTML = plays.length ? plays.map(play => `
    <div class="play-preview-card"><span class="play-icon">⌘</span><div><strong>${escapeHTML(play.title)}</strong><small>${escapeHTML(play.map)} · ${escapeHTML(play.side)} · ${escapeHTML(play.phase)}</small></div></div>`).join("") : emptyState("⌘", "Capture a team play", "Keep your best setups and round plans somewhere everyone can find them.", "Add a play", "add-play");
  dom.matchCount.textContent = matches.length;
  dom.playCount.textContent = workspace.plays.length;
}

function countFocusAreas(matches) {
  return matches.reduce((counts, match) => {
    if (FOCUS_AREAS.includes(match.focus)) counts[match.focus] = (counts[match.focus] || 0) + 1;
    return counts;
  }, {});
}

function renderPlayers() {
  const container = dom.playersPanel;
  document.querySelector("#player-count").textContent = workspace.players.length;
  if (!workspace.players.length) {
    container.innerHTML = emptyState("♙", "Add the team", "Create a profile for every player to keep roles, goals, notes, and schedules in one place.", "Add first player", "add-player");
    return;
  }
  container.innerHTML = workspace.players.map(player => {
    return `<article class="player-card">
      <div class="player-card-head"><span class="player-avatar">${escapeHTML([...player.name][0]?.toUpperCase() || "?")}</span>
        <div class="player-card-name"><h2>${escapeHTML(player.name)}</h2><p>${escapeHTML(player.role || "Role not set")}${player.rank ? ` · ${escapeHTML(player.rank)}` : ""}</p></div>
        <div class="card-actions"><button data-edit-player="${escapeHTML(player.id)}" type="button">Edit</button><button data-delete-player="${escapeHTML(player.id)}" type="button">Remove</button></div>
      </div>
      <div class="player-agent-list">${player.agents ? escapeHTML(player.agents) : "No agents listed"}</div>
      ${player.goal ? `<div class="player-note"><small>CURRENT FOCUS</small><p>${escapeHTML(player.goal)}</p></div>` : ""}
      ${player.notes ? `<div class="player-note"><small>NOTES</small><p>${escapeHTML(player.notes)}</p></div>` : ""}
      <button class="text-button" data-edit-availability="${escapeHTML(player.id)}" type="button">Set availability →</button>
    </article>`;
  }).join("");
}

function renderAvailability() {
  if (window.vantaTeam?.renderAvailability) {
    window.vantaTeam.renderAvailability();
    return;
  }
  const container = dom.availabilityPanel;
  if (!workspace.players.length) {
    container.innerHTML = emptyState("▦", "Add player profiles first", "The weekly planner uses profiles to keep each player's schedule separate.", "Add a player", "add-player");
    return;
  }
  if (!workspace.players.some(player => player.id === availabilityPlayerId)) availabilityPlayerId = workspace.players[0].id;
  const selectedPlayer = workspace.players.find(player => player.id === availabilityPlayerId);
  const slots = workspace.availability[availabilityPlayerId] || Array(168).fill(false);
  const playerOptions = workspace.players.map(player => `<option value="${escapeHTML(player.id)}" ${player.id === availabilityPlayerId ? "selected" : ""}>${escapeHTML(player.name)}</option>`).join("");
  const dayHeads = DAYS.map(day => `<th scope="col">${escapeHTML(day.slice(0, 3))}</th>`).join("");
  const rows = Array.from({ length: 24 }, (_, hour) => `<tr><th scope="row">${String(hour).padStart(2, "0")}:00</th>${DAYS.map((day, dayIndex) => {
    const slot = dayIndex * 24 + hour;
    const count = workspace.players.reduce((sum, player) => sum + (workspace.availability[player.id]?.[slot] ? 1 : 0), 0);
    const active = slots[slot];
    return `<td><button class="availability-slot ${active ? "available" : ""} ${count ? `team-count-${Math.min(count, 5)}` : ""}" data-slot="${slot}" type="button" aria-label="${escapeHTML(day)} ${String(hour).padStart(2, "0")}:00 ${active ? "available" : "unavailable"}; ${count} of ${workspace.players.length} available" aria-pressed="${active}">${count ? `<span>${count}</span>` : ""}</button></td>`;
  }).join("")}</tr>`).join("");
  const totals = workspace.players.map(player => {
    const count = (workspace.availability[player.id] || []).filter(Boolean).length;
    return `<span class="tag">${escapeHTML(player.name)} · ${count}h</span>`;
  }).join("");
  const bestWindows = DAYS.flatMap((day, dayIndex) => Array.from({ length: 24 }, (_, hour) => ({
    day,
    hour,
    count: workspace.players.reduce((sum, player) => sum + (workspace.availability[player.id]?.[dayIndex * 24 + hour] ? 1 : 0), 0)
  })).filter(slot => slot.count === workspace.players.length));
  const commonTimes = bestWindows.slice(0, 8).map(slot => `<span class="tag">${escapeHTML(slot.day.slice(0, 3))} ${String(slot.hour).padStart(2, "0")}:00</span>`).join("");
  container.innerHTML = `<section class="panel availability-panel">
    <div class="availability-tools"><label class="form-field"><span>Editing availability for</span><select id="availability-player" class="select-control">${playerOptions}</select></label><p class="form-hint">Click an hour to toggle it. Times use your computer's local time; schedules repeat weekly.</p></div>
    <div class="availability-key"><span><i class="availability-key-box selected"></i>${escapeHTML(selectedPlayer.name)} is available</span><span><i class="availability-key-box"></i>Not marked</span><span>Numbers show how many teammates are free</span></div>
    <div class="availability-scroll"><table class="availability-table"><thead><tr><th scope="col">Time</th>${dayHeads}</tr></thead><tbody>${rows}</tbody></table></div>
    <div class="availability-summary"><strong>Hours marked available</strong><div>${totals}</div></div>
    <div class="availability-summary"><strong>Times everyone is marked free</strong><div>${commonTimes || `<span class="form-hint">No full-team overlap marked yet.</span>`}</div></div>
  </section>`;
}

function renderLivePanel() {
  document.querySelector("#live-indicator").textContent = workspace.liveSession ? "LIVE" : "";
  const container = dom.livePanel;
  const session = workspace.liveSession;
  if (!session) {
    container.innerHTML = `<section class="panel live-empty-panel"><span class="live-status"><i></i> READY WHEN YOU ARE</span><h2>Start tracking a scrim</h2><p>Choose the map and opponent, track the round score, and save a team takeaway. This tracker saves on this device and can be resumed if you close the app.</p><button class="button button-primary" data-start-live type="button">Set up scrim</button></section>`;
    return;
  }
  const duration = Math.max(0, Math.floor((Date.now() - new Date(session.startedAt).getTime()) / 1000));
  const elapsed = `${String(Math.floor(duration / 3600)).padStart(2, "0")}:${String(Math.floor(duration / 60) % 60).padStart(2, "0")}:${String(duration % 60).padStart(2, "0")}`;
  container.innerHTML = `<section class="panel live-match-panel">
    <div class="live-match-header"><div><span class="live-status"><i></i> LIVE SCRIM · <span id="live-elapsed">${elapsed}</span></span><h2>${escapeHTML(session.opponent)}</h2><p>${escapeHTML(session.map)} · Round ${session.round} · ${escapeHTML(formatDate(session.startedAt.slice(0, 10)))}</p></div><div class="live-score"><div><small>US</small><strong>${session.scoreFor}</strong></div><span>:</span><div><small>THEM</small><strong>${session.scoreAgainst}</strong></div></div></div>
    <div class="round-controls"><span>Record the round</span><button class="button button-quiet" data-round-result="us" type="button">We won</button><button class="button button-quiet" data-round-result="them" type="button">They won</button><span class="form-hint">Round ${session.round} in progress</span></div>
    <div class="live-notes"><label class="form-field"><span>Team takeaway (optional)</span><textarea id="live-notes" class="form-control" maxlength="600" placeholder="Add a quick note for the match log">${escapeHTML(session.notes || "")}</textarea></label></div>
    <div class="form-actions"><button class="button button-quiet" data-cancel-live type="button">End without saving</button><button class="button button-primary" data-finish-live type="button">Finish & save scrim</button></div>
  </section>`;
  startElapsedClock();
}

function resultLetter(result) {
  return result === "win" ? "W" : result === "draw" ? "D" : "L";
}

function renderMatches() {
  const sorted = [...workspace.matches].sort((a, b) => b.date.localeCompare(a.date));
  const filtered = activeFilter === "all" ? sorted : sorted.filter(match => match.result === activeFilter);
  dom.matchTotal.textContent = `${filtered.length} ${filtered.length === 1 ? "match" : "matches"}`;
  const emptyTitle = activeFilter === "all" ? "No matches in the log yet" : `No ${activeFilter === "draw" ? "draws" : `${activeFilter}es`} logged`;
  dom.matchList.innerHTML = filtered.length ? filtered.map(match => {
    return `
    <article class="match-card">
      <div class="match-card-top">
        <div class="match-identity"><span class="result-badge ${match.result}">${resultLetter(match.result)}</span><div><h3>${escapeHTML(match.opponent)}</h3><p>${escapeHTML(match.map)} <span class="muted-dot">·</span> ${escapeHTML(match.format || "Single map")} <span class="muted-dot">·</span> ${escapeHTML(formatDate(match.date))}</p></div></div>
        <span class="match-score">${match.scoreFor} <span class="muted-dot">:</span> ${match.scoreAgainst}</span>
      </div>
      <div class="match-details"><div>
        ${match.notes ? `<p class="match-notes">${escapeHTML(match.notes)}</p>` : `<p class="match-notes muted">No takeaway noted for this match.</p>`}
        <div class="match-meta">${match.focus ? `<span class="tag focus">Focus: ${escapeHTML(match.focus)}</span>` : ""}${match.side ? `<span class="tag">${escapeHTML(match.side)} start</span>` : ""}</div>
      </div><button class="delete-button" data-delete-match="${escapeHTML(match.id)}" type="button">Remove</button></div>
    </article>`;
  }).join("") : emptyState("▤", emptyTitle, "Add match scores and a short team takeaway to make your reviews more useful.", "Log a match", "add-match");
}

function renderPlaybook() {
  const query = document.querySelector("#play-search").value.trim().toLowerCase();
  const map = document.querySelector("#map-filter").value;
  const plays = workspace.plays.filter(play => {
    const matchesMap = map === "all" || play.map === map;
    const text = [play.title, play.map, play.side, play.phase, play.agents, play.description].join(" ").toLowerCase();
    return matchesMap && text.includes(query);
  }).sort((a, b) => a.title.localeCompare(b.title));
  dom.playbookList.innerHTML = plays.length ? plays.map(play => `
    <article class="play-card">
      <div class="play-card-top"><div class="play-labels"><span class="tag">${escapeHTML(play.map)}</span><span class="tag">${escapeHTML(play.side)}</span><span class="tag play-phase">${escapeHTML(play.phase)}</span></div>
        <div class="card-actions"><button data-edit-play="${escapeHTML(play.id)}" type="button" aria-label="Edit ${escapeHTML(play.title)}">Edit</button><button data-delete-play="${escapeHTML(play.id)}" type="button" aria-label="Remove ${escapeHTML(play.title)}">Remove</button></div>
      </div>
      <h3>${escapeHTML(play.title)}</h3><p class="play-description">${escapeHTML(play.description)}</p>
      <div class="play-footer"><span class="agent-list">${play.agents ? `Agents: ${escapeHTML(play.agents)}` : "No agent assignments"}</span><span>${escapeHTML(play.side)}</span></div>
    </article>`).join("") : emptyState("⌘", workspace.plays.length ? "No plays match that search" : "Your playbook is empty", workspace.plays.length ? "Try a different name or map." : "Write down the plan, timings, and player jobs your team wants to remember.", workspace.plays.length ? "" : "Add a play", workspace.plays.length ? "" : "add-play");
}

function renderReview() {
  const matches = [...workspace.matches].sort((a, b) => b.date.localeCompare(a.date));
  const wins = matches.filter(match => match.result === "win").length;
  const draws = matches.filter(match => match.result === "draw").length;
  const series = matches.filter(match => match.format && match.format !== "Single map");
  const seriesWins = series.reduce((sum, match) => sum + match.scoreFor, 0);
  const seriesLosses = series.reduce((sum, match) => sum + match.scoreAgainst, 0);
  const focusRows = FOCUS_AREAS.map(focus => {
    const group = matches.filter(match => match.focus === focus);
    const groupWins = group.filter(match => match.result === "win").length;
    return { focus, count: group.length, rate: group.length ? Math.round(groupWins / group.length * 100) : null };
  }).filter(row => row.count);

  dom.review.innerHTML = matches.length ? `
    <div class="review-summary-grid">
      <article class="review-stat"><small>Logged matches</small><strong>${matches.length}</strong><span>Win/loss entries in this workspace</span></article>
      <article class="review-stat"><small>Series map record</small><strong>${series.length ? `${seriesWins}–${seriesLosses}` : "—"}</strong><span>${series.length ? `Across ${series.length} BO series` : "No best-of series logged yet"}</span></article>
      <article class="review-stat"><small>Overall match record</small><strong>${wins}–${draws}–${matches.length - wins - draws}</strong><span>${Math.round(wins / matches.length * 100)}% match win rate</span></article>
    </div>
    <div class="review-grid">
      <section class="panel review-panel"><h2>Results by practice focus</h2><p>How matches with each selected focus ended. This is descriptive context, not proof of cause.</p>
        ${focusRows.length ? `<table class="focus-table"><thead><tr><th>Focus</th><th>Matches</th><th>Wins</th><th>Win rate</th></tr></thead><tbody>${focusRows.map(row => `<tr><td>${escapeHTML(row.focus)}</td><td>${row.count}</td><td>${matches.filter(match => match.focus === row.focus && match.result === "win").length}</td><td>${row.rate}%</td></tr>`).join("")}</tbody></table>` : `<p>No match focus has been selected yet. Add a focus to future match logs to see this breakdown.</p>`}
      </section>
      <section class="panel review-panel"><h2>Recent team takeaways</h2><p>Notes from your last logged matches.</p>
        ${matches.filter(match => match.notes).slice(0, 4).map(match => `<article class="reflection-card"><small>${escapeHTML(formatDate(match.date))} · ${escapeHTML(match.map)} · ${escapeHTML(match.result.toUpperCase())}</small><p>${escapeHTML(match.notes)}</p></article>`).join("") || `<p>No takeaways recorded yet. Add a short note when logging a match.</p>`}
      </section>
    </div>` : emptyState("↗", "Your review starts with one match", "Once the team has logged a few results and practice focuses, this page will show simple trends to discuss together.", "Log a match", "add-match");
}

function optionList(values, selected = "") {
  return values.map(value => `<option value="${escapeHTML(value)}" ${value === selected ? "selected" : ""}>${escapeHTML(value)}</option>`).join("");
}

function openModal({ title, eyebrow = "TEAM DESK", content }) {
  document.querySelector("#modal-title").textContent = title;
  document.querySelector("#modal-eyebrow").textContent = eyebrow;
  dom.modalContent.innerHTML = content;
  dom.modal.hidden = false;
  document.body.style.overflow = "hidden";
  const firstInput = dom.modalContent.querySelector("input, select, textarea");
  if (firstInput) firstInput.focus();
}

function closeModal() {
  dom.modal.hidden = true;
  document.body.style.overflow = "";
}

function openPlayerForm(player = null) {
  editingPlayerId = player?.id || null;
  openModal({
    title: player ? "Edit player profile" : "Add a player",
    eyebrow: "PLAYER PROFILE",
    content: `<form id="player-form"><p class="form-error" id="form-error" hidden></p>
      <div class="form-grid">
        <div class="form-field"><label for="player-name">Display name</label><input class="form-control" id="player-name" name="name" maxlength="40" value="${escapeHTML(player?.name || "")}" required></div>
        <div class="form-field"><label for="player-role">Main role</label><select class="form-control" id="player-role" name="role">${optionList(["Duelist", "Initiator", "Controller", "Sentinel", "Flex", "IGL", "Other"], player?.role || "Flex")}</select></div>
        <div class="form-field"><label for="player-rank">Current rank</label><input class="form-control" id="player-rank" name="rank" maxlength="32" value="${escapeHTML(player?.rank || "")}" placeholder="e.g. Diamond 2"></div>
        <div class="form-field"><label for="player-agents">Main agents</label><input class="form-control" id="player-agents" name="agents" maxlength="120" value="${escapeHTML(player?.agents || "")}" placeholder="e.g. Jett, Raze"></div>
        <div class="form-field full"><label for="player-goal">Current improvement focus</label><input class="form-control" id="player-goal" name="goal" maxlength="140" value="${escapeHTML(player?.goal || "")}" placeholder="A skill or habit to work on"></div>
        <div class="form-field full"><label for="player-notes">Notes</label><textarea class="form-control" id="player-notes" name="notes" maxlength="500" placeholder="Preferences, strengths, or reminders">${escapeHTML(player?.notes || "")}</textarea></div>
      </div>
      <div class="form-actions"><button class="button button-quiet" data-cancel-modal type="button">Cancel</button><button class="button button-primary" type="submit">${player ? "Save profile" : "Add player"}</button></div>
    </form>`
  });
}

function openLiveForm() {
  if (workspace.liveSession) {
    navigate("live");
    return;
  }
  openModal({
    title: "Set up scrim tracker",
    eyebrow: "LIVE SCRIM",
    content: `<form id="live-form"><p class="form-error" id="form-error" hidden></p>
      <div class="form-grid">
        <div class="form-field"><label for="live-opponent">Opponent / session</label><input class="form-control" id="live-opponent" name="opponent" maxlength="60" placeholder="Practice lobby" required></div>
        <div class="form-field"><label for="live-map">Map</label><select class="form-control" id="live-map" name="map">${optionList(MAPS.slice(0, -1))}</select></div>
        <div class="form-field"><label for="live-side">Starting side</label><select class="form-control" id="live-side" name="side"><option value="">Not noted</option><option>Attack</option><option>Defense</option></select></div>
        <div class="form-field"><label for="live-focus">Focus for this scrim</label><select class="form-control" id="live-focus" name="focus"><option value="">Not selected</option>${optionList(FOCUS_AREAS)}</select></div>
      </div>
      <div class="form-actions"><button class="button button-quiet" data-cancel-modal type="button">Cancel</button><button class="button button-primary" type="submit">Start tracker</button></div>
    </form>`
  });
}

function openAppearanceSettings() {
  const { theme, font, fontSize } = workspace.settings;
  const themes = { ember: "Ember", ocean: "Ocean", forest: "Forest", violet: "Violet", light: "Light" };
  const fonts = { system: "System", rounded: "Rounded", serif: "Serif", mono: "Monospace" };
  const sizes = { compact: "Compact", standard: "Standard", large: "Large" };
  openModal({
    title: "Appearance",
    eyebrow: "MAKE IT YOURS",
    content: `<form id="appearance-form">
      <div class="form-grid">
        <div class="form-field"><label for="appearance-theme">Colour theme</label><select id="appearance-theme" name="theme" class="form-control">${Object.entries(themes).map(([value, label]) => `<option value="${value}" ${theme === value ? "selected" : ""}>${label}</option>`).join("")}</select></div>
        <div class="form-field"><label for="appearance-font">Font style</label><select id="appearance-font" name="font" class="form-control">${Object.entries(fonts).map(([value, label]) => `<option value="${value}" ${font === value ? "selected" : ""}>${label}</option>`).join("")}</select></div>
        <div class="form-field full"><label for="appearance-size">Text size</label><select id="appearance-size" name="fontSize" class="form-control">${Object.entries(sizes).map(([value, label]) => `<option value="${value}" ${fontSize === value ? "selected" : ""}>${label}</option>`).join("")}</select></div>
      </div>
      <p class="form-hint appearance-preview">Settings are saved in this workspace and included when you export it.</p>
      <div class="form-actions"><button class="button button-quiet" data-cancel-modal type="button">Cancel</button><button class="button button-primary" type="submit">Save appearance</button></div>
    </form>`
  });
}

function applyAppearance() {
  const root = document.documentElement;
  root.dataset.theme = workspace.settings.theme;
  root.dataset.font = workspace.settings.font;
  root.dataset.size = workspace.settings.fontSize;
}

function openMatchForm() {
  const today = localDateISO();
  openModal({
    title: "Log a match",
    eyebrow: "SCRIM JOURNAL",
    content: `<form id="match-form">
      <p class="form-error" id="form-error" hidden></p>
      <div class="form-grid">
        <div class="form-field"><label for="match-opponent">Opponent or session name</label><input class="form-control" id="match-opponent" name="opponent" maxlength="60" placeholder="e.g. Tuesday scrim" required></div>
          <div class="form-field"><label for="match-format">Match format</label><select class="form-control" id="match-format" name="format">${optionList(MATCH_FORMATS, "Single map")}</select></div>
          <div class="form-field full"><label for="match-map">Map(s) <span class="optional">· separate multiple maps with commas</span></label><input class="form-control" id="match-map" name="map" maxlength="100" placeholder="e.g. Ascent, Haven, Bind" required></div>
          <div class="form-field full"><label id="score-label">Final round score <span class="optional">· result is calculated automatically</span></label><div class="score-inputs"><input class="form-control" name="scoreFor" type="number" min="0" max="20" placeholder="Us" aria-label="Your team score" required><span>:</span><input class="form-control" name="scoreAgainst" type="number" min="0" max="20" placeholder="Them" aria-label="Opponent score" required></div><span class="form-hint" id="score-hint">For a single map, enter the final round score.</span></div>
        <div class="form-field"><label for="match-date">Date</label><input class="form-control" id="match-date" name="date" type="date" value="${today}" required></div>
        <div class="form-field"><label for="match-side">Starting side <span class="optional">· optional</span></label><select class="form-control" id="match-side" name="side"><option value="">Not noted</option><option>Attack</option><option>Defense</option></select></div>
        <div class="form-field"><label for="match-focus">Team practice focus</label><select class="form-control" id="match-focus" name="focus"><option value="">Not selected</option>${optionList(FOCUS_AREAS)}</select></div>
        <div class="form-field full"><label for="match-notes">One takeaway <span class="optional">· what should the team remember?</span></label><textarea class="form-control" id="match-notes" name="notes" maxlength="600" placeholder="What worked, what broke down, or what should we try next time?"></textarea></div>
      </div>
      <div class="form-actions"><button class="button button-quiet" data-cancel-modal type="button">Cancel</button><button class="button button-primary" type="submit">Save match</button></div>
    </form>`
  });
}

function openPlayForm(play = null) {
  editingPlayId = play?.id || null;
  openModal({
    title: play ? "Edit a play" : "Add a play",
    eyebrow: "TEAM PLAYBOOK",
    content: `<form id="play-form">
      <p class="form-error" id="form-error" hidden></p>
      <div class="form-grid">
        <div class="form-field full"><label for="play-title">Play name</label><input class="form-control" id="play-title" name="title" maxlength="60" value="${escapeHTML(play?.title || "")}" placeholder="e.g. A split with late market pressure" required></div>
        <div class="form-field"><label for="play-map">Map</label><select class="form-control" id="play-map" name="map" required>${optionList(MAPS, play?.map || MAPS[0])}</select></div>
        <div class="form-field"><label for="play-side">Side</label><select class="form-control" id="play-side" name="side">${optionList(["Attack", "Defense"], play?.side || "Attack")}</select></div>
        <div class="form-field"><label for="play-phase">Round type</label><select class="form-control" id="play-phase" name="phase">${optionList(PHASES, play?.phase || "Default")}</select></div>
        <div class="form-field"><label for="play-agents">Key agents <span class="optional">· optional</span></label><input class="form-control" id="play-agents" name="agents" maxlength="100" value="${escapeHTML(play?.agents || "")}" placeholder="e.g. Omen, Sova"></div>
        <div class="form-field full"><label for="play-description">Plan and player jobs</label><textarea class="form-control" id="play-description" name="description" maxlength="900" placeholder="Setup, utility order, timing cue, who takes space, and what to do after contact." required>${escapeHTML(play?.description || "")}</textarea><span class="form-hint">Keep it actionable: who does what, when, and what the fallback is.</span></div>
      </div>
      <div class="form-actions"><button class="button button-quiet" data-cancel-modal type="button">Cancel</button><button class="button button-primary" type="submit">${play ? "Save changes" : "Add to playbook"}</button></div>
    </form>`
  });
}

function showFormError(message) {
  const error = document.querySelector("#form-error");
  error.textContent = message;
  error.hidden = false;
}

function handleMatchSubmit(form) {
  const values = new FormData(form);
  const format = String(values.get("format"));
  const scoreFor = Number(values.get("scoreFor"));
  const scoreAgainst = Number(values.get("scoreAgainst"));
  if (!Number.isInteger(scoreFor) || !Number.isInteger(scoreAgainst) || scoreFor < 0 || scoreAgainst < 0 ||
      !isValidMatchScore(format, scoreFor, scoreAgainst)) {
    showFormError(format === "BO2"
      ? "A BO2 must have exactly two maps played. Enter a final map score such as 2–0, 1–1, or 0–2."
      : format === "Single map"
        ? "Enter two different whole-number round scores between 0 and 20."
        : `${format} needs a final series score where one team reaches the required map wins.`);
    return;
  }
  const opponent = String(values.get("opponent")).trim();
  if (!opponent) {
    showFormError("Add an opponent or session name.");
    return;
  }
  workspace.matches.push({
    id: crypto.randomUUID(),
    date: String(values.get("date")),
    opponent,
    format,
    map: String(values.get("map")),
    result: scoreFor > scoreAgainst ? "win" : scoreFor < scoreAgainst ? "loss" : "draw",
    scoreFor,
    scoreAgainst,
    side: String(values.get("side")),
    focus: String(values.get("focus")),
    notes: String(values.get("notes")).trim()
  });
  saveWorkspace();
  closeModal();
  renderAll();
  renderMatches();
  showToast("Match added to your log.");
}

function isValidMatchScore(format, scoreFor, scoreAgainst) {
  if (format === "Single map") {
    return scoreFor <= 20 && scoreAgainst <= 20 && scoreFor !== scoreAgainst;
  }
  const mapCount = Number(format.slice(2));
  if (!Number.isInteger(mapCount)) return false;
  if (format === "BO2") {
    return scoreFor <= 2 && scoreAgainst <= 2 && scoreFor + scoreAgainst === 2;
  }
  const mapsToWin = Math.floor(mapCount / 2) + 1;
  return scoreFor <= mapsToWin && scoreAgainst <= mapsToWin &&
    ((scoreFor === mapsToWin && scoreAgainst < mapsToWin) ||
      (scoreAgainst === mapsToWin && scoreFor < mapsToWin));
}

function updateScoreInputs(format) {
  const isSingleMap = format === "Single map";
  const scoreLabel = document.querySelector("#score-label");
  const scoreHint = document.querySelector("#score-hint");
  const maxScore = isSingleMap ? 20 : format === "BO2" ? 2 : Math.floor(Number(format.slice(2)) / 2) + 1;
  const scoreInputs = [...document.querySelectorAll('#match-form input[name="scoreFor"], #match-form input[name="scoreAgainst"]')];
  scoreLabel.innerHTML = isSingleMap
    ? 'Final round score <span class="optional">· result is calculated automatically</span>'
    : 'Final series score <span class="optional">· maps won by each team</span>';
  scoreHint.textContent = isSingleMap
    ? "For a single map, enter the final round score."
    : format === "BO2"
      ? "A BO2 plays two maps: 2–0 is a win, 1–1 is a draw, and 0–2 is a loss."
      : `${format} ends when a team wins ${maxScore} map${maxScore === 1 ? "" : "s"}.`;
  scoreInputs.forEach(input => {
    input.max = String(maxScore);
    input.placeholder = isSingleMap ? (input.name === "scoreFor" ? "Us" : "Them") : (input.name === "scoreFor" ? "Us" : "Them");
    input.setAttribute("aria-label", `${input.name === "scoreFor" ? "Your team" : "Opponent"} ${isSingleMap ? "round score" : "maps won"}`);
  });
}

function handlePlayerSubmit(form) {
  const values = Object.fromEntries(new FormData(form).entries());
  const name = String(values.name || "").trim();
  if (!name) {
    showFormError("Enter a player name.");
    return;
  }
  const duplicate = workspace.players.some(player => player.id !== editingPlayerId &&
    player.name.toLowerCase() === name.toLowerCase());
  if (duplicate) {
    showFormError("A player with that name already exists in this workspace.");
    return;
  }
  if (editingPlayerId) {
    workspace.players = workspace.players.map(player => player.id === editingPlayerId ? {
      ...player,
      name,
      role: String(values.role),
      rank: String(values.rank || "").trim(),
      agents: String(values.agents || "").trim(),
      goal: String(values.goal || "").trim(),
      notes: String(values.notes || "").trim()
    } : player);
  } else {
    const player = {
      id: crypto.randomUUID(),
      name,
      role: String(values.role),
      rank: String(values.rank || "").trim(),
      agents: String(values.agents || "").trim(),
      goal: String(values.goal || "").trim(),
      notes: String(values.notes || "").trim()
    };
    workspace.players.push(player);
    workspace.availability[player.id] = Array(168).fill(false);
    if (!availabilityPlayerId) availabilityPlayerId = player.id;
  }
  editingPlayerId = null;
  saveWorkspace();
  closeModal();
  renderPlayers();
  renderAvailability();
  showToast("Player profile saved.");
}

function deletePlayer(playerId) {
  const player = workspace.players.find(item => item.id === playerId);
  if (!player || !window.confirm(`Remove ${player.name}'s profile and availability?`)) return;
  workspace.players = workspace.players.filter(item => item.id !== playerId);
  delete workspace.availability[playerId];
  if (availabilityPlayerId === playerId) availabilityPlayerId = workspace.players[0]?.id || "";
  saveWorkspace();
  renderAll();
  showToast("Player profile removed.");
}

function handleLiveSubmit(form) {
  const values = new FormData(form);
  const opponent = String(values.get("opponent") || "").trim();
  if (!opponent) return showFormError("Enter an opponent or session name.");
  workspace.liveSession = {
    id: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    opponent,
    map: String(values.get("map") || "Ascent"),
    side: String(values.get("side") || ""),
    focus: String(values.get("focus") || ""),
    notes: "",
    round: 1,
    scoreFor: 0,
    scoreAgainst: 0
  };
  saveWorkspace();
  closeModal();
  navigate("live");
  showToast("Scrim tracker started.");
}

function recordLiveRound(result) {
  const session = workspace.liveSession;
  if (!session || !["us", "them"].includes(result)) return;
  const notes = document.querySelector("#live-notes");
  if (notes) session.notes = notes.value;
  if (result === "us") session.scoreFor++;
  else session.scoreAgainst++;
  session.round++;
  saveWorkspace();
  renderLivePanel();
}

function finishLiveScrim() {
  const session = workspace.liveSession;
  if (!session) return;
  if (session.scoreFor === session.scoreAgainst) {
    showToast("Record the winning round before saving this map.", "error");
    return;
  }
  const notes = document.querySelector("#live-notes");
  session.notes = notes?.value.trim() || "";
  workspace.matches.push({
    id: crypto.randomUUID(),
    date: localDateISO(new Date(session.startedAt)),
    opponent: session.opponent,
    format: "Single map",
    map: session.map,
    result: session.scoreFor > session.scoreAgainst ? "win" : "loss",
    scoreFor: session.scoreFor,
    scoreAgainst: session.scoreAgainst,
    side: session.side,
    focus: session.focus,
    notes: session.notes
  });
  workspace.liveSession = null;
  saveWorkspace();
  renderAll();
  navigate("matches");
  showToast("Scrim saved to your match log.");
}

function cancelLiveScrim() {
  if (!workspace.liveSession || !window.confirm("End this tracker without adding it to your match log?")) return;
  workspace.liveSession = null;
  saveWorkspace();
  renderAll();
  showToast("Live tracker ended.");
}

function handleAppearanceSubmit(form) {
  const values = Object.fromEntries(new FormData(form).entries());
  const settings = normalizeSettings(values);
  workspace.settings = settings;
  applyAppearance();
  saveWorkspace();
  closeModal();
  showToast("Appearance settings saved.");
}

function startElapsedClock() {
  if (liveClockTimer) return;
  liveClockTimer = window.setInterval(() => {
    if (!workspace.liveSession || !document.querySelector("#view-live").classList.contains("active")) return;
    const elapsedLabel = document.querySelector("#live-elapsed");
    if (!elapsedLabel) return;
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(workspace.liveSession.startedAt).getTime()) / 1000));
    elapsedLabel.textContent = `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }, 1000);
}

function handlePlaySubmit(form) {
  const values = new FormData(form);
  const title = String(values.get("title")).trim();
  const description = String(values.get("description")).trim();
  if (!title || !description) {
    showFormError("Add a play name and a short plan.");
    return;
  }
  const play = {
    id: editingPlayId || crypto.randomUUID(),
    title,
    map: String(values.get("map")),
    side: String(values.get("side")),
    phase: String(values.get("phase")),
    agents: String(values.get("agents")).trim(),
    description
  };
  if (editingPlayId) workspace.plays = workspace.plays.map(item => item.id === editingPlayId ? play : item);
  else workspace.plays.push(play);
  saveWorkspace();
  closeModal();
  renderAll();
  renderPlaybook();
  showToast(editingPlayId ? "Play updated." : "Play added to your playbook.");
  editingPlayId = null;
}

function removeMatch(id) {
  const match = workspace.matches.find(item => item.id === id);
  if (!match || !window.confirm(`Remove the ${match.result} against ${match.opponent}? This can't be undone.`)) return;
  workspace.matches = workspace.matches.filter(item => item.id !== id);
  saveWorkspace();
  renderAll();
  renderMatches();
  showToast("Match removed.");
}

function removePlay(id) {
  const play = workspace.plays.find(item => item.id === id);
  if (!play || !window.confirm(`Remove "${play.title}" from the playbook? This can't be undone.`)) return;
  workspace.plays = workspace.plays.filter(item => item.id !== id);
  saveWorkspace();
  renderAll();
  renderPlaybook();
  showToast("Play removed.");
}

function exportWorkspace() {
  const json = JSON.stringify({ ...workspace, exportedAt: new Date().toISOString() }, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `vanta-team-desk-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast("Workspace exported. Keep the JSON file as a backup or share it manually.");
}

async function importWorkspace(file) {
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (![1, 2, 3].includes(data?.version) || !Array.isArray(data.matches) || !Array.isArray(data.plays)) {
      throw new Error("This doesn't look like a VANTA Team Desk export.");
    }
    const incomingPlayers = Array.isArray(data.players) ? data.players : [];
    if (incomingPlayers.some(player => !isValidPlayer(player))) {
      throw new Error("That workspace contains an invalid player profile. Nothing was imported.");
    }
    const matches = data.matches.map(match => {
      const cleanMatch = { ...match };
      delete cleanMatch.playerStats;
      return { ...cleanMatch, format: cleanMatch.format || "Single map" };
    }).filter(isValidMatch);
    const plays = data.plays.filter(isValidPlay);
    if (matches.length !== data.matches.length || plays.length !== data.plays.length) {
      throw new Error("Some records in that file were incomplete or not supported. Nothing was imported.");
    }
    const matchIds = new Set(workspace.matches.map(match => match.id));
    const playIds = new Set(workspace.plays.map(play => play.id));
    const playerIds = new Set(workspace.players.map(player => player.id));
    const newMatches = matches.filter(match => !matchIds.has(match.id));
    const newPlays = plays.filter(play => !playIds.has(play.id));
    const newPlayers = incomingPlayers.filter(player => !playerIds.has(player.id));
    const isEmptyWorkspace = !workspace.matches.length && !workspace.plays.length && !workspace.players.length;
    workspace.matches.push(...newMatches);
    workspace.plays.push(...newPlays);
    workspace.players.push(...newPlayers);
    const importedAvailability = data.availability && typeof data.availability === "object" ? data.availability : {};
    for (const player of incomingPlayers) {
      const schedule = importedAvailability[player.id];
      if (Array.isArray(schedule)) {
        workspace.availability[player.id] = Array.from({ length: 168 }, (_, index) => schedule[index] === true);
      } else if (!workspace.availability[player.id]) {
        workspace.availability[player.id] = Array(168).fill(false);
      }
      if (isEmptyWorkspace && data.settings && typeof data.settings === "object") {
        workspace.settings = normalizeSettings(data.settings);
        applyAppearance();
      }
    }
    if (!workspace.liveSession) {
      workspace.liveSession = normalizeLiveSession(data.liveSession);
    }
    saveWorkspace();
    renderAll();
    showToast(`Imported ${newMatches.length} matches, ${newPlays.length} plays, and ${newPlayers.length} new player profiles.`);
  } catch (error) {
    console.error("Unable to import workspace.", error);
    showToast(error.message || "Couldn't read that workspace file.", "error");
  } finally {
    document.querySelector("#import-file").value = "";
  }
}

function loadDemoWorkspace() {
  if ((workspace.matches.length || workspace.plays.length || workspace.players.length) &&
      !window.confirm("Add demo matches, plays, and sample players to this workspace? Existing records will stay.")) return;
  const demoPlayers = workspace.players.length ? [] : [
    { id: crypto.randomUUID(), name: "Riley", role: "Duelist", rank: "Diamond 2", agents: "Jett, Raze", goal: "Trade after first contact", notes: "" },
    { id: crypto.randomUUID(), name: "Morgan", role: "Initiator", rank: "Ascendant 1", agents: "Sova, Fade", goal: "Use utility with a clear timing", notes: "" },
    { id: crypto.randomUUID(), name: "Alex", role: "Controller", rank: "Diamond 3", agents: "Omen, Brimstone", goal: "Stay alive for the retake", notes: "" }
  ];
  for (const player of demoPlayers) workspace.availability[player.id] = Array(168).fill(false);
  if (demoPlayers.length) {
    for (let day = 0; day < 5; day++) {
      for (let hour = 18; hour < 22; hour++) {
        for (const player of demoPlayers) workspace.availability[player.id][day * 24 + hour] = true;
      }
    }
    workspace.players.push(...demoPlayers);
  }
  const today = new Date();
  const dateOffset = offset => {
    const date = new Date(today);
    date.setDate(date.getDate() - offset);
    return localDateISO(date);
  };
  const demoMatches = [
    { id: crypto.randomUUID(), date: dateOffset(1), opponent: "Tuesday Scrim", map: "Ascent", format: "Single map", result: "win", scoreFor: 13, scoreAgainst: 9, side: "Attack", focus: "Trading", notes: "Our mid-round trades were stronger when the second player waited for contact instead of rushing the fight." },
    { id: crypto.randomUUID(), date: dateOffset(3), opponent: "Practice Set", map: "Haven", format: "Single map", result: "loss", scoreFor: 10, scoreAgainst: 13, side: "Defense", focus: "Communication", notes: "We had a few late retake calls. Try naming the regroup point before rotating." },
    { id: crypto.randomUUID(), date: dateOffset(5), opponent: "Friday Scrim", map: "Bind", format: "Single map", result: "win", scoreFor: 13, scoreAgainst: 7, side: "Defense", focus: "Utility", notes: "Early information utility helped us save the site setup for the execute." }
  ];
  const demoPlays = [
    { id: crypto.randomUUID(), title: "Mid pressure into A split", map: "Ascent", side: "Attack", phase: "Default", agents: "Omen, Sova", description: "Start with two showing mid and three holding A main. Use a quiet mid lurk to draw a rotate; on the call, smoke heaven and tree, dart close generator, then hit from both sides. If mid gets denied, regroup and finish through A main." },
    { id: crypto.randomUUID(), title: "Fast B retake setup", map: "Haven", side: "Defense", phase: "Retake", agents: "Initiator + Controller", description: "Give up first contact rather than peeking alone. One player anchors the link-side exit, two regroup through garage, and the last players wait for the flash cue. Clear close corners together, then plant-side utility before taking the defuse." }
  ];
  workspace.matches.push(...demoMatches);
  workspace.plays.push(...demoPlays);
  saveWorkspace();
  renderAll();
  showToast("Demo workspace added. Edit or remove any example.");
}

function renderAll() {
  renderDashboard();
  renderLivePanel();
  renderPlayers();
  renderAvailability();
  renderMatches();
  renderPlaybook();
  renderReview();
}

document.addEventListener("click", event => {
  const target = event.target.closest("button");
  if (!target) return;
  if (target.dataset.view) navigate(target.dataset.view);
  if (target.dataset.navigate) navigate(target.dataset.navigate);
  if (target.dataset.action === "add-match") openMatchForm();
  if (target.dataset.action === "add-play") openPlayForm();
  if (target.dataset.action === "add-player") openPlayerForm();
  if (target.id === "quick-add-match" || target.id === "add-match-button") openMatchForm();
  if (target.id === "start-live-button" || target.id === "new-live-button" || target.dataset.startLive !== undefined) openLiveForm();
  if (target.id === "add-player-button") openPlayerForm();
  if (target.id === "add-play-button") openPlayForm();
  if (target.id === "settings-button") openAppearanceSettings();
  if (target.id === "close-modal" || target.hasAttribute("data-cancel-modal")) closeModal();
  if (target.dataset.deleteMatch) removeMatch(target.dataset.deleteMatch);
  if (target.dataset.deletePlay) removePlay(target.dataset.deletePlay);
  if (target.dataset.editPlay) {
    const play = workspace.plays.find(item => item.id === target.dataset.editPlay);
    if (play) openPlayForm(play);
  }
  if (target.dataset.editPlayer) {
    const player = workspace.players.find(item => item.id === target.dataset.editPlayer);
    if (player) openPlayerForm(player);
  }
  if (target.dataset.deletePlayer) deletePlayer(target.dataset.deletePlayer);
  if (target.dataset.editAvailability) {
    availabilityPlayerId = target.dataset.editAvailability;
    navigate("availability");
  }
  if (target.dataset.slot !== undefined) {
    const slot = Number(target.dataset.slot);
    if (Number.isInteger(slot) && slot >= 0 && slot < 168) {
      const slots = workspace.availability[availabilityPlayerId] || (workspace.availability[availabilityPlayerId] = Array(168).fill(false));
      slots[slot] = !slots[slot];
      saveWorkspace();
      renderAvailability();
    }
  }
  if (target.dataset.roundResult) recordLiveRound(target.dataset.roundResult);
  if (target.hasAttribute("data-finish-live")) finishLiveScrim();
  if (target.hasAttribute("data-cancel-live")) cancelLiveScrim();
  if (target.dataset.filter) {
    activeFilter = target.dataset.filter;
    document.querySelectorAll(".filter-tab").forEach(tab => tab.classList.toggle("selected", tab === target));
    renderMatches();
  }
  if (target.id === "export-button") exportWorkspace();
  if (target.id === "import-button") document.querySelector("#import-file").click();
  if (target.id === "demo-button") loadDemoWorkspace();
});

document.addEventListener("submit", event => {
  if (event.target.id === "player-form") {
    event.preventDefault();
    handlePlayerSubmit(event.target);
  }
  if (event.target.id === "live-form") {
    event.preventDefault();
    handleLiveSubmit(event.target);
  }
  if (event.target.id === "appearance-form") {
    event.preventDefault();
    handleAppearanceSubmit(event.target);
  }
  if (event.target.id === "match-form") {
    event.preventDefault();
    handleMatchSubmit(event.target);
  }
  if (event.target.id === "play-form") {
    event.preventDefault();
    handlePlaySubmit(event.target);
  }
});

document.querySelector("#play-search").addEventListener("input", renderPlaybook);
document.querySelector("#map-filter").addEventListener("change", renderPlaybook);
document.addEventListener("input", event => {
  if (event.target.id !== "live-notes" || !workspace.liveSession) return;
  workspace.liveSession.notes = event.target.value;
  saveWorkspace();
});
document.addEventListener("change", event => {
  if (event.target.id === "match-format") updateScoreInputs(event.target.value);
  if (event.target.id === "availability-player") {
    availabilityPlayerId = event.target.value;
    renderAvailability();
  }
});
document.querySelector("#import-file").addEventListener("change", event => importWorkspace(event.target.files[0]));
dom.modal.addEventListener("click", event => {
  if (event.target === dom.modal) closeModal();
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !dom.modal.hidden) closeModal();
});

applyAppearance();
window.startWorkspaceApp = team => {
  setWorkspaceScope(team.id);
  applyAppearance();
  showApp();
  renderAll();
};
