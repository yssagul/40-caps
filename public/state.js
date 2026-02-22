// ============================================================================
// 40 CAPS — Game State & Logic
// ============================================================================

import { CONFIG, IMPAIRMENTS, BUFFS } from './config.js';
import * as physics from './physics.js';
import * as net from './net.js';

// ============================================================================
// STATE
// ============================================================================

export const State = {
  phase: "SETUP",
  players: [],
  tosserIndex: 0,
  flickerIndex: 0,
  chips: [], // [{body, collider, topUp, flicked, eligible}]
  selectedChipIndex: -1,
  centerAngle: 0,
  currentAngle: 0,
  flickAngle: 0,
  currentPower: 0,
  flickPower: 0,
  oscillator: 0,
  oscillatorDir: 1,
  passedThroughGate: false,
  touchedGateChip: false,
  hitWall: false,
  previousPositions: [], // for line-segment gate detection
  flickStartTime: 0, // prevent early settle detection
  tossAnimStart: 0,
  tossTargetPositions: [],
  message: "",
  messageTimer: 0,
  // Impairment/buff render state
  dazeBlinkOn: true,
  dazeNextToggle: 0,
  doubleVisionOffset: { x: 0, y: 0 },
  effectiveAngleRange: 20, // may be modified by buffs/impairments
  badgeRects: [], // [{x, y, w, h, name, desc, kind}] in canvas pixels, rebuilt each frame
  // Networking state
  myPlayerIndex: -1,
  isOnline: false,
  remoteChipTargets: null,
};

// ============================================================================
// IMPAIRMENT & BUFF HELPERS
// ============================================================================

export function getFlicker() {
  if (State.flickerIndex < 0 || State.flickerIndex >= State.players.length) return null;
  return State.players[State.flickerIndex];
}

export function flickerHas(id) {
  const p = getFlicker();
  if (!p) return false;
  return p.impairments.includes(id) || p.onFireBuffs.includes(id);
}

export function flickerHasImpairment(id) {
  const p = getFlicker();
  return p ? p.impairments.includes(id) : false;
}

export function flickerHasBuff(id) {
  const p = getFlicker();
  return p ? p.onFireBuffs.includes(id) : false;
}

export function flickerImpairmentCount(id) {
  const p = getFlicker();
  return p ? p.impairments.filter((i) => i === id).length : 0;
}

export function assignRandomImpairment(player) {
  const remaining = IMPAIRMENTS.filter(
    (i) => !player.impairments.includes(i.id),
  );
  if (remaining.length === 0) return null; // already has all impairments
  const imp = remaining[Math.floor(Math.random() * remaining.length)];
  player.impairments.push(imp.id);
  return imp;
}

export function assignRandomBuff(player) {
  const remaining = BUFFS.filter((b) => !player.onFireBuffs.includes(b.id));
  if (remaining.length === 0) return null; // already has all buffs
  const buff = remaining[Math.floor(Math.random() * remaining.length)];
  player.onFireBuffs.push(buff.id);
  return buff;
}

export function removeRandomImpairment(player) {
  if (player.impairments.length === 0) return null;
  const idx = Math.floor(Math.random() * player.impairments.length);
  const removed = player.impairments.splice(idx, 1)[0];
  return IMPAIRMENTS.find((i) => i.id === removed);
}

export function consumeBuffs(player) {
  player.onFireBuffs = [];
}

export function getEffectiveAngleRange() {
  let range = CONFIG.FLICK_ANGLE_RANGE;
  if (flickerHasBuff("skilled_shooter")) {
    range = 10;
  }
  return range;
}

export function getEffectiveAngleSpeed() {
  let speed = CONFIG.FLICK_ANGLE_SPEED;
  if (flickerHasBuff("focus")) {
    speed *= 0.5;
  }
  return speed;
}

export function getEffectivePowerSpeed() {
  let speed = CONFIG.FLICK_POWER_SPEED;
  if (flickerHasBuff("focus")) {
    speed *= 0.5;
  }
  return speed;
}

