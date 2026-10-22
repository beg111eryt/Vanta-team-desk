import { createClient } from "@supabase/supabase-js";
import "./app.js";

const CONFIG_KEY = "vanta-team-service-v1";
const ROLE_OPTIONS = [
  ["main_roster", "Main roster"],
  ["main_substitute", "Main substitute"],
  ["substitute", "Substitute"],
  ["tryout", "Tryout"],
  ["coach", "Coach"]
];

let supabase;
let authSubscription;
let currentUser = null;
let currentProfile = null;
let memberships = [];
let activeMembership = null;
let activeTeam = null;
let createdTeam = null;
let createdCode = "";
let teamSubscription = null;
let chatSubscription = null;
let availabilitySubscription = null;
let pendingSubscription = null;
let activeChatId = "";
let messageRequest = 0;
let availabilityRequest = 0;
let passwordRecoveryPending = false;
let routedUserId = null;
let routingRequest = 0;

function loadConfig() {
  try {
    return JSON.parse(localStorage.getItem(CONFIG_KEY) || "null");
  } catch (error) {
    console.error("Unable to read the saved service connection.", error);
    return null;
  }
}

async function subscribePendingMembership() {
  if (pendingSubscription) await supabase.removeChannel(pendingSubscription);
  if (!currentUser) return;
  pendingSubscription = supabase.channel(`pending-membership-${currentUser.id}`)
    .on("postgres_changes", {
      event: "UPDATE", schema: "public", table: "team_memberships", filter: `user_id=eq.${currentUser.id}`
    }, payload => {
      if (payload.new?.status === "approved") {
        routeUser(currentUser, true).then(() => showFlowToast("Your team request was approved."));
      } else if (payload.new?.status === "rejected") {
        routeUser(currentUser, true).then(() => showFlowToast("The team admin declined the join request.", true));
      }
    })
    .subscribe();
}

function errorText(error) {
  return error?.message || "Something went wrong. Please try again.";
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function showScreen(screenId) {
  document.querySelectorAll(".flow-screen").forEach(screen => { screen.hidden = screen.id !== screenId; });
  document.querySelector("#app-shell").hidden = true;
  window.scrollTo({ top: 0, behavior: "instant" });
}

function showFlowToast(message, isError = false) {
  const region = document.querySelector("#flow-toast");
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  if (isError) toast.style.borderLeftColor = "var(--accent)";
  region.append(toast);
  window.setTimeout(() => toast.remove(), 4500);
}

function setError(elementId, message) {
  const element = document.querySelector(`#${elementId}`);
  if (!element) return;
  element.textContent = message;
  element.hidden = !message;
}

function generateTeamCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let binary = "";
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function selectedTeam(row) {
  return Array.isArray(row.teams) ? row.teams[0] : row.teams;
}

function saveConfig(projectUrl, anonKey) {
  const parsed = new URL(projectUrl);
  const localDevelopment = ["localhost", "127.0.0.1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(localDevelopment && parsed.protocol === "http:")) {
    throw new Error("Use your HTTPS Supabase project URL.");
  }
  const key = anonKey.trim();
  if (!key) throw new Error("Enter the public anon or publishable key.");
  if (/^sb_secret_/i.test(key)) {
    throw new Error("Secret keys cannot be used in the desktop app. Enter the public anon or publishable key.");
  }
  const jwtParts = key.split(".");
  if (jwtParts.length === 3) {
    let claims;
    try {
      const jwtPayload = jwtParts[1];
      const base64 = jwtPayload.replace(/-/g, "+").replace(/_/g, "/");
      claims = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")));
    } catch {
      throw new Error("Enter a valid public anon or publishable key.");
    }
    if (!claims || typeof claims !== "object") {
      throw new Error("Enter a valid public anon or publishable key.");
    }
    if (["service_role", "supabase_admin"].includes(claims.role)) {
      throw new Error("Secret keys cannot be used in the desktop app. Enter the public anon or publishable key.");
    }
  }
  const saved = { url: parsed.origin, anonKey: key };
  localStorage.setItem(CONFIG_KEY, JSON.stringify(saved));
  return saved;
}

function removeRealtimeChannels() {
  const channels = [teamSubscription, chatSubscription, availabilitySubscription, pendingSubscription].filter(Boolean);
  teamSubscription = null;
  chatSubscription = null;
  availabilitySubscription = null;
  pendingSubscription = null;
  return Promise.all(channels.map(channel => supabase.removeChannel(channel)));
}

function initializeSupabase(savedConfig) {
  if (authSubscription) {
    authSubscription.unsubscribe();
    authSubscription = null;
  }
  const projectHost = new URL(savedConfig.url).hostname;
  const projectStatus = document.querySelector("#connection-project");
  projectStatus.textContent = `Connected Supabase project: ${projectHost}. This must be the project where Discord is enabled.`;
  projectStatus.hidden = false;
  supabase = createClient(savedConfig.url, savedConfig.anonKey, {
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: false,
      flowType: "pkce",
      persistSession: true,
      storageKey: `vanta-auth-${new URL(savedConfig.url).hostname}`
    }
  });
  const { data } = supabase.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_OUT") {
      routingRequest++;
      removeRealtimeChannels().catch(error => console.error("Unable to close team realtime channels.", error));
      currentUser = null;
      currentProfile = null;
      memberships = [];
      activeMembership = null;
      activeTeam = null;
      routedUserId = null;
      document.querySelector("#app-shell").hidden = true;
      showScreen("auth-screen");
      return;
    }
    if (event === "PASSWORD_RECOVERY") {
      passwordRecoveryPending = true;
      showPasswordRecovery();
      return;
    }
    if (session?.user) {
      const eventRequest = routingRequest;
      window.setTimeout(() => {
        if (routingRequest === eventRequest) routeUser(session.user);
      }, 0);
    }
  });
  authSubscription = data.subscription;
}

async function start() {
  showScreen("opening-screen");
  const savedConfig = loadConfig();
  window.setTimeout(async () => {
    if (!savedConfig) {
      document.querySelector("#connection-setup").open = true;
      showScreen("auth-screen");
      setError("auth-error", "Connect a Supabase project to enable accounts, teams, and shared chat.");
      return;
    }
    try {
      initializeSupabase(savedConfig);
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;
      if (data.session?.user) await routeUser(data.session.user);
      else showScreen("auth-screen");
    } catch (error) {
      console.error("Unable to connect to the team service.", error);
      showScreen("auth-screen");
      setError("auth-error", `Could not connect: ${errorText(error)}`);
    }
  }, 1550);
}

