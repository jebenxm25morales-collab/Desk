/* Grok Bot · iPhone web app for the PAPER copy desk (plain JS, no build step, read-only).
   Data: the copy desk API behind the stored desk address at /copy/api/copy/* (Authorization: Bearer <token>).
   The token and API base (https only) arrive ONLY via the private link's fragment (#t=...&api=https://...),
   opened directly or pasted on the Connect screen; kept in localStorage and stripped from the address bar.
   Nothing secret is ever written into these files. The old token desk screens and /api calls are gone. */
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
  const POLL_S = 15;
  const VERSION = "copy-1";
  const TABS = ["copy", "wallets", "trades", "account"];
  const TAB_NAME = { copy: "Copy", wallets: "Wallets", trades: "Trades", account: "Account" };

  /* ---------------------------------------------------------------- state */
  const S = { tab: "copy", copy: undefined, copyErr: null, copyOk: null, picking: true };
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

  /* ---------------------------------------------------------------- data source: copy desk only */
  async function pickSource() {
    const demo = new URLSearchParams(location.search).get("demo");
    if (demo && /^[a-z]+$/.test(demo)) {                              // test only: ./fixtures/<demo>/ ; absent in production
      try {
        const r = await fetch("fixtures/" + demo + "/ok.json", { cache: "no-store" });
        if (r.ok) { DS.kind = "static"; DS.base = "fixtures/" + demo + "/"; DS.demo = demo; DS.hang = demo === "loading"; return; }
      } catch (e) { /* no fixtures folder in production */ }
    }
    const storedApi = localStorage.getItem("desk.api") || "";
    DS.api = storedApi ? DeskLink.safeApi(storedApi) || "" : "";
    if (storedApi && !DS.api) localStorage.removeItem("desk.api");
    DS.kind = token() && DS.api ? "api" : null;
  }
  const headers = () => (DS.kind === "api" ? { Authorization: "Bearer " + token() } : {});
  const COPY_EPS = ["summary", "wallets", "positions", "trades"];
  function copyUrl(ep) { return DS.kind === "api" ? DS.api + "/copy/api/copy/" + ep : DS.base + "copy/" + ep + ".json"; }

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
  const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

  /* ---------------------------------------------------------------- icons */
  const I = {
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
    wallets: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3" y="6" width="18" height="14" rx="3"/><path d="M3 10h18"/><circle cx="16.5" cy="15" r="1.2" fill="currentColor" stroke="none"/></svg>',
    trades: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>',
    account: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
  };

  /* ---------------------------------------------------------------- shell */
  function shell() {
    document.body.innerHTML = '<div id="app"><main id="tab"></main></div><nav class="tabbar" id="tabbar">' +
      TABS.map((t) => '<button data-tab="' + t + '" aria-label="' + TAB_NAME[t] + '">' + I[t] + "<span>" + TAB_NAME[t] + "</span></button>").join("") + "</nav>";
    $("#tabbar").addEventListener("click", (e) => { const b = e.target.closest("button[data-tab]"); if (b) go(b.dataset.tab); });
  }
  function go(tab) {
    if (S.tab !== tab) { S.tab = tab; window.scrollTo(0, 0); }
    render();
  }
  const navbar = (title) => '<header class="navbar"><div class="title small-title" style="padding-left:6px">' + title + "</div></header>";
  const sk = (h, w = "100%", extra = "") => '<div class="sk" style="height:' + h + "px;width:" + w + ";" + extra + '"></div>';
  const skRows = (n) => '<div class="list">' + Array.from({ length: n }, () => '<div class="row"><div class="main">' + sk(17, "50%") + sk(14, "70%", "margin-top:8px") + "</div>" + sk(17, "60px") + "</div>").join("") + "</div>";

  function errRow() {
    if (!DS.kind) return S.picking ? "" : '<div class="err-row">Not connected · open the app with your private link</div>';
    if (!S.copyErr) return "";
    return '<div class="err-row" id="copy-err"><div>' + esc(S.copyErr.title) + " · retrying</div>" +
      '<div class="err-hint">' + esc(S.copyErr.hint) + (S.copyOk ? " Last update " + hhmm(S.copyOk) + "." : "") + "</div></div>";
  }
  function noData() { return '<div class="empty-msg">' + (DS.kind ? "Copy desk data will show here once it is reachable." : "Paste your private link on this iPhone to connect.") + "</div>"; }

  /* ---------------------------------------------------------------- rows */
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

  /* ---------------------------------------------------------------- screens */
  function renderCopy(c) {
    let h = "";
    if (c === undefined) return h + (S.copyErr || (!DS.kind && !S.picking) ? noData() :
      '<section class="fcard copy-sum">' + sk(15, "30%") + sk(34, "55%", "margin-top:10px") + sk(15, "65%", "margin-top:10px") + sk(40, "100%", "margin-top:16px") + "</section>" +
      '<div class="section-h"><h2>Open positions</h2></div>' + skRows(2));
    h += copySummary(c.summary);
    if (!c.trades.length && !c.positions.length) return h + '<div class="empty-msg">No copied trades yet. Waiting for wallets to trade.</div>' + foot();
    h += '<div class="section-h"><h2>Open positions</h2></div>' + (c.positions.length ? '<div class="list">' + c.positions.map(posRow).join("") + "</div>" : '<div class="empty-msg small">No open positions</div>');
    h += '<div class="section-h"><h2>Recent trades</h2><button class="see" data-go="trades">See all</button></div><div class="list">' + c.trades.slice(0, 5).map(tradeRow).join("") + "</div>";
    return h + foot();
  }
  const foot = () => '<p class="copy-foot">Paper only. Copies are simulated, no real trades are placed.</p>';
  function renderWallets(c) {
    if (c === undefined) return S.copyErr || (!DS.kind && !S.picking) ? noData() : skRows(3);
    return c.wallets.length ? '<div class="list">' + c.wallets.map(walletRow).join("") + "</div>" : '<div class="empty-msg">No wallets followed</div>';
  }
  function renderTrades(c) {
    if (c === undefined) return S.copyErr || (!DS.kind && !S.picking) ? noData() : skRows(6);
    return c.trades.length ? '<div class="list">' + c.trades.slice(0, 100).map(tradeRow).join("") + "</div>" + foot() : '<div class="empty-msg">No copied trades yet. Waiting for wallets to trade.</div>';
  }
  function renderAccount() {
    const t = token(), api = DS.kind === "api" ? DS.api : localStorage.getItem("desk.api") || "";
    const state = !DS.kind ? "Not connected" : DS.demo ? "Demo data" : S.copyErr ? "Unreachable" : S.copy ? "Connected" : "Connecting";
    const cls = state === "Connected" ? " green" : state === "Unreachable" ? " red" : "";
    return '<div class="list">' +
      '<div class="row-link"><span>Copy desk</span><span class="rv' + cls + '">' + state + "</span></div>" +
      '<div class="row-link"><span>Desk address</span><span class="rv wrap mono-s">' + esc(api ? api.replace(/^https:\/\//, "") : "Not set") + "</span></div>" +
      '<div class="row-link"><span>Desk key</span><span class="rv">' + (t ? "Saved on this iPhone ··" + esc(t.slice(-4)) : "Not set") + "</span></div>" +
      '<div class="row-link"><span>Last update</span><span class="rv">' + (S.copyOk ? hhmm(S.copyOk) : "Never") + "</span></div></div>" +
      '<div class="list" style="margin-top:16px"><button class="row-link" data-act="relink"><span>Change private link</span><span class="rv">›</span></button></div>' +
      '<div class="list" style="margin-top:16px"><div class="row-link"><span>Mode</span><span class="rv">Paper · read-only</span></div>' +
      '<div class="row-link"><span>Version</span><span class="rv">Grok Bot ' + VERSION + "</span></div></div>";
  }

  function render() {
    document.querySelectorAll("#tabbar button").forEach((b) => b.classList.toggle("on", b.dataset.tab === S.tab));
    const root = $("#tab"); root.className = "screen";
    const c = S.copy, name = TAB_NAME[S.tab];
    const body = { copy: renderCopy, wallets: renderWallets, trades: renderTrades, account: renderAccount }[S.tab](c);
    root.innerHTML = navbar(name) + (S.tab === "account" ? "" : errRow()) + '<div class="large-title">' + name + "</div>" + body;
    root.onclick = (e) => {
      const g = e.target.closest("[data-go]"); if (g) return go(g.dataset.go);
      const a = e.target.closest("[data-act]"); if (a && a.dataset.act === "relink") relink();
    };
  }
  function relink() {
    ["desk.t", "desk.api", "desk.p"].forEach((k) => localStorage.removeItem(k));
    location.replace(location.pathname + "?screen=connect");
  }

  /* ---------------------------------------------------------------- loading */
  let timer = 0, busy = false;
  async function refresh() {
    if (!DS.kind || busy) { render(); return; }
    if (DS.hang) { render(); return; }                                 // demo=loading: stay on the skeleton
    busy = true;
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
      S.copyErr = /http 401|http 403/.test(e.message)
        ? { title: "Copy desk refused the desk key", hint: "Open the newest private link from Telegram to update the key." }
        : { title: "Copy desk unreachable", hint: "The desk address isn't serving the copy desk yet. It reconnects on its own." };
    }
    busy = false;
        render();
    clearTimeout(timer); timer = setTimeout(refresh, POLL_S * 1000);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && DS.kind) refresh(); });

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
    if (!qs.get("demo") && (isStandalone() || qs.get("screen") === "connect") && !token()) { renderConnect(); return; }
    const scr = qs.get("screen");
    if (TABS.includes(scr)) S.tab = scr;
    render();
    await pickSource();
    S.picking = false;
    if ("serviceWorker" in navigator && DS.kind && !DS.demo) navigator.serviceWorker.register("sw.js").catch(() => {});
    await refresh();
    if (DS.demo === "error" && S.copyOk) { DS.failAll = true; clearTimeout(timer); setTimeout(refresh, 300); }   // fails after one good load
  }
  window.addEventListener("scroll", () => document.body.classList.toggle("scrolled", window.scrollY > 44), { passive: true });
  window.addEventListener("DOMContentLoaded", boot);
})();
