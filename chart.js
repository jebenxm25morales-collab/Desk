/* Canvas charts (devicePixelRatio aware): Home line chart, Coin candles, Analyst score ring. */
(function () {
  "use strict";
  const C = {
    green: "#00d35a", red: "#ff453a", orange: "#ff9f0a", blue: "#0a84ff", cyan: "#64d2ff",
    yellow: "#ffd60a", text: "#ffffff", text2: "rgba(235,235,245,0.6)", text3: "rgba(235,235,245,0.3)",
    sep: "rgba(84,84,88,0.55)", card: "#1c1c1e", card2: "#2c2c2e",
  };
  const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Inter, Roboto, system-ui, sans-serif';
  const reduced = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function setup(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const r = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  /* ---------------- Home line chart ---------------- */
  class LineChart {
    constructor(canvas) {
      this.c = canvas; this.points = []; this.marks = []; this.start = null;
      this.prevLen = 0; this.slide = 1; this.seenMarks = new Map(); this.raf = 0; this.range = null;
      window.addEventListener("resize", () => this.draw());
    }
    setData(points, startValue, marks, range) {
      const rangeChanged = range !== this.range;
      const grew = !rangeChanged && points.length > this.points.length && this.points.length > 0;
      this.points = points || []; this.marks = marks || []; this.start = startValue; this.range = range;
      const now = performance.now();
      for (const m of this.marks) {
        const k = m.ts + "|" + m.text;
        if (!this.seenMarks.has(k)) this.seenMarks.set(k, rangeChanged || reduced() ? now - 1000 : now);
      }
      if (grew && !reduced()) { this.slideT0 = now; this.slide = 0; } else { this.slide = 1; }
      this.loop();
    }
    loop() {
      cancelAnimationFrame(this.raf);
      const step = () => {
        const now = performance.now();
        if (this.slide < 1) this.slide = Math.min(1, (now - this.slideT0) / 250);
        const fading = [...this.seenMarks.values()].some((t0) => now - t0 < 200);
        this.draw(now);
        if (this.slide < 1 || fading) this.raf = requestAnimationFrame(step);
      };
      step();
    }
    draw(now) {
      now = now || performance.now();
      const { ctx, w, h } = setup(this.c);
      const pts = this.points;
      const top = 70, bottom = h - 10, left = 0, right = w;
      const vals = pts.map((p) => p.value).concat(this.start != null ? [this.start] : []);
      if (!vals.length) return;
      let lo = Math.min(...vals), hi = Math.max(...vals);
      if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
      const pad = (hi - lo) * 0.12; lo -= pad; hi += pad;
      const y = (v) => bottom - ((v - lo) / (hi - lo)) * (bottom - top);
      let t0, t1;
      if (pts.length >= 2) { t0 = pts[0].ts; t1 = pts[pts.length - 1].ts; } else if (pts.length === 1) { t0 = pts[0].ts - 60; t1 = pts[0].ts; }
      const x = (t) => (t1 === t0 ? right : left + ((t - t0) / (t1 - t0)) * (right - left));
      // dashed start line
      if (this.start != null) {
        ctx.save(); ctx.setLineDash([3, 4]); ctx.strokeStyle = C.text3; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, Math.round(y(this.start)) + 0.5); ctx.lineTo(w, Math.round(y(this.start)) + 0.5); ctx.stroke(); ctx.restore();
      }
      if (pts.length < 2) return;
      // line path (last segment slides in over 250 ms)
      const n = pts.length;
      const xy = pts.map((p) => [x(p.ts), y(p.value)]);
      if (this.slide < 1) {
        const a = xy[n - 2], b = xy[n - 1], e = 1 - Math.pow(1 - this.slide, 3);
        xy[n - 1] = [a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e];
      }
      const grad = ctx.createLinearGradient(0, top, 0, bottom);
      grad.addColorStop(0, "rgba(0,211,90,0.28)"); grad.addColorStop(1, "rgba(0,211,90,0)");
      ctx.beginPath(); ctx.moveTo(xy[0][0], xy[0][1]);
      for (let i = 1; i < n; i++) ctx.lineTo(xy[i][0], xy[i][1]);
      ctx.lineTo(xy[n - 1][0], bottom); ctx.lineTo(xy[0][0], bottom); ctx.closePath();
      ctx.fillStyle = grad; ctx.fill();
      ctx.beginPath(); ctx.moveTo(xy[0][0], xy[0][1]);
      for (let i = 1; i < n; i++) ctx.lineTo(xy[i][0], xy[i][1]);
      ctx.strokeStyle = C.green; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.stroke();
      // end dot
      ctx.beginPath(); ctx.arc(xy[n - 1][0] - 4, xy[n - 1][1], 4, 0, Math.PI * 2); ctx.fillStyle = C.green; ctx.fill();
      // marks above the line; a later mark that would overlap moves up a row
      ctx.font = "600 12px " + FONT; ctx.textBaseline = "middle";
      const placed = [];
      const valueAt = (t) => {
        for (let i = 1; i < pts.length; i++) if (pts[i].ts >= t) {
          const a = pts[i - 1], b = pts[i], f = (t - a.ts) / Math.max(1, b.ts - a.ts);
          return a.value + (b.value - a.value) * f;
        }
        return pts[pts.length - 1].value;
      };
      for (const m of this.marks) {
        if (m.ts < t0 || m.ts > t1) continue;
        const col = m.kind === "buy" ? C.blue : m.kind === "win" ? C.green : C.red;
        const mx = x(m.ts), my = y(valueAt(m.ts));
        const tw = ctx.measureText(m.text).width + 14, th = 20;
        let bx = Math.min(Math.max(mx - tw / 2, 2), w - tw - 2);
        let by = my - 14 - th, row = 0;
        const hit = (r) => placed.some((p) => r.x < p.x + p.w + 4 && r.x + r.w + 4 > p.x && r.y < p.y + p.h + 2 && r.y + r.h + 2 > p.y);
        let rect = { x: bx, y: by, w: tw, h: th };
        while (hit(rect) && row < 6) { row++; rect = { x: bx, y: by - row * (th + 4), w: tw, h: th }; }
        if (rect.y < 2) rect.y = 2;
        placed.push(rect);
        const t0m = this.seenMarks.get(m.ts + "|" + m.text) || 0;
        const alpha = Math.min(1, Math.max(0, (now - t0m) / 200));
        ctx.save(); ctx.globalAlpha = alpha;
        ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.globalAlpha = alpha * 0.5;
        ctx.beginPath(); ctx.moveTo(mx, my - 5); ctx.lineTo(mx, rect.y + rect.h); ctx.stroke();
        ctx.globalAlpha = alpha;
        ctx.beginPath(); ctx.arc(mx, my, 3.5, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
        roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 10); ctx.fillStyle = C.card; ctx.fill();
        ctx.fillStyle = col; ctx.fillText(m.text, rect.x + 7, rect.y + rect.h / 2 + 0.5);
        ctx.restore();
      }
    }
  }

  /* ---------------- Coin candles (1-minute OHLC from db.prices) ---------------- */
  function buildCandles(prices) {
    const out = [];
    let cur = null, prevVol = null;
    for (const p of prices || []) {
      if (p.price == null) continue;
      const m = Math.floor(p.ts / 60) * 60;
      if (!cur || cur.t !== m) { cur = { t: m, o: p.price, h: p.price, l: p.price, c: p.price, v: 0 }; out.push(cur); }
      cur.h = Math.max(cur.h, p.price); cur.l = Math.min(cur.l, p.price); cur.c = p.price;
      if (p.volumeM5 != null) { if (prevVol != null) cur.v += Math.abs(p.volumeM5 - prevVol); prevVol = p.volumeM5; }
    }
    return out;
  }

  function drawCandles(canvas, prices, exitLine) {
    const { ctx, w, h } = setup(canvas);
    const cs = buildCandles(prices);
    if (!cs.length) {
      ctx.fillStyle = C.text2; ctx.font = "15px " + FONT; ctx.textAlign = "center";
      ctx.fillText("No price yet", w / 2, h / 2); return cs;
    }
    const volH = 48, gap = 10, top = 18, bottom = h - volH - gap;
    let lo = Math.min(...cs.map((c) => c.l)), hi = Math.max(...cs.map((c) => c.h));
    if (exitLine != null) { lo = Math.min(lo, exitLine); hi = Math.max(hi, exitLine); }
    if (hi - lo <= 0) { hi *= 1.01; lo *= 0.99; }
    const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    const y = (v) => bottom - ((v - lo) / (hi - lo)) * (bottom - top);
    const n = cs.length, slot = w / n, bw = Math.max(1, Math.min(10, slot * 0.66));
    const vmax = Math.max(1e-9, ...cs.map((c) => c.v));
    cs.forEach((c, i) => {
      const cx = slot * i + slot / 2, up = c.c >= c.o, col = up ? C.green : C.red;
      ctx.strokeStyle = col; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(Math.round(cx) + 0.5, y(c.h)); ctx.lineTo(Math.round(cx) + 0.5, y(c.l)); ctx.stroke();
      const yo = y(c.o), yc = y(c.c);
      ctx.fillStyle = col; ctx.fillRect(cx - bw / 2, Math.min(yo, yc), bw, Math.max(1, Math.abs(yc - yo)));
      const vh = (c.v / vmax) * volH;
      ctx.globalAlpha = 0.45; ctx.fillRect(cx - bw / 2, h - vh, bw, vh); ctx.globalAlpha = 1;
    });
    if (exitLine != null) {
      const ly = Math.round(y(exitLine)) + 0.5;
      ctx.save(); ctx.setLineDash([6, 4]); ctx.strokeStyle = C.orange; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(w, ly); ctx.stroke(); ctx.restore();
      ctx.font = "600 12px " + FONT; ctx.fillStyle = C.orange; ctx.textAlign = "right"; ctx.textBaseline = "bottom";
      ctx.fillText("Risk trailing stop", w - 4, ly - 4);
    }
    return cs;
  }

  /* ---------------- Analyst score ring 0-100, green from 70 ---------------- */
  function drawRing(canvas, score, accent) {
    const { ctx, w, h } = setup(canvas);
    const r = Math.min(w, h) / 2 - 8, cx = w / 2, cy = h / 2;
    if (!(r > 0)) return;                       // canvas not laid out (hidden): nothing to draw yet
    ctx.lineWidth = 10; ctx.lineCap = "round";
    ctx.strokeStyle = C.card2; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    if (score != null) {
      ctx.strokeStyle = score >= 70 ? C.green : (accent || C.yellow);
      ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * Math.max(0, Math.min(100, score))) / 100); ctx.stroke();
    }
    ctx.fillStyle = score == null ? C.text3 : C.text; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.font = '700 34px -apple-system, BlinkMacSystemFont, "SF Pro Display", Inter, Roboto, system-ui, sans-serif';
    ctx.fillText(score == null ? "–" : String(score), cx, cy + 1);
  }

  window.DeskCharts = { LineChart, drawCandles, buildCandles, drawRing, COLORS: C };
})();
