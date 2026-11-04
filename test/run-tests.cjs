/* Node tests for Squeek Sprint pure logic + a full simulated race.
   Run: node test/run-tests.cjs */
'use strict';
global.window = {};
require('../samples.js');
const { Logic } = require('../app.js');

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name); } }
function eq(a, b, name) { ok(a === b, name + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }

console.log('— segments & samples —');
const samples = global.window.SQUEEK_SAMPLE_SEGMENTS.map(Logic.normalizeSegment);
eq(samples.length, 3, 'three bundled sample segments');
samples.forEach(s => {
  ok(s.synthetic === true, s.segmentId + ' is flagged synthetic');
  ok(Logic.isPlayable(s), s.segmentId + ' is playable (span ' + Logic.spanSec(s).toFixed(1) + 's, ' + s.steps + ' steps)');
  eq(Logic.ghostStepsAt(s.offsetsSec, -1), 0, s.segmentId + ': ghost at 0 before start');
  eq(Logic.ghostStepsAt(s.offsetsSec, Logic.spanSec(s)), s.steps, s.segmentId + ': ghost completes all steps at span');
  eq(Logic.ghostStepsAt(s.offsetsSec, 1e9), s.steps, s.segmentId + ': ghost stays complete after span');
  const mid = Logic.ghostStepsAt(s.offsetsSec, Logic.spanSec(s) / 2);
  ok(mid > 0 && mid < s.steps, s.segmentId + ': ghost mid-race is between (got ' + mid + ')');
  const rpm = Logic.ghostRpmAt(s.offsetsSec, Logic.spanSec(s) / 2);
  ok(rpm > 0 && rpm <= 200, s.segmentId + ': ghost RPM sane mid-race (got ' + rpm + ')');
  ok(Logic.tierFor(s).name.length > 0, s.segmentId + ': has a difficulty tier (' + Logic.tierFor(s).name + ')');
});

console.log('— deterministic daily pick —');
eq(Logic.dailyIndex('2026-11-04', 82), Logic.dailyIndex('2026-11-04', 82), 'same date -> same index');
ok(Logic.dailyIndex('2026-11-04', 82) >= 0 && Logic.dailyIndex('2026-11-04', 82) < 82, 'index in range');
ok(Logic.dailyIndex('2026-11-05', 82) !== undefined, 'other date computes');

console.log('— status parsing (unavailable = unknown, never 0) —');
eq(Logic.liveStateFromStatus(null).state, 'unknown', 'null status -> unknown');
eq(Logic.liveStateFromStatus({ status: 'unavailable' }).state, 'unknown', 'unavailable -> unknown');
eq(Logic.liveStateFromStatus({ measurement: { coreStatus: 'ACTIVE', freshness: 'online', rpmMilli: 77005, distanceMm: 100 } }).state, 'running', 'ACTIVE+online -> running');
eq(Logic.liveStateFromStatus({ measurement: { coreStatus: 'IDLE', freshness: 'online', rpmMilli: 0, distanceMm: 100 } }).state, 'still', 'IDLE+online -> still');
eq(Logic.liveStateFromStatus({ measurement: { coreStatus: 'ACTIVE', freshness: 'stale' } }).state, 'unknown', 'ACTIVE but stale -> unknown');
eq(Logic.liveStateFromStatus({ measurement: { coreStatus: 'ACTIVE', freshness: 'online', rpmMilli: 77005 } }).rpm, 77.005, 'rpmMilli converted');
eq(Logic.blockProgressPct('296609556'), 29.66, 'blockProgress % via BigInt math');
eq(Logic.blockProgressPct('nonsense'), null, 'bad blockProgress -> null');

console.log('— stamina: rhythm beats mashing —');
function simulateSteps(tapIntervalMs, durationMs) {
  const st = Logic.createStamina();
  let steps = 0, t = 0, nextTap = 0;
  const dtMs = 16;
  while (t < durationMs) {
    Logic.regenStamina(st, dtMs / 1000, t);
    if (t >= nextTap) { steps += Logic.tapStamina(st, t); nextTap = t + tapIntervalMs; }
    t += dtMs;
  }
  return steps;
}
const steady = simulateSteps(650, 20000);
const mash = simulateSteps(50, 20000);
ok(steady > mash, 'steady rhythm (' + steady.toFixed(1) + ' steps) beats mashing (' + mash.toFixed(1) + ' steps) in 20s');
ok(steady > 25, 'steady rhythm is fast enough to be fun (got ' + steady.toFixed(1) + ')');

console.log('— FULL simulated race vs a sample segment (the reviewer flow) —');
function simulateRace(seg, tapIntervalMs) {
  const st = Logic.createStamina();
  const target = seg.steps, span = Logic.spanSec(seg);
  let player = 0, elapsed = 0, nextTap = 250; // first tap shortly after GO
  const dt = 1 / 60;
  while (elapsed <= span + 0.001) {
    Logic.regenStamina(st, dt, elapsed * 1000);
    if (elapsed * 1000 >= nextTap) { player += Logic.tapStamina(st, elapsed * 1000); nextTap += tapIntervalMs; }
    if (player >= target) return { won: true, finishTime: elapsed, ghostSteps: Logic.ghostStepsAt(seg.offsetsSec, elapsed) };
    elapsed += dt;
  }
  return { won: false, finishTime: span, ghostSteps: target, playerSteps: player };
}
const pup = samples[0];
const raceWin = simulateRace(pup, 650);
ok(raceWin.won === true && raceWin.finishTime < Logic.spanSec(pup),
   'steady player WINS vs ' + pup.segmentId + ' at ' + raceWin.finishTime.toFixed(1) + 's of ' + Logic.spanSec(pup).toFixed(1) + 's');
const raceMash = simulateRace(samples[1], 50);
console.log('       (info) mashing vs Zoomer sample: won=' + raceMash.won + ', player steps=' + (raceMash.playerSteps || pup.steps).toFixed(1) + '/' + samples[1].steps);
ok(raceMash.won === false, 'mindless mashing LOSES vs the fast sample ghost');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
