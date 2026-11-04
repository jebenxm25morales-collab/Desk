/* Grok Bot desk · iPhone web app (plain JS, no build step).
   Data: live API (/api/*, Authorization: Bearer <token>) or Plan B static JSON (d/<path>/*.json), same shapes.
   The token, API base (https only) and data path arrive ONLY via the private link's fragment
   (#t=...&api=https://...&p=...), opened directly or pasted on the Connect screen; kept in localStorage and
   stripped from the address bar. Nothing secret is ever written into these files.
   FOMO links: only URLs the API/JSON provides (built server-side by links.py) are used. */
/* Private link parsing: #t=<token>&api=<https base>[&p=<plan B path>]. Pure functions (tested in test_web).
   api must be https:// (no http, no other scheme, no user:pass, no query or fragment). */
(function (g) {
  "use strict";
  function safeApi(v) {
    if (v == null || v === "") return null;
    let u;
    try { u = new URL(String(v)); } catch (e) { return null; }
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || !u.hostname) return null;
    return u.origin + u.pathname.replace(/\/+$/, "");
  }
  function parse(text) {
    const s = String(text == null ? "" : text).trim();
    const i = s.indexOf("#");
    const q = new URLSearchParams(i >= 0 ? s.slice(i + 1) : s);    // a whole link or just its fragment
    const t = (q.get("t") || "").trim(), rawApi = (q.get("api") || "").trim(), p = (q.get("p") || "").trim();
    const api = rawApi ? safeApi(rawApi) : null;
    return { t: /^[A-Za-z0-9._~-]{16,512}$/.test(t) ? t : null, api, apiRejected: !!rawApi && api === null,
             p: /^[A-Za-z0-9_-]{1,64}$/.test(p) ? p : null };
  }
  g.DeskLink = { parse, safeApi };
})(typeof globalThis !== "undefined" ? globalThis : this);

