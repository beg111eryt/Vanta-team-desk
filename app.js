"use strict";

const STORAGE_KEY = "vanta-team-desk-v1";
const FOCUS_AREAS = ["Communication", "Utility", "Trading", "Economy", "Positioning", "Composure"];
const MAPS = ["Ascent", "Bind", "Breeze", "Fracture", "Haven", "Icebox", "Lotus", "Pearl", "Split", "Sunset", "Other"];
const MATCH_FORMATS = ["Single map", "BO1", "BO2", "BO3", "BO5"];
const PHASES = ["Pistol", "Anti-eco", "Default", "Execute", "Retake", "Post-plant", "Other"];
const VIEW_TITLES = { dashboard: "Overview", matches: "Match log", playbook: "Playbook", review: "Team review" };

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
  playbookList: document.querySelector("#playbook-list"),
  review: document.querySelector("#review-content"),
  modal: document.querySelector("#modal-backdrop"),
  modalContent: document.querySelector("#modal-content"),
  toastRegion: document.querySelector("#toast-region"),
  appShell: document.querySelector("#app-shell"),
  authScreen: document.querySelector("#auth-screen"),
  authContent: document.querySelector("#auth-content")
};

function emptyWorkspace() {
  return { version: 1, matches: [], plays: [] };
}

function loadWorkspace() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return emptyWorkspace();
    const parsed = JSON.parse(saved);
    if (parsed?.version !== 1 || !Array.isArray(parsed.matches) || !Array.isArray(parsed.plays)) {
      throw new Error("Saved workspace format is not supported.");
    }
    return {
      version: 1,
      matches: parsed.matches.filter(isValidMatch).map(match => ({
        ...match,
        format: match.format || "Single map"
      })),
      plays: parsed.plays.filter(isValidPlay)
    };
  } catch (error) {
    console.error("Unable to load the saved workspace.", error);
    return emptyWorkspace();
  }
}

let workspace = loadWorkspace();
let activeFilter = "all";
let editingPlayId = null;
let currentUser = null;
let currentTeam = null;
let teamRoster = [];
let pendingRequests = [];
let workspaceRevision = 0;
let saveQueue = Promise.resolve();
let pendingWrites = 0;
let saveGeneration = 0;
let refreshingIdentity = false;
let syncTimer = null;

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body) headers.set("Content-Type", "application/json");
  const response = await fetch(path, {
    ...options,
    headers,
    credentials: "same-origin"
  });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, body.message || `Request failed (${response.status}).`);
  return body;
}

function setBrand(teamName = "") {
  const brand = teamName || "VANTA";
  document.querySelector("#team-brand").textContent = brand.toUpperCase();
  document.querySelector("#brand-breadcrumb").textContent = brand.toUpperCase();
  document.querySelector("#team-mark").textContent = [...brand.trim()][0]?.toUpperCase() || "V";
  document.querySelector(".brand").setAttribute("aria-label", `${brand} Team Desk home`);
  document.title = `${brand} Team Desk`;
}

function showAuthScreen(content) {
  dom.appShell.hidden = true;
  dom.authScreen.hidden = false;
  dom.authContent.innerHTML = content;
}

function renderServerSetup(error = "") {
  setBrand("");
  showAuthScreen(`
    <div class="auth-logo"><span class="brand-mark">V</span><strong>VANTA TEAM DESK</strong></div>
    <p class="eyebrow"><span class="eyebrow-line"></span> FIRST-TIME SETUP</p>
    <h1>Connect the <span class="accent-text">team service.</span></h1>
    <p class="auth-copy">This is the hosted app address, not a team name or join code. Your captain must deploy the VANTA Team Desk service first, then share its HTTPS address with the team.</p>
    ${error ? `<p class="auth-error" role="alert">${escapeHTML(error)}</p>` : ""}
    <form class="auth-form" id="server-setup-form">
      <div class="form-field"><label for="server-address">Hosted app address</label><input class="form-control" id="server-address" name="apiBaseUrl" type="url" maxlength="240" placeholder="https://your-team-desk.onrender.com" required><span class="form-hint">Paste the service URL from your captain. Local testing may use http://localhost.</span></div>
      <button class="button button-primary" type="submit">Connect</button>
    </form>
    <p class="auth-footnote">After connecting: create an account, then choose “Create team as captain.” Teammates connect to this same address, create accounts, and request to join with your team code.</p>`);
}

