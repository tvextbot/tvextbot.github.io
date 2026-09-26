// Animated candlestick chart for the home hero background.
// Draws onto <canvas id="hero-candles">; the original background image stays underneath as a fallback.
(function () {
  var canvas = document.getElementById('hero-candles');
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext('2d');
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var COLORS = {
    bgTop: '#0b1220', bgBottom: '#0f1b33',
    grid: 'rgba(148, 163, 184, 0.07)',
    up: '#2ee872', down: '#ff5a5a',
    ma: '#22d3ee', maSlow: 'rgba(250, 204, 21, 0.8)',
    price: 'rgba(226, 232, 240, 0.85)'
  };

  var W = 0, H = 0, dpr = 1, candleW = 14, gap = 6, step = 20;
  var candles = [], signals = [];
  var offset = 0;              // horizontal scroll inside the current step (px)
  var speed = 0.45;            // px per frame at 60fps
  var lastPrice = 100, live = null, liveTicks = 0;
  var FAST = 6, SLOW = 18;     // moving averages whose crossovers trigger the demo trades
  var pos = null;              // open demo position {side, entry, i, market}
  var packets = [], particles = null;            // "webhook" dots flying from a signal to the order toast
  var booting = true;          // no toasts while pre-filling history
  var lastTrade = 0;           // time of the last demo trade (ms)
  var MIN_GAP = 4000, MAX_GAP = 8000, FIRST_TRADE = 1500;
  var PNL_SCALE = 0.25;         // the synthetic price swings a lot; keep shown returns in a realistic range
  var MARKETS = [
    { ex: 'Binance 선물', sym: 'BTC/USDT' }, { ex: 'Bybit', sym: 'ETH/USDT' },
    { ex: 'Bitget', sym: 'SOL/USDT' }, { ex: 'OKX', sym: 'BTC/USDT' }
  ];

  // order toasts (DOM) shown when the webhook dot arrives
  var toastBox = document.createElement('div');
  toastBox.className = 'hero-toasts';
  toastBox.setAttribute('aria-hidden', 'true');
  canvas.parentNode.appendChild(toastBox);

  function showToast(ev) {
    var el = document.createElement('div');
    var m = ev.market, body;
    if (ev.type === 'CLOSE') {
      var pnl = (ev.pnl >= 0 ? '+' : '') + ev.pnl.toFixed(2) + '%';
      el.className = 'hero-toast close';
      body = '<b>청산</b> ' + m.sym + ' · 수익 <span class="' + (ev.pnl >= 0 ? 'pos' : 'neg') + '">' + pnl + '</span>';
    } else {
      var buy = ev.type === 'BUY';
      el.className = 'hero-toast ' + (buy ? 'buy' : 'sell');
      body = '<b>' + (buy ? '매수 (롱)' : '매도 (숏)') + '</b> ' + m.sym + ' · 시장가';
    }
    el.innerHTML = '<div class="t-head"><span class="t-check">✓</span>자동매매 주문 체결<span class="t-time">방금</span></div>' +
      '<div class="t-body">' + body + '</div>' +
      '<div class="t-meta">' + m.ex + ' · 트레이딩뷰 얼러트 → 웹훅 수신</div>';
    toastBox.insertBefore(el, toastBox.firstChild);
    var max = W < 700 ? 1 : 2;
    while (toastBox.children.length > max) toastBox.removeChild(toastBox.lastChild);
    requestAnimationFrame(function () { el.classList.add('show'); });
    setTimeout(function () { el.classList.remove('show'); el.classList.add('hide'); }, 4200);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 4800);
  }

  function emit(ev, delay) {
    if (booting || reduceMotion) return;
    packets.push({ ev: ev, born: performance.now() + (delay || 0), done: false });
  }

  function onCross(up, i, forced) {
    var now = performance.now();
    if (!booting && !forced && now - lastTrade < MIN_GAP) return;   // keep trades from bunching up
    if (!booting) lastTrade = now;
    var price = candles[i].c;
    if (pos && (pos.side === 'long') !== up) {
      var pnl = (pos.side === 'long' ? price - pos.entry : pos.entry - price) / pos.entry * 100 * PNL_SCALE;
      var closeEv = { type: 'CLOSE', i: i, pnl: pnl, market: pos.market, born: performance.now() };
      signals.push(closeEv); emit(closeEv, 0);
    }
    var market = MARKETS[Math.floor(Math.random() * MARKETS.length)];
    var openEv = { type: up ? 'BUY' : 'SELL', i: i, market: market, born: performance.now() };
    signals.push(openEv); emit(openEv, pos ? 450 : 0);
    pos = { side: up ? 'long' : 'short', entry: price, i: i, market: market };
  }

  function rand(a, b) { return a + Math.random() * (b - a); }

  function nextCandle(prev) {
    var open = prev;
    var drift = Math.sin(candles.length / 23) * 0.35 + Math.sin(candles.length / 7) * 0.15;
    var close = open + drift + rand(-1.6, 1.6);
    var high = Math.max(open, close) + rand(0.1, 1.2);
    var low = Math.min(open, close) - rand(0.1, 1.2);
    return { o: open, h: high, l: low, c: close, v: Math.abs(close - open) * rand(0.6, 1.4) + rand(0.2, 1.2) };
  }

  function sma(n, i) {
    if (i < n - 1) return null;
    var s = 0;
    for (var k = i - n + 1; k <= i; k++) s += candles[k].c;
    return s / n;
  }

  function resize() {
    var r = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(1, Math.round(r.width));
    H = Math.max(1, Math.round(r.height));
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    candleW = W < 600 ? 9 : W < 1200 ? 13 : 17;
    gap = Math.round(candleW * 0.45);
    step = candleW + gap;
    var need = Math.ceil(W / step) + 4;
    while (candles.length < need + 40) {
      candles.push(nextCandle(candles.length ? candles[candles.length - 1].c : lastPrice));
    }
  }

  function pushCandle() {
    candles.push(live || nextCandle(candles[candles.length - 1].c));
    live = null; liveTicks = 0;
    var i = candles.length - 1, f0 = sma(FAST, i - 1), s0 = sma(SLOW, i - 1), f1 = sma(FAST, i), s1 = sma(SLOW, i);
    if (f0 && s0 && f1 && s1) {
      if (f0 <= s0 && f1 > s1) onCross(true, i);
      if (f0 >= s0 && f1 < s1) onCross(false, i);
    }
    var keep = Math.ceil(W / step) + 60;
    if (candles.length > keep) {
      var cut = candles.length - keep;
      candles.splice(0, cut);
      signals = signals.filter(function (s) { s.i -= cut; return s.i >= 0; });
      packets.forEach(function (p) { p.ev.i -= cut; });
      if (pos) pos.i -= cut;
    }
  }

  function draw(now) {
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, COLORS.bgTop); g.addColorStop(1, COLORS.bgBottom);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    // aurora: soft colour glows drifting slowly
    var tt = now / 1000;
    [
      { x: 0.18 + Math.sin(tt / 9) * 0.08, y: 0.22 + Math.cos(tt / 11) * 0.06, r: 0.55, c: '34, 211, 238', a: 0.22 },
      { x: 0.82 + Math.cos(tt / 10) * 0.07, y: 0.30 + Math.sin(tt / 8) * 0.07, r: 0.50, c: '168, 85, 247', a: 0.24 },
      { x: 0.55 + Math.sin(tt / 13) * 0.10, y: 0.85 + Math.cos(tt / 12) * 0.05, r: 0.60, c: '59, 130, 246', a: 0.18 }
    ].forEach(function (b) {
      var R = Math.max(W, H) * b.r, gl = ctx.createRadialGradient(b.x * W, b.y * H, 0, b.x * W, b.y * H, R);
      gl.addColorStop(0, 'rgba(' + b.c + ',' + b.a + ')'); gl.addColorStop(1, 'rgba(' + b.c + ',0)');
      ctx.fillStyle = gl; ctx.fillRect(0, 0, W, H);
    });

    // floating particles
    if (!particles) {
      particles = [];
      for (var pi = 0; pi < Math.round(W / 25); pi++) particles.push({ x: Math.random(), y: Math.random(), s: rand(0.6, 2), v: rand(0.00015, 0.0006), p: Math.random() * 6.28 });
    }
    particles.forEach(function (pt) {
      pt.y -= pt.v; if (pt.y < -0.02) { pt.y = 1.02; pt.x = Math.random(); }
      var tw = 0.35 + 0.35 * Math.sin(tt * 2 + pt.p);
      ctx.beginPath(); ctx.arc(pt.x * W, pt.y * H, pt.s, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(165, 243, 252,' + tw + ')'; ctx.fill();
    });

    // perspective floor grid below the chart, scrolling with the candles
    var horizon = H * 0.62, vpX = W / 2;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, horizon, W, H - horizon); ctx.clip();
    var fg = ctx.createLinearGradient(0, horizon, 0, H);
    fg.addColorStop(0, 'rgba(34, 211, 238, 0)'); fg.addColorStop(1, 'rgba(34, 211, 238, 0.38)');
    ctx.strokeStyle = fg; ctx.lineWidth = 1;
    for (var gi2 = -24; gi2 <= 24; gi2++) {
      ctx.beginPath(); ctx.moveTo(vpX + gi2 * 12, horizon); ctx.lineTo(vpX + gi2 * W * 0.12, H); ctx.stroke();
    }
    var phase = (offset / step);
    for (var r2 = 0; r2 < 14; r2++) {
      var z = (r2 + 1 - phase) / 14, yy = horizon + (H - horizon) * z * z;
      ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(W, yy); ctx.stroke();
    }
    ctx.restore();

    // faint flat grid behind the price area
    ctx.strokeStyle = COLORS.grid; ctx.lineWidth = 1;
    for (var gy = 0; gy < horizon; gy += 60) { ctx.beginPath(); ctx.moveTo(0, gy + 0.5); ctx.lineTo(W, gy + 0.5); ctx.stroke(); }
    for (var gx = -offset % 120; gx < W; gx += 120) { ctx.beginPath(); ctx.moveTo(gx + 0.5, 0); ctx.lineTo(gx + 0.5, horizon); ctx.stroke(); }

    // live (forming) candle wiggles before it is committed
    var last = candles[candles.length - 1];
    if (!live) live = { o: last.c, h: last.c, l: last.c, c: last.c, v: 0.3 };
    liveTicks++;
    if (liveTicks % 6 === 0) {
      live.c += rand(-0.6, 0.6);
      live.h = Math.max(live.h, live.c); live.l = Math.min(live.l, live.c); live.v += rand(0.02, 0.12);
    }

    var visible = Math.ceil(W / step) + 2;
    var start = Math.max(0, candles.length - visible);
    var series = candles.slice(start).concat([live]);
    var lo = Infinity, hi = -Infinity;
    series.forEach(function (c) { lo = Math.min(lo, c.l); hi = Math.max(hi, c.h); });
    var pad = (hi - lo) * 0.25 + 1;
    lo -= pad; hi += pad;
    var top = H * 0.12, bottom = H * 0.74;   // price area; volume bars sit below
    function y(v) { return bottom - (v - lo) / (hi - lo) * (bottom - top); }
    function x(k) { return W - (series.length - k) * step - offset + step; }

    // moving averages
    function drawMA(n, color, width) {
      ctx.beginPath(); var started = false;
      for (var k = 0; k < series.length; k++) {
        var gi = start + k, m;
        if (k === series.length - 1) { m = null; }
        else m = sma(n, gi);
        if (m == null) continue;
        var px = x(k) + candleW / 2, py = y(m);
        if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = color; ctx.lineWidth = width;
      ctx.shadowColor = color; ctx.shadowBlur = 8; ctx.stroke(); ctx.shadowBlur = 0;
    }

    // volume bars along the bottom
    var volTop = H * 0.80, volBottom = H;
    var vmax = 0; series.forEach(function (c) { vmax = Math.max(vmax, c.v || 0); });
    for (var q = 0; q < series.length; q++) {
      var vc = series[q], vx = x(q), vh = ((vc.v || 0) / (vmax || 1)) * (volBottom - volTop);
      ctx.globalAlpha = Math.min(0.28, Math.max(0.05, vx / (W * 0.35) * 0.28));
      ctx.fillStyle = vc.c >= vc.o ? COLORS.up : COLORS.down;
      ctx.fillRect(vx, volBottom - vh, candleW, vh);
    }
    ctx.globalAlpha = 1;

    // candles
    for (var k = 0; k < series.length; k++) {
      var c = series[k], cx = x(k), up = c.c >= c.o, col = up ? COLORS.up : COLORS.down;
      var alpha = Math.min(1, Math.max(0.5, cx / (W * 0.15)));   // slight fade at the left edge
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(cx + candleW / 2, y(c.h)); ctx.lineTo(cx + candleW / 2, y(c.l)); ctx.stroke();
      var by = y(Math.max(c.o, c.c)), bh = Math.max(1, Math.abs(y(c.o) - y(c.c)));
      ctx.shadowColor = col; ctx.shadowBlur = k === series.length - 1 ? 16 : 5;
      ctx.fillRect(cx, by, candleW, bh);
      ctx.shadowBlur = 0;
    }
    ctx.globalAlpha = 0.9;
    drawMA(SLOW, COLORS.maSlow, 2.2);
    drawMA(FAST, COLORS.ma, 2.8);

    // open position: entry line + live P&L badge
    if (pos) {
      var ey = y(pos.entry), ex0 = Math.max(0, x(pos.i - start) + candleW / 2);
      var pnlNow = (pos.side === 'long' ? live.c - pos.entry : pos.entry - live.c) / pos.entry * 100 * PNL_SCALE;
      var pcol = pnlNow >= 0 ? COLORS.up : COLORS.down;
      ctx.setLineDash([6, 4]); ctx.strokeStyle = pos.side === 'long' ? COLORS.up : COLORS.down; ctx.globalAlpha = 0.8; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(ex0, ey + 0.5); ctx.lineTo(W - 70, ey + 0.5); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
      var label = (pos.side === 'long' ? 'LONG ' : 'SHORT ') + (pnlNow >= 0 ? '+' : '') + pnlNow.toFixed(2) + '%';
      ctx.font = '700 12px Mulish, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      var bw = ctx.measureText(label).width + 16, bx = W - 76 - bw;
      ctx.fillStyle = 'rgba(11,18,32,0.85)'; ctx.fillRect(bx, ey - 11, bw, 22);
      ctx.strokeStyle = pcol; ctx.lineWidth = 1; ctx.strokeRect(bx + 0.5, ey - 10.5, bw - 1, 21);
      ctx.fillStyle = pcol; ctx.fillText(label, bx + bw / 2, ey);
    }
    ctx.globalAlpha = 1;

    // last price line + label
    var ly = y(live.c);
    ctx.setLineDash([4, 6]); ctx.strokeStyle = 'rgba(226,232,240,0.35)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, ly + 0.5); ctx.lineTo(W, ly + 0.5); ctx.stroke(); ctx.setLineDash([]);
    var lcol = live.c >= live.o ? COLORS.up : COLORS.down;
    ctx.fillStyle = lcol; ctx.fillRect(W - 64, ly - 11, 64, 22);
    ctx.fillStyle = '#0b1220'; ctx.font = '600 12px Mulish, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText((live.c * 1000).toFixed(0), W - 32, ly);

    // BUY / SELL signals
    signals.forEach(function (s) {
      var k = s.i - start;
      if (k < 0 || k >= series.length) return;
      var c = series[k], sx = x(k) + candleW / 2, buy = s.type === 'BUY';
      if (s.type === 'CLOSE') {
        var cy = y(c.c), ccol = s.pnl >= 0 ? COLORS.up : COLORS.down;
        ctx.beginPath(); ctx.arc(sx, cy, 5, 0, Math.PI * 2); ctx.fillStyle = '#e2e8f0'; ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = ccol; ctx.stroke();
        ctx.font = '700 11px Mulish, sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = ccol;
        ctx.fillText('청산 ' + (s.pnl >= 0 ? '+' : '') + s.pnl.toFixed(1) + '%', sx, cy - 14);
        return;
      }
      var sy = buy ? y(c.l) + 18 : y(c.h) - 18;
      var age = (now - s.born) / 1000;
      var col = buy ? COLORS.up : COLORS.down;
      if (age < 1.6 && !reduceMotion) {               // pulse ring when a signal appears
        ctx.beginPath(); ctx.arc(sx, sy, 8 + age * 28, 0, Math.PI * 2);
        ctx.strokeStyle = col; ctx.globalAlpha = Math.max(0, 1 - age / 1.6); ctx.lineWidth = 2; ctx.stroke(); ctx.globalAlpha = 1;
      }
      ctx.fillStyle = col; ctx.beginPath();
      if (buy) { ctx.moveTo(sx, sy - 7); ctx.lineTo(sx - 6, sy + 4); ctx.lineTo(sx + 6, sy + 4); }
      else { ctx.moveTo(sx, sy + 7); ctx.lineTo(sx - 6, sy - 4); ctx.lineTo(sx + 6, sy - 4); }
      ctx.closePath(); ctx.fill();
      ctx.font = '700 11px Mulish, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(buy ? '매수' : '매도', sx, buy ? sy + 16 : sy - 16);
    });

    // darken the centre so the logo and text stay readable
    var v = ctx.createRadialGradient(W / 2, H * 0.45, 0, W / 2, H * 0.45, Math.max(W, H) * 0.6);
    v.addColorStop(0, 'rgba(11,18,32,0.38)'); v.addColorStop(0.3, 'rgba(11,18,32,0.12)'); v.addColorStop(1, 'rgba(11,18,32,0)');
    ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);

    // webhook dots: signal -> order toast
    var cr = canvas.getBoundingClientRect(), tr = toastBox.getBoundingClientRect();
    var tx = tr.left - cr.left + (W < 700 ? tr.width / 2 : 0), ty = tr.bottom - cr.top - 30;
    packets.forEach(function (p) {
      var t = (now - p.born) / 900;
      if (t < 0 || p.done) return;
      if (t >= 1) { p.done = true; showToast(p.ev); return; }
      var k = p.ev.i - start, sc = series[Math.max(0, Math.min(series.length - 1, k))];
      var sx = x(k) + candleW / 2, sy = y(sc.c);
      var e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      var cx = (sx + tx) / 2, cy = Math.min(sy, ty) - H * 0.18;
      function pt(u) { return [(1 - u) * (1 - u) * sx + 2 * (1 - u) * u * cx + u * u * tx, (1 - u) * (1 - u) * sy + 2 * (1 - u) * u * cy + u * u * ty]; }
      var col = p.ev.type === 'SELL' ? COLORS.down : p.ev.type === 'BUY' ? COLORS.up : '#e2e8f0';
      for (var j = 8; j >= 0; j--) {
        var q = pt(Math.max(0, e - j * 0.025));
        ctx.beginPath(); ctx.arc(q[0], q[1], 4 - j * 0.35, 0, Math.PI * 2);
        ctx.fillStyle = col; ctx.globalAlpha = (1 - j / 9) * 0.9; ctx.shadowColor = col; ctx.shadowBlur = 12; ctx.fill();
      }
      ctx.globalAlpha = 1; ctx.shadowBlur = 0;
    });
    packets = packets.filter(function (p) { return !p.done; });
  }

  var running = true, visible = true;
  function frame(now) {
    if (running && visible) {
      offset += speed;
      if (offset >= step) { offset -= step; pushCandle(); }
      // guarantee a trade soon after arriving, then at least every MAX_GAP
      if (!reduceMotion && now - lastTrade > (lastTrade === startAt ? FIRST_TRADE : MAX_GAP)) {
        onCross(!pos || pos.side === 'short', candles.length - 1, true);
      }
      draw(now);
    }
    requestAnimationFrame(frame);
  }

  resize();
  // pre-fill with enough history that the moving averages and a few signals are on screen
  for (var i = 0; i < 80; i++) pushCandle();
  signals.forEach(function (s) { s.born = -1e6; });
  booting = false;
  var startAt = performance.now();
  lastTrade = startAt;
  window.addEventListener('resize', function () { particles = null; resize(); });
  canvas.classList.add('ready');

  if (reduceMotion) { draw(performance.now()); return; }
  document.addEventListener('visibilitychange', function () { running = !document.hidden; });
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (e) { visible = e[0].isIntersecting; }).observe(canvas);
  }
  requestAnimationFrame(frame);
})();