async function routeUser(user, force = false) {
  if (!supabase || !user) return;
  if (!force && routedUserId === user.id) return;
  const request = ++routingRequest;
  currentUser = user;
  document.querySelector("#app-shell").hidden = true;
  try {
    const displayName = String(user.user_metadata?.display_name || user.user_metadata?.full_name || user.email?.split("@")[0] || "Player").slice(0, 40);
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .upsert({ id: user.id, display_name: displayName }, { onConflict: "id" })
      .select("id,display_name,avatar_url")
      .single();
    if (profileError) throw profileError;
    if (request !== routingRequest || currentUser?.id !== user.id) return;
    currentProfile = profile;

    const { data, error } = await supabase
      .from("team_memberships")
      .select("id,team_id,user_id,role,is_admin,status,created_at,teams!inner(id,name,tag,description,region,timezone,logo_url)")
      .eq("user_id", user.id)
      .order("created_at", { ascending: true });
    if (error) throw error;
    if (request !== routingRequest || currentUser?.id !== user.id) return;
    memberships = data || [];
    routedUserId = user.id;
    const approved = memberships.filter(row => row.status === "approved" && selectedTeam(row));
    if (approved.length === 1) {
      await enterTeam(approved[0], request);
    } else if (approved.length > 1) {
      renderTeamPicker(approved);
      showScreen("team-picker-screen");
    } else {
      const pending = memberships.find(row => row.status === "pending");
      if (pending) {
        document.querySelector("#pending-team-name").textContent = selectedTeam(pending)?.name || "the team";
        showScreen("pending-screen");
        await subscribePendingMembership();
      } else {
        showScreen("team-choice-screen");
      }
    }
  } catch (error) {
    if (request !== routingRequest || currentUser?.id !== user.id) return;
    console.error("Unable to load account and team memberships.", error);
    showScreen("auth-screen");
    setError("auth-error", `Could not load your account: ${errorText(error)}`);
  }
}

function renderTeamPicker(approved) {
  document.querySelector("#team-picker-list").innerHTML = approved.map(row => {
    const team = selectedTeam(row);
    return `<button class="team-picker-option" data-select-team="${escapeHTML(row.id)}" type="button">
      <span class="team-avatar">${team.logo_url ? `<img src="${escapeHTML(team.logo_url)}" alt="">` : escapeHTML((team.tag || team.name).slice(0, 2).toUpperCase())}</span>
      <span><strong>${escapeHTML(team.name)}</strong><small>${escapeHTML(roleLabel(row.role))}${row.is_admin ? " · Admin" : ""}</small></span><span aria-hidden="true">→</span>
    </button>`;
  }).join("");
}

function roleLabel(role) {
  return ROLE_OPTIONS.find(([value]) => value === role)?.[1] || "Member";
}

async function enterTeam(row, request = routingRequest) {
  const team = selectedTeam(row);
  if (!team || row.status !== "approved" || request !== routingRequest) return;
  if (pendingSubscription) await supabase.removeChannel(pendingSubscription);
  pendingSubscription = null;
  if (chatSubscription) await supabase.removeChannel(chatSubscription);
  chatSubscription = null;
  activeMembership = row;
  activeTeam = team;
  document.querySelector("#pending-count").textContent = "";
  activeChatId = "";
  document.querySelector("#active-team-name").textContent = team.name;
  document.querySelector("#team-brand").textContent = team.tag || team.name;
  document.querySelector("#brand-breadcrumb").textContent = team.tag || team.name;
  const teamMark = document.querySelector("#team-mark");
  teamMark.innerHTML = team.logo_url
    ? `<img src="${escapeHTML(team.logo_url)}" alt="">`
    : escapeHTML(team.tag ? team.tag.slice(0, 1).toUpperCase() : team.name.slice(0, 1).toUpperCase());
  await subscribeTeam();
  if (request !== routingRequest || currentUser?.id !== row.user_id) return;
  window.startWorkspaceApp(team);
  showScreen("");
  document.querySelector("#app-shell").hidden = false;
  refreshPendingCount();
}

async function refreshMemberships() {
  if (!currentUser) return [];
  const { data, error } = await supabase
    .from("team_memberships")
    .select("id,team_id,user_id,role,is_admin,status,created_at,teams!inner(id,name,tag,description,region,timezone,logo_url)")
    .eq("user_id", currentUser.id)
    .order("created_at", { ascending: true });
  if (error) throw error;
  memberships = data || [];
  return memberships;
}

async function handleAuthSubmit(form) {
  if (!supabase) {
    setError("auth-error", "Connect your Supabase project first.");
    document.querySelector("#connection-setup").open = true;
    return;
  }
  const values = new FormData(form);
  const email = String(values.get("email")).trim();
  const password = String(values.get("password"));
  const isSignup = form.dataset.mode === "signup";
  const submit = document.querySelector("#auth-submit");
  submit.disabled = true;
  setError("auth-error", "");
  try {
    const result = isSignup
      ? await supabase.auth.signUp({
        email,
        password,
        options: {
          data: { display_name: String(values.get("displayName")).trim() },
          emailRedirectTo: "vantateamdesk://auth/callback"
        }
      })
      : await supabase.auth.signInWithPassword({ email, password });
    if (result.error) throw result.error;
    if (isSignup && !result.data.session) {
      setError("auth-error", "Account created. Check your email to confirm the address, then sign in here.");
    } else if (result.data.user) {
      await routeUser(result.data.user, true);
    }
  } catch (error) {
    setError("auth-error", errorText(error));
  } finally {
    submit.disabled = false;
  }
}

async function startProviderSignIn(provider) {
  if (!supabase) {
    document.querySelector("#connection-setup").open = true;
    setError("auth-error", "Connect your Supabase project first.");
    return;
  }
  try {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: "vantateamdesk://auth/callback", skipBrowserRedirect: true }
    });
    if (error) throw error;
    if (!data.url) throw new Error("The identity provider did not return a sign-in URL.");
    await window.vantaDesktop.openExternal(data.url);
  } catch (error) {
    setError("auth-error", errorText(error));
  }
}