function renderLogin(mode = "login", error = "") {
  const registering = mode === "register";
  showAuthScreen(`
    <div class="auth-logo"><span class="brand-mark">V</span><strong>VANTA TEAM DESK</strong></div>
    <p class="eyebrow"><span class="eyebrow-line"></span> YOUR TEAM, TOGETHER</p>
    <h1>${registering ? "Create your" : "Welcome"} <span class="accent-text">${registering ? "account." : "back."}</span></h1>
    <p class="auth-copy">${registering ? "Create an account, then create a team or request to join one with your captain's code." : "Sign in to see your team's shared playbook and match history."}</p>
    ${error ? `<p class="auth-error" role="alert">${escapeHTML(error)}</p>` : ""}
    <form class="auth-form" id="${registering ? "register-form" : "login-form"}">
      ${registering ? `<div class="form-field"><label for="auth-name">Display name</label><input class="form-control" id="auth-name" name="displayName" maxlength="40" autocomplete="name" required></div>` : ""}
      <div class="form-field"><label for="auth-email">Email</label><input class="form-control" id="auth-email" name="email" type="email" maxlength="254" autocomplete="email" required></div>
      <div class="form-field"><label for="auth-password">Password</label><input class="form-control" id="auth-password" name="password" type="password" minlength="10" maxlength="128" autocomplete="${registering ? "new-password" : "current-password"}" required><span class="form-hint">${registering ? "Use at least 10 characters." : "Your password is stored as a secure hash."}</span></div>
      <button class="button button-primary" type="submit">${registering ? "Create account" : "Sign in"}</button>
    </form>
    <p class="auth-switch">${registering ? "Already have an account?" : "New to VANTA Team Desk?"} <button type="button" data-auth-page="${registering ? "login" : "register"}">${registering ? "Sign in" : "Create an account"}</button></p>
    <p class="auth-footnote">Team notes are shared only with approved members. Don't reuse a password from another account.</p>`);
}

function renderTeamGate(membership = null, error = "") {
  const userName = currentUser?.displayName || "player";
  const errorPanel = error ? `<p class="auth-error" role="alert">${escapeHTML(error)}</p>` : "";
  if (membership?.status === "pending") {
    showAuthScreen(`
      <div class="auth-logo"><span class="brand-mark">V</span><strong>VANTA TEAM DESK</strong></div>
      <p class="eyebrow"><span class="eyebrow-line"></span> REQUEST SENT</p>
      <h1>Almost <span class="accent-text">there.</span></h1>
      <p class="auth-copy">Hi ${escapeHTML(userName)}. Your request to join <strong>${escapeHTML(membership.teamName)}</strong> is waiting for the team captain to approve it. This page will update when you're approved.</p>
      ${errorPanel}
      <button class="button button-quiet" id="gate-logout" type="button">Sign out</button>`);
    return;
  }
  showAuthScreen(`
    <div class="auth-logo"><span class="brand-mark">V</span><strong>VANTA TEAM DESK</strong></div>
    <p class="eyebrow"><span class="eyebrow-line"></span> SET UP YOUR TEAM</p>
    <h1>Create or join a <span class="accent-text">team.</span></h1>
    <p class="auth-copy">You're signed in as ${escapeHTML(userName)}. Captains: enter a team name below and choose “Create team as captain.” Players: enter the code your captain shared and request to join.</p>
    ${errorPanel}
    <form class="auth-form" id="join-team-form">
      <div class="form-field"><label for="join-team-code-input">Team code</label><input class="form-control" id="join-team-code-input" name="joinCode" maxlength="12" autocomplete="off" placeholder="Ask your captain for the code" required></div>
      <button class="button button-primary" type="submit">Request to join</button>
    </form>
    <div class="auth-divider">or create a new team</div>
    <form class="auth-form" id="create-team-form">
      <div class="form-field"><label for="new-team-name">Team name</label><input class="form-control" id="new-team-name" name="name" maxlength="32" placeholder="e.g. Dino Nuggies" required></div>
      <button class="button button-quiet" type="submit">Create team as captain</button>
    </form>
    <p class="auth-switch">Signed in as ${escapeHTML(currentUser?.email || userName)} · <button id="gate-logout" type="button">Sign out</button></p>`);
}

