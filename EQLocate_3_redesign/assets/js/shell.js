/* ---------- EQLocate 3 application shell ----------
   Presentation only: workspace routing, shared-view mounting, sidebar, live readouts, toasts, keyboard,
   theme, drag-and-drop and the Google key form. It reads the application state (app.js) but never changes a computation. */
(function(){
"use strict";
const $ = id => document.getElementById(id);
const root = document.documentElement, shell = document.querySelector(".shell");
$("verOut").textContent = APP_VERSION; $("verHome").textContent = APP_VERSION;

/* ---------- toasts replace the blocking alert() dialogs ---------- */
const toasts = $("toasts");
function toast(msg, ms){
  const t = document.createElement("div"); t.className = "toast"; t.textContent = String(msg);
  const x = document.createElement("button"); x.type = "button"; x.setAttribute("aria-label", "Dismiss"); x.textContent = "×"; x.onclick = () => t.remove();
  t.appendChild(x); toasts.appendChild(t);
  while(toasts.children.length > 4) toasts.firstChild.remove();
  setTimeout(() => t.remove(), ms || Math.min(16000, 5000 + 40*String(msg).length));
}
window.alert = msg => toast(msg);

/* ---------- workspaces ----------
   Each workspace owns a controls panel; the plot, map, audit and figure views are shared and are moved into the
   slots of whichever workspace is open, so every element (and its state) exists exactly once. */
const VIEWS = {wave:$("vWave"), wadati:$("vWadati"), depth:$("vDepth"), map:$("vMap"), audit:$("vAudit"), figs:$("vFigs")};
const WS = [...document.querySelectorAll(".work > .ws")].map(s => s.id.slice(3));
const BYNUM = {h:"home", 1:"data", 2:"pick", 3:"pick", 4:"wadati", 5:"velocity", 6:"circles", 7:"joint", 8:"joint", 9:"case"};
const navs = [...document.querySelectorAll(".nav[data-ws]")];
let current = null;
function go(ws, opts){
  if(!WS.includes(ws)) ws = "home";
  opts = opts || {};
  const sec = $("ws-" + ws);
  if(current !== ws){
    for(const id of WS) $("ws-" + id).hidden = id !== ws;
    sec.querySelectorAll(".slot").forEach(sl => { const v = VIEWS[sl.dataset.slot]; if(v && v.parentNode !== sl) sl.appendChild(v); });
    navs.forEach(n => n.dataset.ws === ws ? n.setAttribute("aria-current", "page") : n.removeAttribute("aria-current"));
    $("tbTitle").textContent = sec.dataset.title; $("tbSub").textContent = sec.dataset.sub; $("tbN").textContent = sec.dataset.n || "";
    document.title = ws === "home" ? "EQLocate · Hypocentre Workbench" : `${sec.dataset.title} · EQLocate`;
    current = ws;
    try{ localStorage.setItem("eqlocate-ws", ws); }catch(e){}
    if(!opts.fromHash && location.hash !== "#" + ws) history.replaceState(null, "", "#" + ws);
    const ctl = sec.querySelector(".ctl"); if(ctl && opts.top) ctl.scrollTop = 0;
    requestAnimationFrame(() => handleResize());
  }
  if(opts.focus){ const ctl = sec.querySelector(".ctl, .home"); if(ctl){ ctl.tabIndex = -1; ctl.focus({preventScroll:true}); } }
  refresh();
}
navs.forEach(n => n.addEventListener("click", () => go(n.dataset.ws, {focus:true})));
document.querySelectorAll("[data-go]").forEach(b => b.addEventListener("click", () => go(b.dataset.go, {focus:true})));
window.addEventListener("hashchange", () => go(location.hash.slice(1), {fromHash:true}));
/* canvases follow their box when the workspace area changes size (sidebar collapse, window resize) */
if("ResizeObserver" in window){ let t = null; new ResizeObserver(() => { clearTimeout(t); t = setTimeout(handleResize, 80); }).observe($("work")); }

/* ---------- sidebar collapse ---------- */
function setCollapsed(on){
  const narrow = matchMedia("(max-width:1180px)").matches;
  shell.classList.toggle("collapsed", !narrow && on); shell.classList.toggle("expanded", narrow && !on);
  $("btnCollapse").setAttribute("aria-label", on ? "Expand the sidebar" : "Collapse the sidebar"); $("btnCollapse").title = $("btnCollapse").getAttribute("aria-label");
}
const isCollapsed = () => shell.classList.contains("collapsed") || (matchMedia("(max-width:1180px)").matches && !shell.classList.contains("expanded"));
$("btnCollapse").addEventListener("click", () => { const on = !isCollapsed(); setCollapsed(on); try{ localStorage.setItem("eqlocate-side", on ? "1" : "0"); }catch(e){} });
try{ if(localStorage.getItem("eqlocate-side") === "1") setCollapsed(true); }catch(e){}

/* ---------- pick-phase segmented control ---------- */
const _setPickMode = setPickMode;
setPickMode = function(m){            // eslint-disable-line no-global-assign
  _setPickMode(m);
  $("btnPickP").classList.toggle("on", m === "P"); $("btnPickS").classList.toggle("on", m === "S");
  $("btnPickP").setAttribute("aria-pressed", m === "P"); $("btnPickS").setAttribute("aria-pressed", m === "S");
  refresh();
};

/* ---------- loading: drop zone, home button; files load as soon as they are chosen ---------- */
const drop = $("dropZone"), fileIn = $("fileInput"), dirIn = $("dirInput");
["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, () => drop.classList.add("over")));
["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, () => drop.classList.remove("over")));
function chosen(){
  const n = (fileIn.files ? fileIn.files.length : 0) + (dirIn.files ? dirIn.files.length : 0);
  drop.classList.toggle("has", n > 0);
  $("dropTitle").textContent = n ? `${n} file${n === 1 ? "" : "s"} selected` : "Drop SAC files here, or browse";
  $("dropSub").textContent = n ? "Reading… use Load to read the selection again" : "Any byte order · .sac .SAC .s · read locally, never uploaded";
  if(n){ if(current === "home") go("data"); $("btnLoad").click(); }
}
fileIn.addEventListener("change", chosen); dirIn.addEventListener("change", chosen);
$("btnHomeLoad").addEventListener("click", () => { go("data"); fileIn.click(); });
$("btnHomeKeys").addEventListener("click", () => $("btnKeys").click());

/* ---------- theme: auto → paper → night ---------- */
const THEMES = ["auto", "light", "dark"], NAMES = {auto:"Auto", light:"Paper", dark:"Night"};
let theme = root.dataset.theme || "auto";
function setTheme(t){
  theme = t;
  if(t === "auto") delete root.dataset.theme; else root.dataset.theme = t;
  try{ if(t === "auto") localStorage.removeItem("eqlocate-theme"); else localStorage.setItem("eqlocate-theme", t); }catch(e){}
  $("themeLbl").textContent = NAMES[t];
  applyTheme();
}
$("themeLbl").textContent = NAMES[theme];
$("btnTheme").addEventListener("click", () => setTheme(THEMES[(THEMES.indexOf(theme) + 1) % 3]));
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if(theme === "auto") applyTheme(); });

/* ---------- keys dialog + shortcuts ---------- */
const dlg = $("keysDlg");
$("btnKeys").addEventListener("click", () => dlg.showModal ? dlg.showModal() : dlg.setAttribute("open", ""));
document.addEventListener("keydown", e => {
  if(e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target, tag = t && t.tagName;
  if(tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || (t && t.isContentEditable) || dlg.open) return;
  const k = e.key;
  if(k === "p" || k === "P"){ setPickMode("P"); e.preventDefault(); }
  else if(k === "s" || k === "S"){ setPickMode("S"); e.preventDefault(); }
  else if(k === "[" || k === "]"){
    if(!state.order.length) return;
    const i = state.order.indexOf(state.current), n = state.order.length;
    if(current !== "pick") go("pick");
    selectStation(state.order[i < 0 ? 0 : (i + (k === "]" ? 1 : n - 1)) % n]); e.preventDefault();
  }
  else if(k === "0"){ if(state.current){ resetViewToCurrent(); drawWave(); } }
  else if(BYNUM[k.toLowerCase()]){ go(BYNUM[k.toLowerCase()], {top:false}); e.preventDefault(); }
  else if(k === "?"){ $("btnKeys").click(); }
});

/* ---------- live readouts: top-bar plate, sidebar status, home, status bar ---------- */
const fin = Number.isFinite, f = (v, d) => fin(v) ? v.toFixed(d) : "—";
const ll = (lat, lon) => `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(4)}°${lon >= 0 ? "E" : "W"}`;
function set(id, main, sub){
  const el = $(id), html = main == null ? '<span class="dim">—</span>' : `${escapeHtml(main)}${sub ? `<small>${escapeHtml(sub)}</small>` : ""}`;
  if(el.innerHTML !== html) el.innerHTML = html;
}
const txt = (id, v) => { v = String(v); if($(id).textContent !== v) $(id).textContent = v; };
function refresh(){
  if(typeof bayesSync === "function") bayesSync();
  const n = state.order.length, picks = c => state.picks[c] || {};
  const nPS = state.order.filter(c => fin(picks(c).p) && fin(picks(c).s)).length, nAny = state.order.filter(c => fin(picks(c).p) || fin(picks(c).s)).length;
  const nC = state.order.filter(c => fin(state.stations[c].lat) && fin(state.stations[c].lon)).length;
  const nFiles = state.order.reduce((a, c) => a + Object.keys(state.stations[c].comps).length, 0);
  set("plNet", n ? `${n} station${n === 1 ? "" : "s"}` : null, n ? `${nPS} P+S · ${nC} located` : "");
  const W = state.wadati;
  set("plK", W ? f(W.kappa, 3) : null, W ? `± ${f(W.seKappa, 3)} · n ${W.n}` : "");
  const J = state.joint, Ch = state.chord;
  let best = "—";
  if(J){
    const sg = J.mcSigma || J.sigma || [];
    set("plEpi", ll(J.epi.lat, J.epi.lon), `joint LS · ±${f(sg[1], 2)} / ${f(sg[0], 2)} km`);
    set("plDep", `${f(J.m[2], 2)} km`, `± ${f(sg[2], 2)} · RMS ${f(J.rms*1000, 0)} ms`);
    set("plTo", hhmmss_msec_utc(J.m[3] + J.tref), `± ${f(sg[3], 3)} s · Vp ${f(J.m[4], 2)}`);
    best = `joint LS: ${ll(J.epi.lat, J.epi.lon)}, ${f(J.m[2], 2)} km`;
  } else if(Ch){
    set("plEpi", ll(Ch.sol.epi.lat, Ch.sol.epi.lon), "three-circle radical centre");
    set("plDep", `${f(Ch.sol.depth, 2)} km`, `circles · Vp ${f(Ch.Vp, 2)}`);
    set("plTo", W ? hhmmss_msec_utc(W.To) : null, W ? "Wadati intercept" : "");
    best = `three circles: ${ll(Ch.sol.epi.lat, Ch.sol.epi.lon)}, ${f(Ch.sol.depth, 2)} km`;
  } else {
    set("plEpi", null); set("plDep", null);
    set("plTo", W ? hhmmss_msec_utc(W.To) : null, W ? `Wadati · ± ${f(W.seTo, 3)} s` : "");
  }
  const R = state.reference, E = J ? J.epi : Ch ? Ch.sol.epi : null;
  if(R && fin(R.lat) && fin(R.lon) && E){
    const d = C.haversineKm(R.lat, R.lon, E.lat, E.lon), dz = J ? J.m[2] - R.depth : Ch ? Ch.sol.depth - R.depth : NaN;
    set("plRef", `${f(d, 2)} km`, `offset${fin(dz) ? ` · Δh ${dz >= 0 ? "+" : ""}${f(dz, 2)} km` : ""}`);
  } else set("plRef", R && fin(R.lat) ? ll(R.lat, R.lon) : null, R && fin(R.lat) ? `reference · h ${f(R.depth, 1)} km` : "");

  // workspace status: done / ready / idle (sidebar dots and home tiles)
  const st = {data:n ? "done" : "ready", pick:nAny ? "done" : n ? "ready" : "",
    wadati:W ? "done" : nPS >= 2 ? "ready" : "", velocity:state.vpEst && state.vpEst.ok ? "done" : nAny >= 4 && nC >= 4 ? "ready" : "",
    circles:Ch ? "done" : nPS >= 3 && nC >= 3 ? "ready" : "", joint:J ? "done" : nAny >= 4 && nC >= 4 ? "ready" : "",
    case:state.caseStudy ? "done" : nPS >= 4 && nC >= 4 ? "ready" : ""};
  document.querySelectorAll(".nav[data-ws], .feat[data-go]").forEach(a => { const v = st[a.dataset.ws || a.dataset.go] || "idle"; if(a.dataset.state !== v) a.dataset.state = v; });

  const audit = state.pickAudit, bad = audit && audit.stations ? audit.stations.filter(e => e.status !== "OK").length : 0;
  txt("auditBadge", bad ? bad : "");
  txt("figBadge", state.caseStudy && state.caseStudy.figures ? state.caseStudy.figures.length : "");
  const pk = state.current ? picks(state.current) : null;
  txt("pickHint", pk ? `${state.current} · mode ${state.pickMode} · P ${hhmmss_msec_utc(pk.p)} · S ${hhmmss_msec_utc(pk.s)}` : "");
  txt("sbSession", n ? `${nFiles} records · ${n} stations · ${nPS} with P+S · ${nC} located` : "No records loaded");
  txt("hsFiles", n ? `${nFiles} SAC records` : "none loaded"); txt("hsSta", n ? `${n} (${nC} with coordinates)` : "—");
  txt("hsPicks", n ? `${nPS} P+S, ${nAny} with any pick` : "—"); txt("hsSol", best);
  const ds = $("dropSub"), msg = "Loaded. Use Load to read the selection again, or drop new files.";
  if(n && ds.textContent !== msg) ds.textContent = msg;
}
let queued = false;
function schedule(){ if(queued) return; queued = true; requestAnimationFrame(() => { queued = false; refresh(); }); }
const mo = new MutationObserver(schedule);
mo.observe($("work"), {subtree:true, childList:true, characterData:true});
mo.observe($("viewPool"), {subtree:true, childList:true, characterData:true});
document.addEventListener("click", schedule, true);

/* ---------- Joint LS: optional Bayesian sampling (iterations shown only when ticked) ---------- */
const bayesSync = () => { $("useBayes").closest(".bayes-opt").classList.toggle("on", $("useBayes").checked); };
$("useBayes").addEventListener("change", bayesSync); bayesSync();

/* ---------- Google Satellite key ---------- */
function gStatus(){ $("gKeyStatus").textContent = googleKey() ? "A key is saved in this browser. Google Satellite is the default basemap." : "No key saved: Esri World Imagery is the default satellite basemap."; }
$("btnGKeySave").addEventListener("click", () => {
  const k = $("gKeyIn").value.trim(); if(!k){ toast("Paste a Google Maps Platform API key first."); return; }
  setGoogleKey(k); $("gKeyIn").value = ""; gStatus(); setBasemap("gsat");
});
$("btnGKeyForget").addEventListener("click", () => { setGoogleKey(""); gStatus(); if(/^g/.test(state.activeBaseKey || "")) setBasemap("imagery"); toast("Google key removed from this browser."); });
gStatus();

/* ---------- start: the workspace in the address (#joint …), else Home ---------- */
go(location.hash.slice(1) || "home", {fromHash:true});
})();