async function finishAuthCallback(value) {
  if (!supabase || !value) return;
  try {
    const callback = new URL(value);
    const providerError = callback.searchParams.get("error_description") || callback.searchParams.get("error");
    if (providerError) throw new Error(providerError);
    const code = callback.searchParams.get("code");
    if (!code) throw new Error("The sign-in callback did not include an authorization code.");
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) throw error;
    if (passwordRecoveryPending) showPasswordRecovery();
    else if (data.user) await routeUser(data.user, true);
  } catch (error) {
    console.error("Sign-in callback could not be completed.", error);
    showScreen("auth-screen");
    setError("auth-error", `Sign-in could not be completed: ${errorText(error)}`);
  }
}

function showPasswordRecovery() {
  showScreen("auth-screen");
  document.querySelector("#password-recovery-panel").hidden = false;
  document.querySelector("#auth-form").hidden = true;
  document.querySelector(".auth-mode-switch").hidden = true;
  document.querySelector("#reset-password").hidden = true;
  document.querySelector(".auth-divider").hidden = true;
  document.querySelector(".auth-providers").hidden = true;
  document.querySelector(".riot-provider-note").hidden = true;
  setError("reset-error", "");
}

function showSignInForm() {
  passwordRecoveryPending = false;
  document.querySelector("#password-recovery-panel").hidden = true;
  document.querySelector("#auth-form").hidden = false;
  document.querySelector(".auth-mode-switch").hidden = false;
  document.querySelector(".auth-divider").hidden = false;
  document.querySelector(".auth-providers").hidden = false;
  document.querySelector(".riot-provider-note").hidden = false;
  document.querySelector("#reset-password").hidden = document.querySelector("#auth-form").dataset.mode === "signup";
  setError("auth-error", "");
}

async function createTeam(form) {
  if (!supabase || !currentUser) return setError("team-error", "Sign in before creating a team.");
  const values = new FormData(form);
  const name = String(values.get("name")).trim();
  const tag = String(values.get("tag") || "").trim();
  const description = String(values.get("description") || "").trim();
  const region = String(values.get("region") || "Europe");
  const logo = values.get("logo");
  if (!name) return setError("team-error", "Enter a team name.");
  if (logo?.size > 5 * 1024 * 1024) return setError("team-error", "The team picture must be 5 MB or smaller.");
  if (logo?.size && !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(logo.type)) {
    return setError("team-error", "Use a PNG, JPEG, WebP, or GIF team picture.");
  }

  const code = generateTeamCode();
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  setError("team-error", "");
  try {
    const { data: teamId, error } = await supabase.rpc("create_team", {
      p_name: name, p_tag: tag, p_description: description, p_region: region,
      p_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", p_join_code: code
    });
    if (error) throw error;
    createdCode = code;
    const { data: team, error: teamError } = await supabase
      .from("teams")
    .select("id,name,tag,description,region,timezone,logo_url")
      .eq("id", teamId)
      .single();
    if (teamError) throw teamError;
    createdTeam = team;
    if (logo?.size) {
      try {
        const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" }[logo.type];
        const path = `${teamId}/logo.${ext}`;
        const { error: uploadError } = await supabase.storage.from("team-logos")
          .upload(path, logo, { upsert: true, contentType: logo.type });
        if (uploadError) throw uploadError;
        const { data: publicFile } = supabase.storage.from("team-logos").getPublicUrl(path);
        const { error: updateError } = await supabase.from("teams").update({ logo_url: publicFile.publicUrl }).eq("id", teamId);
        if (updateError) throw updateError;
        createdTeam.logo_url = publicFile.publicUrl;
      } catch (uploadError) {
        showFlowToast(`Team created, but its picture could not be uploaded: ${errorText(uploadError)}`, true);
      }
    }
    document.querySelector("#team-code-value").textContent = createdCode;
    document.querySelector("#created-team-code").hidden = false;
    await refreshMemberships();
  } catch (error) {
    setError("team-error", errorText(error));
  } finally {
    submit.disabled = false;
  }
}

async function joinTeam(form) {
  const code = String(new FormData(form).get("code") || "").trim();
  setError("join-error", "");
  if (!/^[A-Za-z0-9_-]{32}$/.test(code)) {
    setError("join-error", "Enter the complete 32-character team code.");
    return;
  }
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const { data, error } = await supabase.rpc("request_team_join", { p_join_code: code });
    if (error) throw error;
    const request = Array.isArray(data) ? data[0] : data;
    document.querySelector("#pending-team-name").textContent = request?.team_name || "the team";
    await routeUser(currentUser, true);
    showFlowToast("Join request sent. A team admin must approve it.");
  } catch (error) {
    setError("join-error", errorText(error));
  } finally {
    submit.disabled = false;
  }
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const input = document.createElement("textarea");
    input.value = value;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.append(input);
    input.select();
    const copied = document.execCommand("copy");
    input.remove();
    if (!copied) throw new Error("Copy failed. Select and copy the code manually.");
  }
  showFlowToast("Team code copied. Keep it private and share it only with invited teammates.");
}

async function signOut() {
  if (!supabase) return;
  await removeRealtimeChannels();
  const { error } = await supabase.auth.signOut();
  if (error) showFlowToast(errorText(error), true);
  else {
    currentUser = null;
    activeTeam = null;
    activeMembership = null;
    document.querySelector("#app-shell").hidden = true;
    showScreen("auth-screen");
  }
}