function saveWorkspace() {
  try {
    const localKey = currentTeam ? `${STORAGE_KEY}:${currentTeam.id}` : STORAGE_KEY;
    localStorage.setItem(localKey, JSON.stringify(workspace));
  } catch (error) {
    console.error("Unable to save the local workspace backup.", error);
    showToast("Couldn't save a local backup. Check browser storage.", "error");
  }
  if (!currentTeam) return saveQueue;
  const teamId = currentTeam.id;
  const generation = saveGeneration;
  const snapshot = JSON.parse(JSON.stringify(workspace));
  pendingWrites++;
  document.querySelector("#sync-label").textContent = "Syncing";
  saveQueue = saveQueue.then(async () => {
    if (generation !== saveGeneration) {
      pendingWrites--;
      return;
    }
    const result = await api(`/api/teams/${encodeURIComponent(teamId)}/workspace`, {
      method: "PUT",
      body: JSON.stringify({ revision: workspaceRevision, ...snapshot })
    });
    workspaceRevision = result.revision;
    pendingWrites--;
    if (!pendingWrites) document.querySelector("#sync-label").textContent = "Synced";
  }).catch(async error => {
    pendingWrites--;
    console.error("Unable to sync the team workspace.", error);
    document.querySelector("#sync-label").textContent = "Sync issue";
    if (error.status === 409) {
      saveGeneration++;
      await refreshTeamData(true, true);
      showToast("A teammate saved first. The latest team data is loaded; retry your change.", "error");
    } else {
      showToast(error.message || "Couldn't sync with the team server. Your local backup remains.", "error");
    }
  });
  return saveQueue;
}

function showApp() {
  dom.authScreen.hidden = true;
  dom.appShell.hidden = false;
  setBrand(currentTeam?.name || "");
  document.querySelector("#sync-label").textContent = "Synced";
  document.querySelector("#team-button").textContent =
    pendingRequests.length ? `Team · ${pendingRequests.length}` : "Team";
  document.querySelector("#team-button").setAttribute("aria-label",
    pendingRequests.length ? `Team, ${pendingRequests.length} pending requests` : "Team management");
}

async function refreshTeamData(force = false, ignorePendingWrites = false) {
  if (!currentTeam || (pendingWrites && !ignorePendingWrites)) return;
  const [teamData, teamWorkspace] = await Promise.all([
    api(`/api/teams/${encodeURIComponent(currentTeam.id)}`),
    api(`/api/teams/${encodeURIComponent(currentTeam.id)}/workspace`)
  ]);
  currentTeam = { ...teamData.team, role: currentTeam.role };
  teamRoster = teamData.roster;
  pendingRequests = teamData.requests;
  if (force || teamWorkspace.revision !== workspaceRevision) {
    workspace = {
      version: 1,
      matches: teamWorkspace.matches.map(match => ({
        ...match,
        format: match.format || "Single map",
        playerIds: Array.isArray(match.playerIds) ? match.playerIds : []
      })),
      plays: teamWorkspace.plays
    };
    workspaceRevision = teamWorkspace.revision;
    try {
      localStorage.setItem(`${STORAGE_KEY}:${currentTeam.id}`, JSON.stringify(workspace));
    } catch (error) {
      console.error("Unable to cache the team workspace locally.", error);
    }
    renderAll();
  }
  showApp();
}

