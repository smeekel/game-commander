'use strict';

(() => {
  const canvas = document.getElementById('bg');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  const BG = '#07060b';
  const STAR_COLORS = ['255,207,107', '95,225,255', '201,164,92', '243,234,215'];
  const BARS = [
    { dark: '42,14,71', mid: '91,42,134', light: '217,184,255', speed: 0.31, phase: 0.0, amp: 0.36 },
    { dark: '13,61,61', mid: '31,138,138', light: '182,255,247', speed: 0.23, phase: 2.1, amp: 0.4 },
    { dark: '90,61,12', mid: '201,164,92', light: '255,240,196', speed: 0.27, phase: 4.2, amp: 0.33 },
  ];

  let width = 0;
  let height = 0;
  let stars = [];
  let running = false;
  let rafId = 0;
  let lastTime = 0;
  let clock = 0;

  function makeStar(spawnFar) {
    return {
      x: (Math.random() * 2 - 1),
      y: (Math.random() * 2 - 1),
      z: spawnFar ? 1 : 0.15 + Math.random() * 0.85,
      speed: 0.07 + Math.random() * 0.16,
      size: 0.5 + Math.random() * 1.1,
      color: STAR_COLORS[(Math.random() * STAR_COLORS.length) | 0],
    };
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const count = Math.round(Math.min(700, Math.max(160, (width * height) / 2600)));
    stars = Array.from({ length: count }, () => makeStar(false));
    if (!running) draw(0);
  }

  function project(x, y, z) {
    const focal = Math.max(width, height) * 0.5;
    return [width / 2 + (x / z) * focal * 0.6, height / 2 + (y / z) * focal * 0.6];
  }

  function drawBars() {
    const barHeight = Math.max(28, height * 0.045);
    ctx.globalCompositeOperation = 'lighter';
    for (const bar of BARS) {
      const center = height / 2 + Math.sin(clock * bar.speed + bar.phase) * height * bar.amp;
      const top = center - barHeight / 2;
      const g = ctx.createLinearGradient(0, top, 0, top + barHeight);
      g.addColorStop(0, `rgba(${bar.dark},0)`);
      g.addColorStop(0.25, `rgba(${bar.mid},0.16)`);
      g.addColorStop(0.5, `rgba(${bar.light},0.24)`);
      g.addColorStop(0.75, `rgba(${bar.mid},0.16)`);
      g.addColorStop(1, `rgba(${bar.dark},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, top, width, barHeight);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  function drawStars(dt) {
    ctx.lineCap = 'round';
    for (let i = 0; i < stars.length; i++) {
      const s = stars[i];
      const prevZ = s.z;
      s.z -= s.speed * dt;
      if (s.z <= 0.03) {
        stars[i] = makeStar(true);
        continue;
      }
      const [x, y] = project(s.x, s.y, s.z);
      if (x < -20 || x > width + 20 || y < -20 || y > height + 20) {
        stars[i] = makeStar(true);
        continue;
      }
      const [px, py] = project(s.x, s.y, Math.min(prevZ + s.speed * 0.04, 1));
      const nearness = 1 - s.z;
      const alpha = Math.min(1, 0.15 + nearness * 1.1);
      ctx.strokeStyle = `rgba(${s.color},${alpha.toFixed(3)})`;
      ctx.lineWidth = s.size * (0.4 + nearness * 1.8);
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(x + 0.01, y + 0.01);
      ctx.stroke();
    }
  }

  function draw(dt) {
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, width, height);
    drawBars();
    drawStars(dt);
  }

  function frame(now) {
    const dt = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;
    clock += dt;
    draw(dt);
    rafId = requestAnimationFrame(frame);
  }

  function start() {
    if (running || reducedMotion.matches || document.hidden) return;
    running = true;
    lastTime = performance.now();
    rafId = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(rafId);
  }

  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  reducedMotion.addEventListener('change', () => {
    if (reducedMotion.matches) {
      stop();
      draw(0);
    } else {
      start();
    }
  });
  window.addEventListener('resize', resize);

  resize();
  start();
})();