async function subscribeTeam() {
  if (teamSubscription) await supabase.removeChannel(teamSubscription);
  if (availabilitySubscription) await supabase.removeChannel(availabilitySubscription);
  if (!activeTeam) return;
  teamSubscription = supabase.channel(`team-members-${activeTeam.id}`)
    .on("postgres_changes", {
      event: "*", schema: "public", table: "team_memberships", filter: `team_id=eq.${activeTeam.id}`
    }, payload => {
      refreshPendingCount();
      const pending = payload.new?.status === "pending";
      if (activeMembership.is_admin && pending && payload.eventType === "INSERT") {
        showFlowToast("New team join request received.");
      }
      if (payload.new?.user_id === currentUser.id && payload.new?.status === "approved") {
        const nextMembership = memberships.find(row => row.id === payload.new.id);
        if (nextMembership) {
          nextMembership.role = payload.new.role;
          nextMembership.is_admin = payload.new.is_admin;
          if (nextMembership.id === activeMembership.id) {
            activeMembership.role = payload.new.role;
            activeMembership.is_admin = payload.new.is_admin;
          }
          if (document.querySelector("#view-chat").classList.contains("active")) renderChat();
          if (document.querySelector("#view-coach").classList.contains("active")) renderCoachHub();
        }
      }
      if (document.querySelector("#view-roster").classList.contains("active")) renderRoster();
    })
    .subscribe();
  availabilitySubscription = supabase.channel(`team-availability-${activeTeam.id}`)
    .on("postgres_changes", {
      event: "*", schema: "public", table: "team_availability", filter: `team_id=eq.${activeTeam.id}`
    }, () => {
      if (document.querySelector("#view-availability").classList.contains("active")) renderTeamAvailability();
    })
    .subscribe();
}

async function refreshPendingCount() {
  if (!activeTeam || !activeMembership?.is_admin) return;
  const { count, error } = await supabase.from("team_memberships")
    .select("id", { count: "exact", head: true })
    .eq("team_id", activeTeam.id).eq("status", "pending");
  if (error) {
    console.error("Unable to refresh pending team requests.", error);
    return;
  }
  document.querySelector("#pending-count").textContent = count ? String(count) : "";
}

async function renderRoster() {
  const container = document.querySelector("#roster-content");
  if (!activeTeam) return;
  const admin = activeMembership.is_admin;
  document.querySelector("#team-code-button").hidden = !admin;
  container.innerHTML = `<section class="panel team-list-panel"><p class="form-hint">Loading roster…</p></section>`;
  let query = supabase.from("team_memberships")
    .select("id,user_id,role,is_admin,status,created_at,profiles!team_memberships_profile_fkey(display_name)")
    .eq("team_id", activeTeam.id)
    .order("created_at", { ascending: true });
  if (!admin) query = query.eq("status", "approved");
  const { data, error } = await query;
  if (error) {
    container.innerHTML = `<section class="panel team-list-panel"><p class="form-error">${escapeHTML(errorText(error))}</p></section>`;
    return;
  }
  const pending = (data || []).filter(member => member.status === "pending");
  const accepted = (data || []).filter(member => member.status === "approved");
  container.innerHTML = `${admin && pending.length ? `<section class="panel team-list-panel"><div class="panel-heading"><div><p class="eyebrow">NEEDS A DECISION</p><h2>Join requests <span class="pending-pill">${pending.length}</span></h2></div></div><div class="roster-list">${pending.map(member => `
    <article class="roster-row"><div><strong>${escapeHTML(member.profiles?.display_name || "Player")}</strong><small>Requested ${escapeHTML(new Date(member.created_at).toLocaleDateString())}</small></div><span class="role-pill">Awaiting approval</span><div class="roster-actions"><button class="button button-quiet" data-review-member="${escapeHTML(member.id)}" data-decision="rejected" type="button">Decline</button><button class="button button-primary" data-review-member="${escapeHTML(member.id)}" data-decision="approved" type="button">Approve as tryout</button></div></article>`).join("")}</div></section>` : ""}
    <section class="panel team-list-panel"><div class="panel-heading"><div><p class="eyebrow">APPROVED MEMBERS</p><h2>${escapeHTML(activeTeam.name)} roster <span class="subtle-label">· ${accepted.length}</span></h2></div></div>
      <div class="roster-list">${accepted.map(member => {
        const name = member.profiles?.display_name || "Player";
        return `<article class="roster-row"><div class="roster-member-name"><span class="player-avatar">${escapeHTML([...name][0]?.toUpperCase() || "?")}</span><span><strong>${escapeHTML(name)}${member.user_id === currentUser.id ? " (you)" : ""}</strong><small>${member.is_admin ? "Team admin" : "Team member"}</small></span></div>
          ${admin ? `<form class="member-access-form" data-membership-id="${escapeHTML(member.id)}"><select name="role" class="select-control" aria-label="Role for ${escapeHTML(name)}">${ROLE_OPTIONS.map(([value, label]) => `<option value="${value}" ${member.role === value ? "selected" : ""}>${label}</option>`).join("")}</select><label class="admin-check"><input type="checkbox" name="isAdmin" ${member.is_admin ? "checked" : ""}> Admin</label><button class="button button-quiet" type="submit">Save role</button></form>` : `<span class="role-pill">${escapeHTML(roleLabel(member.role))}${member.is_admin ? " · Admin" : ""}</span>`}
        </article>`;
      }).join("")}</div></section>`;
}

async function reviewMember(button) {
  button.disabled = true;
  try {
    const { error } = await supabase.rpc("set_membership_status", {
      p_membership_id: button.dataset.reviewMember,
      p_status: button.dataset.decision
    });
    if (error) throw error;
    await renderRoster();
    await refreshPendingCount();
    showFlowToast(button.dataset.decision === "approved" ? "Member approved. Set their roster role below." : "Join request declined.");
  } catch (error) {
    button.disabled = false;
    showFlowToast(errorText(error), true);
  }
}

async function updateMemberAccess(form) {
  const values = new FormData(form);
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const { error } = await supabase.rpc("set_member_access", {
      p_membership_id: form.dataset.membershipId,
      p_role: String(values.get("role")),
      p_is_admin: values.get("isAdmin") === "on"
    });
    if (error) throw error;
    if (form.dataset.membershipId === activeMembership.id) {
      activeMembership.role = String(values.get("role"));
      activeMembership.is_admin = values.get("isAdmin") === "on";
    }
    await renderRoster();
    await refreshPendingCount();
    showFlowToast("Team role updated.");
  } catch (error) {
    showFlowToast(errorText(error), true);
  } finally {
    submit.disabled = false;
  }
}

async function generateInviteCode() {
  if (!activeTeam || !activeMembership?.is_admin) return;
  const code = generateTeamCode();
  try {
    const { error } = await supabase.rpc("regenerate_team_code", { p_team_id: activeTeam.id, p_join_code: code });
    if (error) throw error;
    document.querySelector("#new-team-code-value").textContent = code;
    document.querySelector("#team-code-modal").hidden = false;
  } catch (error) {
    showFlowToast(errorText(error), true);
  }
}