async function refreshIdentity() {
  if (refreshingIdentity) return;
  refreshingIdentity = true;
  try {
    const identity = await api("/api/auth/me");
    currentUser = identity.user;
    if (!identity.membership || identity.membership.status !== "approved") {
      currentTeam = null;
      teamRoster = [];
      pendingRequests = [];
      renderTeamGate(identity.membership);
    } else {
      const teamChanged = currentTeam?.id !== identity.membership.teamId;
      currentTeam = {
        id: identity.membership.teamId,
        name: identity.membership.teamName,
        role: identity.membership.role
      };
      await refreshTeamData(teamChanged);
    }
  } catch (error) {
    if (error.status === 401) {
      currentUser = null;
      currentTeam = null;
      teamRoster = [];
      pendingRequests = [];
      renderLogin();
      return;
    }
    throw error;
  } finally {
    refreshingIdentity = false;
  }
}

async function boot() {
  try {
    const appConfig = await api("/api/app-config");
    document.querySelector("#server-settings-button").hidden = !appConfig.desktop;
    if (!appConfig.configured) {
      renderServerSetup();
      return;
    }
    await refreshIdentity();
  } catch (error) {
    console.error("Unable to connect to VANTA Team Desk.", error);
    showAuthScreen(`
      <div class="auth-logo"><span class="brand-mark">V</span><strong>VANTA TEAM DESK</strong></div>
      <p class="eyebrow"><span class="eyebrow-line"></span> SERVER CONNECTION</p>
      <h1>Can't reach the <span class="accent-text">team desk.</span></h1>
      <p class="auth-copy">${escapeHTML(error.message)} Start the team desk server and database, then retry.</p>
      <button class="button button-primary" id="retry-connection" type="button">Retry connection</button>`);
  }
  if (syncTimer) window.clearInterval(syncTimer);
  syncTimer = window.setInterval(async () => {
    if (!currentUser || refreshingIdentity) return;
    try {
      await refreshIdentity();
    } catch (error) {
      console.error("Team sync check failed.", error);
      document.querySelector("#sync-label").textContent = "Sync issue";
    }
  }, 12000);
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

function navigate(viewName) {
  if (!VIEW_TITLES[viewName]) return;
  dom.nav.forEach(button => button.classList.toggle("active", button.dataset.view === viewName));
  dom.views.forEach(view => view.classList.toggle("active", view.id === `view-${viewName}`));
  dom.section.textContent = VIEW_TITLES[viewName];
  if (viewName === "matches") renderMatches();
  if (viewName === "playbook") renderPlaybook();
  if (viewName === "review") renderReview();
  window.scrollTo({ top: 0, behavior: "smooth" });
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

function playersForMatch(match) {
  const playerIds = Array.isArray(match.playerIds) ? match.playerIds : [];
  return teamRoster.filter(player => playerIds.includes(player.id));
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
    const players = playersForMatch(match);
    return `
    <article class="match-card">
      <div class="match-card-top">
        <div class="match-identity"><span class="result-badge ${match.result}">${resultLetter(match.result)}</span><div><h3>${escapeHTML(match.opponent)}</h3><p>${escapeHTML(match.map)} <span class="muted-dot">·</span> ${escapeHTML(match.format || "Single map")} <span class="muted-dot">·</span> ${escapeHTML(formatDate(match.date))}</p></div></div>
        <span class="match-score">${match.scoreFor} <span class="muted-dot">:</span> ${match.scoreAgainst}</span>
      </div>
      <div class="match-details"><div>
        ${match.notes ? `<p class="match-notes">${escapeHTML(match.notes)}</p>` : `<p class="match-notes muted">No takeaway noted for this match.</p>`}
        <div class="match-meta">${match.focus ? `<span class="tag focus">Focus: ${escapeHTML(match.focus)}</span>` : ""}${match.side ? `<span class="tag">${escapeHTML(match.side)} start</span>` : ""}${players.map(player => `<span class="tag">${escapeHTML(player.displayName)}</span>`).join("")}</div>
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

async function openTeamPanel() {
  await refreshTeamData(false);
  const requestsMarkup = pendingRequests.length
    ? pendingRequests.map(request => `
      <div class="request-row">
        <div class="roster-person"><span class="player-avatar">${escapeHTML([...request.displayName][0]?.toUpperCase() || "?")}</span>
          <div><strong>${escapeHTML(request.displayName)}</strong><small>${escapeHTML(request.email)} · wants to join</small></div></div>
        <div class="request-actions"><button class="button button-primary" data-approve-player="${escapeHTML(request.id)}" type="button">Approve</button><button class="button button-quiet" data-reject-player="${escapeHTML(request.id)}" type="button">Decline</button></div>
      </div>`).join("")
    : `<p class="muted-inline">No membership requests right now.</p>`;
  const rosterMarkup = teamRoster.map(player => `
    <div class="roster-row"><div class="roster-person"><span class="player-avatar">${escapeHTML([...player.displayName][0]?.toUpperCase() || "?")}</span>
      <div><strong>${escapeHTML(player.displayName)}</strong><small>${escapeHTML(player.role === "captain" ? "Team captain" : "Approved player")}</small></div></div>
      <span class="tag">${player.role === "captain" ? "CAPTAIN" : "PLAYER"}</span>
    </div>`).join("");
  const codePanel = currentTeam.role === "captain"
    ? `<div class="join-code-panel"><div><small>Share this code with players to request access</small><strong id="captain-team-code">${escapeHTML(currentTeam.joinCode)}</strong></div><button class="button button-quiet" id="copy-team-code" type="button">Copy</button></div>`
    : "";
  openModal({
    title: `${currentTeam.name} team`,
    eyebrow: currentTeam.role === "captain" ? "CAPTAIN CONTROLS" : "TEAM ROSTER",
    content: `${codePanel}
      ${currentTeam.role === "captain" ? `<h3 class="form-section-title">Pending requests <span class="tag">${pendingRequests.length}</span></h3><div class="request-list">${requestsMarkup}</div><div class="auth-divider">approved players</div>` : `<p class="form-hint">Your roster is shared with approved team members.</p>`}
      <div class="roster-list">${rosterMarkup || `<p class="muted-inline">No approved players yet.</p>`}</div>`
  });
}

async function renderServerSettings() {
  try {
    const config = await api("/api/app-config");
    openModal({
      title: "Hosted app address",
      eyebrow: "DESKTOP APP SETTINGS",
      content: `<p class="auth-copy">This is the hosted service address, not your team's name or join code. It connects the app to shared accounts and data.</p>
        <form id="server-settings-form">
          <p class="form-error" id="form-error" hidden></p>
          <div class="form-field"><label for="settings-server-address">Hosted app address</label><input class="form-control" id="settings-server-address" name="apiBaseUrl" type="url" maxlength="240" value="${escapeHTML(config.apiBaseUrl || "")}" required><span class="form-hint">The service address is stored on this device. Use HTTPS except for local development.</span></div>
          <div class="form-actions"><button class="button button-quiet" data-cancel-modal type="button">Cancel</button><button class="button button-primary" type="submit">Save and reconnect</button></div>
        </form>`
    });
  } catch (error) {
    showToast(error.message || "Couldn't read the desktop app settings.", "error");
  }
}

async function handleAuthSubmit(form) {
  const values = new FormData(form);
  const payload = Object.fromEntries(values.entries());
  try {
    if (form.id === "server-setup-form") {
      const result = await api("/api/app-config", {
        method: "PUT",
        body: JSON.stringify(payload)
      });
      if (!result.configured) throw new Error("The team server address was not saved.");
      window.location.reload();
      return;
    }
    if (form.id === "server-settings-form") {
      const result = await api("/api/app-config", {
        method: "PUT",
        body: JSON.stringify(payload)
      });
      if (!result.configured) throw new Error("The team server address was not saved.");
      window.location.reload();
      return;
    }
    if (form.id === "register-form") {
      await api("/api/auth/register", { method: "POST", body: JSON.stringify(payload) });
      await refreshIdentity();
      return;
    }
    if (form.id === "login-form") {
      await api("/api/auth/login", { method: "POST", body: JSON.stringify(payload) });
      await refreshIdentity();
      return;
    }
    if (form.id === "create-team-form") {
      await api("/api/teams", { method: "POST", body: JSON.stringify(payload) });
      await refreshIdentity();
      showToast("Team created. Share the join code from Team settings.");
      return;
    }
    if (form.id === "join-team-form") {
      const result = await api("/api/teams/join", { method: "POST", body: JSON.stringify(payload) });
      await refreshIdentity();
      showToast(result.message);
    }
  } catch (error) {
    if (form.id === "server-setup-form") {
      renderServerSetup(error.message);
      return;
    }
    if (form.id === "server-settings-form") {
      const errorPanel = form.querySelector("#form-error");
      if (errorPanel) {
        errorPanel.textContent = error.message;
        errorPanel.hidden = false;
      }
      return;
    }
    const errorPanel = dom.authContent.querySelector(".auth-error");
    if (errorPanel) errorPanel.textContent = error.message;
    else showAuthScreen(`<p class="auth-error" role="alert">${escapeHTML(error.message)}</p><button class="button button-quiet" id="back-to-login" type="button">Back to sign in</button>`);
  }
}

async function signOut() {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch (error) {
    console.error("Unable to sign out cleanly.", error);
  }
  currentUser = null;
  saveGeneration++;
  currentTeam = null;
  teamRoster = [];
  pendingRequests = [];
  setBrand("");
  renderLogin();
}

async function handleTeamRequest(userId, approve) {
  try {
    const endpoint = `/api/teams/${encodeURIComponent(currentTeam.id)}/requests/${encodeURIComponent(userId)}`;
    await api(approve ? `${endpoint}/approve` : endpoint, {
      method: approve ? "POST" : "DELETE",
      ...(approve ? { body: JSON.stringify({}) } : {})
    });
    await refreshTeamData(true);
    await openTeamPanel();
    showToast(approve ? "Player approved and added to the roster." : "Request declined.");
  } catch (error) {
    showToast(error.message || "Couldn't update the team request.", "error");
  }
}

async function copyTeamCode() {
  try {
    await navigator.clipboard.writeText(currentTeam.joinCode);
    showToast("Team code copied.");
  } catch (error) {
    console.error("Unable to copy the team code.", error);
    showToast("Couldn't copy the team code. Select and copy it instead.", "error");
  }
}

function openMatchForm() {
  const today = new Date().toISOString().slice(0, 10);
  const rosterChoices = teamRoster.map(player => `
    <label class="roster-checkbox"><input type="checkbox" name="playerIds" value="${escapeHTML(player.id)}"><span>${escapeHTML(player.displayName)}${player.role === "captain" ? " · captain" : ""}</span></label>`).join("");
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
        <div class="form-field full"><label>Players who played <span class="optional">· optional</span></label>${rosterChoices ? `<div class="roster-select">${rosterChoices}</div>` : `<span class="muted-inline">Your approved team roster will appear here.</span>`}</div>
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
    playerIds: values.getAll("playerIds").map(String),
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
  const nameSlug = (currentTeam?.name || "vanta").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  link.download = `${nameSlug || "vanta"}-team-desk-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast("Workspace exported. Send the JSON file to your team.");
}

async function importWorkspace(file) {
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data?.version !== 1 || !Array.isArray(data.matches) || !Array.isArray(data.plays)) {
      throw new Error("This doesn't look like a VANTA Team Desk export.");
    }
    const matches = data.matches.map(match => ({
      ...match,
      format: match.format || "Single map",
      playerIds: Array.isArray(match.playerIds)
        ? match.playerIds.filter(id => teamRoster.some(player => player.id === id))
        : []
    })).filter(isValidMatch);
    const plays = data.plays.filter(isValidPlay);
    if (matches.length !== data.matches.length || plays.length !== data.plays.length) {
      throw new Error("Some records in that file were incomplete or not supported. Nothing was imported.");
    }
    const matchIds = new Set(workspace.matches.map(match => match.id));
    const playIds = new Set(workspace.plays.map(play => play.id));
    const newMatches = matches.filter(match => !matchIds.has(match.id));
    const newPlays = plays.filter(play => !playIds.has(play.id));
    workspace.matches.push(...newMatches);
    workspace.plays.push(...newPlays);
    saveWorkspace();
    renderAll();
    showToast(`Imported ${newMatches.length} matches and ${newPlays.length} plays.`);
  } catch (error) {
    console.error("Unable to import workspace.", error);
    showToast(error.message || "Couldn't read that workspace file.", "error");
  } finally {
    document.querySelector("#import-file").value = "";
  }
}