// Update daze blink state
export function updateDazeBlink(now) {
  if (!flickerHasImpairment("daze")) {
    State.dazeBlinkOn = true;
    return;
  }
  if (now >= State.dazeNextToggle) {
    State.dazeBlinkOn = !State.dazeBlinkOn;
    // Random duration 50-200ms for next toggle
    State.dazeNextToggle = now + 50 + Math.random() * 150;
  }
}

export function shouldDazeHide() {
  // In online mode, spectators (not the flicker) never see daze effect
  if (State.isOnline && State.myPlayerIndex !== State.flickerIndex) return false;
  return flickerHasImpairment("daze") && !State.dazeBlinkOn;
}

export function setMessage(msg) {
  State.message = msg;
  State.messageTimer = performance.now();
}

export function currentTosserName() {
  return State.players[State.tosserIndex]?.name || "Player";
}

export function currentFlickerName() {
  return State.players[State.flickerIndex]?.name || "Player";
}

// ============================================================================
// TOSS LOGIC
// ============================================================================

export function generateTossPositions() {
  const S = CONFIG.TABLE_SIZE;
  const center = S / 2;
  const minDist = CONFIG.TOSS_TRIANGLE_MIN;
  const maxDist = CONFIG.TOSS_TRIANGLE_MAX;

  // Generate 3 points in a rough triangle
  for (let attempt = 0; attempt < 100; attempt++) {
    const baseAngle = Math.random() * Math.PI * 2;
    const positions = [];
    for (let i = 0; i < 3; i++) {
      const angle =
        baseAngle + (i * Math.PI * 2) / 3 + (Math.random() - 0.5) * 0.6;
      const dist = minDist + Math.random() * (maxDist - minDist);
      const x = center + Math.cos(angle) * dist;
      const y = center + Math.sin(angle) * dist;
      positions.push({ x, y });
    }

    // Validate: all on table and minimum distance between chips
    const margin = CONFIG.CHIP_RADIUS + 5;
    let valid = true;
    for (const p of positions) {
      if (
        p.x < margin ||
        p.x > S - margin ||
        p.y < margin ||
        p.y > S - margin
      ) {
        valid = false;
        break;
      }
    }
    if (valid) {
      for (let i = 0; i < 3 && valid; i++) {
        for (let j = i + 1; j < 3; j++) {
          const d = Math.hypot(
            positions[i].x - positions[j].x,
            positions[i].y - positions[j].y,
          );
          if (d < CONFIG.CHIP_RADIUS * 3) {
            valid = false;
            break;
          }
        }
      }
    }
    if (valid) return positions;
  }

  // Fallback: equilateral triangle at center
  return [
    { x: center, y: center - 80 },
    { x: center - 70, y: center + 40 },
    { x: center + 70, y: center + 40 },
  ];
}

export function rollOrientations() {
  // Keep rolling until all 3 match
  let orientations;
  do {
    orientations = [];
    for (let i = 0; i < 3; i++) {
      orientations.push(Math.random() < CONFIG.TOSS_TOP_PROBABILITY);
    }
  } while (
    !(
      orientations[0] === orientations[1] && orientations[1] === orientations[2]
    )
  );
  return orientations;
}

export function performToss() {
  physics.removeChips(State.chips);
  State.chips = [];

  // In online mode, the tosser generates and sends; others wait for broadcast
  if (State.isOnline) {
    if (net.amITosser(State.tosserIndex)) {
      const positions = generateTossPositions();
      const orientations = rollOrientations();
      const tossPositions = positions.map((p, i) => ({
        x: p.x,
        y: p.y,
        topUp: orientations[i],
      }));
      net.sendTossResult(tossPositions);
    }
    // All clients wait for toss_broadcast to actually animate
    return;
  }

  // Local play: proceed immediately
  const positions = generateTossPositions();
  const orientations = rollOrientations();

  State.tossTargetPositions = positions.map((p, i) => ({
    x: p.x,
    y: p.y,
    topUp: orientations[i],
  }));

  // Create chips at center first for animation
  const center = CONFIG.TABLE_SIZE / 2;
  for (let i = 0; i < 3; i++) {
    const chip = physics.createChipBody(center, center, orientations[i]);
    // Teleport to center for animation start
    chip.body.setTranslation({ x: center, y: center }, true);
    chip.body.setLinvel({ x: 0, y: 0 }, true);
    State.chips.push(chip);
  }

  State.tossAnimStart = performance.now();
  State.phase = "TOSS_ANIMATING";
  setMessage(`${currentTosserName()} tosses the chips!`);
}