async function renderCoachHub() {
  if (!activeTeam) return;
  const container = document.querySelector("#coach-content");
  const canFeedback = activeMembership.is_admin || activeMembership.role === "coach";
  const canVod = activeMembership.is_admin || ["main_roster", "main_substitute"].includes(activeMembership.role);
  container.innerHTML = `<div class="coach-layout">${canFeedback || canVod ? `<section class="panel coach-compose-panel"><p class="eyebrow">SHARE WITH THE TEAM</p><h2>New post</h2><form id="coach-post-form" class="flow-form"><p class="form-error" id="coach-error" hidden></p><div class="coach-post-tabs">${canFeedback ? `<button class="selected" data-post-kind="feedback" type="button">Coach feedback</button>` : ""}${canVod ? `<button class="${canFeedback ? "" : "selected"}" data-post-kind="vod" type="button">Share a VOD</button>` : ""}</div><input type="hidden" name="kind" value="${canFeedback ? "feedback" : "vod"}"><label class="form-field"><span id="coach-title-label">${canFeedback ? "Feedback title" : "VOD title"}</span><input class="form-control" name="title" maxlength="100" required placeholder="${canFeedback ? "A point to carry into the next scrim" : "Map, opponent, or round" }"></label><label class="form-field coach-vod-url" ${canFeedback ? "hidden" : ""}><span>VOD link</span><input class="form-control" name="vodUrl" type="url" maxlength="1000" placeholder="https://…"></label><label class="form-field"><span id="coach-body-label">${canFeedback ? "Feedback" : "Context (optional)"}</span><textarea class="form-control" name="body" maxlength="4000" ${canFeedback ? "required" : ""} placeholder="${canFeedback ? "Specific, constructive feedback and what to try next." : "Timestamp, round, or a note for the reviewers."}"></textarea></label><button class="button button-primary" type="submit">Post to team</button></form></section>` : `<section class="panel coach-compose-panel"><p class="eyebrow">READ-ONLY FOR YOUR ROLE</p><h2>Watch, learn, discuss.</h2><p class="form-hint">Coaches and admins can post feedback. Main roster and main substitutes can post VOD links.</p></section>`}<section class="coach-feed" id="coach-feed"><section class="panel team-list-panel"><p class="form-hint">Loading team posts…</p></section></section></div>`;
  const { data, error } = await supabase.from("coach_posts")
    .select("id,author_id,kind,title,body,vod_url,created_at,profiles!coach_posts_author_profile_fkey(display_name)")
    .eq("team_id", activeTeam.id).order("created_at", { ascending: false }).limit(100);
  const feed = document.querySelector("#coach-feed");
  if (error) {
    feed.innerHTML = `<section class="panel team-list-panel"><p class="form-error">${escapeHTML(errorText(error))}</p></section>`;
    return;
  }
  feed.innerHTML = data?.length ? data.map(post => `
    <article class="panel coach-post-card"><div class="coach-post-meta"><span class="role-pill">${post.kind === "feedback" ? "Coach feedback" : "VOD"}</span><span>${escapeHTML(post.profiles?.display_name || "Teammate")}</span><time>${escapeHTML(new Date(post.created_at).toLocaleString())}</time></div><h2>${escapeHTML(post.title)}</h2>${post.body ? `<p>${escapeHTML(post.body)}</p>` : ""}${post.vod_url ? `<a class="button button-quiet" href="${escapeHTML(post.vod_url)}" target="_blank" rel="noopener noreferrer">Open VOD link ↗</a>` : ""}</article>`).join("") : `<section class="panel team-list-panel"><p class="empty-state-copy">No posts yet. Share the first useful note or VOD.</p></section>`;
}

async function submitCoachPost(form) {
  const values = new FormData(form);
  const kind = String(values.get("kind"));
  const title = String(values.get("title") || "").trim();
  const body = String(values.get("body") || "").trim();
  const vodUrl = String(values.get("vodUrl") || "").trim();
  const allowed = kind === "feedback"
    ? activeMembership.is_admin || activeMembership.role === "coach"
    : activeMembership.is_admin || ["main_roster", "main_substitute"].includes(activeMembership.role);
  if (!allowed) return setError("coach-error", "Your team role cannot publish this post type.");
  if (!title) return setError("coach-error", "Enter a post title.");
  if (kind === "feedback" && !body) return setError("coach-error", "Add the feedback before posting.");
  if (kind === "vod") {
    try {
      if (new URL(vodUrl).protocol !== "https:") throw new Error();
    } catch {
      return setError("coach-error", "Use a valid HTTPS VOD link.");
    }
  }
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  setError("coach-error", "");
  try {
    const { error } = await supabase.from("coach_posts").insert({
      team_id: activeTeam.id, author_id: currentUser.id, kind, title, body, vod_url: kind === "vod" ? vodUrl : null
    });
    if (error) throw error;
    await renderCoachHub();
    showFlowToast(kind === "vod" ? "VOD shared with the team." : "Feedback posted.");
  } catch (error) {
    setError("coach-error", errorText(error));
  } finally {
    submit.disabled = false;
  }
}

function switchCoachPostKind(kind) {
  const form = document.querySelector("#coach-post-form");
  if (!form) return;
  const canFeedback = activeMembership.is_admin || activeMembership.role === "coach";
  const canVod = activeMembership.is_admin || ["main_roster", "main_substitute"].includes(activeMembership.role);
  if ((kind === "feedback" && !canFeedback) || (kind === "vod" && !canVod)) return;
  form.elements.kind.value = kind;
  form.querySelectorAll("[data-post-kind]").forEach(button => button.classList.toggle("selected", button.dataset.postKind === kind));
  const feedback = kind === "feedback";
  form.querySelector(".coach-vod-url").hidden = feedback;
  form.elements.vodUrl.required = !feedback;
  form.querySelector("#coach-title-label").textContent = feedback ? "Feedback title" : "VOD title";
  form.querySelector("#coach-body-label").textContent = feedback ? "Feedback" : "Context (optional)";
  form.elements.body.required = feedback;
  form.elements.body.placeholder = feedback ? "Specific, constructive feedback and what to try next." : "Timestamp, round, or a note for the reviewers.";
}

