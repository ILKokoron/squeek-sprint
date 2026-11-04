/* Squeek Sprint: a race game powered by Squeekchain's public API.
   Ghosts are replayed from GET /v1/measurement/runs (device-signed wheel
   evidence, certifiedCoreWork = false, NOT SqueekCore-certified work).
   Live status/duel data comes from GET /v1/status.
   Race results are local to this browser and are never recorded onchain.
   No wallet, no analytics, no API keys. Plain static site. */
'use strict';

/* ================= Pure logic (also exported for Node tests) ================= */
const Logic = (() => {
  const BLOCK_UNITS_PER_BLOCK = 1000000000n;

  // offsetNs arrives as a decimal string; parse via BigInt so nothing is lost.
  function parseOffsetNs(v) {
    try { return Number(BigInt(String(v))); } catch (e) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
  }
  function bigIntOrNull(v) {
    try { return BigInt(String(v)); } catch (e) { return null; }
  }
  // Normalise a raw API/sample segment into {segmentId,startAt,offsetsSec[],provenance,synthetic}
  function normalizeSegment(raw) {
    if (!raw || !Array.isArray(raw.passages) || raw.passages.length === 0) return null;
    const offs = raw.passages.map(p => parseOffsetNs(p && p.offsetNs) / 1e9);
    offs.sort((a, b) => a - b);
    const base = offs[0];
    const rel = offs.map(o => +(o - base).toFixed(4));
    return {
      segmentId: String(raw.segmentId || 'unknown'),
      startAt: raw.startAt || null,
      offsetsSec: rel,
      steps: rel.length,
      provenance: raw.provenance || (raw.synthetic ? 'sample' : 'hardware'),
      synthetic: !!raw.synthetic,
      label: raw.label || null,
    };
  }
  function spanSec(seg) { return seg.offsetsSec.length ? seg.offsetsSec[seg.offsetsSec.length - 1] : 0; }
  function maxGapSec(seg) {
    let m = 0; const o = seg.offsetsSec;
    for (let i = 1; i < o.length; i++) m = Math.max(m, o[i] - o[i - 1]);
    return m;
  }
  // Playable = long enough to race, short enough to finish, enough steps to tap.
  function isPlayable(seg) {
    if (!seg) return false;
    const s = spanSec(seg);
    return s >= 10 && s <= 60 && seg.steps >= 10;
  }
  function tierFor(seg) {
    const density = seg.steps / Math.max(1, spanSec(seg)); // passages per second
    if (density < 1.05) return { id: 'cruiser', name: 'Cozy Cruiser' };
    if (density < 1.35) return { id: 'jogger', name: 'Steady Jogger' };
    if (density < 1.65) return { id: 'zoomie', name: 'Zoomie' };
    return { id: 'turbo', name: 'Turbo Squeek' };
  }
  // Deterministic daily pick: FNV-1a hash of the UTC date string.
  function dailyIndex(dateStr, count) {
    let h = 0x811c9dc5;
    for (let i = 0; i < dateStr.length; i++) { h ^= dateStr.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return count > 0 ? h % count : 0;
  }
  // Ghost steps completed by time t (binary search over passage times).
  function ghostStepsAt(offsetsSec, t) {
    let lo = 0, hi = offsetsSec.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (offsetsSec[mid] <= t) lo = mid + 1; else hi = mid; }
    return lo;
  }
  // Approximate wheel RPM around time t from recent passage intervals.
  // (One sensor passage = one wheel revolution.)
  function ghostRpmAt(offsetsSec, t) {
    const idx = ghostStepsAt(offsetsSec, t);
    if (idx <= 0 || offsetsSec.length < 2) return 0;
    const gaps = [];
    for (let i = Math.max(1, idx - 2); i <= Math.min(idx, offsetsSec.length - 1); i++) {
      const g = offsetsSec[i] - offsetsSec[i - 1];
      if (g > 0.05) gaps.push(g);
    }
    if (!gaps.length) return 0;
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    return Math.round(Math.min(200, 60 / mean));
  }
  /* Stamina + rhythm model: a steady ~0.6s rhythm is optimal.
     Step value = rhythmFactor(interval) x staminaFactor:
     - rhythm: <160ms = 0.08 (mashing is nearly useless), <380ms = 0.35,
       <560ms = 0.7, >=560ms = 1.0 (a full stride needs a beat between taps)
     - stamina: >=55 = 1, >=30 = 0.75, >0 = 0.5; taps cost 5 stamina
       (mash taps cost +9 extra); stamina 0 = "winded" for 1.4s where
       steps are worth almost nothing and regen is slow.
     Ghosts average ~0.9-1.65 steps/s, so a clean rhythm (~1.5 steps/s)
     beats easy ghosts comfortably and top-tier ghosts only just. */
  function createStamina() { return { value: 100, lastTapMs: -1e9, windedUntilMs: 0, mashCount: 0 }; }
  function tapStamina(st, nowMs) {
    const interval = nowMs - st.lastTapMs;
    st.lastTapMs = nowMs;
    const mashing = interval < 160;
    st.mashCount = mashing ? st.mashCount + 1 : 0;
    let rhythm;
    if (interval < 160) rhythm = 0.08;
    else if (interval < 380) rhythm = 0.35;
    else if (interval < 560) rhythm = 0.7;
    else rhythm = 1;
    let staminaFactor;
    if (nowMs < st.windedUntilMs) staminaFactor = 0.08;
    else if (st.value >= 55) staminaFactor = 1;
    else if (st.value >= 30) staminaFactor = 0.75;
    else staminaFactor = 0.5;
    const step = rhythm * staminaFactor;
    st.value = Math.max(0, st.value - (5 + (mashing ? 9 : 0)));
    if (st.value <= 0 && nowMs >= st.windedUntilMs) st.windedUntilMs = nowMs + 1400;
    return step;
  }
  function regenStamina(st, dtSec, nowMs) {
    const rate = nowMs < st.windedUntilMs ? 9 : 13;
    st.value = Math.min(100, st.value + rate * dtSec);
  }
  function blockProgressPct(blockProgressStr) {
    const bp = bigIntOrNull(blockProgressStr);
    if (bp === null) return null;
    return Number((bp * 10000n) / BLOCK_UNITS_PER_BLOCK) / 100;
  }
  // /status -> simplified live state. 'unavailable' / missing data = unknown, never 0.
  function liveStateFromStatus(json) {
    if (!json || json.status === 'unavailable') return { state: 'unknown' };
    const m = json.measurement;
    if (!m) return { state: 'unknown' };
    const anchor = (json.builder && json.builder.anchor) || null;
    const out = {
      state: 'unknown',
      coreStatus: m.coreStatus || null,
      freshness: m.freshness || null,
      rpm: typeof m.rpmMilli === 'number' ? m.rpmMilli / 1000 : null,
      speedMmPerSecond: typeof m.speedMmPerSecond === 'number' ? m.speedMmPerSecond : null,
      distanceMm: typeof m.distanceMm === 'number' ? m.distanceMm : null,
      blockHeight: anchor && anchor.blockHeight != null ? String(anchor.blockHeight) : null,
      blockProgressPct: anchor ? blockProgressPct(anchor.blockProgress) : null,
    };
    if (m.freshness === 'online' && m.coreStatus === 'ACTIVE') out.state = 'running';
    else if (m.freshness === 'online') out.state = 'still';
    return out;
  }
  return { parseOffsetNs, normalizeSegment, spanSec, maxGapSec, isPlayable, tierFor,
           dailyIndex, ghostStepsAt, ghostRpmAt, createStamina, tapStamina,
           regenStamina, blockProgressPct, liveStateFromStatus };
})();