function loadDemoWorkspace() {
  if ((workspace.matches.length || workspace.plays.length) && !window.confirm("Add the demo entries to your current workspace? Existing records will stay.")) return;
  const today = new Date();
  const dateOffset = offset => {
    const date = new Date(today);
    date.setDate(date.getDate() - offset);
    return date.toISOString().slice(0, 10);
  };
  const demoMatches = [
    { id: crypto.randomUUID(), date: dateOffset(1), opponent: "Tuesday Scrim", map: "Ascent", format: "Single map", result: "win", scoreFor: 13, scoreAgainst: 9, playerIds: [], side: "Attack", focus: "Trading", notes: "Our mid-round trades were stronger when the second player waited for contact instead of rushing the fight." },
    { id: crypto.randomUUID(), date: dateOffset(3), opponent: "Practice Set", map: "Haven", format: "Single map", result: "loss", scoreFor: 10, scoreAgainst: 13, playerIds: [], side: "Defense", focus: "Communication", notes: "We had a few late retake calls. Try naming the regroup point before rotating." },
    { id: crypto.randomUUID(), date: dateOffset(5), opponent: "Friday Scrim", map: "Bind", format: "Single map", result: "win", scoreFor: 13, scoreAgainst: 7, playerIds: [], side: "Defense", focus: "Utility", notes: "Early information utility helped us save the site setup for the execute." }
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
  if (target.id === "quick-add-match" || target.id === "add-match-button") openMatchForm();
  if (target.id === "add-play-button") openPlayForm();
  if (target.id === "close-modal" || target.hasAttribute("data-cancel-modal")) closeModal();
  if (target.dataset.deleteMatch) removeMatch(target.dataset.deleteMatch);
  if (target.dataset.deletePlay) removePlay(target.dataset.deletePlay);
  if (target.dataset.editPlay) {
    const play = workspace.plays.find(item => item.id === target.dataset.editPlay);
    if (play) openPlayForm(play);
  }
  if (target.dataset.filter) {
    activeFilter = target.dataset.filter;
    document.querySelectorAll(".filter-tab").forEach(tab => tab.classList.toggle("selected", tab === target));
    renderMatches();
  }
  if (target.id === "export-button") exportWorkspace();
  if (target.id === "import-button") document.querySelector("#import-file").click();
  if (target.id === "demo-button") loadDemoWorkspace();
  if (target.dataset.authPage) renderLogin(target.dataset.authPage);
  if (target.id === "team-button") openTeamPanel().catch(error => showToast(error.message, "error"));
  if (target.id === "logout-button" || target.id === "gate-logout") signOut();
  if (target.id === "copy-team-code") copyTeamCode();
  if (target.dataset.approvePlayer) handleTeamRequest(target.dataset.approvePlayer, true);
  if (target.dataset.rejectPlayer) handleTeamRequest(target.dataset.rejectPlayer, false);
  if (target.id === "retry-connection") boot();
  if (target.id === "server-settings-button") renderServerSettings();
  if (target.id === "back-to-login") renderLogin();
});

document.addEventListener("submit", event => {
  if (["register-form", "login-form", "create-team-form", "join-team-form", "server-setup-form", "server-settings-form"].includes(event.target.id)) {
    event.preventDefault();
    handleAuthSubmit(event.target);
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
document.addEventListener("change", event => {
  if (event.target.id === "match-format") updateScoreInputs(event.target.value);
});
document.querySelector("#import-file").addEventListener("change", event => importWorkspace(event.target.files[0]));
dom.modal.addEventListener("click", event => {
  if (event.target === dom.modal) closeModal();
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !dom.modal.hidden) closeModal();
});

setBrand("");
renderLogin();
boot();