async function renderChat() {
  if (!activeTeam) return;
  const container = document.querySelector("#chat-content");
  container.innerHTML = `<section class="panel team-list-panel"><p class="form-hint">Loading chats…</p></section>`;
  const { data, error } = await supabase.from("chat_channels")
    .select("id,team_id,name,kind,allowed_roles,allowed_user_ids,created_at")
    .or(`team_id.is.null,team_id.eq.${activeTeam.id}`)
    .order("created_at", { ascending: true });
  if (error) {
    container.innerHTML = `<section class="panel team-list-panel"><p class="form-error">${escapeHTML(errorText(error))}</p></section>`;
    return;
  }
  const channels = data || [];
  if (!channels.some(channel => channel.id === activeChatId)) activeChatId = channels[0]?.id || "";
  const currentChannel = channels.find(channel => channel.id === activeChatId);
  const customForm = activeMembership.is_admin ? `<details class="custom-chat-create"><summary>Create a custom chat</summary><form id="custom-channel-form" class="flow-form"><p class="form-error" id="custom-chat-error" hidden></p><label class="form-field"><span>Chat name</span><input class="form-control" name="name" maxlength="48" minlength="2" required placeholder="e.g. Map pool discussion"></label><fieldset class="form-field"><legend>Allow roles</legend><div class="custom-role-list">${ROLE_OPTIONS.map(([role, label]) => `<label><input type="checkbox" name="roles" value="${role}"> ${label}</label>`).join("")}</div></fieldset><fieldset class="form-field"><legend>Also allow specific players</legend><div id="custom-user-list" class="custom-role-list">Loading roster…</div></fieldset><button class="button button-quiet" type="submit">Create chat</button></form></details>` : "";
  container.innerHTML = `<div class="chat-layout"><aside class="panel chat-sidebar"><div class="chat-sidebar-heading"><div><p class="eyebrow">CHANNELS</p><h2>Conversations</h2></div></div><div class="chat-channel-list">${channels.map(channel => `<div class="chat-channel-entry"><button class="chat-channel-button ${channel.id === activeChatId ? "selected" : ""}" data-chat-channel="${escapeHTML(channel.id)}" type="button"><span>${channel.kind === "global" ? "◎" : channel.kind === "main" ? "✦" : channel.kind === "custom" ? "◈" : "◌"}</span><span><strong>${escapeHTML(channel.name)}</strong><small>${channel.kind === "global" ? "English · all users" : channel.kind === "team" ? "Team, excluding tryouts" : channel.kind === "main" ? "Main roster + coaches" : "Selected roles and players"}</small></span></button>${activeMembership.is_admin && channel.kind === "custom" ? `<button class="chat-channel-delete" data-delete-channel="${escapeHTML(channel.id)}" title="Delete custom chat" aria-label="Delete ${escapeHTML(channel.name)}">×</button>` : ""}</div>`).join("") || `<p class="form-hint">No channels are available.</p>`}</div>${customForm}</aside>
    <section class="panel chat-window"><header class="chat-header"><div><p class="eyebrow">${currentChannel?.kind === "global" ? "OPEN COMMUNITY" : "PRIVATE TO YOUR TEAM"}</p><h2>${escapeHTML(currentChannel?.name || "No chat selected")}</h2></div><span class="live-status"><i></i> LIVE</span></header><div class="chat-messages" id="chat-messages" aria-live="polite"><p class="form-hint">Loading messages…</p></div><form id="chat-message-form" class="chat-composer" ${currentChannel ? "" : "hidden"}><label class="visually-hidden" for="chat-message">Message</label><textarea id="chat-message" class="form-control" name="body" maxlength="4000" rows="2" required placeholder="Write a message…"></textarea><button class="button button-primary" type="submit">Send</button></form></section></div>`;
  if (activeMembership.is_admin) await populateCustomUsers();
  await showChatMessages();
}

async function populateCustomUsers() {
  const list = document.querySelector("#custom-user-list");
  if (!list) return;
  const { data, error } = await supabase.from("team_memberships")
    .select("user_id,profiles!team_memberships_profile_fkey(display_name)")
    .eq("team_id", activeTeam.id).eq("status", "approved");
  if (error) {
    list.textContent = `Could not load members: ${errorText(error)}`;
    return;
  }
  list.innerHTML = (data || []).map(member => `<label><input type="checkbox" name="users" value="${escapeHTML(member.user_id)}"> ${escapeHTML(member.profiles?.display_name || "Player")}</label>`).join("");
}

async function showChatMessages() {
  const request = ++messageRequest;
  const channelId = activeChatId;
  const container = document.querySelector("#chat-messages");
  if (!container || !channelId) return;
  if (chatSubscription) await supabase.removeChannel(chatSubscription);
  const { data, error } = await supabase.from("chat_messages")
    .select("id,body,author_id,created_at,profiles!chat_messages_author_profile_fkey(display_name)")
    .eq("channel_id", channelId)
    .order("created_at", { ascending: false }).limit(100);
  if (request !== messageRequest) return;
  if (error) {
    container.innerHTML = `<p class="form-error">${escapeHTML(errorText(error))}</p>`;
    return;
  }
  const messages = (data || []).reverse();
  container.innerHTML = messages.length ? messages.map(message => `
    <article class="chat-message ${message.author_id === currentUser.id ? "mine" : ""}"><div class="chat-message-meta"><strong>${escapeHTML(message.profiles?.display_name || "Teammate")}</strong><time>${escapeHTML(new Date(message.created_at).toLocaleString())}</time></div><p>${escapeHTML(message.body)}</p></article>`).join("") : `<p class="chat-empty">No messages yet. Start the conversation.</p>`;
  container.scrollTop = container.scrollHeight;
  chatSubscription = supabase.channel(`chat-messages-${channelId}`)
    .on("postgres_changes", {
      event: "INSERT", schema: "public", table: "chat_messages", filter: `channel_id=eq.${channelId}`
    }, () => showChatMessages())
    .subscribe();
}

async function submitChatMessage(form) {
  const body = String(new FormData(form).get("body") || "").trim();
  if (!body || !activeChatId) return;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const { error } = await supabase.from("chat_messages").insert({
      channel_id: activeChatId, author_id: currentUser.id, body
    });
    if (error) throw error;
    form.reset();
    await showChatMessages();
  } catch (error) {
    showFlowToast(errorText(error), true);
  } finally {
    submit.disabled = false;
  }
}