/* ================= Pixel-art hamster sprites (drawn in code) =================
   26x20 grids: 18 body rows + 2 leg rows per frame. The player hamster follows
   kokoron's reference: a chubby golden hamster in side profile, round ear with
   a pink inner ear, shiny eye, pink nose, cream muzzle and belly, tiny paw.
   Squeektoshi's ghost uses the same silhouette as a Terminator hamster: pale
   steel fur, a metal face plate with a seam, a glowing red eye in a dark
   socket, a metal ear and a metal paw. Palette keys: O outline, B body,
   L light fur, S shaded fur, I inner ear, W cream, K eye black, H highlight,
   N nose, P paw, C blush, F feet, G metal, D dark metal, R red eye. */
const SPRITE_W = 26, SPRITE_H = 20;
const SPRITE_PLAYER = [
  '................OOO.......',
  '...............OBBBO......',
  '...............OBIBO......',
  '...............OBIBBOO....',
  '.........OOOOOOBBBBBBBO...',
  '......OOOBBBBBBBBBBBBBBO..',
  '.....OBBBBBBBBBBBBBBBBBBO.',
  '....OBBBBBBBBBBBBBBBHKBBO.',
  '...OBBBBBBBBBBBBBBBBKKBBO.',
  '..OBBBBBBBBBBBBBBBBBKKBBO.',
  '..OBBBBBBBBBBBBBBBBBBBBBN.',
  '..OBBBBBBBBBBBBBBBWWWWWBO.',
  '..OBBBBBBBBBBBBBBCCWWWWOO.',
  '..OBBBBBBBBBBBBBBWWWWWWO..',
  '...OBBBBBWBBBBBBBWWWWWO...',
  '....OBWWWWWWWBBBPPWWOO....',
  '.....OWWWWWWWWSSSSSO......',
  '......OOOWWWWSSSOOO.......'
];
const SPRITE_TERM = [
  '................OOO.......',
  '...............OBBBO......',
  '...............OBGBO......',
  '...............OBGBBOO....',
  '.........OOOOOOBBBBGGGO...',
  '......OOOBBBBBBBBBBGGGGO..',
  '.....OBBBBBBBBBBBBBGGGGGO.',
  '....OBBBBBBBBBBBBBBGDDGGO.',
  '...OBBBBBBBBBBBBBBBGDRGGO.',
  '..OBBBBBBBBBBBBBBBBGDDGGO.',
  '..OBBBBBBBBBBBBBBBBGGGGGD.',
  '..OBBBBBBBBBBBBBBBBGGGGGO.',
  '..OBBBBBBBBBBBBBBBBGDGGGO.',
  '..OBBBBBBBBBBBBBBBBGGDGD..',
  '...OBBBBBWBBBBBBGGBGGGO...',
  '....OBWWWWWWWBBBDDBGOO....',
  '.....OWWWWWWWWSSSSSO......',
  '......OOOWWWWSSSOOO.......'
];
const SPRITE_LEGS = [
[
  '......OFFO........OFFO....',
  '.......OO..........OO.....'
],
[
  '..........OFFO.OFFO.......',
  '...........OO...OO........'
]
];
const PALETTES = {
  player: { O:'#33241a', B:'#f0a13e', L:'#ffc978', S:'#d97f26', I:'#ff9db0', W:'#fff3e0', K:'#221610', H:'#ffffff', N:'#ff7d95', P:'#ffb3a7', C:'#ffb59d', F:'#ff9db0', G:'#aeb9cc', D:'#5d6f96', R:'#ff2626' },
  ghost:  { O:'#232733', B:'#b9c6dd', L:'#d7e1f2', S:'#8296b8', I:'#8fa3c4', W:'#eef3ff', K:'#221610', H:'#ffffff', N:'#5d6f96', P:'#aeb9cc', C:'#8296b8', F:'#aeb9cc', G:'#aeb9cc', D:'#5d6f96', R:'#ff2626' },
};
function drawHamster(ctx, x, y, px, palette, frame, alpha, bodyRows) {
  const rows = (bodyRows || SPRITE_PLAYER).concat(SPRITE_LEGS[frame % 2]);
  ctx.save();
  if (alpha != null) ctx.globalAlpha = alpha;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    for (let c = 0; c < row.length; c++) {
      const col = palette[row[c]];
      if (!col) continue;
      ctx.fillStyle = col;
      ctx.fillRect(x + c * px, y + r * px, px, px);
    }
  }
  ctx.restore();
}
/* Pixel wheel (for the home-screen ghost avatar): blocky ring + spokes + hamster. */
function drawWheelScene(ctx, w, h) {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#ffe9bd'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#8fce6e'; ctx.fillRect(0, h - 4, w, 4);
  const cx = w / 2, cy = h / 2 - 2, R = Math.min(w, h) / 2 - 3;
  ctx.strokeStyle = '#33241a'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
  ctx.lineWidth = 2;
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 4 + 0.4;
    ctx.beginPath(); ctx.moveTo(cx - Math.cos(a) * R, cy - Math.sin(a) * R);
    ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); ctx.stroke();
  }
  drawHamster(ctx, cx - 26, cy - 17, 2, PALETTES.ghost, 0, 1, SPRITE_TERM);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Logic, SPRITE_PLAYER, SPRITE_TERM, SPRITE_LEGS, PALETTES, drawHamster };
}