// ============================================================================
// FLICK LOGIC
// ============================================================================

export function computeCenterAngle(selectedIdx) {
  const selected = State.chips[selectedIdx];
  const others = State.chips.filter((_, i) => i !== selectedIdx);
  const mid = {
    x: (others[0].body.translation().x + others[1].body.translation().x) / 2,
    y: (others[0].body.translation().y + others[1].body.translation().y) / 2,
  };
  const sPos = selected.body.translation();
  return Math.atan2(mid.y - sPos.y, mid.x - sPos.x);
}

export function getGateChips() {
  return State.chips.filter((_, i) => i !== State.selectedChipIndex);
}

export function startAngleSelection() {
  State.centerAngle = computeCenterAngle(State.selectedChipIndex);
  State.oscillator = 0.5; // start center
  State.oscillatorDir = 1;
  State.doubleVisionOffset = {
    x: (Math.random() - 0.5) * 60,
    y: (Math.random() - 0.5) * 60,
  };
  State.phase = "FLICK_ANGLE";
}

export function lockAngle() {
  State.flickAngle = State.currentAngle;
  State.oscillator = 0.5;
  State.oscillatorDir = 1;
  State.phase = "FLICK_POWER";
}

export function lockPowerAndFlick() {
  State.flickPower = State.currentPower;
  executeFlick();
}

export function executeFlick() {
  const chip = State.chips[State.selectedChipIndex];

  let angle = State.flickAngle;
  let power = State.flickPower;

  // Wild Shooter impairment: perturb angle ±5%, power ±10% per stack
  const wildCount = flickerImpairmentCount("wild_shooter");
  for (let i = 0; i < wildCount; i++) {
    angle += angle * (Math.random() * 0.1 - 0.05);
    power += power * (Math.random() * 0.2 - 0.1);
  }

  // Jump Shot buff: disable collision between flicked chip and gate chips
  // We set different collision groups so flicked chip ignores other chips but still hits walls
  if (flickerHasBuff("jump_shot")) {
    // Group 1, filter to only collide with group 0 (walls)
    // Membership bits = 0x0002, Filter bits = 0x0001
    chip.collider.setCollisionGroups(0x00020001);
  }

  const impulse = {
    x: Math.cos(angle) * power,
    y: Math.sin(angle) * power,
  };
  chip.body.applyImpulse(impulse, true);

  // Reset tracking flags
  State.passedThroughGate = false;
  State.touchedGateChip = false;
  State.hitWall = false;

  // Store initial position for gate detection
  const pos = chip.body.translation();
  State.previousPositions = [{ x: pos.x, y: pos.y }];

  // Create gate sensor between the other two chips
  const gate = getGateChips();
  physics.createGateSensor(gate[0], gate[1]);

  State.flickStartTime = performance.now();
  State.phase = "FLICK_ANIMATING";

  // In online mode, if I am the flicker, start streaming physics frames
  if (State.isOnline && net.isMyTurn(State.flickerIndex)) {
    net.startPhysicsStreaming(() => {
      if (State.phase !== "FLICK_ANIMATING") return null;
      return State.chips.map((c) => {
        const p = c.body.translation();
        return { x: p.x, y: p.y };
      });
    });
  }
}

// ============================================================================
// FLICK EVALUATION
// ============================================================================