async function createCustomChannel(form) {
  const values = new FormData(form);
  const name = String(values.get("name") || "").trim();
  const allowedRoles = values.getAll("roles").map(String);
  const allowedUserIds = values.getAll("users").map(String);
  try {
    const { data, error } = await supabase.rpc("create_custom_channel", {
      p_team_id: activeTeam.id,
      p_name: name,
      p_allowed_roles: allowedRoles,
      p_allowed_user_ids: allowedUserIds
    });
    if (error) throw error;
    activeChatId = data;
    await renderChat();
    showFlowToast("Custom team chat created.");
  } catch (error) {
    setError("custom-chat-error", errorText(error));
  }
}

async function deleteCustomChannel(button) {
  if (!window.confirm("Delete this custom chat and its messages? This cannot be undone.")) return;
  button.disabled = true;
  try {
    const { error } = await supabase.from("chat_channels").delete()
      .eq("id", button.dataset.deleteChannel).eq("team_id", activeTeam.id).eq("kind", "custom");
    if (error) throw error;
    if (activeChatId === button.dataset.deleteChannel) activeChatId = "";
    await renderChat();
    showFlowToast("Custom chat deleted.");
  } catch (error) {
    button.disabled = false;
    showFlowToast(errorText(error), true);
  }
}

function render(view) {
  if (view === "roster") renderRoster();
  if (view === "coach") renderCoachHub();
  if (view === "chat") renderChat();
  if (view === "availability") renderTeamAvailability();
}

async function renderTeamAvailability() {
  if (!activeTeam) return;
  const requestId = ++availabilityRequest;
  const container = document.querySelector("#availability-panel");
  container.innerHTML = `<section class="panel availability-panel"><p class="form-hint">Loading team availability…</p></section>`;
  const [{ data: members, error: memberError }, { data: rows, error: availabilityError }] = await Promise.all([
    supabase.from("team_memberships")
      .select("user_id,role,profiles!team_memberships_profile_fkey(display_name)")
      .eq("team_id", activeTeam.id).eq("status", "approved")
      .order("created_at", { ascending: true }),
    supabase.from("team_availability")
      .select("user_id,slot_index,available")
      .eq("team_id", activeTeam.id)
  ]);
  if (requestId !== availabilityRequest) return;
  if (memberError || availabilityError) {
    container.innerHTML = `<section class="panel availability-panel"><p class="form-error">${escapeHTML(errorText(memberError || availabilityError))}</p></section>`;
    return;
  }
  const teamMembers = members || [];
  const slotsByUser = new Map(teamMembers.map(member => [member.user_id, Array(168).fill(false)]));
  (rows || []).forEach(row => {
    if (slotsByUser.has(row.user_id) && row.slot_index >= 0 && row.slot_index < 168) {
      slotsByUser.get(row.user_id)[row.slot_index] = row.available;
    }
  });
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const dayHeaders = days.map(day => `<th scope="col">${day.slice(0, 3)}</th>`).join("");
  const tableRows = Array.from({ length: 24 }, (_, hour) => `<tr><th scope="row">${String(hour).padStart(2, "0")}:00</th>${days.map((day, dayIndex) => {
    const slot = dayIndex * 24 + hour;
    const count = [...slotsByUser.values()].reduce((sum, schedule) => sum + Number(schedule[slot]), 0);
    const own = slotsByUser.get(currentUser.id)?.[slot] || false;
    return `<td><button class="availability-slot ${own ? "available" : ""} ${count ? `team-count-${Math.min(count, 5)}` : ""}" data-team-slot="${slot}" type="button" aria-label="${day} ${String(hour).padStart(2, "0")}:00; ${count} of ${teamMembers.length} teammates available. ${own ? "Your schedule is marked available." : "Your schedule is not marked available."}" aria-pressed="${own}">${count ? `<span>${count}</span>` : ""}</button></td>`;
  }).join("")}</tr>`).join("");
  const hours = teamMembers.map(member => {
    const name = member.profiles?.display_name || "Player";
    const total = (slotsByUser.get(member.user_id) || []).filter(Boolean).length;
    return `<span class="tag">${escapeHTML(name)} · ${total}h</span>`;
  }).join("");
  const common = days.flatMap((day, dayIndex) => Array.from({ length: 24 }, (_, hour) => ({
    day, hour, count: [...slotsByUser.values()].reduce((sum, schedule) => sum + Number(schedule[dayIndex * 24 + hour]), 0)
  })).filter(item => teamMembers.length > 0 && item.count === teamMembers.length))
    .slice(0, 8).map(item => `<span class="tag">${item.day.slice(0, 3)} ${String(item.hour).padStart(2, "0")}:00</span>`).join("");
  container.innerHTML = `<section class="panel availability-panel">
    <div class="availability-tools"><label class="form-field"><span>Your schedule · ${escapeHTML(activeTeam.timezone || "UTC")}</span><div class="availability-owner"><strong>${escapeHTML(currentProfile?.display_name || "You")}</strong><span>${escapeHTML(roleLabel(activeMembership.role))}</span></div></label><p class="form-hint">Click an hour to update your availability. Everyone uses the team's time zone; changes appear for teammates in real time.</p></div>
    <div class="availability-key"><span><i class="availability-key-box selected"></i>Your availability</span><span><i class="availability-key-box"></i>Not marked</span><span>Numbers show the total teammates marked free.</span></div>
    <div class="availability-scroll"><table class="availability-table"><thead><tr><th scope="col">Time</th>${dayHeaders}</tr></thead><tbody>${tableRows}</tbody></table></div>
    <div class="availability-summary"><strong>Hours marked available</strong><div>${hours || `<span class="form-hint">No approved members yet.</span>`}</div></div>
    <div class="availability-summary"><strong>Times everyone is marked free</strong><div>${common || `<span class="form-hint">No full-team overlap marked yet.</span>`}</div></div>
  </section>`;
}