/* ================= Browser app ================= */
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
(function () {
  const API = 'https://api.squeekchain.com/v1';
  const LS_SAVE = 'squeekSprint.v1';
  const LS_RUNS = 'squeekSprint.runsCache.v1';
  const $ = id => document.getElementById(id);
  const els = {
    pill: $('statusPill'), dot: $('statusDot'), statusText: $('statusText'),
    home: $('viewHome'), race: $('viewRace'), result: $('viewResult'),
    ghostWhen: $('ghostWhen'), ghostSteps: $('ghostSteps'), ghostTime: $('ghostTime'),
    ghostTier: $('ghostTier'), ghostBest: $('ghostBest'), sourceBadge: $('ghostSourceBadge'),
    runsNote: $('runsNote'), btnPlay: $('btnPlay'), btnNextHome: $('btnNextGhostHome'),
    liveText: $('liveText'), btnLive: $('btnLive'), liveBadge: $('liveBadge'),
    statWins: $('statWins'), statRaces: $('statRaces'), medalList: $('medalList'), themeList: $('themeList'),
    track: $('track'), countdown: $('countdown'),
    hudTime: $('hudTime'), hudYou: $('hudYou'), hudTarget: $('hudTarget'), hudGhost: $('hudGhost'), hudRpm: $('hudRpm'),
    ghostRunner: $('ghostRunner'), playerRunner: $('playerRunner'),
    staminaFill: $('staminaFill'), rhythmHint: $('rhythmHint'), btnTap: $('btnTap'), btnQuit: $('btnQuit'),
    raceSource: $('raceSource'),
    resultBanner: $('resultBanner'), resultMargin: $('resultMargin'),
    resSource: $('resSource'), resSegment: $('resSegment'), resRace: $('resRace'),
    resChain: $('resChain'), resMedal: $('resMedal'),
    btnAgain: $('btnAgain'), btnNext: $('btnNextGhost'), btnShare: $('btnShare'), btnHome: $('btnHome'),
    ghostAvatar: $('ghostAvatar'), shareCanvas: $('shareCanvas'),
  };
  // Runner sprites
  function makeRunnerSprite(el, palette, bodyRows) {
    const c = document.createElement('canvas');
    c.width = SPRITE_W; c.height = SPRITE_H; c.className = 'pixel-sprite';
    el.appendChild(c);
    return { canvas: c, ctx: c.getContext('2d'), palette, bodyRows, frame: -1 };
  }
  const ghostSprite = makeRunnerSprite(els.ghostRunner, PALETTES.ghost, SPRITE_TERM);
  const playerSprite = makeRunnerSprite(els.playerRunner, PALETTES.player, SPRITE_PLAYER);
  function paintSprite(spr, frame) {
    if (spr.frame === frame) return;
    spr.frame = frame;
    spr.ctx.clearRect(0, 0, SPRITE_W, SPRITE_H);
    drawHamster(spr.ctx, 0, 0, 1, spr.palette, frame, 1, spr.bodyRows);
  }
  paintSprite(ghostSprite, 0); paintSprite(playerSprite, 0);
  // Brand + avatar pixel art
  const brandCtx = $('brandCanvas').getContext('2d');
  drawHamster(brandCtx, 0, 0, 1, PALETTES.player, 0, 1);
  const avatarCanvas = document.createElement('canvas');
  avatarCanvas.width = 76; avatarCanvas.height = 62; avatarCanvas.className = 'pixel-sprite';
  els.ghostAvatar.appendChild(avatarCanvas);
  drawWheelScene(avatarCanvas.getContext('2d'), 76, 62);

  /* ---------- saved progress ---------- */
  const THEMES = [
    { id: 'meadow', name: 'Meadow', wins: 0 },
    { id: 'sunset', name: 'Sunset', wins: 1 },
    { id: 'night', name: 'Night Wheel', wins: 3 },
    { id: 'candy', name: 'Candy Burrow', wins: 5 },
  ];
  let save = { bests: {}, wins: 0, races: 0, medals: {}, theme: 'meadow' };
  try { const raw = localStorage.getItem(LS_SAVE); if (raw) save = Object.assign(save, JSON.parse(raw)); } catch (e) {}
  function persist() { try { localStorage.setItem(LS_SAVE, JSON.stringify(save)); } catch (e) {} }

  /* ---------- app state ---------- */
  let segments = [];        // playable segments (real if available, else samples)
  let usingSamples = false;
  let currentIdx = 0;
  let lastStatus = null;    // simplified live state (last good)
  let lastStatusRaw = null;

  function fmtDate(iso) {
    if (!iso) return 'a past run';
    const d = new Date(iso);
    if (isNaN(d)) return 'a past run';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ', ' +
           d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  function fmtSec(s) { return (Math.round(s * 10) / 10).toFixed(1) + 's'; }

  /* ---------- API with retry/backoff (429/503 honour Retry-After) ---------- */
  async function fetchJson(url, tries) {
    tries = tries || 3;
    let delay = 1000;
    for (let i = 0; i < tries; i++) {
      let res;
      try { res = await fetch(url, { method: 'GET' }); }
      catch (e) { if (i === tries - 1) throw e; await new Promise(r => setTimeout(r, delay)); delay *= 2; continue; }
      if (res.status === 429 || res.status === 503) {
        if (i === tries - 1) throw new Error('HTTP ' + res.status);
        const ra = Number(res.headers.get('Retry-After'));
        await new Promise(r => setTimeout(r, Number.isFinite(ra) && ra > 0 ? ra * 1000 : delay));
        delay *= 2; continue;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      if (res.status === 204) return null;
      return res.json();
    }
    throw new Error('unreachable');
  }

  async function loadStatus() {
    try {
      const json = await fetchJson(API + '/status', 2);
      if (json && json.schemaVersion != null && json.schemaVersion !== 1 && json.schemaVersion !== '1') {
        console.warn('Squeek Sprint: unexpected /status schemaVersion', json.schemaVersion);
        return lastStatus;
      }
      const st = Logic.liveStateFromStatus(json);
      if (st.state !== 'unknown' || !lastStatus) { lastStatus = st; lastStatusRaw = json; }
      return lastStatus;
    } catch (e) {
      console.warn('Squeek Sprint: /status failed, keeping last good', e);
      return lastStatus; // keep last good instead of blanking
    }
  }

  function cacheSegments(list) {
    try {
      const slim = list.slice(0, 60).map(s => ({
        segmentId: s.segmentId, startAt: s.startAt, provenance: s.provenance,
        passages: s.offsetsSec.map(o => ({ offsetNs: String(Math.round(o * 1e9)) })),
      }));
      localStorage.setItem(LS_RUNS, JSON.stringify(slim));
    } catch (e) {}
  }
  function cachedSegments() {
    try {
      const raw = localStorage.getItem(LS_RUNS);
      if (!raw) return [];
      return JSON.parse(raw).map(Logic.normalizeSegment).filter(Logic.isPlayable);
    } catch (e) { return []; }
  }
  function sampleSegments() {
    const raw = (window.SQUEEK_SAMPLE_SEGMENTS || []);
    return raw.map(Logic.normalizeSegment).filter(Logic.isPlayable);
  }

  async function loadSegments() {
    try {
      const json = await fetchJson(API + '/measurement/runs?limit=100', 3);
      if (json && json.schemaVersion != null && json.schemaVersion !== 'measurement-runs.v1') {
        console.warn('Squeek Sprint: unexpected runs schemaVersion', json.schemaVersion);
        throw new Error('schema');
      }
      const items = (json && json.items) || [];
      let list = items.map(Logic.normalizeSegment).filter(Logic.isPlayable);
      // deterministic order so the daily pick is stable for everyone
      list.sort((a, b) => a.segmentId < b.segmentId ? -1 : 1);
      if (list.length) { cacheSegments(list); return { list, source: 'api' }; }
      throw new Error('no playable segments');
    } catch (e) {
      console.warn('Squeek Sprint: runs fetch failed, falling back', e);
      const cached = cachedSegments();
      if (cached.length) return { list: cached, source: 'cache' };
      return { list: sampleSegments(), source: 'sample' };
    }
  }

  /* ---------- home rendering ---------- */
  function currentSegment() { return segments.length ? segments[currentIdx % segments.length] : null; }

  function renderStatusPill() {
    const st = lastStatus;
    els.dot.className = 'dot ' + (!st || st.state === 'unknown' ? 'dot-unknown' : st.state === 'running' ? 'dot-run' : 'dot-still');
    if (!st || st.state === 'unknown') els.statusText.textContent = 'Wheel status unknown';
    else if (st.state === 'running') els.statusText.textContent = 'Squeektoshi is running!';
    else els.statusText.textContent = 'Wheel is still, he may be napping';
    // Live Duel availability
    if (st && st.state === 'running') {
      els.liveText.textContent = 'He is on the wheel RIGHT NOW. Race him live for 30 seconds, his distance comes straight from the wheel (distanceMm on /v1/status). First to 40 m, or furthest when the clock runs out.';
      els.btnLive.disabled = false;
      els.liveBadge.textContent = 'LIVE now · 30 seconds';
    } else if (st && st.state === 'still') {
      els.liveText.textContent = 'He is not running right now (the wheel is still), so Live Duel is off. No faking it, race one of his recorded ghosts in Sprint Replay instead, they are just as real.';
      els.btnLive.disabled = true;
      els.liveBadge.textContent = 'Not live right now';
    } else {
      els.liveText.textContent = 'Live status is unknown at the moment, so Live Duel is off. Sprint Replay below always works.';
      els.btnLive.disabled = true;
      els.liveBadge.textContent = 'Status unknown';
    }
  }

  function renderChallenge() {
    const seg = currentSegment();
    if (!seg) {
      els.ghostWhen.textContent = 'No ghost available';
      els.btnPlay.disabled = true;
      return;
    }
    els.btnPlay.disabled = false;
    const tier = Logic.tierFor(seg);
    if (seg.synthetic) {
      els.sourceBadge.textContent = 'SAMPLE / PRACTICE GHOST · synthetic data';
      els.sourceBadge.className = 'badge badge-sample';
      els.ghostWhen.textContent = (seg.label || 'Practice ghost') + ' (sample)';
      els.runsNote.textContent = 'The live API did not give us a playable run, so this is a bundled practice ghost. It is synthetic, not a real recording, and is labelled as such. Real ghosts return automatically when the API does.';
    } else {
      els.sourceBadge.textContent = 'Real ghost · Squeekchain API';
      els.sourceBadge.className = 'badge badge-real';
      els.ghostWhen.textContent = 'His run on ' + fmtDate(seg.startAt);
      els.runsNote.textContent = 'Ghost replayed from segment ' + seg.segmentId.slice(0, 8) + '… of GET /v1/measurement/runs (device-signed wheel evidence). Use “Next ghost” to browse his other recorded runs.';
    }
    els.ghostSteps.textContent = seg.steps + ' steps';
    els.ghostTime.textContent = fmtSec(Logic.spanSec(seg)) + ' · best gap ' + fmtSec(Logic.maxGapSec(seg));
    els.ghostTier.textContent = tier.name;
    const best = save.bests[seg.segmentId];
    els.ghostBest.textContent = !best ? 'No race yet, set the bar!'
      : best.won ? 'You beat him by ' + fmtSec(best.marginSec) + '!'
      : 'Closest: ' + best.stepsShort + ' steps short';
    renderShelf();
  }

  function renderShelf() {
    els.statWins.textContent = save.wins;
    els.statRaces.textContent = save.races;
    const medals = Object.keys(save.medals).filter(k => save.medals[k] > 0);
    els.medalList.innerHTML = medals.length
      ? medals.map(k => {
          const name = { cruiser: 'Cozy Cruiser', jogger: 'Steady Jogger', zoomie: 'Zoomie', turbo: 'Turbo Squeek' }[k] || k;
          return '<span class="medal">' + name + ' × ' + save.medals[k] + '</span>';
        }).join('')
      : '<span class="muted">No medals yet, beat a ghost!</span>';
    els.themeList.innerHTML = '';
    THEMES.forEach(t => {
      const unlocked = save.wins >= t.wins;
      const b = document.createElement('button');
      b.className = 'theme-btn' + (save.theme === t.id ? ' active' : '') + (unlocked ? '' : ' locked');
      b.textContent = t.name + (unlocked ? '' : ' · ' + t.wins + ' wins');
      b.disabled = !unlocked;
      b.addEventListener('click', () => { save.theme = t.id; persist(); renderShelf(); });
      els.themeList.appendChild(b);
    });
    els.track.className = 'track theme-' + (save.theme || 'meadow');
  }

  /* ---------- race engine ---------- */
  let race = null; // active race state
  function show(view) {
    els.home.classList.toggle('hidden', view !== 'home');
    els.race.classList.toggle('hidden', view !== 'race');
    els.result.classList.toggle('hidden', view !== 'result');
    window.scrollTo(0, 0);
  }
  function setRunnerPos(el, frac) {
    el.style.left = (2 + Math.max(0, Math.min(1, frac)) * 84) + '%';
  }

  function startCountdown(done) {
    els.countdown.classList.remove('hidden');
    const seq = ['3', '2', '1', 'GO!'];
    let i = 0;
    els.countdown.textContent = seq[0];
    const iv = setInterval(() => {
      i++;
      if (i >= seq.length) {
        clearInterval(iv);
        els.countdown.classList.add('hidden');
        done();
      } else els.countdown.textContent = seq[i];
    }, 620);
    race.countdownIv = iv;
  }

  function beginRace(kind, seg) {
    cancelRace();
    race = {
      kind, seg: kind === 'replay' ? seg : null,
      phase: 'countdown',
      elapsed: 0, lastTs: 0, raf: 0,
      playerSteps: 0, ghostSteps: 0,
      stamina: Logic.createStamina(),
      tapTimes: [],
      live: null, pollIv: 0,
      frameFlipAt: 0, playerFrame: 0, ghostFrame: 0,
      lastPlayerStepsShown: 0, lastGhostStepsShown: 0,
      stepFlashUntil: 0,
    };
    show('race');
    els.staminaFill.style.width = '100%';
    els.staminaFill.className = 'stamina-fill';
    els.rhythmHint.textContent = 'Find a steady rhythm…';
    if (kind === 'replay') {
      els.hudTarget.textContent = seg.steps;
      els.raceSource.textContent = seg.synthetic
        ? 'SAMPLE / PRACTICE GHOST · synthetic segment ' + seg.segmentId + ' (not a real recording).'
        : 'Ghost: his real run, ' + fmtDate(seg.startAt) + ' · segment ' + seg.segmentId.slice(0, 8) + '… · ' + seg.steps + ' steps in ' + fmtSec(Logic.spanSec(seg));
    } else {
      els.hudTarget.textContent = '40 m';
      els.raceSource.textContent = 'LIVE DUEL · ghost distance is Squeektoshi\u2019s real distanceMm from /v1/status, polled about once a second.';
    }
    els.hudYou.textContent = '0'; els.hudGhost.textContent = '0';
    els.hudTime.textContent = '0.0s'; els.hudRpm.textContent = '0';
    setRunnerPos(els.playerRunner, 0); setRunnerPos(els.ghostRunner, 0);
    paintSprite(playerSprite, 0); paintSprite(ghostSprite, 0);
    startCountdown(() => {
      if (!race) return;
      race.phase = 'running';
      race.lastTs = performance.now();
      if (kind === 'live') startLivePolling();
      race.raf = requestAnimationFrame(tick);
    });
  }

  function cancelRace() {
    if (!race) return;
    if (race.raf) cancelAnimationFrame(race.raf);
    if (race.pollIv) clearInterval(race.pollIv);
    if (race.countdownIv) clearInterval(race.countdownIv);
    race = null;
  }

  function startLivePolling() {
    const lv = { startDistanceMm: lastStatus && lastStatus.distanceMm != null ? lastStatus.distanceMm : null, ghostMeters: 0, rpm: 0 };
    race.live = lv;
    const poll = async () => {
      const st = await loadStatus();
      if (!race || race.kind !== 'live' || race.phase !== 'running') return;
      if (st && st.distanceMm != null) {
        if (lv.startDistanceMm == null) lv.startDistanceMm = st.distanceMm;
        lv.ghostMeters = Math.max(0, (st.distanceMm - lv.startDistanceMm) / 1000);
      }
      if (st && st.rpm != null) lv.rpm = st.rpm;
      renderStatusPill();
    };
    race.pollIv = setInterval(poll, 1200); // /status is cached ~1s; never poll faster
    poll();
  }

  function onTap() {
    if (!race || race.phase !== 'running') return;
    const now = performance.now();
    const step = Logic.tapStamina(race.stamina, now);
    race.tapTimes.push(now);
    if (race.tapTimes.length > 12) race.tapTimes.shift();
    if (race.kind === 'live') race.playerSteps += step * 1.25; // metres
    else race.playerSteps += step;
    race.stepFlashUntil = now + 130;
  }

  function tick(ts) {
    if (!race || race.phase !== 'running') return;
    const dt = Math.min(0.1, (ts - race.lastTs) / 1000);
    race.lastTs = ts;
    race.elapsed += dt;
    Logic.regenStamina(race.stamina, dt, ts);
    const R = race;

    if (R.kind === 'replay') {
      const offs = R.seg.offsetsSec;
      R.ghostSteps = Logic.ghostStepsAt(offs, R.elapsed);
      els.hudTime.textContent = fmtSec(R.elapsed);
      els.hudYou.textContent = Math.floor(R.playerSteps);
      els.hudGhost.textContent = R.ghostSteps;
      els.hudRpm.textContent = Logic.ghostRpmAt(offs, R.elapsed);
      setRunnerPos(els.playerRunner, R.playerSteps / R.seg.steps);
      setRunnerPos(els.ghostRunner, R.ghostSteps / R.seg.steps);
      animateSprites(ts);
      renderStamina(ts);
      if (R.playerSteps >= R.seg.steps) return finishRace(true);
      if (R.elapsed >= Logic.spanSec(R.seg)) return finishRace(false);
    } else {
      const ghostM = R.live ? R.live.ghostMeters : 0;
      els.hudTime.textContent = fmtSec(Math.min(30, R.elapsed)) + ' / 30.0s';
      els.hudYou.textContent = R.playerSteps.toFixed(1) + ' m';
      els.hudGhost.textContent = ghostM.toFixed(1) + ' m';
      els.hudRpm.textContent = R.live ? Math.round(R.live.rpm) : 0;
      setRunnerPos(els.playerRunner, R.playerSteps / 40);
      setRunnerPos(els.ghostRunner, ghostM / 40);
      animateSprites(ts);
      renderStamina(ts);
      if (R.playerSteps >= 40) return finishRace(true);
      if (ghostM >= 40) return finishRace(false);
      if (R.elapsed >= 30) return finishRace(R.playerSteps > ghostM ? true : R.playerSteps < ghostM ? false : 'tie');
    }
    R.raf = requestAnimationFrame(tick);
  }

  function animateSprites(ts) {
    if (ts - race.frameFlipAt > 160) {
      race.frameFlipAt = ts;
      if (Math.floor(race.playerSteps) !== race.lastPlayerStepsShown || ts < race.stepFlashUntil) {
        race.playerFrame = 1 - race.playerFrame; race.lastPlayerStepsShown = Math.floor(race.playerSteps);
      }
      if (race.kind === 'replay' && race.ghostSteps !== race.lastGhostStepsShown) {
        race.ghostFrame = 1 - race.ghostFrame; race.lastGhostStepsShown = race.ghostSteps;
      }
      paintSprite(playerSprite, race.playerFrame);
      paintSprite(ghostSprite, race.ghostFrame);
    }
  }

  function renderStamina(ts) {
    const v = race.stamina.value;
    els.staminaFill.style.width = v + '%';
    els.staminaFill.className = 'stamina-fill' + (v < 30 ? ' low' : '');
    const taps = race.tapTimes;
    if (ts < race.stamina.windedUntilMs) els.rhythmHint.textContent = 'Winded! Ease off a beat…';
    else if (taps.length >= 3) {
      const iv = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
      els.rhythmHint.textContent = iv < 200 ? 'Too fast, mashing wastes steps!' :
        iv <= 950 ? 'Perfect rhythm, keep it steady!' : 'Steady… you can push a little harder.';
    }
  }

  function chainContextText() {
    const st = lastStatus;
    if (!st || st.blockHeight == null) return 'Squeek block height unknown right now (API status unavailable).';
    let s = 'Settled at Squeek block #' + st.blockHeight;
    if (st.blockProgressPct != null) s += ' · ' + st.blockProgressPct.toFixed(1) + '% of the way to the next block';
    return s + ' (via /v1/status).';
  }

  let lastResult = null;
  function finishRace(won) {
    const R = race;
    R.phase = 'done';
    if (R.raf) cancelAnimationFrame(R.raf);
    if (R.pollIv) clearInterval(R.pollIv);
    save.races++;
    let marginText, result;
    if (R.kind === 'replay') {
      const span = Logic.spanSec(R.seg);
      const tier = Logic.tierFor(R.seg);
      let medal = null, unlocked = null;
      if (won === true) {
        const marginSec = +(span - R.elapsed).toFixed(2);
        marginText = 'You finished in ' + fmtSec(R.elapsed) + ', beating his real ' + fmtSec(span) + ' by ' + fmtSec(marginSec) + ', with the ghost ' + (R.seg.steps - R.ghostSteps) + ' steps behind.';
        save.wins++;
        save.medals[tier.id] = (save.medals[tier.id] || 0) + 1;
        medal = tier.name + ' medal earned!';
        const prevBest = save.bests[R.seg.segmentId];
        if (!prevBest || !prevBest.won || marginSec > prevBest.marginSec) {
          save.bests[R.seg.segmentId] = { won: true, marginSec, at: Date.now() };
        }
        const newTheme = THEMES.find(t => t.wins === save.wins);
        if (newTheme) unlocked = newTheme.name;
        result = { won: true, title: 'YOU WIN!', marginText, medal: medal + (unlocked ? ' New track unlocked: ' + unlocked + '!' : ''),
                   source: R.seg.synthetic ? 'Sample / practice ghost (synthetic data, not a real recording)' : 'Real ghost: his run on ' + fmtDate(R.seg.startAt),
                   segmentId: R.seg.segmentId, raceLine: 'You ' + Math.floor(R.playerSteps) + ' steps · Ghost ' + R.ghostSteps + ' steps · His time ' + fmtSec(span) };
      } else {
        const short = R.seg.steps - Math.floor(R.playerSteps);
        marginText = 'The ghost finished his real run in ' + fmtSec(span) + ', you were ' + short + ' steps short. His pauses are your chances: save stamina for his bursts.';
        const prevBest = save.bests[R.seg.segmentId];
        if (!prevBest || (!prevBest.won && (prevBest.stepsShort == null || short < prevBest.stepsShort))) {
          save.bests[R.seg.segmentId] = { won: false, stepsShort: short, at: Date.now() };
        }
        result = { won: false, title: 'GHOST WINS', marginText, medal: 'No medal this time, the ' + tier.name + ' medal is still out there.',
                   source: R.seg.synthetic ? 'Sample / practice ghost (synthetic data, not a real recording)' : 'Real ghost: his run on ' + fmtDate(R.seg.startAt),
                   segmentId: R.seg.segmentId, raceLine: 'You ' + Math.floor(R.playerSteps) + ' steps · Ghost ' + R.ghostSteps + ' steps · His time ' + fmtSec(span) };
      }
    } else {
      const ghostM = R.live ? R.live.ghostMeters : 0;
      const title = won === true ? 'YOU WIN · LIVE!' : won === 'tie' ? 'DEAD HEAT!' : 'HE OUTRAN YOU · LIVE';
      marginText = won === true ? 'You covered ' + R.playerSteps.toFixed(1) + ' m while he really ran ' + ghostM.toFixed(1) + ' m on the wheel.'
        : won === 'tie' ? 'Identical distance: ' + R.playerSteps.toFixed(1) + ' m each. The wheel provides, the wheel decides nothing.'
        : 'He really ran ' + ghostM.toFixed(1) + ' m on the wheel while you covered ' + R.playerSteps.toFixed(1) + ' m.';
      if (won === true) {
        save.wins++;
        const newTheme = THEMES.find(t => t.wins === save.wins);
        result = { won: true, title, marginText, medal: 'Live Duel win!' + (newTheme ? ' New track unlocked: ' + newTheme.name + '!' : ''),
                   source: 'Live wheel: distanceMm from /v1/status during this race', segmentId: 'live-duel',
                   raceLine: 'You ' + R.playerSteps.toFixed(1) + ' m · Squeektoshi ' + ghostM.toFixed(1) + ' m · 30s duel' };
      } else {
        result = { won: won === 'tie', title, marginText, medal: won === 'tie' ? 'A tie against the live hamster is its own trophy.' : 'No medal, he was really moving.',
                   source: 'Live wheel: distanceMm from /v1/status during this race', segmentId: 'live-duel',
                   raceLine: 'You ' + R.playerSteps.toFixed(1) + ' m · Squeektoshi ' + ghostM.toFixed(1) + ' m · 30s duel' };
      }
    }
    persist();
    lastResult = result;
    els.resultBanner.textContent = result.title;
    els.resultBanner.className = 'result-banner ' + (result.title.includes('WIN') ? 'win' : result.title.includes('HEAT') ? 'tie' : 'lose');
    els.resultMargin.textContent = result.marginText;
    els.resSource.textContent = result.source;
    els.resSegment.textContent = result.segmentId;
    els.resRace.textContent = result.raceLine;
    els.resChain.textContent = chainContextText();
    els.resMedal.textContent = result.medal;
    race = null;
    renderChallenge();
    show('result');
    loadStatus().then(renderStatusPill);
  }

  /* ---------- share card (canvas, pixel style) ---------- */
  function shareCard() {
    if (!lastResult) return;
    const cv = els.shareCanvas, ctx = cv.getContext('2d');
    // Text lives in a left column (x 48 to 728). Sprites live in a right zone
    // (x 740 to 1160, y 362 to 482). The two zones never overlap.
    function wrapText(text, x, startY, maxWidth, lineHeight) {
      const words = String(text).split(' ');
      let line = '', y = startY;
      for (const w of words) {
        if (ctx.measureText(line + w).width > maxWidth && line) { ctx.fillText(line, x, y); y += lineHeight; line = ''; }
        line += w + ' ';
      }
      if (line.trim()) { ctx.fillText(line, x, y); y += lineHeight; }
      return y;
    }
    ctx.fillStyle = '#fdf3d8'; ctx.fillRect(0, 0, 1200, 630);
    ctx.fillStyle = '#8fce6e'; ctx.fillRect(0, 500, 1200, 130);
    ctx.fillStyle = '#e8622c'; ctx.fillRect(0, 0, 1200, 110);
    ctx.fillStyle = '#ffffff'; ctx.font = '700 54px "Courier New", monospace';
    ctx.fillText('SQUEEK SPRINT', 48, 74);
    ctx.fillStyle = '#33241a'; ctx.font = '700 84px "Courier New", monospace';
    ctx.fillText(lastResult.title, 48, 226);
    ctx.font = '28px Verdana, sans-serif';
    let y = wrapText(lastResult.marginText, 48, 274, 680, 38);
    ctx.font = '22px "Courier New", monospace'; ctx.fillStyle = '#7a5c40';
    y += 10;
    y = wrapText(lastResult.raceLine, 48, y, 680, 30);
    y = wrapText(lastResult.source, 48, y, 680, 30);
    if (lastStatus && lastStatus.blockHeight != null) {
      y = wrapText('Settled at Squeek block #' + lastStatus.blockHeight, 48, y, 680, 30);
      if (lastStatus.blockProgressPct != null) {
        y = wrapText(lastStatus.blockProgressPct.toFixed(1) + '% of the way to the next block', 48, y, 680, 30);
      }
    } else {
      y = wrapText('Squeek block height unknown right now.', 48, y, 680, 30);
    }
    // Sprite zone: a dirt strip for them to stand on, then both hamsters.
    ctx.fillStyle = '#8a5a33'; ctx.fillRect(724, 484, 436, 10);
    drawHamster(ctx, 740, 362, 6, PALETTES.ghost, 1, 1, SPRITE_TERM);
    drawHamster(ctx, 968, 362, 6, PALETTES.player, 0, 1);
    ctx.font = '22px "Courier New", monospace'; ctx.fillStyle = '#33241a';
    ctx.fillText('Race results are local fun, not recorded onchain. Ghosts: real Squeekchain wheel data.', 48, 586);
    cv.toBlob(blob => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'squeek-sprint-result.png';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }, 'image/png');
  }

  /* ---------- wiring ---------- */
  els.btnPlay.addEventListener('click', () => { const s = currentSegment(); if (s) beginRace('replay', s); });
  els.btnAgain.addEventListener('click', () => {
    if (lastResult && lastResult.segmentId === 'live-duel') { renderStatusPill(); show('home'); return; }
    const s = currentSegment(); if (s) beginRace('replay', s);
  });
  function nextGhost() {
    if (!segments.length) return;
    currentIdx = (currentIdx + 1) % segments.length;
    renderChallenge();
    show('home');
  }
  els.btnNext.addEventListener('click', nextGhost);
  els.btnNextHome.addEventListener('click', nextGhost);
  els.btnHome.addEventListener('click', () => show('home'));
  els.btnShare.addEventListener('click', shareCard);
  els.btnLive.addEventListener('click', () => { if (lastStatus && lastStatus.state === 'running') beginRace('live', null); });
  els.btnQuit.addEventListener('click', () => { cancelRace(); show('home'); });
  els.btnTap.addEventListener('pointerdown', e => { e.preventDefault(); onTap(); });
  els.track.addEventListener('pointerdown', e => { if (e.target.closest('button')) return; onTap(); });
  window.addEventListener('keydown', e => {
    if (e.code === 'Space' && race && race.phase === 'running') { e.preventDefault(); if (!e.repeat) onTap(); }
  });

  /* ---------- init ---------- */
  (async function init() {
    renderShelf();
    const [segRes] = await Promise.all([loadSegments(), loadStatus().then(renderStatusPill)]);
    segments = segRes.list;
    usingSamples = segRes.source === 'sample';
    if (!segments.length) { segments = sampleSegments(); usingSamples = true; }
    const today = new Date().toISOString().slice(0, 10);
    const sorted = segments.slice();
    currentIdx = usingSamples ? Logic.dailyIndex(today, sorted.length)
      : Logic.dailyIndex(today, sorted.length);
    renderChallenge();
    // gentle status refresh while on the home screen (API status cache is ~1s;
    // 15s is plenty and keeps us far under rate limits)
    setInterval(async () => {
      if (!els.home.classList.contains('hidden') && !race) { await loadStatus(); renderStatusPill(); }
    }, 15000);
  })();
})();
}