(function () {
  "use strict";
  const DeskLink = globalThis.DeskLink;
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const reduced = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const AGENTS = ["scanner", "auditor", "analyst", "executor", "risk"];
  const AGENT_NAME = { scanner: "Scanner", auditor: "Auditor", analyst: "Analyst", executor: "Executor", risk: "Risk" };
  const AGENT_COLOR = { scanner: "#64d2ff", auditor: "#ffffff", analyst: "#ffd60a", executor: "#00d35a", risk: "#ff6b9a" };
  const RANGES = ["LIVE", "1H", "4H", "1D", "1W", "ALL"];
  const POLL_S = 15;
  const NOT_HERE = "Not available on this hosting · use Telegram";

  /* ---------------------------------------------------------------- state */
  const S = {
    tab: "home", push: null, range: "LIVE",
    state: undefined, settings: undefined, account: undefined, chart: {}, act: undefined, actNext: null, actPage: 0,
    dec: {}, coin: {}, audit: {}, liveLayers: {}, copy: undefined, copyErr: null, copyOk: null,
    lastOk: null, offline: null, live: false, loadedOnce: false, executorSeen: null,
  };
  const DS = { kind: null, base: "", api: "", demo: null, failAll: false, hang: false };

  /* ---------------------------------------------------------------- credentials (fragment only) */
  function readFragment() {
    const h = location.hash.replace(/^#/, "");
    if (!h) return;
    const L = DeskLink.parse(h);
    if (L.t) localStorage.setItem("desk.t", L.t);
    if (L.p) localStorage.setItem("desk.p", L.p);
    if (L.api) localStorage.setItem("desk.api", L.api);            // https:// only; http and other schemes are dropped
    if (L.apiRejected) S.linkError = "The desk address in this link must start with https://";
    history.replaceState(null, "", location.pathname + location.search);   // strip from address bar
  }
  const isStandalone = () => (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
  const token = () => localStorage.getItem("desk.t");
  const dataPath = () => localStorage.getItem("desk.p");

  /* ---------------------------------------------------------------- data source */
  function url(kind, arg) {
    if (DS.kind === "api") {
      const b = DS.api + "/api/";
      return {
        state: b + "state", settings: b + "settings", account: b + "account",
        chart: b + "chart?range=" + encodeURIComponent(arg),
        activity: b + "activity" + (arg ? "?before=" + encodeURIComponent(arg) : ""),
        coin: b + "coin/" + encodeURIComponent(arg), audit: b + "audit/" + encodeURIComponent(arg),
        decisions: b + "agents/" + encodeURIComponent(arg) + "/decisions",
      }[kind];
    }
    const b = DS.base;
    return {
      state: b + "state.json", settings: b + "settings.json", account: b + "account.json",
      chart: b + "chart_" + arg + ".json", activity: b + "activity_" + (arg || 0) + ".json",
      coin: b + "coin/" + encodeURIComponent(arg) + ".json", audit: b + "audit/" + encodeURIComponent(arg) + ".json",
      decisions: b + "agents/" + encodeURIComponent(arg) + ".json",
    }[kind];
  }
  function headers() { return DS.kind === "api" ? { Authorization: "Bearer " + token() } : {}; }

  async function get(kind, arg, { nullOn404 = false } = {}) {
    if (DS.hang) return new Promise(() => {});                       // demo=loading
    if (DS.failAll) throw new Error("offline");                       // demo=error after first load
    const r = await fetch(url(kind, arg), { headers: headers(), cache: "no-store" });
    if (r.status === 404 && nullOn404) return null;
    if (!r.ok) throw new Error("http " + r.status);
    return r.json();
  }
  async function post(path, body) {
    if (DS.kind !== "api") throw new Error(NOT_HERE);
    const r = await fetch(DS.api + "/api/" + path, { method: "POST", headers: { ...headers(), "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    let j = null; try { j = await r.json(); } catch (e) { /* empty */ }
    if (!r.ok) { const d = j && j.detail; throw new Error(typeof d === "string" ? d : (Array.isArray(d) && d[0] && d[0].msg) || "error " + r.status); }
    return j;
  }

  async function pickSource() {
    const qs = new URLSearchParams(location.search);
    const demo = qs.get("demo");
    if (demo && /^[a-z]+$/.test(demo)) {                              // only reads ./fixtures/<demo>/ ; ignored when absent
      try {
        const r = await fetch("fixtures/" + demo + "/state.json", { cache: "no-store" });
        if (r.ok) { DS.kind = "static"; DS.base = "fixtures/" + demo + "/"; DS.demo = demo; DS.hang = demo === "loading"; return; }
      } catch (e) { /* no fixtures folder in production */ }
    }
    const storedApi = localStorage.getItem("desk.api") || "";
    DS.api = storedApi ? DeskLink.safeApi(storedApi) || "" : "";
    if (storedApi && !DS.api) localStorage.removeItem("desk.api");
    if (token()) {
      try {
        const r = await fetch(DS.api + "/api/state", { headers: { Authorization: "Bearer " + token() }, cache: "no-store",
          signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined });
        if (r.ok) { DS.kind = "api"; S.live = true; return; }
      } catch (e) { /* not reachable -> Plan B */ }
    }
    if (dataPath() && /^[A-Za-z0-9_-]{1,64}$/.test(dataPath())) { DS.kind = "static"; DS.base = "d/" + dataPath() + "/"; return; }
    DS.kind = null;
  }

  /* ---------------------------------------------------------------- formatting */
  const nf2 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const usd = (v) => (v == null ? "n/a" : (v < 0 ? "-$" : "$") + nf2.format(Math.abs(v)));
  function usdCompact(v) {
    if (v == null) return "n/a";
    const a = Math.abs(v);
    if (a >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
    if (a >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
    if (a >= 1e3) return "$" + (v / 1e3).toFixed(1) + "K";
    return usd(v);
  }
  function price(v) {
    if (v == null) return "n/a";
    if (v >= 1) return "$" + nf2.format(v);
    if (v >= 0.01) return "$" + v.toFixed(4);
    return "$" + v.toPrecision(4);
  }
  const pct = (v, d = 2) => (v == null ? "n/a" : (v >= 0 ? "+" : "") + v.toFixed(d) + "%");
  const tsOf = (iso) => (typeof iso === "number" ? iso * 1000 : Date.parse(iso));
  const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  function age(iso) {
    if (!iso) return "";
    const m = Math.max(0, Math.floor((Date.now() - tsOf(iso)) / 60000));
    if (m < 60) return m + "m";
    if (m < 48 * 60) return Math.floor(m / 60) + "h";
    return Math.floor(m / 1440) + "d";
  }
  function dur(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    return h ? h + "h " + String(m).padStart(2, "0") + "m" : m + "m";
  }
  const setVal = (k) => (S.settings && S.settings.settings && S.settings.settings[k] ? S.settings.settings[k].value : null);

  /* ---------------------------------------------------------------- icons */
  const I = {
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/></svg>',
    agents: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/></svg>',
    activity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
    account: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>',
    bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4z"/><path d="M10 21h4"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 4 7 12l8 8"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5z"/></svg>',
    check: "✓",
  };

  /* ---------------------------------------------------------------- odometer */
  function odometer(el, text) {
    const old = el.dataset.v;
    el.dataset.v = text;
    const shape = (t) => t.replace(/\d/g, "9");
    const animate = old != null && !reduced() && shape(old) === shape(text);
    if (!animate) {
      el.innerHTML = [...text].map((ch) => /\d/.test(ch)
        ? '<span class="d"><span class="strip" style="transform:translateY(-' + (+ch * 1.1) + 'em)">' + [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => "<span>" + n + "</span>").join("") + "</span></span>"
        : '<span class="c">' + esc(ch) + "</span>").join("");
      return;
    }
    const strips = el.querySelectorAll(".strip");
    const digits = [...text].filter((c) => /\d/.test(c));
    const oldDigits = [...old].filter((c) => /\d/.test(c));
    let k = 0;
    for (let i = digits.length - 1; i >= 0; i--) {                      // right to left, 30 ms stagger
      if (digits[i] !== oldDigits[i]) {
        const s = strips[i];
        s.style.transitionDelay = k * 30 + "ms";
        s.style.transform = "translateY(-" + (+digits[i] * 1.1) + "em)";
        k++;
      }
    }
  }

  /* ---------------------------------------------------------------- shell */
  function shell() {
    document.body.innerHTML =
      '<div id="app"><main id="tab"></main><div id="push" class="hidden"></div></div>' +
      '<nav class="tabbar" id="tabbar">' +
      ["home", "agents", "copy", "activity", "account"].map((t) =>
        '<button data-tab="' + t + '" aria-label="' + t + '">' + I[t] + "<span>" + t[0].toUpperCase() + t.slice(1) + "</span></button>").join("") +
      "</nav>";
    $("#tabbar").addEventListener("click", (e) => { const b = e.target.closest("button[data-tab]"); if (b) go(b.dataset.tab); });
  }

  function go(tab, opts) {
    S.push = null; $("#push").classList.add("hidden"); $("#push").innerHTML = ""; document.body.classList.remove("push-open");
    if (S.tab !== tab) { S.tab = tab; $("#tab").innerHTML = ""; window.scrollTo(0, 0); }
    if (tab === "activity") markSeen();
    render();
    if (opts && opts.anchor) setTimeout(() => { const a = document.getElementById(opts.anchor); if (a) a.scrollIntoView(); }, 30);
    refresh();
  }
  function open(type, mint) {
    S.push = { type, mint: mint || null };
    if (!document.body.classList.contains("push-open")) S.tabScroll = window.scrollY;
    const p = $("#push"); p.classList.remove("hidden"); p.innerHTML = ""; document.body.classList.add("push-open"); window.scrollTo(0, 0);
    beam = null;
    render(); refresh();
  }
  function closePush() {
    S.push = null; $("#push").classList.add("hidden"); $("#push").innerHTML = ""; beam = null;
    document.body.classList.remove("push-open"); render(); window.scrollTo(0, S.tabScroll || 0);
  }

  function errRow() {
    if (!S.offline && DS.kind) return "";
    if (!DS.kind) return S.picking ? "" : '<div class="err-row">Desk offline · open the app with your private link</div>';   // still connecting: the skeleton says so
    const n = Math.max(0, Math.ceil((S.offline.retryAt - Date.now()) / 1000));
    return '<div class="err-row" id="err-row">Desk offline · retrying in ' + n + "s · last update " + (S.lastOk ? hhmm(S.lastOk) : "never") + "</div>";
  }

  function navbar(title, { back = false, extra = "" } = {}) {
    if (back) return '<header class="navbar"><button class="nav-btn" data-act="back" aria-label="Back">' + I.back + '</button><div class="title center">' + title + '</div>' + (extra || '<span class="nav-btn"></span>') + "</header>";
    return '<header class="navbar"><div class="title small-title" style="padding-left:6px">' + title + "</div></header>";   // iOS: shows once the large title scrolls away
  }

  /* ---------------------------------------------------------------- render dispatch */
  let homeChart = null, beam = null;
  function render() {
    document.querySelectorAll("#tabbar button").forEach((b) => b.classList.toggle("on", b.dataset.tab === S.tab));
    if (S.push) { (S.push.type === "auditor" ? renderAuditor : renderCoin)(); return; }   // the tab is hidden: render it on close
    ({ home: renderHome, agents: renderAgents, copy: renderCopy, activity: renderActivity, account: renderAccount })[S.tab]();
  }

  const sk = (h, w = "100%", extra = "") => '<div class="sk" style="height:' + h + "px;width:" + w + ";" + extra + '"></div>';

  /* ---------------------------------------------------------------- HOME */
  function renderHome() {
    const root = $("#tab");
    if (!root.dataset.home) {
      root.dataset.home = "1";
      root.className = "screen";
      root.innerHTML =
        '<header class="navbar">' +
        '<button class="nav-btn" data-act="account" aria-label="Account"><span class="avatar">GB</span></button>' +
        '<button class="brand" data-act="agents">Grok Bot<span class="chev">›</span></button>' +
        '<button class="nav-btn" data-act="search" aria-label="Search">' + I.search + "</button>" +
        '<button class="nav-btn" data-act="bell" aria-label="Notifications">' + I.bell + '<span class="dot-badge hidden" id="bell-dot"></span></button>' +
        "</header>" +
        '<div id="home-err"></div>' +
        '<section class="balance" id="bal"></section>' +
        '<div class="chart-wrap" id="chart-wrap"><canvas id="home-chart"></canvas><div class="chart-empty hidden" id="chart-empty">Waiting for the first trade</div></div>' +
        '<div class="ranges" id="ranges">' + RANGES.map((r) => '<button data-range="' + r + '">' + r + "</button>").join("") + "</div>" +
        '<div class="section-h"><h2 id="agents-h">Agents</h2></div>' +
        '<div class="carousel" id="carousel"></div>' +
        '<div class="section-h"><h2>Activity</h2><button class="see" data-act="activity">See all</button></div>' +
        '<div id="home-act"></div>';
      root.addEventListener("click", onHomeClick);
      homeChart = new window.DeskCharts.LineChart($("#home-chart"));
    }
    $("#home-err").innerHTML = errRow();
    document.querySelectorAll("#ranges button").forEach((b) => b.classList.toggle("on", b.dataset.range === S.range));
    const st = S.state;
    const bal = $("#bal");
    if (st === undefined) {
      bal.innerHTML = '<div class="balance-row">' + sk(66, "62%", "margin-top:6px") + "</div>" + sk(20, "40%", "margin-top:10px");
      $("#carousel").innerHTML = AGENTS.map(() => '<div class="acard sk-card"></div>').join("");
      $("#home-act").innerHTML = '<div class="list">' + [0, 1, 2, 3, 4].map(() => '<div class="row"><div class="main">' + sk(17, "55%") + sk(14, "35%", "margin-top:8px") + "</div>" + sk(17, "60px") + "</div>").join("") + "</div>";
      $("#agents-h").textContent = "Agents";
      $("#chart-wrap").classList.add("sk"); $("#chart-wrap").style.margin = "12px 16px 0";
      return;
    }
    $("#chart-wrap").classList.remove("sk"); $("#chart-wrap").style.margin = "";
    if (!bal.querySelector(".odo")) {
      bal.innerHTML = '<div class="balance-row"><span class="odo" id="odo"></span><span class="pill paper hidden" id="paper">PAPER</span></div>' +
        '<div class="today"><span id="today"></span><span class="pill mult hidden" id="mult"></span></div>';
    }
    const b = st.balance;
    const btxt = usd(b.stack);
    $("#odo").classList.toggle("small", btxt.length > 9);
    odometer($("#odo"), btxt);
    $("#paper").classList.toggle("hidden", st.mode !== "PAPER");
    const tp = b.todayPct;
    $("#today").innerHTML = tp == null ? "" : '<span class="' + (tp > 0 ? "green" : tp < 0 ? "red" : "muted") + '">' + pct(tp) + '</span> <span class="muted">today</span>';
    $("#mult").classList.toggle("hidden", b.multiplier == null);
    $("#mult").textContent = b.multiplier == null ? "" : b.multiplier.toFixed(2) + "×";
    const running = st.agents.filter((a) => a.status === "ok").length;
    $("#agents-h").textContent = "Agents · " + running + " running";
    // chart
    const ch = S.chart[S.range];
    if (ch) {
      homeChart.setData(ch.points, ch.startValue, ch.marks, S.range);
      $("#chart-empty").classList.toggle("hidden", ch.points.length >= 2 || (ch.marks || []).length > 0);
    }
    $("#bell-dot").classList.toggle("hidden", !unread());
    renderCarousel();
    const items = S.act ? S.act.slice(0, 5) : null;
    $("#home-act").innerHTML = items == null ? "" : items.length ? '<div class="list">' + items.map(actRow).join("") + "</div>" : '<div class="empty-msg">Nothing yet tonight</div>';
  }

  function onHomeClick(e) {
    const r = e.target.closest("[data-range]");
    if (r) { S.range = r.dataset.range; render(); refresh(); return; }
    const a = e.target.closest("[data-act]");
    if (a) return act(a.dataset.act, a);
    const row = e.target.closest("[data-row]");
    if (row) return openRow(row);
    const card = e.target.closest("[data-card]");
    if (card) { if (card.dataset.card === "auditor") open("auditor"); else go("agents", { anchor: "agent-" + card.dataset.card }); }
  }

  function agentCard(name) {
    const st = S.state, d = (S.dec[name] || {}).items, ag = st.agents.find((a) => a.name === name) || {};
    const head = '<div class="ah"><span class="sw" style="background:' + AGENT_COLOR[name] + '"></span>' + AGENT_NAME[name] + "</div>";
    let big = "", sub = "", body = "", foot = "";
    if (name === "scanner") {
      big = esc(ag.card || "");
      if (!d) body = sk(15) + sk(15, "80%", "margin-top:10px") + sk(15, "70%", "margin-top:10px");
      else if (!d.length) body = '<div class="card-empty">Listening for graduations</div>';
      else body = '<ul class="feed">' + d.slice(0, 4).map((x) => x.verdict === "pass"
        ? '<li class="passed"><span class="nm">' + esc(x.name || x.mint) + " · liq " + usdCompact(x.liquidityUsd) + '</span><span class="why">→ auditor</span></li>'
        : '<li class="killed"><span class="nm">' + esc(x.name || x.mint) + '</span><span class="why">' + esc(x.reason) + "</span></li>").join("") + "</ul>";
    } else if (name === "auditor") {
      const n = st.counts.audits, rej = st.counts.audits - st.counts.auditPassed;
      big = n + " taken apart";
      const live = latestLive();
      const last = d && d[0];
      const layers = live ? live.layers : last ? last.layers : [];
      body = '<div class="strips">' + [0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
        const l = layers[i]; const c = l ? (l.result === "ok" ? "ok" : l.result === "red" ? "red" : "") : "";
        return '<i class="' + c + '"></i>';
      }).join("") + "</div>";
      let line = "";
      if (live) line = '<span class="muted">taking apart...</span>';
      else if (!d) line = sk(15, "60%");
      else if (!last) line = '<span class="muted">No coin taken apart yet</span>';
      else if (last.passed) line = '<span class="green">' + last.layersChecked + "/8 → Executor</span>";
      else line = '<span class="red">' + esc(last.reason) + "</span>";
      body += '<div style="margin-top:14px;font-size:17px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + (last && !live ? esc(last.name || "") + (last.name ? " · " : "") : "") + line + "</div>";
      foot = rej + " rejected";
    } else if (name === "analyst") {
      big = "Scoring";
      const v = d && d[0];
      body = '<div class="ring-wrap"><canvas id="ring"></canvas><div class="ring-meta">' + (!d ? sk(15, "120px") :
        v ? '<div style="color:#fff;font-size:17px">' + esc(v.name || v.mint) + "</div>" +
          ["alive_6h", "organic", "flush", "chase"].map((k) => "<div>" + k + " " + (v.answers[k] == null ? "n/a" : v.answers[k].toFixed(2)) + "</div>").join("")
          : "<div>Waiting for a coin</div>") + "</div></div>";
      foot = v ? (v.passed ? '<span class="green">Passed → Executor</span>' : '<span class="red">' + esc((v.failed || [])[0] || "") + "</span>") : "";
    } else if (name === "executor") {
      big = esc(ag.card || "");
      const e = d && d.find((x) => x.status === "bought" || x.status === "sent");
      if (!d) body = sk(17, "70%");
      else if (!e) body = '<div class="card-empty">No trades yet</div>';
      else {
        body = '<div style="font-size:17px">' + esc(e.name || "") + '</div><div class="sub">' + usd(e.sizeUsd) + " · " + e.stackPct + "% of stack</div>" +
          '<div class="bar"><i id="exec-bar" style="width:100%"></i></div><div id="exec-txt" class="green" style="margin-top:8px;font-size:15px">✓ Filled</div>';
      }
    } else if (name === "risk") {
      big = st.counts.openPositions ? "Guarding" : "Guarding";
      const r = d && d[0];
      const open = st.openPositions[0];
      sub = open ? esc(open.name) + " · exit line " + price(open.stopLine) : "No open position";
      if (!d) body = sk(17, "70%");
      else if (r) {
        const word = r.exitReason === "trail" ? "Trailed out" : r.exitReason === "stop" ? "Stopped" : r.exitReason === "timeout" ? "Timed out" : "Pulled";
        body = '<div style="font-size:17px">' + word + '</div><div class="sub">' + esc(r.name) + " · <span class=\"" + (r.pnlUsd >= 0 ? "green" : "red") + '">' + (r.pnlUsd >= 0 ? "+" : "") + usd(r.pnlUsd) + "</span></div>";
      } else body = '<div class="card-empty">Nothing closed yet</div>';
      const sp = setVal("risk.stop_pct"), tp = setVal("risk.trail_pct");
      body += '<div class="pills">' + (sp != null ? '<span class="pill mono stop">stop -' + sp + "%</span>" : "") + (tp != null ? '<span class="pill mono trail">trail ' + tp + "%</span>" : "") + "</div>";
    }
    return '<div class="acard" data-card="' + name + '" id="card-' + name + '">' + head + '<div class="big">' + big + "</div>" + (sub ? '<div class="sub">' + sub + "</div>" : "") +
      '<div class="body">' + body + "</div>" + (foot ? '<div class="foot">' + foot + "</div>" : "") + "</div>";
  }

  function renderCarousel() {
    const c = $("#carousel"), x = c.scrollLeft;
    c.innerHTML = AGENTS.map(agentCard).join("");
    c.scrollLeft = x;
    const ring = $("#ring");
    if (ring) { const v = (S.dec.analyst || {}).items; window.DeskCharts.drawRing(ring, v && v[0] ? v[0].score : null, "#ffd60a"); }
    runExecutorBar();
  }

  function runExecutorBar() {
    const d = (S.dec.executor || {}).items; const e = d && d.find((x) => x.status === "bought" || x.status === "sent");
    const key = e ? e.ts + e.mint : null;
    const first = S.executorSeen === null;
    if (key === S.executorSeen) return;
    S.executorSeen = key;
    if (!e || first || reduced() || !$("#exec-bar")) return;          // only a NEW fill runs the bar (1.2 s)
    const bar = $("#exec-bar"), txt = $("#exec-txt"), t0 = performance.now();
    txt.className = "muted";
    const step = (now) => {
      const p = Math.min(1, (now - t0) / 1200);
      if (!$("#exec-bar")) return;
      $("#exec-bar").style.width = Math.round(p * 100) + "%";
      $("#exec-txt").textContent = p < 1 ? "Executing... " + Math.round(p * 100) + "%" : "✓ Filled";
      if (p < 1) requestAnimationFrame(step); else $("#exec-txt").className = "green";
    };
    bar.style.width = "0%"; requestAnimationFrame(step);
  }

  function latestLive() {
    const keys = Object.keys(S.liveLayers);
    if (!keys.length) return null;
    const l = S.liveLayers[keys[keys.length - 1]];
    return l.done ? null : l;
  }

  /* ---------------------------------------------------------------- activity rows */
  function actRow(r) {
    let v = "", cls = "";
    if (r.kind === "reject") { v = r.tag || "Skipped"; cls = "skip"; }
    else if (r.style === "stopped") { v = r.amount; cls = "neg"; }
    else { v = r.amount || ""; cls = r.kind === "exit" ? ((r.amount || "").startsWith("-") ? "neg" : "pos") : ""; }
    // "$N · N% of stack" / "+$N · +P%": amount on top, the second part under it (fits 390px without clipping)
    const sub = r.kind !== "reject" && r.style !== "stopped" && r.tag ? '<div class="vs">' + esc(r.tag) + "</div>" : "";
    return '<button class="row" data-row="' + esc(r.kind) + '" data-mint="' + esc(r.mint || "") + '"><div class="main"><div class="t">' + esc(r.title) +
      '</div><div class="s">' + esc(r.subtitle) + '</div></div><div class="v ' + cls + '">' + esc(v) + sub + "</div></button>";
  }
  function openRow(row) {
    const mint = row.dataset.mint || null;
    if (!mint) return;
    if (row.dataset.row === "reject") open("auditor", mint); else open("coin", mint);
  }
  function unread() {
    const seen = +(localStorage.getItem("desk.seenAct") || 0);
    return (S.act || []).some((r) => (r.kind === "fill" || r.kind === "exit") && r.id > seen);
  }
  function markSeen() { if (S.act && S.act.length) localStorage.setItem("desk.seenAct", String(Math.max(...S.act.map((r) => r.id)))); }

  /* ---------------------------------------------------------------- ACTIVITY TAB */
  function renderActivity() {
    const root = $("#tab"); root.className = "screen"; delete root.dataset.home;
    let body;
    if (S.act === undefined) body = '<div class="list">' + Array.from({ length: 8 }, () => '<div class="row"><div class="main">' + sk(17, "55%") + sk(14, "40%", "margin-top:8px") + "</div>" + sk(17, "70px") + "</div>").join("") + "</div>";
    else if (!S.act.length) body = '<div class="empty-msg">Nothing yet tonight</div>';
    else body = '<div class="list">' + S.act.map(actRow).join("") + "</div>" + (S.actNext != null ? '<button class="more" data-act="more">Load more</button>' : "");
    root.innerHTML = navbar("Activity") + errRow() + '<div class="large-title">Activity</div>' + body;
    root.onclick = (e) => { const a = e.target.closest("[data-act]"); if (a) return act(a.dataset.act, a); const row = e.target.closest("[data-row]"); if (row) openRow(row); };
  }

  /* ---------------------------------------------------------------- AGENTS TAB */
  function decRow(name, x) {
    const t = x.ts ? hhmm(tsOf(x.ts)) : "";
    let vd = "", vc = "", rs = "";
    if (name === "scanner") { vd = x.verdict === "pass" ? "Passed" : "Killed"; vc = x.verdict === "pass" ? "green" : "red"; rs = x.verdict === "pass" ? "liq " + usdCompact(x.liquidityUsd) + " · → auditor" : x.reason; }
    else if (name === "auditor") { vd = x.passed ? "Cleared " + x.layersChecked + "/8" : "Rejected"; vc = x.passed ? "green" : "red"; rs = x.passed ? "→ Executor" : x.reason; }
    else if (name === "analyst") { vd = "Score " + (x.score == null ? "n/a" : x.score); vc = x.passed ? "green" : "red"; rs = x.passed ? "passed" : (x.failed || [])[0]; }
    else if (name === "executor") { vd = x.status === "bought" ? usd(x.sizeUsd) : x.status; vc = x.status === "bought" ? "green" : "muted"; rs = x.status === "bought" ? x.stackPct + "% of stack" : x.reason; }
    else { vd = (x.pnlUsd >= 0 ? "+" : "") + usd(x.pnlUsd); vc = x.pnlUsd >= 0 ? "green" : "red"; rs = { trail: "trailing stop", stop: "-" + x.stopPct + "% stop", timeout: "timeout", pulled: "liquidity pulled" }[x.exitReason] || x.status; }
    const coin = x.link ? '<a class="coin" href="' + esc(x.link) + '" target="_blank" rel="noopener"><span>' + esc(x.name || x.mint) + "</span></a>" : '<span class="coin"><span>' + esc(x.name || x.mint) + "</span></span>";
    return '<div class="dec"><span class="tm">' + t + "</span>" + coin + '<span class="vd ' + vc + '">' + esc(vd) + '</span><span class="rs">' + esc(rs || "") + "</span></div>";
  }

  function renderAgents() {
    const root = $("#tab"); root.className = "screen"; delete root.dataset.home;
    const st = S.state;
    let html = navbar("Agents") + errRow() + '<div class="large-title">Agents</div>';
    if (st === undefined) {
      html += AGENTS.map(() => '<div class="fcard"><div class="fh">' + sk(20, "40%") + '</div><div style="padding:0 16px 12px">' + sk(15) + sk(15, "85%", "margin-top:12px") + sk(15, "70%", "margin-top:12px") + "</div></div>").join("");
    } else {
      const lockRisk = st.counts.openPositions > 0;
      html += AGENTS.map((name) => {
        const ag = st.agents.find((a) => a.name === name) || {};
        const d = (S.dec[name] || {}).items;
        const disabled = !S.live || (name === "risk" && lockRisk && !ag.paused);
        const note = !S.live ? NOT_HERE : name === "risk" && lockRisk ? "Locked while a position is open" : "";
        return '<section class="fcard" id="agent-' + name + '"><div class="fh"><span class="status-dot ' + esc(ag.status) + '"></span><span class="name">' + AGENT_NAME[name] +
          '</span><span class="count">' + esc(ag.status === "paused" ? "paused" : ag.status === "stale" ? "no heartbeat" : ag.status === "never" ? "not started" : "running") + " · " + esc(ag.card || "") + "</span>" +
          '<label class="switch" aria-label="Run ' + name + '"><input type="checkbox" data-pause="' + name + '"' + (ag.paused ? "" : " checked") + (disabled ? " disabled" : "") + '><span class="tr"></span><span class="kn"></span></label></div>' +
          (note ? '<div class="note">' + note + "</div>" : "") +
          (d === undefined ? '<div style="padding:0 16px 12px">' + sk(15) + sk(15, "80%", "margin-top:12px") + "</div>"
            : d.length ? d.slice(0, 20).map((x) => decRow(name, x)).join("") : '<div class="dec-empty">' + (name === "scanner" ? "Listening for graduations" : "Nothing yet tonight") + "</div>") +
          '<button class="link-btn" data-act="settings" data-agent="' + name + '">Settings ›</button></section>';
      }).join("");
    }
    root.innerHTML = html;
    root.onclick = (e) => { const a = e.target.closest("[data-act]"); if (a) act(a.dataset.act, a); };
    root.onchange = async (e) => {
      const i = e.target.closest("[data-pause]"); if (!i) return;
      const name = i.dataset.pause;
      try { await post("agents/" + name + "/" + (i.checked ? "resume" : "pause")); toast(AGENT_NAME[name] + (i.checked ? " running" : " paused")); }
      catch (err) { i.checked = !i.checked; toast(err.message); }
      refresh();
    };
  }

  /* ---------------------------------------------------------------- COPY TAB (PAPER copy-trading desk, read-only)
     Its own small API (copydesk) behind the same desk address at /copy, same desk key. Fails on its own:
     the rest of the app keeps working when the copy desk is unreachable, and vice versa. */
  const COPY_EPS = ["summary", "wallets", "positions", "trades"];
  function copyUrl(ep) { return DS.kind === "api" ? DS.api + "/copy/api/copy/" + ep : DS.base + "copy/" + ep + ".json"; }
  async function refreshCopy() {
    if (!DS.kind) return;
    if (DS.hang) return new Promise(() => {});
    try {
      if (DS.failAll) throw new Error("offline");
      const res = await Promise.all(COPY_EPS.map(async (ep) => {
        const r = await fetch(copyUrl(ep), { headers: headers(), cache: "no-store", signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined });
        if (!r.ok) throw new Error("http " + r.status);
        return r.json();
      }));
      S.copy = { summary: res[0], wallets: res[1].wallets || [], positions: res[2].positions || [], trades: res[3].trades || [] };
      S.copyErr = null; S.copyOk = Date.now();
    } catch (e) {
      S.copyErr = /http 401/.test(e.message) ? "Copy desk refused the desk key" : "Copy desk unreachable";
    }
  }
  const short = (a) => (a && a.length > 10 ? a.slice(0, 4) + "…" + a.slice(-4) : a || "");
  const dexLink = (mint) => "https://dexscreener.com/solana/" + encodeURIComponent(mint);
  function ago(sec) {
    if (sec == null) return "never";
    const d = Math.max(0, Math.floor(Date.now() / 1000 - sec));
    return d < 60 ? d + "s ago" : d < 3600 ? Math.floor(d / 60) + "m ago" : d < 172800 ? Math.floor(d / 3600) + "h ago" : Math.floor(d / 86400) + "d ago";
  }
  const signCls = (v) => (v == null ? "" : v >= 0 ? " pos" : " neg");
  const pnlUsd = (v) => (v == null ? "n/a" : (v >= 0 ? "+" : "") + usd(v));
  const EXIT = { take_profit: "Take profit", stop_loss: "Stop loss", mirror_sell: "Wallet sold", mirror_partial: "Wallet trimmed" };
  const exitLabel = (t) => (t.status === "open" ? "Open" : EXIT[t.exit_reason] || (t.exit_reason ? String(t.exit_reason).replace(/_/g, " ") : t.status || ""));

  function copySummary(s) {
    const pnlCls = s.pnl_usd >= 0 ? "green" : "red";
    const hb = s.last_poll == null ? "No watcher heartbeat yet" : "Watcher checked wallets " + ago(s.last_poll);
    return '<section class="fcard copy-sum">' +
      '<div class="cs-top"><span class="cs-l">Paper equity</span><span class="pill">Paper</span></div>' +
      '<div class="cs-eq">' + usd(s.equity_usd) + "</div>" +
      '<div class="cs-pnl ' + pnlCls + '">' + pnlUsd(s.pnl_usd) + " (" + pct(s.pnl_pct) + ')<span class="muted"> vs ' + usd(s.start_balance_usd) + " start</span></div>" +
      '<div class="cs-stats">' +
      [["Win rate", s.win_rate_pct == null ? "n/a" : s.win_rate_pct.toFixed(0) + "%"], ["Trades", s.trades], ["Open", s.open], ["Cash", usd(s.cash_usd)]]
        .map(([k, v]) => '<div><div class="k">' + k + '</div><div class="v">' + esc(v) + "</div></div>").join("") +
      "</div>" + '<div class="cs-hb">' + esc(hb) + " · " + esc(s.wallets_enabled) + " wallets followed</div></section>";
  }
  function walletRow(w) {
    const bits = [w.copied + " copied", w.win_rate_pct == null ? null : w.win_rate_pct.toFixed(0) + "% win", w.avg_slippage_pct == null ? null : pct(w.avg_slippage_pct, 1) + " slip"].filter(Boolean);
    return '<a class="row" href="https://solscan.io/account/' + encodeURIComponent(w.address) + '" target="_blank" rel="noopener"><div class="main"><div class="t">' + esc(w.label || w.short) +
      '</div><div class="s">' + esc(w.label ? w.short : "") + '</div><div class="s">' + esc(bits.join(" · ")) + '</div></div><div class="v' + (w.copied ? signCls(w.pnl_usd) : " skip") + '">' + (w.copied ? pnlUsd(w.pnl_usd) : "n/a") +
      '<div class="vs">' + (w.enabled ? (w.last_trade ? ago(w.last_trade) : "No trades yet") : "Off") + "</div></div></a>";
  }
  function posRow(p) {
    const now = p.current_price == null ? "no price yet" : price(p.current_price);
    return '<a class="row" href="' + dexLink(p.mint) + '" target="_blank" rel="noopener"><div class="main"><div class="t">' + esc(short(p.mint)) +
      '</div><div class="s">' + esc(p.wallet_label || p.wallet_short) + '</div><div class="s">' + price(p.our_entry_price) + " → " + now + '</div><div class="s">Stop ' + price(p.stop_price) + " · TP " + price(p.tp_price) +
      '</div></div><div class="v' + signCls(p.pnl_pct) + '">' + pct(p.pnl_pct, 1) + '<div class="vs">' + usd(p.size_usd) + "</div></div></a>";
  }
  function tradeRow(t) {
    const val = t.status === "open" ? null : t.pnl_usd;
    return '<a class="row" href="' + dexLink(t.mint) + '" target="_blank" rel="noopener"><div class="main"><div class="t">' + esc(short(t.mint)) + '</div><div class="s">' + esc(t.wallet_label || t.wallet_short) + '</div><div class="s">Wallet ' + price(t.wallet_entry_price) + " → us " + price(t.our_entry_price) + '</div><div class="s">' +
      (t.delay_s == null ? "" : Math.round(t.delay_s) + "s later · ") + (t.slippage_pct == null ? "n/a" : pct(t.slippage_pct, 1)) + " slip" + (t.our_entry_time ? " · " + hhmm(t.our_entry_time * 1000) : "") +
      '</div></div><div class="v' + (val == null ? " skip" : signCls(val)) + '">' + (val == null ? "Open" : pnlUsd(val)) + '<div class="vs">' + esc(exitLabel(t)) + "</div></div></a>";
  }
  function renderCopy() {
    const root = $("#tab"); root.className = "screen"; delete root.dataset.home;
    let html = navbar("Copy") + errRow() + '<div class="large-title">Copy</div>';
    const c = S.copy;
    if (S.copyErr) html += '<div class="err-row" id="copy-err">' + esc(S.copyErr) + " · retrying · last update " + (S.copyOk ? hhmm(S.copyOk) : "never") + "</div>";
    if (c === undefined) {
      if (S.copyErr || (!DS.kind && !S.picking)) { html += '<div class="empty-msg">Copy desk data will show here once it is reachable.</div>'; root.innerHTML = html; return; }
      html += '<section class="fcard copy-sum">' + sk(15, "30%") + sk(34, "55%", "margin-top:10px") + sk(15, "65%", "margin-top:10px") + sk(40, "100%", "margin-top:16px") + "</section>" +
        '<div class="section-h"><h2>Wallets</h2></div><div class="list">' + Array.from({ length: 3 }, () => '<div class="row"><div class="main">' + sk(17, "50%") + sk(14, "70%", "margin-top:8px") + "</div>" + sk(17, "60px") + "</div>").join("") + "</div>";
      root.innerHTML = html; return;
    }
    html += copySummary(c.summary);
    html += '<div class="section-h"><h2>Wallets</h2></div>' + (c.wallets.length ? '<div class="list">' + c.wallets.map(walletRow).join("") + "</div>" : '<div class="empty-msg">No wallets followed</div>');
    if (!c.trades.length && !c.positions.length) {
      html += '<div class="empty-msg">No copied trades yet. Waiting for wallets to trade.</div>';
    } else {
      html += '<div class="section-h"><h2>Open positions</h2></div>' + (c.positions.length ? '<div class="list">' + c.positions.map(posRow).join("") + "</div>" : '<div class="empty-msg small">No open positions</div>');
      html += '<div class="section-h"><h2>Recent trades</h2></div><div class="list">' + c.trades.slice(0, 50).map(tradeRow).join("") + "</div>";
    }
    html += '<p class="copy-foot">Paper only. Copies are simulated, no real trades are placed.</p>';
    root.innerHTML = html;
  }

  /* ---------------------------------------------------------------- AUDITOR SCREEN */
  function auditorMint() {
    if (S.push.mint) return S.push.mint;
    const d = (S.dec.auditor || {}).items; return d && d.length ? d[0].mint : null;
  }

  function renderAuditor() {
    const p = $("#push");
    const mint = auditorMint();
    const decLoaded = S.dec.auditor !== undefined;
    const a = mint ? S.audit[mint] : (decLoaded ? null : undefined);
    const live = mint && S.liveLayers[mint];
    const enabled = setVal("auditor.enabled");
    const header = navbar(a && a.name ? esc(a.name) : "Auditor", { back: true });
    if (p.dataset.mint !== String(mint) || !p.querySelector("#discs") || !beam || (!a && !live)) {
      p.dataset.mint = String(mint);
      if (a === undefined && !live) {
        p.innerHTML = header + errRow() + '<div class="aud"><div class="discs">' + [0, 1, 2, 3, 4, 5, 6, 7].map((i) => '<div class="disc" style="top:' + i * 44 + 'px"><div class="sk" style="height:34px;border-radius:56px/17px"></div></div>').join("") +
          '</div><div class="layer-rows">' + [0, 1, 2, 3, 4, 5, 6, 7].map(() => '<div class="lr">' + sk(12, "60%") + sk(14, "45%", "margin-top:6px") + "</div>").join("") + "</div></div>";
        bindPush(); return;
      }
      if (!a && !live) {
        p.innerHTML = header + errRow() + '<div class="empty-msg">No coin taken apart yet</div>' + toggleRow(enabled); bindPush(); return;
      }
      p.innerHTML = header + '<div id="push-err"></div>' +
        '<div class="aud"><div class="discs" id="discs">' + [0, 1, 2, 3, 4, 5, 6, 7].map((i) => '<div class="disc" id="disc' + i + '" style="top:' + i * 44 + 'px;z-index:' + (10 - i) + '"><div class="side"></div><div class="top"></div></div>').join("") +
        '<div class="beam" id="beam"></div></div><div class="layer-rows" id="lrows"></div></div>' +
        '<div class="verdict" id="verdict"></div>' + '<div id="aud-toggle"></div>' +
        '<a class="cta hidden" id="fomo-btn" target="_blank" rel="noopener">Open on FOMO</a>';
      bindPush();
      beam = new Beam(mint);
    }
    $("#push-err") && ($("#push-err").innerHTML = errRow());
    const layers = a ? a.layers : (live ? live.layers : []);
    beam.update(layers, a);
    $("#aud-toggle").innerHTML = toggleRow(enabled);
    const link = a && a.link;
    const btn = $("#fomo-btn");
    if (link) { btn.href = link; btn.classList.remove("hidden"); } else btn.classList.add("hidden");
  }

  function toggleRow(enabled) {
    return '<div class="toggle-row"><div class="main">Take apart before buying' + (!S.live ? '<div class="ro-note" style="padding:2px 0 0">' + NOT_HERE + "</div>" : "") + "</div>" +
      '<label class="switch"><input type="checkbox" id="aud-enabled"' + (enabled !== false ? " checked" : "") + (!S.live ? " disabled" : "") + '><span class="tr"></span><span class="kn"></span></label></div>';
  }

  class Beam {
    constructor(mint) {
      this.mint = mint; this.res = []; this.idx = 0; this.tEnter = performance.now(); this.done = false; this.raf = 0; this.audit = null;
      this.names = ["Mint authority", "Freeze authority", "Dev wallet", "Top 10 holders", "Liquidity", "Pool age", "Bundled wallets", "Delegations"];
      $("#lrows").innerHTML = this.names.map((n, i) => '<div class="lr" id="lr' + i + '"><div class="ln">' + (i + 1) + " · " + n + '</div><div class="lv">&nbsp;</div></div>').join("");
      if (!reduced()) { const b = $("#beam"); b.style.transition = "none"; b.style.top = "17px"; b.style.opacity = "1"; void b.offsetHeight; b.style.transition = ""; }
    }
    update(layers, audit) {
      for (const l of layers || []) this.res[(l.layer || l.n) - 1] = l;
      this.audit = audit || null;
      if (reduced()) { this.revealAll(); return; }
      cancelAnimationFrame(this.raf);
      const tick = () => {
        if (!$("#beam") || this.done) return;
        const now = performance.now();
        const r = this.res[this.idx];
        if (r && now - this.tEnter >= 350) {                    // server result for this layer is in, beam read it
          this.reveal(this.idx);
          if (r.result !== "ok") { this.finish(); return; }
          this.idx++;
          this.tEnter = now + 150;
          if (this.idx >= 8) { setTimeout(() => this.finish(), 150); return; }
          setTimeout(() => { const b = $("#beam"); if (b) b.style.top = this.idx * 44 + 17 + "px"; }, 150);
        }
        this.raf = requestAnimationFrame(tick);                  // otherwise the beam waits on this layer
      };
      tick();
    }
    reveal(i) {
      const r = this.res[i]; if (!r) return;
      const cls = r.result === "ok" ? "ok" : r.result === "red" ? "red" : "";
      const d = $("#disc" + i), row = $("#lr" + i);
      if (d) { d.className = "disc " + cls; d.querySelector(".top").textContent = cls === "ok" ? "✓" : cls === "red" ? "✕" : ""; }
      if (row) { row.className = "lr " + cls; row.querySelector(".lv").textContent = r.value; }
    }
    revealAll() { for (let i = 0; i < 8; i++) this.reveal(i); this.finish(); }
    finish() {
      this.done = true;
      const b = $("#beam"); if (b) b.style.opacity = "0";
      for (let i = 0; i < 8; i++) if (this.res[i] && this.res[i].result === "not checked") this.reveal(i);
      const a = this.audit, v = $("#verdict");
      if (!a || !v) return;
      if (a.passed) v.innerHTML = '<div class="vt green">Cleared · ' + a.layersChecked + "/8 parts</div>" + '<div class="vs">' + (a.sentUsd != null ? "Sent to Executor · " + usd(a.sentUsd) : "Sent to Analyst") + "</div>";
      else v.innerHTML = '<div class="vt red">Rejected · ' + esc(a.reason) + '</div><div class="vs">Grok Bot won\'t buy ' + esc(a.name || "this coin") + "</div>";
    }
  }

  /* ---------------------------------------------------------------- COIN SCREEN */
  function coinMint() {
    if (S.push.mint) return S.push.mint;
    const st = S.state; if (!st) return undefined;
    if (st.openPositions.length) return st.openPositions[0].mint;
    const e = (S.dec.executor || {}).items; if (e && e.length) return e[0].mint;
    return st.recentCoins.length ? st.recentCoins[0].mint : null;
  }

  function renderCoin() {
    const p = $("#push");
    const mint = coinMint();
    const c = mint ? S.coin[mint] : mint === null ? null : undefined;
    const paper = S.state && S.state.mode === "PAPER" ? '<span class="pill paper">PAPER</span>' : "";
    if (c === undefined) {
      p.innerHTML = navbar("", { back: true }) + errRow() + '<div class="coin-head">' + sk(24, "55%") + sk(15, "45%", "margin-top:8px") + sk(44, "60%", "margin-top:14px") + sk(17, "35%", "margin-top:8px") +
        '</div><div style="margin:12px 16px 0">' + sk(300) + '</div><div class="stats">' + [0, 1, 2, 3].map(() => "<div>" + sk(12, "50%") + sk(17, "70%", "margin-top:8px") + "</div>").join("") + "</div>";
      bindPush(); return;
    }
    if (c === null) { p.innerHTML = navbar("Coin", { back: true }) + errRow() + '<div class="empty-msg">Nothing scanned yet</div>'; bindPush(); return; }
    const coin = c.coin, pos = c.position, open = pos && (pos.status === "open" || pos.status === "exiting");
    const last = c.prices.length ? c.prices[c.prices.length - 1].price : null;
    const a = c.audit;
    const shield = a ? '<span class="shield' + (a.passed ? "" : " red") + '">' + I.shield + a.layersChecked + "/8</span>" : "";
    let since = "";
    if (open && last != null && pos.entryPrice) {
      const ch = (last / pos.entryPrice - 1) * 100;
      since = '<div class="since ' + (ch >= 0 ? "green" : "red") + '">' + (ch >= 0 ? "▲ " : "▼ ") + Math.abs(ch).toFixed(2) + "% since entry</div>";
    }
    const m = c.market || {};
    let posHtml = "";
    if (open) {
      const sp = pos.stopPct, tp = pos.trailPct, entry = pos.entryPrice;
      const stopLine = entry * (1 - sp / 100);
      const trailLine = pos.trailActive ? pos.peak * (1 - tp / 100) : null;
      const th = setVal("risk.timeout_h"), ts = setVal("risk.trail_start_pct");
      const left = th != null ? th * 3600 - (Date.now() - tsOf(pos.openedAt)) / 1000 : null;
      posHtml = '<div class="pos-card"><div class="ph">Your position · ' + usd(pos.sizeUsd) + " in · Executor</div>" +
        '<div class="kv"><span class="k">Entry</span><span>' + price(entry) + "</span></div></div>" +
        '<div class="exit-card"><div class="kv"><span class="k">Stop line</span><span class="red">' + price(stopLine) + " · -" + sp + "%</span></div>" +
        '<div class="kv"><span class="k">Trail line</span><span class="green">' + (trailLine != null ? price(trailLine) + " · " + tp + "% off top" : (ts != null ? "starts at +" + ts + "%" : "not active")) + "</span></div>" +
        '<div class="kv"><span class="k">Time left</span><span>' + (left == null ? "n/a" : dur(left)) + "</span></div></div>";
    }
    p.innerHTML = navbar("", { back: true, extra: paper ? '<span class="nav-btn" style="padding-right:6px">' + paper + "</span>" : "" }) + errRow() +
      '<div class="coin-head"><div class="nm-row"><span class="nm">' + esc(coin.name || mint) + "</span>" + shield + "</div>" +
      '<div class="meta">' + esc(coin.symbol || "") + " · Solana · " + age(coin.migrated_at) + " old</div>" +
      '<div class="price">' + price(last) + "</div>" + since + "</div>" +
      '<div class="candles"><canvas id="candles"></canvas></div>' +
      '<div class="stats"><div><div class="k">Market cap</div><div class="vv">' + usdCompact(m.marketCap) + '</div></div><div><div class="k">Liquidity</div><div class="vv">' + usdCompact(m.liquidityUsd) +
      '</div></div><div><div class="k">24h volume</div><div class="vv">' + usdCompact(m.volume24h) + '</div></div><div><div class="k">Holders</div><div class="vv">' + (m.holders == null ? "n/a" : m.holders.toLocaleString("en-US")) + "</div></div></div>" +
      posHtml +
      '<a class="cta' + (open ? " sell" : "") + '" href="' + esc(c.link) + '" target="_blank" rel="noopener">' + (open ? "Sell on FOMO" : "Buy on FOMO") + "</a>";
    bindPush();
    window.DeskCharts.drawCandles($("#candles"), c.prices, open ? pos.stopLine : null);
  }

  function bindPush() {
    const p = $("#push");
    p.onclick = (e) => { const a = e.target.closest("[data-act]"); if (a) act(a.dataset.act, a); };
    p.onchange = (e) => { if (e.target.id === "aud-enabled") onAuditorToggle(e.target); };
  }

  async function onAuditorToggle(input) {
    if (!S.live) { input.checked = !input.checked; return toast(NOT_HERE); }
    if (!input.checked) {
      const ok1 = await confirmSheet("Stop taking coins apart?", "Coins would go to the Analyst without the 8 checks.", "Turn off");
      const ok2 = ok1 && await confirmSheet("Are you sure?", "Mint, freeze, dev wallet, holders, liquidity, pool age, bundles and delegations will not be checked.", "Yes, turn off");
      if (!ok2) { input.checked = true; return; }
    }
    try { const r = await post("settings", { key: "auditor.enabled", value: input.checked }); S.settings = { settings: r.settings }; }
    catch (e) { input.checked = !input.checked; toast(e.message); }
  }

  /* ---------------------------------------------------------------- ACCOUNT TAB */
  const GROUPS = ["scanner", "auditor", "analyst", "executor", "risk", "desk"];
  const LABELS = {
    "scanner.min_liquidity_usd": "Min liquidity ($)", "scanner.liq_grace_min": "Liquidity grace period (min)",
    "scanner.max_top10_pct": "Max top 10 holders (%)", "scanner.max_h1_change_pct": "Max 1h price change (%)",
    "scanner.poll_s": "Poll interval (s)", "scanner.min_pool_age_min": "Min pool age (min)",
    "scanner.max_wait_min": "Max wait for a pool (min)", "scanner.runner_h24_pct": "Runner cutoff, 24h change (%)",
    "scanner.ws_silent_s": "Feed silence limit (s)", "scanner.dex_req_per_min": "DexScreener requests per minute",
    "scanner.dex_429_wait_s": "DexScreener rate-limit pause (s)",
    "auditor.enabled": "Take apart before buying", "auditor.max_dev_pct": "Max dev wallet (%)",
    "auditor.max_top10_pct": "Max top 10 holders (%)", "auditor.min_lp_locked_pct": "Min liquidity locked or burned (%)",
    "auditor.min_pool_age_min": "Min pool age (min)", "auditor.max_bundled": "Max bundled wallets",
    "auditor.max_delegated_accounts": "Max delegated accounts", "auditor.retries": "Retries per source",
    "auditor.retry_gap_s": "Pause between retries (s)", "auditor.liq_pulled_drop_pct": "Liquidity pulled at a drop of (%)",
    "analyst.mode": "Scoring mode", "analyst.min_alive_6h": "Min alive in 6h", "analyst.min_organic": "Min organic",
    "analyst.max_chase": "Max chase", "analyst.min_score": "Min score", "analyst.timeout_s": "Answer timeout (s)",
    "analyst.rules_alive_volume_h1": "Rules · 1h volume target ($)", "analyst.rules_organic_buys_h1": "Rules · 1h buys target",
    "analyst.rules_bundled_penalty": "Rules · bundled penalty", "analyst.rules_bundled_penalty_wallets": "Rules · bundled wallets limit",
    "analyst.rules_flush_drop_m5_pct": "Rules · flush drop, 5m (%)", "analyst.rules_chase_h1_pct": "Rules · chase rise, 1h (%)",
    "executor.stack_pct": "Ticket size (% of stack)", "executor.max_pool_pct": "Max share of the pool (%)",
    "executor.min_ticket_usd": "Min ticket ($)", "executor.below_min": "Below the min ticket",
    "executor.recheck_liq_drop_pct": "Skip if liquidity dropped (%)", "executor.recheck_price_up_pct": "Skip if price ran up (%)",
    "executor.confirm_window_min": "Buy confirm window (min)",
    "risk.poll_s": "Price check interval (s)", "risk.stop_pct": "Stop loss (%)", "risk.trail_start_pct": "Trailing starts at gain (%)",
    "risk.trail_pct": "Trailing stop, off the top (%)", "risk.timeout_h": "Dead money timeout (h)",
    "risk.timeout_min_gain_pct": "Timeout if gain is below (%)", "risk.confirm_window_min": "Sell confirm window (min)",
    "desk.mode": "Mode", "desk.paper_start_stack": "Paper start stack", "desk.report_time": "Morning report time",
    "desk.notifier": "Push channel", "desk.rpc_url": "RPC URL", "desk.push_rejects": "Push rejected coins",
    "desk.fees_ref_discount": "Fee referral discount", "desk.fomo_handle": "FOMO handle", "desk.live_stack": "Live stack",
  };
  const CHOICE_LABELS = { jev: "Jev", rules: "Rules", bump: "Bump to the min", skip: "Skip", telegram: "Telegram", test: "Test", webpush: "Web push" };
  const choiceLabel = (v) => CHOICE_LABELS[v] || v;
  const compactNum = (v) => { const a = Math.abs(v); return a >= 1e9 ? v / 1e9 + "B" : a >= 1e6 ? v / 1e6 + "M" : a >= 1e4 ? v / 1e3 + "K" : String(v); };
  function label(k) {
    if (LABELS[k]) return LABELS[k];
    const s = k.split(".")[1].replace(/_/g, " "); return s[0].toUpperCase() + s.slice(1);
  }
  function stepOf(it) {
    if (Number.isInteger(it.default) && Number.isInteger(it.min) && Number.isInteger(it.max)) return 1;
    const span = it.max - it.min;
    return span <= 1 ? 0.01 : span <= 100 ? 0.5 : span <= 10000 ? 1 : 100;
  }
  function settingRow(k, it) {
    const dis = !S.live || it.readonly ? " disabled" : "";
    let ctrl = "";
    if (it.type === "number") {
      ctrl = '<div class="ctrl"><input type="range" data-k="' + k + '" min="' + it.min + '" max="' + it.max + '" step="' + stepOf(it) + '" value="' + it.value + '"' + dis + ' aria-label="' + esc(label(k)) + '">' +
        '<input type="number" data-k="' + k + '" value="' + it.value + '" min="' + it.min + '" max="' + it.max + '" step="any"' + dis + ' aria-label="' + esc(label(k)) + ' value"></div>';
      return '<div class="set"><div class="sl"><span class="lab">' + esc(label(k)) + '</span><span class="faint mono" style="font-family:var(--font-mono);font-size:13px">' + compactNum(it.min) + "–" + compactNum(it.max) + "</span></div>" + ctrl + "</div>";
    }
    if (it.type === "bool") return '<div class="set"><div class="sl" style="min-height:44px"><span class="lab">' + esc(label(k)) + '</span><label class="switch"><input type="checkbox" data-k="' + k + '"' + (it.value ? " checked" : "") + dis + '><span class="tr"></span><span class="kn"></span></label></div></div>';
    if (it.type === "choice") return '<div class="set"><div class="sl"><span class="lab">' + esc(label(k)) + '</span></div><div class="ctrl"><div class="seg" style="flex:1">' +
      it.choices.map((c) => '<button data-k="' + k + '" data-v="' + esc(c) + '" class="' + (c === it.value ? "on" : "") + '"' + dis + ">" + esc(choiceLabel(c)) + "</button>").join("") + "</div></div></div>";
    return '<div class="set"><div class="sl"><span class="lab">' + esc(label(k)) + '</span><input type="text" data-k="' + k + '" value="' + esc(it.value) + '"' + dis + ' style="width:150px"></div></div>';
  }

  function renderAccount() {
    const root = $("#tab"); root.className = "screen"; delete root.dataset.home;
    const st = S.state, ac = S.account, se = S.settings;
    let h = navbar("Account") + errRow() + '<div class="large-title">Account</div>';
    if (st === undefined || ac === undefined || se === undefined) {
      h += '<div class="list" style="padding:12px 16px">' + sk(40) + sk(44, "100%", "margin-top:12px") + "</div>" +
        '<div class="list" style="margin-top:16px;padding:8px 16px">' + [0, 1, 2, 3].map(() => sk(20, "70%", "margin:14px 0")).join("") + "</div>" +
        '<div class="group-h">' + sk(22, "40%") + '</div><div class="list" style="padding:8px 16px">' + [0, 1, 2].map(() => sk(15, "50%", "margin-top:10px") + sk(44, "100%", "margin-top:8px")).join("") + "</div>";
      root.innerHTML = h; return;
    }
    const mode = st.mode, pm = ac.modes[mode] || {};
    const stackKey = mode === "LIVE" ? "desk.live_stack" : "desk.paper_start_stack";
    const roNote = !S.live ? '<div class="ro-note">' + NOT_HERE + "</div>" : "";
    h += '<div class="list" style="padding:12px 16px 14px"><div class="seg seg-hit">' + ["PAPER", "LIVE"].map((m) => '<button data-mode="' + m + '" class="' + (m === mode ? "on" : "") + '"' + (S.live ? "" : " disabled") + ">" + m + "</button>").join("") + "</div>" +
      '<div class="sl" style="display:flex;justify-content:space-between;align-items:center;margin-top:12px"><span>' + (mode === "LIVE" ? "Stack" : "Paper start stack") + '</span><input class="field" type="number" data-k="' + stackKey + '" value="' + setVal(stackKey) + '" step="any"' + (S.live ? "" : " disabled") + ' aria-label="Stack"></div></div>' + roNote;
    h += '<div class="list" style="margin-top:16px">' +
      '<div class="row-link"><span>Stack</span><span class="rv">' + usd(ac.stack) + "</span></div>" +
      '<div class="row-link"><span>Realized PnL</span><span class="rv ' + ((pm.realizedPnlUsd || 0) >= 0 ? "green" : "red") + '">' + (pm.realizedPnlUsd >= 0 ? "+" : "") + usd(pm.realizedPnlUsd) + "</span></div>" +
      '<div class="row-link"><span>Fees paid</span><span class="rv">' + usd(pm.feesPaidUsd) + "</span></div>" +
      '<div class="row-link"><span>Trades</span><span class="rv">' + (pm.trades || 0) + " · " + (pm.wins || 0) + " won · " + (pm.losses || 0) + " lost</span></div>" +
      '<div class="row-link"><span>Fee referral discount</span><span class="rv">' + Math.round((ac.feesRefDiscount || 0) * 100) + "%</span></div></div>";
    const lk = ac.links || st.links || {};
    h += '<div class="list" style="margin-top:16px">' +
      '<a class="row-link" href="' + esc(ac.fomoProfile || lk.profile) + '" target="_blank" rel="noopener"><span>Your FOMO profile</span><span class="rv">' + esc("@" + (setVal("desk.fomo_handle") || "")) + " ›</span></a>" +
      '<button class="row-link" data-act="invite"><span>Invite a friend</span><span class="rv">›</span></button></div>';
    const tg = ac.telegram || {};
    const standalone = isStandalone();
    let notif = "";
    if (!S.live) notif = '<div class="row-link"><span>Notifications</span><span class="rv wrap">Telegram only on this hosting</span></div>';
    else if (standalone) notif = '<button class="row-link" data-act="webpush"><span>Enable notifications</span><span class="rv">›</span></button>';
    h += '<div class="list" style="margin-top:16px"><div class="row-link"><span>Telegram</span><span class="rv ' + (tg.connected ? "green" : "") + '">' + (tg.connected ? "Connected" : "Not connected") + "</span></div>" +
      '<div class="row-link"><span>Send test push</span>' + (S.live ? '<button class="btn" data-act="testpush">Send</button>' : '<span class="rv">Not on this hosting</span>') + "</div>" + notif + "</div>";
    for (const g of GROUPS) {
      const keys = Object.keys(se.settings).filter((k) => k.startsWith(g + ".") && !se.settings[k].readonly && k !== stackKey && k !== "desk.live_stack" && k !== "desk.paper_start_stack");
      if (!keys.length) continue;
      h += '<div class="group-h" id="settings-' + g + '">' + (g === "desk" ? "Desk" : AGENT_NAME[g]) + "</div>" + roNote.replace("ro-note", "ro-note\" style=\"padding:0 16px 8px") + '<div class="list">' + keys.map((k) => settingRow(k, se.settings[k])).join("") + "</div>";
    }
    root.innerHTML = h;
    root.onclick = async (e) => {
      const m = e.target.closest("[data-mode]"); if (m) return switchMode(m.dataset.mode);
      const c = e.target.closest("button[data-k][data-v]"); if (c) return saveSetting(c.dataset.k, c.dataset.v);
      const a = e.target.closest("[data-act]"); if (a) act(a.dataset.act, a);
    };
    root.oninput = (e) => { const t = e.target; if (t.type === "range") { const n = t.parentNode.querySelector("input[type=number]"); if (n) n.value = t.value; } };
    root.onchange = (e) => {
      const t = e.target; if (!t.dataset.k) return;
      const v = t.type === "checkbox" ? t.checked : t.value;
      if (t.type === "number") { const r = t.parentNode.querySelector("input[type=range]"); if (r) r.value = t.value; }
      saveSetting(t.dataset.k, v);
    };
  }

  async function saveSetting(k, v) {
    if (!S.live) return toast(NOT_HERE);
    try { const r = await post("settings", { key: k, value: v }); S.settings = { settings: r.settings }; (r.messages || []).forEach(toast); }
    catch (e) { toast(e.message); }
    render();
  }

  async function switchMode(m) {
    if (!S.live) return toast(NOT_HERE);
    if (!S.state || m === S.state.mode) return;
    let body = { mode: m };
    if (m === "LIVE") {
      const typed = await promptSheet("Switch to LIVE", "Type LIVE to confirm. Real money: every push becomes a real trade you place on FOMO.", "LIVE");
      if (typed !== "LIVE") return;
      body.confirm = "LIVE";
    }
    try { await post("mode", body); toast("Mode: " + m); } catch (e) { toast(e.message); }
    refresh();
  }

  /* ---------------------------------------------------------------- actions */
  async function act(name, el) {
    if (name === "back") return closePush();
    if (name === "account") return go("account");
    if (name === "agents") return go("agents");
    if (name === "activity") return go("activity");
    if (name === "bell") { markSeen(); return go("activity"); }
    if (name === "search") return openSearch();
    if (name === "settings") return go("account", { anchor: "settings-" + el.dataset.agent });
    if (name === "more") return loadMore();
    if (name === "invite") return invite();
    if (name === "testpush") { try { await post("push", { test: true }); toast("Test push sent"); } catch (e) { toast(e.message); } return; }
    if (name === "webpush") return enableWebPush();
  }

  async function invite() {
    const u = (S.account && S.account.links && S.account.links.signup) || (S.state && S.state.links && S.state.links.signup);
    if (!u) return;
    if (navigator.share) { try { await navigator.share({ title: "FOMO", url: u }); return; } catch (e) { if (e && e.name === "AbortError") return; } }
    try { await navigator.clipboard.writeText(u); toast("Link copied"); } catch (e) { toast("Copy failed"); }
  }

  async function enableWebPush() {
    if (!S.live) return toast("Web push isn't available on this hosting · Telegram only");
    const key = S.account && S.account.webPush && S.account.webPush.vapidPublicKey;
    if (!key || !("serviceWorker" in navigator) || !("PushManager" in window)) return toast("Notifications aren't set up yet");
    try {
      if ((await Notification.requestPermission()) !== "granted") return toast("Notifications not allowed");
      const reg = await navigator.serviceWorker.register("sw.js");
      const raw = atob(key.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (key.length % 4)) % 4));
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(raw, (c) => c.charCodeAt(0)) });
      await post("push", { subscription: sub.toJSON() });
      toast("Notifications on");
    } catch (e) { toast(e.message || "Could not enable notifications"); }
  }

  function openSearch() {
    const bg = document.createElement("div");
    bg.className = "pushed";
    bg.innerHTML = '<div class="search-box" style="padding-top:calc(8px + var(--safe-t))"><input id="q" type="search" placeholder="Name, symbol or mint" autocomplete="off" autocapitalize="off"><button class="btn" data-x>Cancel</button></div><div class="list flat" id="qres"></div>';
    document.body.appendChild(bg);
    const draw = () => {
      const q = $("#q").value.trim().toLowerCase();
      const coins = (S.state && S.state.recentCoins) || [];
      const res = q ? coins.filter((c) => (c.name || "").toLowerCase().includes(q) || (c.symbol || "").toLowerCase().includes(q) || c.mint.toLowerCase().startsWith(q) || c.mint.toLowerCase() === q) : coins.slice(0, 20);
      $("#qres").innerHTML = res.length ? res.map((c) => '<button class="row" data-m="' + esc(c.mint) + '"><div class="main"><div class="t">' + esc(c.name || c.mint) + '</div><div class="s">' + esc(c.symbol || "") + " · " + esc(c.mint.slice(0, 4) + "…" + c.mint.slice(-4)) + '</div></div><div class="v skip">' + esc(c.status || "") + "</div></button>").join("") : '<div class="empty-msg">No coin found</div>';
    };
    bg.addEventListener("input", draw);
    bg.addEventListener("click", (e) => {
      if (e.target.closest("[data-x]")) return bg.remove();
      const r = e.target.closest("[data-m]"); if (r) { bg.remove(); open("coin", r.dataset.m); }
    });
    draw(); $("#q").focus();
  }

  function sheet(html) {
    return new Promise((resolve) => {
      const bg = document.createElement("div"); bg.className = "sheet-bg"; bg.innerHTML = '<div class="sheet">' + html + "</div>";
      document.body.appendChild(bg);
      bg.addEventListener("click", (e) => {
        if (e.target === bg || e.target.closest("[data-no]")) { bg.remove(); resolve(null); }
        if (e.target.closest("[data-yes]")) { const f = bg.querySelector("input"); bg.remove(); resolve(f ? f.value : true); }
      });
      bg.addEventListener("input", () => { const f = bg.querySelector("input"), y = bg.querySelector("[data-yes]"); if (f && y) y.disabled = f.value !== f.dataset.need; });
    });
  }
  const confirmSheet = (t, p, yes) => sheet("<h3>" + esc(t) + "</h3><p>" + esc(p) + '</p><div class="acts"><button class="btn" data-no>Cancel</button><button class="btn primary" data-yes>' + esc(yes) + "</button></div>");
  const promptSheet = (t, p, need) => sheet("<h3>" + esc(t) + "</h3><p>" + esc(p) + '</p><input class="field" data-need="' + esc(need) + '" autocapitalize="characters" autocomplete="off" placeholder="' + esc(need) + '"><div class="acts"><button class="btn" data-no>Cancel</button><button class="btn primary" data-yes disabled>Confirm</button></div>');
  function toast(msg) { msg = String(msg || ""); msg = msg.charAt(0).toUpperCase() + msg.slice(1); const t = document.createElement("div"); t.className = "toast"; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 2400); }

  /* ---------------------------------------------------------------- loading */
  async function loadMore() {
    if (S.actNext == null) return;
    try {
      const r = DS.kind === "api" ? await get("activity", S.actNext) : await get("activity", S.actPage + 1);
      if (DS.kind !== "api") S.actPage++;
      S.act = S.act.concat(r.items); S.actNext = r.next;
      render();
    } catch (e) { fail(); }
  }

  let refreshing = false, retryTimer = 0;
  async function refresh() {
    if (!DS.kind || refreshing) { render(); return; }
    refreshing = true;
    const copyJob = S.tab === "copy" && !S.push ? refreshCopy() : null;
    try {
      const jobs = [get("state"), get("settings"), get("chart", S.range), get("activity", null), ...AGENTS.map((a) => get("decisions", a))];
      if (S.tab === "account") jobs.push(get("account"));
      const [state, settings, chart, act0, ...rest] = await Promise.all(jobs);
      S.state = state; S.settings = settings; S.chart[S.range] = chart;
      const keepMore = S.act && S.act.length > act0.items.length && S.tab === "activity";
      if (!keepMore) { S.act = act0.items; S.actNext = act0.next; S.actPage = 0; }
      AGENTS.forEach((a, i) => { S.dec[a] = rest[i]; });
      if (S.tab === "account") S.account = rest[AGENTS.length];
      if (S.push) {
        const mint = S.push.type === "auditor" ? auditorMint() : coinMint();
        if (mint) {
          if (S.push.type === "auditor") S.audit[mint] = await get("audit", mint, { nullOn404: true });
          else S.coin[mint] = await get("coin", mint, { nullOn404: true });
        }
      }
      S.lastOk = Date.now(); S.offline = null; S.loadedOnce = true;
    } catch (e) {
      fail();
    } finally {
      if (copyJob) await copyJob;
      refreshing = false;
    }
    render();
    schedule();
  }
  function fail() { S.offline = { retryAt: Date.now() + POLL_S * 1000 }; }
  function schedule() {
    clearTimeout(retryTimer);
    if (DS.kind === "api" && !S.offline && sseUp) { retryTimer = setTimeout(refresh, 60000); return; }   // SSE drives updates
    retryTimer = setTimeout(refresh, POLL_S * 1000);
  }
  setInterval(() => { const r = $("#err-row"); if (r && S.offline) { const n = Math.max(0, Math.ceil((S.offline.retryAt - Date.now()) / 1000)); r.textContent = "Desk offline · retrying in " + n + "s · last update " + (S.lastOk ? hhmm(S.lastOk) : "never"); } }, 1000);

  /* ---------------------------------------------------------------- SSE (live API) */
  let sseUp = false, sseBackoff = 1;
  async function sse() {
    if (DS.kind !== "api") return;
    try {
      const r = await fetch(DS.api + "/api/stream", { headers: headers(), cache: "no-store" });
      if (!r.ok || !r.body) throw new Error("stream " + r.status);
      sseUp = true; sseBackoff = 1;
      const rd = r.body.getReader(), dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await rd.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          let ev = null, data = "";
          for (const line of frame.split("\n")) { if (line.startsWith("event: ")) ev = line.slice(7); else if (line.startsWith("data: ")) data += line.slice(6); }
          if (ev) onEvent(ev, data);
        }
      }
    } catch (e) { /* fall through to retry */ }
    sseUp = false; fail(); render();
    setTimeout(sse, Math.min(60, (sseBackoff *= 2)) * 1000);
  }
  let evTimer = 0;
  function onEvent(ev, data) {
    let d = {}; try { d = JSON.parse(data); } catch (e) { return; }
    if (ev === "audit_layer" && d.mint) {
      const L = S.liveLayers[d.mint] || (S.liveLayers[d.mint] = { layers: [], done: false });
      L.layers[d.n - 1] = { layer: d.n, name: d.name, result: d.pass === true ? "ok" : d.pass === false ? "red" : "not checked", value: d.value, source: d.source };
      if (d.n === 8 || d.pass === false) L.done = d.n === 8;
      if (S.push && S.push.type === "auditor" && auditorMint() === d.mint && beam) beam.update(L.layers, null);
    }
    clearTimeout(evTimer); evTimer = setTimeout(refresh, 400);
  }

  /* ---------------------------------------------------------------- connect (home-screen app, no token yet)
     An app added to the iPhone home screen has its own storage and opens at ./ without the link's fragment,
     so it asks once for the private link. The link is parsed here and kept in localStorage only. */
  function renderConnect() {
    document.body.classList.add("connecting");
    const root = $("#tab"); root.className = "screen connect";
    root.innerHTML = '<div class="large-title connect-title">Connect your desk</div>' +
      '<p class="connect-sub">Paste the private link Grok Bot sent you in Telegram. It stays on this iPhone.</p>' +
      '<div class="list connect-box"><textarea id="connect-link" rows="3" placeholder="Private link" aria-label="Private link" ' +
      'autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false"></textarea></div>' +
      '<div class="connect-err" id="connect-err" role="alert"></div>' +
      '<button class="cta connect-go" id="connect-go" type="button">Connect</button>';
    const err = (m) => { $("#connect-err").textContent = m || ""; };
    if (S.linkError) err(S.linkError);
    $("#connect-go").onclick = () => {
      const L = DeskLink.parse($("#connect-link").value);
      if (L.apiRejected) return err("The desk address in that link must start with https://");
      if (!L.t) return err("That link has no desk key. Copy the whole link from Telegram.");
      if (!L.api) return err("That link has no desk address. Copy the whole link from Telegram.");
      localStorage.setItem("desk.t", L.t); localStorage.setItem("desk.api", L.api);
      if (L.p) localStorage.setItem("desk.p", L.p);
      $("#connect-link").value = "";
      location.replace(location.pathname + location.search);   // reload: boot finds the stored link
    };
  }

  /* ---------------------------------------------------------------- boot */
  async function boot() {
    readFragment();
    shell();
    const qs = new URLSearchParams(location.search);
    if (isStandalone() && !token() && !qs.get("demo")) { renderConnect(); return; }
    const scr = qs.get("screen");
    if (["home", "agents", "copy", "activity", "account"].includes(scr)) S.tab = scr;
    if (scr === "auditor" || scr === "coin") S.push = { type: scr, mint: qs.get("mint") || null };
    if (S.push) { $("#push").classList.remove("hidden"); document.body.classList.add("push-open"); }
    S.picking = true; render();
    await pickSource();
    S.picking = false;
    if ("serviceWorker" in navigator && DS.kind && !DS.demo) navigator.serviceWorker.register("sw.js").catch(() => {});
    await refresh();
    if (DS.demo === "error" && S.loadedOnce) { DS.failAll = true; setTimeout(refresh, 300); }   // fetch fails after one good load
    if (DS.kind === "api") sse();
  }
  window.addEventListener("scroll", () => document.body.classList.toggle("scrolled", window.scrollY > 44), { passive: true });
  window.addEventListener("DOMContentLoaded", boot);
})();