async function setAvailabilitySlot(slot) {
  if (!activeTeam || !Number.isInteger(slot) || slot < 0 || slot >= 168) return;
  const button = document.querySelector(`[data-team-slot="${slot}"]`);
  if (button) button.disabled = true;
  try {
    const { data, error: readError } = await supabase.from("team_availability")
      .select("available").eq("team_id", activeTeam.id).eq("user_id", currentUser.id).eq("slot_index", slot).maybeSingle();
    if (readError) throw readError;
    const { error } = await supabase.from("team_availability").upsert({
      team_id: activeTeam.id, user_id: currentUser.id, slot_index: slot, available: !data?.available,
      updated_at: new Date().toISOString()
    }, { onConflict: "team_id,user_id,slot_index" });
    if (error) throw error;
    await renderTeamAvailability();
  } catch (error) {
    if (button) button.disabled = false;
    showFlowToast(errorText(error), true);
  }
}

window.vantaTeam = { render, renderAvailability: renderTeamAvailability };
window.vantaDesktop?.onAuthCallback(finishAuthCallback);

document.querySelectorAll("[data-auth-mode]").forEach(button => {
  button.addEventListener("click", () => {
    const signup = button.dataset.authMode === "signup";
    document.querySelectorAll("[data-auth-mode]").forEach(item => item.classList.toggle("selected", item === button));
    document.querySelector("#auth-form").dataset.mode = signup ? "signup" : "signin";
    document.querySelector("#auth-title").textContent = signup ? "Create your account." : "Welcome back.";
    document.querySelector("#auth-subtitle").textContent = signup ? "Set up a profile to join your team." : "Sign in to continue to your team.";
    document.querySelector("#auth-submit").textContent = signup ? "Create account" : "Sign in";
    document.querySelectorAll(".signup-only").forEach(field => { field.hidden = !signup; });
    document.querySelector("#reset-password").hidden = signup;
    document.querySelector("#auth-form").elements.password.autocomplete = signup ? "new-password" : "current-password";
    setError("auth-error", "");
  });
});
document.querySelector("#auth-form").dataset.mode = "signin";

document.addEventListener("click", event => {
  const deleteChannelButton = event.target.closest("[data-delete-channel]");
  if (deleteChannelButton) {
    event.preventDefault();
    event.stopPropagation();
    deleteCustomChannel(deleteChannelButton);
    return;
  }
  const target = event.target.closest("button");
  if (!target) return;
  if (target.dataset.provider) startProviderSignIn(target.dataset.provider);
  if (target.id === "flow-signout" || target.id === "pending-signout" || target.id === "picker-signout" || target.id === "team-signout-button") signOut();
  if (target.id === "pending-refresh") routeUser(currentUser, true);
  if (target.id === "switch-team-button") {
    const approved = memberships.filter(row => row.status === "approved");
    if (approved.length) {
      renderTeamPicker(approved);
      showScreen("team-picker-screen");
    } else {
      document.querySelector("#created-team-code").hidden = true;
      showScreen("team-choice-screen");
    }
  }
  if (target.id === "picker-new-team") {
    document.querySelector("#created-team-code").hidden = true;
    showScreen("team-choice-screen");
  }
  if (target.dataset.selectTeam) {
    const row = memberships.find(item => item.id === target.dataset.selectTeam);
    if (row) enterTeam(row);
  }
  if (target.id === "continue-created-team" && createdTeam) {
    const row = memberships.find(item => item.team_id === createdTeam.id && item.status === "approved");
    if (row) enterTeam(row);
  }
  if (target.id === "copy-team-code") copyText(createdCode).catch(error => showFlowToast(errorText(error), true));
  if (target.id === "team-code-button") generateInviteCode();
  if (target.id === "close-team-code") document.querySelector("#team-code-modal").hidden = true;
  if (target.id === "copy-new-team-code") copyText(document.querySelector("#new-team-code-value").textContent).catch(error => showFlowToast(errorText(error), true));
  if (target.id === "cancel-password-recovery") showSignInForm();
  if (target.dataset.reviewMember) reviewMember(target);
  if (target.dataset.chatChannel) {
    activeChatId = target.dataset.chatChannel;
    renderChat();
  }
  if (target.dataset.teamSlot !== undefined) setAvailabilitySlot(Number(target.dataset.teamSlot));
  if (target.dataset.postKind) switchCoachPostKind(target.dataset.postKind);
});

document.addEventListener("submit", event => {
  const form = event.target;
  if (form.id === "config-form") {
    event.preventDefault();
    try {
      const values = new FormData(form);
      const saved = saveConfig(String(values.get("url")).trim(), String(values.get("anonKey")));
      initializeSupabase(saved);
      document.querySelector("#connection-setup").open = false;
      setError("auth-error", "");
      showFlowToast("Team service connection saved.");
      supabase.auth.getSession().then(({ data, error }) => {
        if (error) throw error;
        if (data.session?.user) routeUser(data.session.user, true);
      }).catch(error => setError("auth-error", errorText(error)));
    } catch (error) {
      setError("auth-error", errorText(error));
    }
  }
  if (form.id === "auth-form") {
    event.preventDefault();
    handleAuthSubmit(form);
  }
  if (form.id === "password-recovery-form") {
    event.preventDefault();
    const password = String(new FormData(form).get("password"));
    supabase.auth.updateUser({ password }).then(({ data, error }) => {
      if (error) throw error;
      passwordRecoveryPending = false;
      showSignInForm();
      if (data.user) routeUser(data.user, true);
    }).catch(error => setError("reset-error", errorText(error)));
  }
  if (form.id === "create-team-form") {
    event.preventDefault();
    createTeam(form);
  }
  if (form.id === "join-team-form") {
    event.preventDefault();
    joinTeam(form);
  }
  if (form.classList.contains("member-access-form")) {
    event.preventDefault();
    updateMemberAccess(form);
  }
  if (form.id === "coach-post-form") {
    event.preventDefault();
    submitCoachPost(form);
  }
  if (form.id === "chat-message-form") {
    event.preventDefault();
    submitChatMessage(form);
  }
  if (form.id === "custom-channel-form") {
    event.preventDefault();
    createCustomChannel(form);
  }
});

document.querySelector("#reset-password").addEventListener("click", async () => {
  const email = document.querySelector("#auth-form").elements.email.value.trim();
  if (!email) {
    setError("auth-error", "Enter your email address first, then choose Forgot password.");
    return;
  }
  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: "vantateamdesk://auth/callback" });
    if (error) throw error;
    setError("auth-error", "If that address has an account, a password reset link is on its way.");
  } catch (error) {
    setError("auth-error", errorText(error));
  }
});

start();