export function evaluateFlick() {
  physics.removeGateSensor();

  // Jump Shot: ignore gate chip touching
  const ignoreTouch = flickerHasBuff("jump_shot");
  // Hand of God: ignore wall hits
  const ignoreWall = flickerHasBuff("hand_of_god");

  const success = !(State.touchedGateChip && !ignoreTouch) &&
                  !(State.hitWall && !ignoreWall) &&
                  State.passedThroughGate;

  // In online mode, the active flicker sends the result to the server
  if (State.isOnline && net.isMyTurn(State.flickerIndex)) {
    net.stopPhysicsStreaming();
    const finalPositions = State.chips.map((c) => {
      const p = c.body.translation();
      return { x: p.x, y: p.y, topUp: c.topUp };
    });

    let reason = "";
    if (State.touchedGateChip && !ignoreTouch) {
      reason = "Touched a gate chip!";
    } else if (State.hitWall && !ignoreWall) {
      reason = "Chip hit the wall!";
    } else if (!State.passedThroughGate) {
      reason = "Missed the gate!";
    }

    net.sendFlickResult(success, reason, State.selectedChipIndex, finalPositions);
    // Wait for flick_result_broadcast to update state
    return;
  }

  // Local play (or online spectator should not reach here)
  if (!State.isOnline) {
    if (State.touchedGateChip && !ignoreTouch) {
      onFlickFailure("Touched a gate chip!");
    } else if (State.hitWall && !ignoreWall) {
      onFlickFailure("Chip hit the wall!");
    } else if (!State.passedThroughGate) {
      onFlickFailure("Missed the gate!");
    } else {
      onFlickSuccess();
    }
  }
}

// ============================================================================
// TURN FLOW
// ============================================================================

export function onFlickSuccess() {
  const player = getFlicker();
  if (!player) return;

  // Consume On Fire buffs after this flick
  consumeBuffs(player);

  // Restore collision groups if jump_shot was active
  const chip = State.chips[State.selectedChipIndex];
  chip.collider.setCollisionGroups(0x0002ffff);

  // The flicked chip is ineligible for the next turn only;
  // all other chips become eligible again
  for (let i = 0; i < State.chips.length; i++) {
    if (i === State.selectedChipIndex) {
      State.chips[i].flicked = true;
      State.chips[i].eligible = false;
    } else {
      State.chips[i].flicked = false;
      State.chips[i].eligible = true;
    }
  }
  State.selectedChipIndex = -1;

  // Streak tracking — counter never resets on success, only on failure
  player.streak++;
  let streakMsg = "";

  // Every 3 successes: earn an On Fire buff
  if (player.streak % 3 === 0) {
    const buff = assignRandomBuff(player);
    if (buff) {
      streakMsg += ` ${player.name} is On Fire! Buff: ${buff.name}`;
    }
  }

  // Every 5 successes: cure one impairment
  if (player.streak % 5 === 0 && player.impairments.length > 0) {
    const cured = removeRandomImpairment(player);
    if (cured) {
      streakMsg += ` ${player.name} cured: ${cured.name}!`;
    }
  }

  setMessage("Success!" + streakMsg);

  // Next player flicks (chips remain where they are)
  State.flickerIndex = (State.flickerIndex + 1) % State.players.length;
  State.phase = "SELECTING_CHIP";
}

export function onFlickFailure(reason) {
  const player = getFlicker();
  if (!player) return;

  // Consume On Fire buffs after this flick
  consumeBuffs(player);

  // Restore collision groups if jump_shot was active
  const chip = State.chips[State.selectedChipIndex];
  chip.collider.setCollisionGroups(0x0002ffff);

  player.failures++;
  player.streak = 0;

  let impMsg = "";
  // Assign impairment every 5 failures
  if (player.failures % 5 === 0) {
    const imp = assignRandomImpairment(player);
    if (imp) {
      impMsg = ` Gains: ${imp.name}!`;
    }
  }

  setMessage(`${currentFlickerName()} fails! ${reason}${impMsg}`);
  State.selectedChipIndex = -1;

  // Failing player becomes tosser, next player flicks first
  State.tosserIndex = State.flickerIndex;

  // In online mode, skip the setTimeout — the server handles the 1800ms delay
  if (State.isOnline) {
    State.phase = "EVALUATING";
    return;
  }

  setTimeout(() => {
    if (State.phase !== "EVALUATING") return;
    State.flickerIndex = (State.tosserIndex + 1) % State.players.length;
    performToss();
  }, CONFIG.FAILURE_TOSS_DELAY);
  State.phase = "EVALUATING";
}
