// ============================================================================
// 40 CAPS — A chip-flicking browser game
// ============================================================================

import RAPIER from "https://esm.sh/@dimforge/rapier2d-compat";
import * as net from './net.js';

await RAPIER.init();

// ============================================================================
// CONFIG — All tunable constants
// ============================================================================

const CONFIG = {
  // Table
  TABLE_SIZE: 600, // px, square playing surface
  TABLE_COLOR: "#2d6a2d",
  TABLE_BORDER_COLOR: "#5a3a1a",
  TABLE_BORDER_WIDTH: 8,
  WALL_THICKNESS: 20, // Rapier wall collider half-thickness

  // Chips
  CHIP_RADIUS: 20, // px (and Rapier units)
  CHIP_TOP_COLOR: "#e63946",
  CHIP_BOTTOM_COLOR: "#f1faee",
  CHIP_BORDER_COLOR: "#1d3557",
  CHIP_BORDER_WIDTH: 2,

  // Physics — EDITABLE friction coefficients
  FRICTION_TABLE: 0.3, // Table surface friction (Rapier collider friction for walls)
  FRICTION_CHIP_TOP: 0.4, // Friction when chip is top-down (top surface contacts table)
  FRICTION_CHIP_BOTTOM: 0.5, // Friction when chip is top-up (bottom surface contacts table)
  DAMPING_SCALE: 12.0, // Multiplier: linear damping = chipFriction * tableFriction * this
  ANGULAR_DAMPING: 10.0, // Quick spin stop
  CHIP_RESTITUTION: 0.3, // Bounciness on chip-chip or chip-wall collision
  VELOCITY_THRESHOLD: 0.6, // Below this speed (Rapier units/s), chip is considered stopped

  // Toss
  TOSS_TOP_PROBABILITY: 0.5,
  TOSS_TRIANGLE_MIN: 40, // Min distance between chips
  TOSS_TRIANGLE_MAX: 180, // Max distance from center
  TOSS_ANIM_DURATION: 600, // ms for toss scatter animation

  // Flick interaction
  FLICK_ANGLE_RANGE: 20, // degrees ±
  FLICK_ANGLE_SPEED: 1.8, // oscillation speed (cycles per second)
  FLICK_POWER_MIN: 50, // min impulse magnitude (~32px travel)
  FLICK_POWER_MAX: 600, // max impulse magnitude (~320px travel)
  FLICK_POWER_SPEED: 1.0, // power oscillation speed (cycles per second)

  // Rendering
  CANVAS_PADDING: 80, // extra space around table for HUD
  ARROW_COLOR: "#ffb703",
  ARROW_WIDTH: 4,
  ARROW_HEAD_LEN: 14,
  ARROW_LENGTH_MIN: 35,
  ARROW_LENGTH_MAX: 120,
  GATE_LINE_COLOR: "rgba(255, 255, 255, 0.4)",

  // Players
  PLAYER_COLORS: [
    "#e63946",
    "#457b9d",
    "#2a9d8f",
    "#e9c46a",
    "#f4a261",
    "#264653",
    "#d62828",
    "#6a4c93",
  ],
};

// ============================================================================
// CANVAS SETUP
// ============================================================================

const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

const CANVAS_W = CONFIG.TABLE_SIZE + CONFIG.CANVAS_PADDING * 2;
const CANVAS_H = CONFIG.TABLE_SIZE + CONFIG.CANVAS_PADDING * 2;
canvas.width = CANVAS_W;
canvas.height = CANVAS_H;

// Table offset (top-left corner of playing surface on canvas)
const TX = CONFIG.CANVAS_PADDING;
const TY = CONFIG.CANVAS_PADDING;

// Convert table coords (0..TABLE_SIZE) to canvas coords
function toCanvas(x, y) {
  return { x: TX + x, y: TY + y };
}

// Convert canvas coords to table coords
function toTable(cx, cy) {
  return { x: cx - TX, y: cy - TY };
}

// ============================================================================
// STATE
// ============================================================================

const State = {
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
  consecutiveFlicks: 0,
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
// IMPAIRMENTS & BUFFS
// ============================================================================

const IMPAIRMENTS = [
  {
    id: "wild_shooter", //Randomly affects angle ±5% and power ±10%
    name: "Wild Shooter",
    abbr: "W",
    desc: "Your accuracy is a little off tonight.",
  },
  {
    id: "daze", //Meters blink on/off randomly
    name: "Daze",
    abbr: "D",
    desc: "It's hard to make out your aim tonight.",
  },
  {
    id: "double_vision", //Ghost copies offset from real
    name: "Double Vision",
    abbr: "V",
    desc: "You're wondering why there are too many chips on the table.",
  },
  {
    id: "blackout", //80% darkness overlay
    name: "Blackout",
    abbr: "B",
    desc: "The night is fading, but you can just make out the target.",
  },
  {
    id: "false_confidence", //
    name: "False Confidence",
    abbr: "F",
    desc: "You're feeling hot tonight, but are you?",
  },
];

const BUFFS = [
  {
    id: "skilled_shooter", //Angle range narrows to ±10°
    name: "Skilled Shooter",
    abbr: "S",
    desc: "Your aim is more precise.",
  },
  {
    id: "long_shot", //Arrow length 2x
    name: "Long Shot",
    abbr: "L",
    desc: "Seems easier to make those long shots.",
  },
  {
    id: "focus", //Meters move at half speed
    name: "Focus",
    abbr: "F",
    desc: "You take a deep breath and the world slows down.",
  },
  {
    id: "hand_of_god", //Wall hits don't fail
    name: "Hand of God",
    abbr: "H",
    desc: "Fate is on your side.",
  },
  {
    id: "jump_shot", //Chip passes through others
    name: "Jump Shot",
    abbr: "J",
    desc: "You summon powers from another dimension to avoid hitting any chips.",
  },
];

function getFlicker() {
  return State.players[State.flickerIndex];
}

function flickerHas(id) {
  const p = getFlicker();
  if (!p) return false;
  return p.impairments.includes(id) || p.onFireBuffs.includes(id);
}

function flickerHasImpairment(id) {
  const p = getFlicker();
  return p ? p.impairments.includes(id) : false;
}

function flickerHasBuff(id) {
  const p = getFlicker();
  return p ? p.onFireBuffs.includes(id) : false;
}

function flickerImpairmentCount(id) {
  const p = getFlicker();
  return p ? p.impairments.filter((i) => i === id).length : 0;
}

function assignRandomImpairment(player) {
  const remaining = IMPAIRMENTS.filter(
    (i) => !player.impairments.includes(i.id),
  );
  if (remaining.length === 0) return null; // already has all impairments
  const imp = remaining[Math.floor(Math.random() * remaining.length)];
  player.impairments.push(imp.id);
  return imp;
}

function assignRandomBuff(player) {
  const remaining = BUFFS.filter((b) => !player.onFireBuffs.includes(b.id));
  if (remaining.length === 0) return null; // already has all buffs
  const buff = remaining[Math.floor(Math.random() * remaining.length)];
  player.onFireBuffs.push(buff.id);
  return buff;
}

function removeRandomImpairment(player) {
  if (player.impairments.length === 0) return null;
  const idx = Math.floor(Math.random() * player.impairments.length);
  const removed = player.impairments.splice(idx, 1)[0];
  return IMPAIRMENTS.find((i) => i.id === removed);
}

function consumeBuffs(player) {
  player.onFireBuffs = [];
}

function getEffectiveAngleRange() {
  let range = CONFIG.FLICK_ANGLE_RANGE;
  if (flickerHasBuff("skilled_shooter")) {
    range = 10;
  }
  return range;
}

function getEffectiveAngleSpeed() {
  let speed = CONFIG.FLICK_ANGLE_SPEED;
  if (flickerHasBuff("focus")) {
    speed *= 0.5;
  }
  return speed;
}

function getEffectivePowerSpeed() {
  let speed = CONFIG.FLICK_POWER_SPEED;
  if (flickerHasBuff("focus")) {
    speed *= 0.5;
  }
  return speed;
}

// Update daze blink state
function updateDazeBlink(now) {
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

function shouldDazeHide() {
  // In online mode, spectators (not the flicker) never see daze effect
  if (State.isOnline && State.myPlayerIndex !== State.flickerIndex) return false;
  return flickerHasImpairment("daze") && !State.dazeBlinkOn;
}

// ============================================================================
// RAPIER WORLD
// ============================================================================

let world = null;
let eventQueue = null;
let wallBodies = [];
let wallColliders = [];
let gateSensorCollider = null;
let gateSensorBody = null;

function createWorld() {
  const gravity = { x: 0.0, y: 0.0 };
  world = new RAPIER.World(gravity);
  eventQueue = new RAPIER.EventQueue(true);
}

function createWalls() {
  const S = CONFIG.TABLE_SIZE;
  const W = CONFIG.WALL_THICKNESS;

  // Walls: top, bottom, left, right
  const wallDefs = [
    { x: S / 2, y: -W, hw: S / 2 + W, hh: W }, // top
    { x: S / 2, y: S + W, hw: S / 2 + W, hh: W }, // bottom
    { x: -W, y: S / 2, hw: W, hh: S / 2 + W }, // left
    { x: S + W, y: S / 2, hw: W, hh: S / 2 + W }, // right
  ];

  wallBodies = [];
  wallColliders = [];

  for (const def of wallDefs) {
    const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(def.x, def.y);
    const body = world.createRigidBody(bodyDesc);
    // Walls: group 0, collides with all groups
    // Membership = 0x0001, Filter = 0xFFFF
    const colliderDesc = RAPIER.ColliderDesc.cuboid(def.hw, def.hh)
      .setFriction(CONFIG.FRICTION_TABLE)
      .setRestitution(CONFIG.CHIP_RESTITUTION)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
      .setCollisionGroups(0x0001ffff);
    const collider = world.createCollider(colliderDesc, body);
    wallBodies.push(body);
    wallColliders.push(collider);
  }
}

function createChipBody(x, y, topUp) {
  const chipFriction = topUp
    ? CONFIG.FRICTION_CHIP_BOTTOM
    : CONFIG.FRICTION_CHIP_TOP;
  const damping = chipFriction * CONFIG.FRICTION_TABLE * CONFIG.DAMPING_SCALE;

  const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(x, y)
    .setLinearDamping(damping)
    .setAngularDamping(CONFIG.ANGULAR_DAMPING)
    .setCcdEnabled(true);
  const body = world.createRigidBody(bodyDesc);

  // Set density so total mass ≈ 1.0 (area = π*r² ≈ 1257, so density ≈ 1/1257)
  // Chips: group 1, collides with all groups (walls=group0, other chips=group1)
  // Membership = 0x0002, Filter = 0xFFFF
  const colliderDesc = RAPIER.ColliderDesc.ball(CONFIG.CHIP_RADIUS)
    .setDensity(1.0 / (Math.PI * CONFIG.CHIP_RADIUS * CONFIG.CHIP_RADIUS))
    .setFriction(chipFriction)
    .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Multiply)
    .setRestitution(CONFIG.CHIP_RESTITUTION)
    .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
    .setCollisionGroups(0x0002ffff);
  const collider = world.createCollider(colliderDesc, body);

  return { body, collider, topUp, flicked: false, eligible: true };
}

function removeChips() {
  for (const chip of State.chips) {
    world.removeRigidBody(chip.body);
  }
  State.chips = [];
  removeGateSensor();
}

function removeGateSensor() {
  if (gateSensorBody) {
    world.removeRigidBody(gateSensorBody);
    gateSensorBody = null;
    gateSensorCollider = null;
  }
}

function createGateSensor(chipA, chipB) {
  removeGateSensor();

  const posA = chipA.body.translation();
  const posB = chipB.body.translation();
  const midX = (posA.x + posB.x) / 2;
  const midY = (posA.y + posB.y) / 2;
  const dx = posB.x - posA.x;
  const dy = posB.y - posA.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const angle = Math.atan2(dy, dx);

  // Thin rectangle spanning the gate, slightly narrower than the full distance
  // (subtract chip radii so the sensor is between the chip edges)
  const gateLength = Math.max(0, dist / 2 - CONFIG.CHIP_RADIUS);
  const gateWidth = 2; // very thin

  const bodyDesc = RAPIER.RigidBodyDesc.fixed()
    .setTranslation(midX, midY)
    .setRotation(angle);
  gateSensorBody = world.createRigidBody(bodyDesc);

  const colliderDesc = RAPIER.ColliderDesc.cuboid(gateLength, gateWidth)
    .setSensor(true)
    .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
  gateSensorCollider = world.createCollider(colliderDesc, gateSensorBody);
}

// ============================================================================
// TOSS
// ============================================================================

function generateTossPositions() {
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

function rollOrientations() {
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

function performToss() {
  removeChips();

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
    const chip = createChipBody(center, center, orientations[i]);
    // Teleport to center for animation start
    chip.body.setTranslation({ x: center, y: center }, true);
    chip.body.setLinvel({ x: 0, y: 0 }, true);
    State.chips.push(chip);
  }

  State.tossAnimStart = performance.now();
  State.consecutiveFlicks = 0;
  State.phase = "TOSS_ANIMATING";
  setMessage(`${currentTosserName()} tosses the chips!`);
}

// ============================================================================
// FLICK LOGIC
// ============================================================================

function computeCenterAngle(selectedIdx) {
  const selected = State.chips[selectedIdx];
  const others = State.chips.filter((_, i) => i !== selectedIdx);
  const selPos = selected.body.translation();
  const midX =
    (others[0].body.translation().x + others[1].body.translation().x) / 2;
  const midY =
    (others[0].body.translation().y + others[1].body.translation().y) / 2;
  return Math.atan2(midY - selPos.y, midX - selPos.x);
}

function getGateChips() {
  return State.chips.filter((_, i) => i !== State.selectedChipIndex);
}

function startAngleSelection() {
  State.centerAngle = computeCenterAngle(State.selectedChipIndex);
  State.oscillator = 0.5;
  State.oscillatorDir = 1;
  State.phase = "FLICK_ANGLE";

  // Seed double vision offset for this turn
  if (flickerHasImpairment("double_vision")) {
    const sign = () => (Math.random() < 0.5 ? -1 : 1);
    State.doubleVisionOffset = {
      x: sign() * (15 + Math.random() * 10),
      y: sign() * (15 + Math.random() * 10),
    };
  }
}

function lockAngle() {
  State.flickAngle = State.currentAngle;
  State.oscillator = 0.5;
  State.oscillatorDir = 1;
  State.phase = "FLICK_POWER";
}

function lockPowerAndFlick() {
  State.flickPower = State.currentPower;
  executeFlick();
}

function executeFlick() {
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
  createGateSensor(gate[0], gate[1]);

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
// GATE CROSSING DETECTION
// ============================================================================

function lineSegmentsIntersect(p1, p2, p3, p4) {
  const d1x = p2.x - p1.x,
    d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x,
    d2y = p4.y - p3.y;
  const cross = d1x * d2y - d1y * d2x;
  if (Math.abs(cross) < 1e-10) return false;
  const dx = p3.x - p1.x,
    dy = p3.y - p1.y;
  const t = (dx * d2y - dy * d2x) / cross;
  const u = (dx * d1y - dy * d1x) / cross;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

function checkGateCrossing() {
  if (State.selectedChipIndex < 0) return;

  const chip = State.chips[State.selectedChipIndex];
  const pos = chip.body.translation();
  const gate = getGateChips();
  const gA = gate[0].body.translation();
  const gB = gate[1].body.translation();

  // Check if chip path crossed the gate line
  const prevPositions = State.previousPositions;
  if (prevPositions.length > 0) {
    const prev = prevPositions[prevPositions.length - 1];
    if (lineSegmentsIntersect(prev, pos, gA, gB)) {
      State.passedThroughGate = true;
    }
  }

  State.previousPositions.push({ x: pos.x, y: pos.y });
}

function processCollisionEvents() {
  if (State.phase !== "FLICK_ANIMATING" || State.selectedChipIndex < 0) return;

  const flickedHandle = State.chips[State.selectedChipIndex].collider.handle;
  const gate = getGateChips();
  const gateHandles = new Set(gate.map((c) => c.collider.handle));
  const wallHandleSet = new Set(wallColliders.map((c) => c.handle));

  eventQueue.drainCollisionEvents((handle1, handle2, started) => {
    if (!started) return; // only care about collision start

    const other =
      handle1 === flickedHandle
        ? handle2
        : handle2 === flickedHandle
          ? handle1
          : null;
    if (other === null) return;

    if (gateHandles.has(other)) {
      State.touchedGateChip = true;
    }
    if (wallHandleSet.has(other)) {
      State.hitWall = true;
    }
  });
}

function allChipsStopped() {
  // Don't evaluate too early — wait at least 200ms for the impulse to take effect
  if (performance.now() - State.flickStartTime < 200) return false;

  for (const chip of State.chips) {
    const vel = chip.body.linvel();
    const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y);
    if (speed > CONFIG.VELOCITY_THRESHOLD) return false;
  }
  return true;
}

function evaluateFlick() {
  removeGateSensor();

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

function onFlickSuccess() {
  const player = getFlicker();

  // Consume On Fire buffs after this flick
  consumeBuffs(player);

  // Restore collision groups if jump_shot was active
  const chip = State.chips[State.selectedChipIndex];
  chip.collider.setCollisionGroups(0x0002ffff);

  State.consecutiveFlicks++;
  State.chips[State.selectedChipIndex].flicked = true;
  State.chips[State.selectedChipIndex].eligible = false;
  State.selectedChipIndex = -1;

  // Streak tracking
  player.streak++;
  let streakMsg = "";

  // 5-streak: cure one impairment (priority over 3-streak)
  if (player.streak >= 5 && player.impairments.length > 0) {
    const cured = removeRandomImpairment(player);
    if (cured) {
      streakMsg = ` ${player.name} cured: ${cured.name}!`;
    }
    player.streak = 0;
  }
  // 3-streak: earn On Fire buff
  else if (player.streak >= 3) {
    const buff = assignRandomBuff(player);
    if (buff) {
      streakMsg = ` ${player.name} is On Fire! Buff: ${buff.name}`;
    }
    player.streak = 0;
  }

  // After 2 successful flicks, reset all chips to eligible for the next cycle
  if (State.consecutiveFlicks >= 2) {
    State.consecutiveFlicks = 0;
    for (const c of State.chips) {
      c.flicked = false;
      c.eligible = true;
    }
    setMessage("Round complete! Chips stay." + streakMsg);
  } else {
    setMessage("Success!" + streakMsg);
    // Only the just-flicked chip is ineligible
    for (let i = 0; i < State.chips.length; i++) {
      State.chips[i].eligible = !State.chips[i].flicked;
    }
  }

  // Next player flicks (chips remain where they are)
  State.flickerIndex = (State.flickerIndex + 1) % State.players.length;
  State.phase = "SELECTING_CHIP";
}

function onFlickFailure(reason) {
  const player = getFlicker();

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
  }, 1800);
  State.phase = "EVALUATING";
}

function currentTosserName() {
  return State.players[State.tosserIndex]?.name || "Player";
}

function currentFlickerName() {
  return State.players[State.flickerIndex]?.name || "Player";
}

function setMessage(msg) {
  State.message = msg;
  State.messageTimer = performance.now();
}

// ============================================================================
// INPUT
// ============================================================================

function getCanvasMousePos(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top) * scaleY,
  };
}

function getClickedChipIndex(tableX, tableY) {
  for (let i = State.chips.length - 1; i >= 0; i--) {
    const pos = State.chips[i].body.translation();
    const dist = Math.hypot(pos.x - tableX, pos.y - tableY);
    if (dist <= CONFIG.CHIP_RADIUS + 5) return i;
  }
  return -1;
}

canvas.addEventListener("click", (e) => {
  const canvasPos = getCanvasMousePos(e);
  const tablePos = toTable(canvasPos.x, canvasPos.y);

  // In online mode, only allow interaction when it is my turn
  if (State.isOnline) {
    if (
      State.phase === "SELECTING_CHIP" ||
      State.phase === "FLICK_ANGLE" ||
      State.phase === "FLICK_POWER"
    ) {
      if (!net.isMyTurn(State.flickerIndex)) return;
    }
  }

  switch (State.phase) {
    case "SELECTING_CHIP": {
      const idx = getClickedChipIndex(tablePos.x, tablePos.y);
      if (idx >= 0 && State.chips[idx].eligible) {
        if (State.isOnline) {
          // Send to server; wait for broadcast
          net.sendChipSelected(idx);
        } else {
          State.selectedChipIndex = idx;
          startAngleSelection();
        }
      }
      break;
    }
    case "FLICK_ANGLE": {
      if (State.isOnline) {
        // Send locked angle to server; wait for broadcast
        net.sendAngleLocked(State.currentAngle, State.centerAngle);
      } else {
        lockAngle();
      }
      break;
    }
    case "FLICK_POWER": {
      if (State.isOnline) {
        // Send power lock to server; wait for broadcast
        net.sendPowerLocked(State.selectedChipIndex, State.flickAngle, State.currentPower);
      } else {
        lockPowerAndFlick();
      }
      break;
    }
    default:
      break;
  }
});

// Touch support
canvas.addEventListener(
  "touchstart",
  (e) => {
    e.preventDefault();
    if (e.touches.length > 0) {
      const touch = e.touches[0];
      const fakeEvent = { clientX: touch.clientX, clientY: touch.clientY };
      canvas.dispatchEvent(new MouseEvent("click", fakeEvent));
    }
  },
  { passive: false },
);

// ============================================================================
// MOUSE TRACKING (for canvas-drawn badge tooltips)
// ============================================================================

let mouseCanvasX = -1;
let mouseCanvasY = -1;

canvas.addEventListener("mousemove", (e) => {
  const pos = getCanvasMousePos(e);
  mouseCanvasX = pos.x;
  mouseCanvasY = pos.y;
});

canvas.addEventListener("mouseleave", () => {
  mouseCanvasX = -1;
  mouseCanvasY = -1;
});

// ============================================================================
// RENDERER
// ============================================================================

function drawTable() {
  // Border
  ctx.fillStyle = CONFIG.TABLE_BORDER_COLOR;
  ctx.fillRect(
    TX - CONFIG.TABLE_BORDER_WIDTH,
    TY - CONFIG.TABLE_BORDER_WIDTH,
    CONFIG.TABLE_SIZE + CONFIG.TABLE_BORDER_WIDTH * 2,
    CONFIG.TABLE_SIZE + CONFIG.TABLE_BORDER_WIDTH * 2,
  );
  // Surface
  ctx.fillStyle = CONFIG.TABLE_COLOR;
  ctx.fillRect(TX, TY, CONFIG.TABLE_SIZE, CONFIG.TABLE_SIZE);
}

function drawChip(chip, index) {
  const pos = chip.body.translation();
  const cx = TX + pos.x;
  const cy = TY + pos.y;
  const r = CONFIG.CHIP_RADIUS;

  // Shadow
  ctx.beginPath();
  ctx.arc(cx + 2, cy + 2, r, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.fill();

  // Main disc
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = chip.topUp ? CONFIG.CHIP_TOP_COLOR : CONFIG.CHIP_BOTTOM_COLOR;
  ctx.fill();

  // Border
  ctx.strokeStyle = CONFIG.CHIP_BORDER_COLOR;
  ctx.lineWidth = CONFIG.CHIP_BORDER_WIDTH;
  ctx.stroke();

  // Center dot (opposite color)
  ctx.beginPath();
  ctx.arc(cx, cy, 5, 0, Math.PI * 2);
  ctx.fillStyle = chip.topUp ? CONFIG.CHIP_BOTTOM_COLOR : CONFIG.CHIP_TOP_COLOR;
  ctx.fill();

  // Selection highlight
  if (index === State.selectedChipIndex) {
    ctx.beginPath();
    ctx.arc(cx, cy, r + 6, 0, Math.PI * 2);
    ctx.strokeStyle = CONFIG.ARROW_COLOR;
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  // Eligible pulsing indicator (only during SELECTING_CHIP)
  if (
    State.phase === "SELECTING_CHIP" &&
    chip.eligible &&
    index !== State.selectedChipIndex
  ) {
    const pulse = 0.4 + 0.6 * Math.abs(Math.sin(performance.now() / 300));
    ctx.beginPath();
    ctx.arc(cx, cy, r + 4, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255, 255, 255, ${pulse * 0.6})`;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function drawGateLine() {
  if (State.selectedChipIndex < 0) return;
  if (!["FLICK_ANGLE", "FLICK_POWER", "FLICK_ANIMATING"].includes(State.phase))
    return;

  const gate = getGateChips();
  if (gate.length < 2) return;

  const pA = gate[0].body.translation();
  const pB = gate[1].body.translation();

  ctx.save();
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = CONFIG.GATE_LINE_COLOR;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(TX + pA.x, TY + pA.y);
  ctx.lineTo(TX + pB.x, TY + pB.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

function drawArrow(angle, length) {
  if (State.selectedChipIndex < 0) return;

  const chip = State.chips[State.selectedChipIndex];
  const pos = chip.body.translation();
  const sx = TX + pos.x;
  const sy = TY + pos.y;
  const ex = sx + Math.cos(angle) * length;
  const ey = sy + Math.sin(angle) * length;

  // Arrow shaft
  ctx.strokeStyle = CONFIG.ARROW_COLOR;
  ctx.lineWidth = CONFIG.ARROW_WIDTH;
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(ex, ey);
  ctx.stroke();

  // Arrowhead
  const headAngle = Math.PI / 6;
  ctx.beginPath();
  ctx.moveTo(ex, ey);
  ctx.lineTo(
    ex - CONFIG.ARROW_HEAD_LEN * Math.cos(angle - headAngle),
    ey - CONFIG.ARROW_HEAD_LEN * Math.sin(angle - headAngle),
  );
  ctx.moveTo(ex, ey);
  ctx.lineTo(
    ex - CONFIG.ARROW_HEAD_LEN * Math.cos(angle + headAngle),
    ey - CONFIG.ARROW_HEAD_LEN * Math.sin(angle + headAngle),
  );
  ctx.stroke();
}

function drawPowerBar() {
  if (State.phase !== "FLICK_POWER") return;

  const barX = TX + CONFIG.TABLE_SIZE + 16;
  const barY = TY + 40;
  const barW = 24;
  const barH = CONFIG.TABLE_SIZE - 80;

  // Background
  ctx.fillStyle = "#222";
  ctx.fillRect(barX, barY, barW, barH);

  // Fill
  const ratio =
    (State.currentPower - CONFIG.FLICK_POWER_MIN) /
    (CONFIG.FLICK_POWER_MAX - CONFIG.FLICK_POWER_MIN);
  const fillH = ratio * barH;

  const hue = 120 - ratio * 120;
  ctx.fillStyle = `hsl(${hue}, 80%, 50%)`;
  ctx.fillRect(barX, barY + barH - fillH, barW, fillH);

  // Border
  ctx.strokeStyle = "#666";
  ctx.lineWidth = 1;
  ctx.strokeRect(barX, barY, barW, barH);

  // Label
  ctx.fillStyle = "#aaa";
  ctx.font = "11px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("POWER", barX + barW / 2, barY - 8);
}

function drawImpairmentBadge(x, y, abbr, color, name, desc, kind) {
  const w = 16,
    h = 14;
  ctx.fillStyle = color;
  ctx.fillRect(x, y - h + 2, w, h);
  ctx.fillStyle = "#fff";
  ctx.font = "bold 9px monospace";
  ctx.textAlign = "center";
  ctx.fillText(abbr, x + w / 2, y - 1);
  ctx.textAlign = "left";
  // Record bounding box for hover detection (canvas pixels)
  State.badgeRects.push({ x, y: y - h + 2, w, h, name, desc, kind });
  return w + 2;
}

function drawAnonymousBadge(x, y, count, color) {
  const w = 16,
    h = 14;
  ctx.fillStyle = color;
  ctx.fillRect(x, y - h + 2, w, h);
  ctx.fillStyle = "#fff";
  ctx.font = "bold 9px monospace";
  ctx.textAlign = "center";
  ctx.fillText(String(count), x + w / 2, y - 1);
  ctx.textAlign = "left";
  // Record bounding box for hover detection — anonymous badges show generic tooltip
  const kindLabel = color === "#b8860b" ? "buff" : "impairment";
  const plural = count !== 1 ? "s" : "";
  State.badgeRects.push({
    x,
    y: y - h + 2,
    w,
    h,
    name: kindLabel === "buff" ? "Buffs" : "Impairments",
    desc: `${count} active ${kindLabel}${plural}`,
    kind: kindLabel,
  });
  return w + 2;
}

function drawBadgeTooltip() {
  if (mouseCanvasX < 0 || mouseCanvasY < 0) return;

  const PAD = 4;
  const hit = State.badgeRects.find(
    (r) =>
      mouseCanvasX >= r.x - PAD &&
      mouseCanvasX <= r.x + r.w + PAD &&
      mouseCanvasY >= r.y - PAD &&
      mouseCanvasY <= r.y + r.h + PAD,
  );
  if (!hit || !hit.desc) return;

  // Measure text to size the tooltip
  const nameFont = "bold 11px sans-serif";
  const descFont = "11px sans-serif";
  ctx.font = nameFont;
  const nameW = ctx.measureText(hit.name).width;
  ctx.font = descFont;

  // Word-wrap the description to a max width
  const maxTextW = 170;
  const words = hit.desc.split(" ");
  const descLines = [];
  let line = "";
  for (const word of words) {
    const test = line ? line + " " + word : word;
    if (ctx.measureText(test).width > maxTextW && line) {
      descLines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) descLines.push(line);

  let descMaxW = 0;
  for (const dl of descLines) {
    const w = ctx.measureText(dl).width;
    if (w > descMaxW) descMaxW = w;
  }

  const padX = 8,
    padY = 6;
  const lineH = 14;
  const gapAfterName = 4;
  const tipW = Math.max(nameW, descMaxW) + padX * 2;
  const tipH = padY + lineH + gapAfterName + descLines.length * lineH + padY;

  // Always position below the badge
  let tx = hit.x;
  let ty = hit.y + hit.h + 6;
  if (tx + tipW > CANVAS_W - 4) tx = CANVAS_W - tipW - 4;
  if (tx < 2) tx = 2;

  // Rounded rect background
  const r = 5;
  ctx.fillStyle = "rgba(10, 10, 30, 0.92)";
  ctx.beginPath();
  ctx.moveTo(tx + r, ty);
  ctx.lineTo(tx + tipW - r, ty);
  ctx.arcTo(tx + tipW, ty, tx + tipW, ty + r, r);
  ctx.lineTo(tx + tipW, ty + tipH - r);
  ctx.arcTo(tx + tipW, ty + tipH, tx + tipW - r, ty + tipH, r);
  ctx.lineTo(tx + r, ty + tipH);
  ctx.arcTo(tx, ty + tipH, tx, ty + tipH - r, r);
  ctx.lineTo(tx, ty + r);
  ctx.arcTo(tx, ty, tx + r, ty, r);
  ctx.closePath();
  ctx.fill();

  // Border
  ctx.strokeStyle = "#555";
  ctx.lineWidth = 1;
  ctx.stroke();

  // Name text
  ctx.font = nameFont;
  ctx.fillStyle = hit.kind === "impairment" ? "#e05555" : "#ffb703";
  ctx.textAlign = "left";
  ctx.fillText(hit.name, tx + padX, ty + padY + lineH - 3);

  // Description text
  ctx.font = descFont;
  ctx.fillStyle = "#ccc";
  let textY = ty + padY + lineH + gapAfterName;
  for (const dl of descLines) {
    ctx.fillText(dl, tx + padX, textY + lineH - 3);
    textY += lineH;
  }
}

function drawHUD() {
  State.badgeRects = []; // clear each frame before redrawing badges

  ctx.font = "14px sans-serif";
  ctx.textAlign = "left";

  // Player info + scores at the top
  let x = TX;
  const y = TY - 30;

  for (let i = 0; i < State.players.length; i++) {
    const p = State.players[i];
    const isActive =
      (State.phase === "SELECTING_CHIP" ||
        State.phase === "FLICK_ANGLE" ||
        State.phase === "FLICK_POWER") &&
      i === State.flickerIndex;
    const isTosser =
      (State.phase === "TOSSING" || State.phase === "TOSS_ANIMATING") &&
      i === State.tosserIndex;

    ctx.fillStyle =
      isActive || isTosser
        ? CONFIG.PLAYER_COLORS[i % CONFIG.PLAYER_COLORS.length]
        : "#777";
    ctx.font =
      isActive || isTosser ? "bold 14px sans-serif" : "14px sans-serif";

    const text = `${p.name}: ${p.failures}`;
    ctx.fillText(text, x, y);

    // Draw impairment/buff badges below name
    let bx = x;
    const by = y + 14;

    // Determine if we should show full badge details or anonymous counts
    const showFull = !State.isOnline || i === State.myPlayerIndex;

    if (showFull) {
      // Self (or local play): draw actual badges with tooltips
      for (const impId of p.impairments) {
        const imp = IMPAIRMENTS.find((imp) => imp.id === impId);
        if (imp) {
          bx += drawImpairmentBadge(
            bx,
            by,
            imp.abbr,
            "#8b2020",
            imp.name,
            imp.desc,
            "impairment",
          );
        }
      }
      for (const buffId of p.onFireBuffs) {
        const buff = BUFFS.find((b) => b.id === buffId);
        if (buff) {
          bx += drawImpairmentBadge(
            bx,
            by,
            buff.abbr,
            "#b8860b",
            buff.name,
            buff.desc,
            "buff",
          );
        }
      }
    } else {
      // Other players in online mode: draw anonymous count badges
      const impCount = p.impairmentCount !== undefined ? p.impairmentCount : (p.impairments ? p.impairments.length : 0);
      const buffCount = p.buffCount !== undefined ? p.buffCount : (p.onFireBuffs ? p.onFireBuffs.length : 0);
      if (impCount > 0) {
        bx += drawAnonymousBadge(bx, by, impCount, "#8b2020");
      }
      if (buffCount > 0) {
        bx += drawAnonymousBadge(bx, by, buffCount, "#b8860b");
      }
    }

    // Show streak if > 0
    if (p.streak > 0) {
      ctx.font = "10px sans-serif";
      ctx.fillStyle = "#ffb703";
      ctx.fillText(`x${p.streak}`, bx + 2, by);
    }

    x += ctx.measureText(text).width + 24;
  }

  // Phase / instruction text at the bottom
  let instruction = "";
  switch (State.phase) {
    case "TOSS_ANIMATING":
      instruction = `${currentTosserName()} tosses...`;
      break;
    case "SELECTING_CHIP":
      instruction = `${currentFlickerName()}: Click a chip to flick`;
      break;
    case "FLICK_ANGLE":
      instruction = `${currentFlickerName()}: Click to set angle`;
      break;
    case "FLICK_POWER":
      instruction = `${currentFlickerName()}: Click to set power`;
      break;
    case "FLICK_ANIMATING":
      instruction = "Flicking...";
      break;
    case "EVALUATING":
      instruction = State.message;
      break;
  }

  if (instruction) {
    ctx.fillStyle = "#ddd";
    ctx.font = "13px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(
      instruction,
      TX + CONFIG.TABLE_SIZE / 2,
      TY + CONFIG.TABLE_SIZE + 24,
    );
  }

  // Transient message
  if (State.message && performance.now() - State.messageTimer < 2500) {
    ctx.fillStyle = "#ffb703";
    ctx.font = "bold 16px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(
      State.message,
      TX + CONFIG.TABLE_SIZE / 2,
      TY + CONFIG.TABLE_SIZE + 50,
    );
  }
}

function getArrowAngleForDisplay() {
  // False Confidence: display uses narrow ±10° range, but actual is full ±20°
  if (
    flickerHasImpairment("false_confidence") &&
    State.phase === "FLICK_ANGLE"
  ) {
    const narrowRad = (10 * Math.PI) / 180;
    return State.centerAngle + (State.oscillator * 2 - 1) * narrowRad;
  }
  // Skilled Shooter buff: display AND actual use effective range
  if (flickerHasBuff("skilled_shooter") && State.phase === "FLICK_ANGLE") {
    const effRad = (State.effectiveAngleRange * Math.PI) / 180;
    return State.centerAngle + (State.oscillator * 2 - 1) * effRad;
  }
  return State.currentAngle;
}

function getArrowLengthMultiplier() {
  return flickerHasBuff("long_shot") ? 2.0 : 1.0;
}

function drawNormalScene(offsetX, offsetY, alpha) {
  const prevAlpha = ctx.globalAlpha;
  ctx.globalAlpha = alpha;
  ctx.save();
  ctx.translate(offsetX, offsetY);

  // Chips
  for (let i = 0; i < State.chips.length; i++) {
    drawChip(State.chips[i], i);
  }

  drawGateLine();

  // Arrow (respect daze blink)
  if (!shouldDazeHide()) {
    if (State.phase === "FLICK_ANGLE") {
      const displayAngle = getArrowAngleForDisplay();
      drawArrow(displayAngle, 80 * getArrowLengthMultiplier());
    } else if (State.phase === "FLICK_POWER") {
      const arrowLen =
        CONFIG.ARROW_LENGTH_MIN +
        ((State.currentPower - CONFIG.FLICK_POWER_MIN) /
          (CONFIG.FLICK_POWER_MAX - CONFIG.FLICK_POWER_MIN)) *
          (CONFIG.ARROW_LENGTH_MAX - CONFIG.ARROW_LENGTH_MIN);
      drawArrow(State.flickAngle, arrowLen);
    }
  }

  // Power bar (respect daze blink)
  if (!shouldDazeHide()) {
    drawPowerBar();
  }

  ctx.restore();
  ctx.globalAlpha = prevAlpha;
}

function render() {
  // Clear
  ctx.fillStyle = "#1a1a2e";
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  drawTable();

  // Normal scene
  drawNormalScene(0, 0, 1.0);

  // Determine if impairment visual effects should apply
  // In online mode, only the flicker sees their own impairments
  const isMyFlick = !State.isOnline || State.myPlayerIndex === State.flickerIndex;

  // Double Vision ghost layer
  if (
    isMyFlick &&
    flickerHasImpairment("double_vision") &&
    [
      "FLICK_ANGLE",
      "FLICK_POWER",
      "FLICK_ANIMATING",
      "SELECTING_CHIP",
    ].includes(State.phase)
  ) {
    drawNormalScene(
      State.doubleVisionOffset.x,
      State.doubleVisionOffset.y,
      0.35,
    );
  }

  drawHUD();

  // Blackout overlay (drawn last so it covers everything except HUD)
  if (
    isMyFlick &&
    flickerHasImpairment("blackout") &&
    ["FLICK_ANGLE", "FLICK_POWER", "SELECTING_CHIP"].includes(State.phase)
  ) {
    ctx.fillStyle = "rgba(0, 0, 0, 0.8)";
    ctx.fillRect(TX, TY, CONFIG.TABLE_SIZE, CONFIG.TABLE_SIZE);
  }
}

// ============================================================================
// UPDATE (per frame)
// ============================================================================

function updateOscillators(dt) {
  if (State.phase === "FLICK_ANGLE") {
    const speed = getEffectiveAngleSpeed();
    State.oscillator += State.oscillatorDir * speed * dt;
    if (State.oscillator >= 1) {
      State.oscillator = 1;
      State.oscillatorDir = -1;
    }
    if (State.oscillator <= 0) {
      State.oscillator = 0;
      State.oscillatorDir = 1;
    }

    // Skilled Shooter narrows ACTUAL range; False Confidence does NOT
    const actualRange = flickerHasBuff("skilled_shooter")
      ? 10
      : CONFIG.FLICK_ANGLE_RANGE;
    const rangeRad = (actualRange * Math.PI) / 180;
    State.currentAngle =
      State.centerAngle + (State.oscillator * 2 - 1) * rangeRad;

    // Store effective display range for rendering
    State.effectiveAngleRange = getEffectiveAngleRange();
  }

  if (State.phase === "FLICK_POWER") {
    const speed = getEffectivePowerSpeed();
    State.oscillator += State.oscillatorDir * speed * dt;
    if (State.oscillator >= 1) {
      State.oscillator = 1;
      State.oscillatorDir = -1;
    }
    if (State.oscillator <= 0) {
      State.oscillator = 0;
      State.oscillatorDir = 1;
    }

    State.currentPower =
      CONFIG.FLICK_POWER_MIN +
      State.oscillator * (CONFIG.FLICK_POWER_MAX - CONFIG.FLICK_POWER_MIN);
  }
}

function updateTossAnimation(now) {
  if (State.phase !== "TOSS_ANIMATING") return;

  const elapsed = now - State.tossAnimStart;
  const progress = Math.min(1, elapsed / CONFIG.TOSS_ANIM_DURATION);
  const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic

  const center = CONFIG.TABLE_SIZE / 2;
  for (let i = 0; i < State.chips.length; i++) {
    const target = State.tossTargetPositions[i];
    const x = center + (target.x - center) * eased;
    const y = center + (target.y - center) * eased;
    State.chips[i].body.setTranslation({ x, y }, true);
    State.chips[i].body.setLinvel({ x: 0, y: 0 }, true);
  }

  if (progress >= 1) {
    // Finalize positions
    for (let i = 0; i < State.chips.length; i++) {
      const target = State.tossTargetPositions[i];
      State.chips[i].body.setTranslation({ x: target.x, y: target.y }, true);
      State.chips[i].body.setLinvel({ x: 0, y: 0 }, true);
    }

    // Reset eligibility
    for (const chip of State.chips) {
      chip.flicked = false;
      chip.eligible = true;
    }

    State.phase = "SELECTING_CHIP";
    setMessage(`${currentFlickerName()}: Pick a chip to flick!`);
  }
}

function updateFlickAnimation() {
  if (State.phase !== "FLICK_ANIMATING") return;

  // In online mode and not my turn: skip physics, lerp toward remote targets
  if (State.isOnline && !net.isMyTurn(State.flickerIndex)) {
    if (State.remoteChipTargets && State.chips.length === State.remoteChipTargets.length) {
      const lerpFactor = 0.3;
      for (let i = 0; i < State.chips.length; i++) {
        const current = State.chips[i].body.translation();
        const target = State.remoteChipTargets[i];
        const nx = current.x + (target.x - current.x) * lerpFactor;
        const ny = current.y + (target.y - current.y) * lerpFactor;
        State.chips[i].body.setTranslation({ x: nx, y: ny }, true);
        State.chips[i].body.setLinvel({ x: 0, y: 0 }, true);
      }
    }
    // Spectators wait for flick_result_broadcast — do not evaluate locally
    return;
  }

  // Active flicker (or local play): run physics + gate detection + evaluation
  checkGateCrossing();
  processCollisionEvents();

  if (allChipsStopped()) {
    evaluateFlick();
  }
}

function update(now, dt) {
  updateTossAnimation(now);
  updateDazeBlink(now);
  updateOscillators(dt);

  // Step the physics world with event queue for collision detection
  if (State.phase === "FLICK_ANIMATING") {
    // In online mode and not my turn, skip world.step (using lerp instead)
    if (State.isOnline && !net.isMyTurn(State.flickerIndex)) {
      // No physics step — handled by lerp in updateFlickAnimation
    } else {
      world.step(eventQueue);
    }
  }

  updateFlickAnimation();
}

// ============================================================================
// GAME LOOP
// ============================================================================

let lastTime = 0;

function tick(timestamp) {
  const dt = Math.min((timestamp - lastTime) / 1000, 0.05); // cap at 50ms
  lastTime = timestamp;

  if (State.phase !== "SETUP" && State.phase !== "GAME_OVER") {
    update(timestamp, dt);
    render();
  }

  requestAnimationFrame(tick);
}

// ============================================================================
// SETUP UI
// ============================================================================

const setupOverlay = document.getElementById("setupOverlay");
const endOverlay = document.getElementById("endOverlay");
const endGameBtn = document.getElementById("endGameBtn");
const playerCountInput = document.getElementById("playerCount");
const playerNamesContainer = document.getElementById("playerNamesContainer");
const advancedToggle = document.getElementById("advancedToggle");
const advancedSettings = document.getElementById("advancedSettings");
const startBtn = document.getElementById("startBtn");
const playAgainBtn = document.getElementById("playAgainBtn");

// View elements
const modeSelect = document.getElementById("modeSelect");
const localSetup = document.getElementById("localSetup");
const onlineMenu = document.getElementById("onlineMenu");
const waitingRoom = document.getElementById("waitingRoom");

// Online menu elements
const localPlayBtn = document.getElementById("localPlayBtn");
const onlinePlayBtn = document.getElementById("onlinePlayBtn");
const localBackBtn = document.getElementById("localBackBtn");
const onlineBackBtn = document.getElementById("onlineBackBtn");
const onlineNameInput = document.getElementById("onlineName");
const createRoomBtn = document.getElementById("createRoomBtn");
const roomCodeInput = document.getElementById("roomCodeInput");
const joinRoomBtn = document.getElementById("joinRoomBtn");
const onlineAdvToggle = document.getElementById("onlineAdvToggle");
const onlineAdvSettings = document.getElementById("onlineAdvSettings");
const roomCodeBig = document.getElementById("roomCodeBig");
const lobbyPlayerList = document.getElementById("lobbyPlayerList");
const lobbyStartBtn = document.getElementById("lobbyStartBtn");
const leaveRoomBtn = document.getElementById("leaveRoomBtn");
const onlineError = document.getElementById("onlineError");

// ---- View Management ----

function showView(viewId) {
  // Hide all views
  modeSelect.style.display = "none";
  localSetup.style.display = "none";
  onlineMenu.style.display = "none";
  waitingRoom.style.display = "none";

  // Show requested view
  const el = document.getElementById(viewId);
  if (el) el.style.display = "";
}

// Default: show mode select
showView("modeSelect");

// ---- Mode Select Buttons ----

localPlayBtn.addEventListener("click", () => {
  showView("localSetup");
});

onlinePlayBtn.addEventListener("click", () => {
  showView("onlineMenu");
  if (onlineError) onlineError.textContent = "";
});

localBackBtn.addEventListener("click", () => {
  showView("modeSelect");
});

onlineBackBtn.addEventListener("click", () => {
  showView("modeSelect");
});

// ---- Local Setup ----

function updatePlayerNameInputs() {
  const count = Math.max(2, Math.min(8, parseInt(playerCountInput.value) || 2));
  playerNamesContainer.innerHTML = "";
  for (let i = 0; i < count; i++) {
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = `Player ${i + 1}`;
    input.value = `Player ${i + 1}`;
    input.className = "player-name-input";
    playerNamesContainer.appendChild(input);
  }
}

playerCountInput.addEventListener("change", updatePlayerNameInputs);
updatePlayerNameInputs();

advancedToggle.addEventListener("click", () => {
  advancedSettings.classList.toggle("visible");
  advancedToggle.textContent = advancedSettings.classList.contains("visible")
    ? "Hide Advanced Settings"
    : "Advanced Settings";
});

// Wire up slider value displays (local)
for (const id of [
  "frictionTable",
  "frictionChipTop",
  "frictionChipBottom",
  "dampingScale",
  "chipRestitution",
]) {
  const slider = document.getElementById(id);
  const valSpan = document.getElementById(id + "Val");
  if (slider && valSpan) {
    slider.addEventListener("input", () => {
      valSpan.textContent = parseFloat(slider.value).toFixed(
        slider.step < 1 ? 2 : 1,
      );
    });
  }
}

// Wire up online advanced settings slider value displays
for (const id of [
  "onFrictionTable",
  "onFrictionChipTop",
  "onFrictionChipBottom",
  "onDampingScale",
  "onChipRestitution",
]) {
  const slider = document.getElementById(id);
  const valSpan = document.getElementById(id + "Val");
  if (slider && valSpan) {
    slider.addEventListener("input", () => {
      valSpan.textContent = parseFloat(slider.value).toFixed(
        slider.step < 1 ? 2 : 1,
      );
    });
  }
}

if (onlineAdvToggle && onlineAdvSettings) {
  onlineAdvToggle.addEventListener("click", () => {
    onlineAdvSettings.classList.toggle("visible");
    onlineAdvToggle.textContent = onlineAdvSettings.classList.contains("visible")
      ? "Hide Advanced Settings"
      : "Advanced Settings";
  });
}

startBtn.addEventListener("click", () => {
  // Read player names
  const nameInputs = playerNamesContainer.querySelectorAll("input");
  const players = [];
  nameInputs.forEach((input, i) => {
    players.push({
      name: input.value.trim() || `Player ${i + 1}`,
      failures: 0,
      impairments: [],
      onFireBuffs: [],
      streak: 0,
    });
  });

  // Read advanced settings
  CONFIG.FRICTION_TABLE = parseFloat(
    document.getElementById("frictionTable").value,
  );
  CONFIG.FRICTION_CHIP_TOP = parseFloat(
    document.getElementById("frictionChipTop").value,
  );
  CONFIG.FRICTION_CHIP_BOTTOM = parseFloat(
    document.getElementById("frictionChipBottom").value,
  );
  CONFIG.DAMPING_SCALE = parseFloat(
    document.getElementById("dampingScale").value,
  );
  CONFIG.CHIP_RESTITUTION = parseFloat(
    document.getElementById("chipRestitution").value,
  );

  startGame(players);
});

// ---- Online Menu ----

createRoomBtn.addEventListener("click", () => {
  const name = (onlineNameInput.value || "").trim() || "Player";
  if (onlineError) onlineError.textContent = "";

  // Read online advanced settings for config
  const config = {};
  const onFrictionTable = document.getElementById("onFrictionTable");
  const onFrictionChipTop = document.getElementById("onFrictionChipTop");
  const onFrictionChipBottom = document.getElementById("onFrictionChipBottom");
  const onDampingScale = document.getElementById("onDampingScale");
  const onChipRestitution = document.getElementById("onChipRestitution");
  if (onFrictionTable) config.frictionTable = parseFloat(onFrictionTable.value);
  if (onFrictionChipTop) config.frictionChipTop = parseFloat(onFrictionChipTop.value);
  if (onFrictionChipBottom) config.frictionChipBottom = parseFloat(onFrictionChipBottom.value);
  if (onDampingScale) config.dampingScale = parseFloat(onDampingScale.value);
  if (onChipRestitution) config.chipRestitution = parseFloat(onChipRestitution.value);

  net.createRoom(name, config);
});

joinRoomBtn.addEventListener("click", () => {
  const name = (onlineNameInput.value || "").trim() || "Player";
  const code = (roomCodeInput.value || "").trim();
  if (onlineError) onlineError.textContent = "";

  if (!code || code.length < 4) {
    if (onlineError) onlineError.textContent = "Enter a 4-digit room code.";
    return;
  }

  net.joinRoom(code, name);
});

// ---- Waiting Room ----

leaveRoomBtn.addEventListener("click", () => {
  net.leaveRoom();
  showView("onlineMenu");
});

lobbyStartBtn.addEventListener("click", () => {
  net.startGame();
});

// ============================================================================
// END GAME
// ============================================================================

endGameBtn.addEventListener("click", () => {
  if (State.isOnline) {
    // Only host can end game in online mode
    if (net.getIsHost()) {
      net.sendEndGame();
    }
  } else {
    endGame();
  }
});

playAgainBtn.addEventListener("click", () => {
  endOverlay.classList.remove("visible");
  if (State.isOnline) {
    // Return to lobby (waiting room)
    setupOverlay.style.display = "flex";
    showView("waitingRoom");
    State.phase = "SETUP";
  } else {
    setupOverlay.style.display = "flex";
    showView("localSetup");
    State.phase = "SETUP";
  }
});

function endGame() {
  State.phase = "GAME_OVER";
  endGameBtn.classList.remove("visible");

  // Sort players by failures (ascending)
  const sorted = [...State.players].sort((a, b) => a.failures - b.failures);
  const minFails = sorted[0].failures;

  const scoreboard = document.getElementById("endScoreboard");
  scoreboard.innerHTML = sorted
    .map((p) => {
      const isWinner = p.failures === minFails;
      return `<div class="${isWinner ? "winner" : ""}">${p.name}: ${p.failures} failure${p.failures !== 1 ? "s" : ""}${isWinner ? " ★" : ""}</div>`;
    })
    .join("");

  endOverlay.classList.add("visible");

  // Clean up physics
  removeChips();
}

// ============================================================================
// START GAME (Local)
// ============================================================================

function startGame(players) {
  setupOverlay.style.display = "none";
  endOverlay.classList.remove("visible");
  endGameBtn.classList.add("visible");

  State.isOnline = false;
  State.myPlayerIndex = -1;
  State.players = players;
  State.tosserIndex = 0;
  State.flickerIndex = 1 % players.length;
  State.phase = "TOSSING";

  // Create fresh Rapier world (old one is garbage collected)
  State.chips = [];
  wallBodies = [];
  wallColliders = [];
  gateSensorBody = null;
  gateSensorCollider = null;
  createWorld();
  createWalls();

  performToss();
}

// ============================================================================
// START GAME (Online)
// ============================================================================

function startGameOnline(players, config, tosserIndex, flickerIndex) {
  setupOverlay.style.display = "none";
  endOverlay.classList.remove("visible");
  endGameBtn.classList.add("visible");

  State.isOnline = true;
  State.myPlayerIndex = net.getMyIndex();
  State.remoteChipTargets = null;

  // Apply server config
  if (config) {
    if (config.frictionTable !== undefined) CONFIG.FRICTION_TABLE = config.frictionTable;
    if (config.frictionChipTop !== undefined) CONFIG.FRICTION_CHIP_TOP = config.frictionChipTop;
    if (config.frictionChipBottom !== undefined) CONFIG.FRICTION_CHIP_BOTTOM = config.frictionChipBottom;
    if (config.dampingScale !== undefined) CONFIG.DAMPING_SCALE = config.dampingScale;
    if (config.chipRestitution !== undefined) CONFIG.CHIP_RESTITUTION = config.chipRestitution;
  }

  // Build player objects
  State.players = players.map((p) => ({
    name: p.name,
    failures: 0,
    impairments: [],
    onFireBuffs: [],
    streak: 0,
  }));

  State.tosserIndex = tosserIndex;
  State.flickerIndex = flickerIndex;
  State.consecutiveFlicks = 0;
  State.phase = "TOSSING";

  // Create fresh Rapier world
  State.chips = [];
  wallBodies = [];
  wallColliders = [];
  gateSensorBody = null;
  gateSensorCollider = null;
  createWorld();
  createWalls();
}

// ============================================================================
// NETWORK HANDLERS
// ============================================================================

function setupNetworkHandlers() {
  // --- Lobby events ---

  net.on("room_created", (msg) => {
    showView("waitingRoom");
    roomCodeBig.textContent = msg.code;
    lobbyStartBtn.style.display = "";
  });

  net.on("room_joined", (msg) => {
    showView("waitingRoom");
    roomCodeBig.textContent = msg.code;
    lobbyStartBtn.style.display = "none";
  });

  net.on("lobby_update", (msg) => {
    // Update player list display
    if (lobbyPlayerList) {
      lobbyPlayerList.innerHTML = msg.players
        .map(
          (p) =>
            `<div class="lobby-player${p.isHost ? " host" : ""}${!p.connected ? " disconnected" : ""}">${p.name}${p.isHost ? " (Host)" : ""}${!p.connected ? " (disconnected)" : ""}</div>`,
        )
        .join("");
    }
    // Show start button only for host with 2+ players
    if (lobbyStartBtn) {
      const amHost = net.getIsHost();
      lobbyStartBtn.style.display =
        amHost && msg.players.length >= 2 ? "" : "none";
    }
  });

  // --- Game started ---

  net.on("game_started", (msg) => {
    startGameOnline(msg.players, msg.config, msg.tosserIndex, msg.flickerIndex);
  });

  // --- Toss ---

  net.on("request_toss", (msg) => {
    State.tosserIndex = msg.tosserIndex;
    State.flickerIndex = msg.flickerIndex;
    State.phase = "TOSSING";

    // If I am the tosser, generate positions and send
    if (net.amITosser(msg.tosserIndex)) {
      performToss();
    }
    // Otherwise, wait for toss_broadcast
  });

  net.on("toss_broadcast", (msg) => {
    // All clients create chips and animate scatter
    removeChips();

    State.tosserIndex = msg.tosserIndex;
    State.flickerIndex = msg.flickerIndex;
    State.consecutiveFlicks = 0;

    const positions = msg.positions;
    State.tossTargetPositions = positions.map((p) => ({
      x: p.x,
      y: p.y,
      topUp: p.topUp,
    }));

    // Create chips at center for animation
    const center = CONFIG.TABLE_SIZE / 2;
    for (let i = 0; i < positions.length; i++) {
      const chip = createChipBody(center, center, positions[i].topUp);
      chip.body.setTranslation({ x: center, y: center }, true);
      chip.body.setLinvel({ x: 0, y: 0 }, true);
      State.chips.push(chip);
    }

    State.tossAnimStart = performance.now();
    State.phase = "TOSS_ANIMATING";
    setMessage(`${currentTosserName()} tosses the chips!`);
  });

  // --- Chip Selected ---

  net.on("chip_selected_broadcast", (msg) => {
    State.selectedChipIndex = msg.chipIndex;
    startAngleSelection();
  });

  // --- Angle Locked ---

  net.on("angle_locked_broadcast", (msg) => {
    State.flickAngle = msg.angle;
    if (msg.centerAngle !== undefined) {
      State.centerAngle = msg.centerAngle;
    }
    State.oscillator = 0.5;
    State.oscillatorDir = 1;
    State.phase = "FLICK_POWER";
  });

  // --- Execute Flick ---

  net.on("execute_flick_broadcast", (msg) => {
    State.selectedChipIndex = msg.chipIndex;
    State.flickAngle = msg.angle;
    State.flickPower = msg.power;

    if (net.isMyTurn(State.flickerIndex)) {
      // Active client: run physics locally + stream
      executeFlick();
    } else {
      // Spectator: enter FLICK_ANIMATING state, wait for physics frames
      State.flickStartTime = performance.now();
      State.phase = "FLICK_ANIMATING";
      State.remoteChipTargets = null;
    }
  });

  // --- Physics Frame (spectator lerp targets) ---

  net.on("physics_frame_broadcast", (msg) => {
    State.remoteChipTargets = msg.chips;
  });

  // --- Flick Result ---

  net.on("flick_result_broadcast", (msg) => {
    net.stopPhysicsStreaming();
    State.remoteChipTargets = null;

    // Teleport chips to final positions
    if (msg.finalPositions && State.chips.length === msg.finalPositions.length) {
      for (let i = 0; i < State.chips.length; i++) {
        const fp = msg.finalPositions[i];
        State.chips[i].body.setTranslation({ x: fp.x, y: fp.y }, true);
        State.chips[i].body.setLinvel({ x: 0, y: 0 }, true);
        if (fp.topUp !== undefined) {
          State.chips[i].topUp = fp.topUp;
        }
      }
    }

    // Restore collision groups on the flicked chip
    if (msg.chipIndex >= 0 && msg.chipIndex < State.chips.length) {
      State.chips[msg.chipIndex].collider.setCollisionGroups(0x0002ffff);
    }

    removeGateSensor();

    if (msg.success) {
      // Update chip states from server
      if (msg.chipStates) {
        for (let i = 0; i < State.chips.length && i < msg.chipStates.length; i++) {
          State.chips[i].flicked = msg.chipStates[i].flicked;
          State.chips[i].eligible = msg.chipStates[i].eligible;
        }
      }

      State.consecutiveFlicks = msg.consecutiveFlicks || 0;
      State.selectedChipIndex = -1;

      // Build message
      let flickerName = State.players[msg.flickerIndex]?.name || "Player";
      let streakMsg = "";
      if (msg.streakEvent) {
        if (msg.streakEvent.type === "cure") {
          const imp = IMPAIRMENTS.find((i) => i.id === msg.streakEvent.impairmentId);
          streakMsg = ` ${flickerName} cured: ${imp ? imp.name : msg.streakEvent.impairmentId}!`;
        } else if (msg.streakEvent.type === "buff") {
          const buff = BUFFS.find((b) => b.id === msg.streakEvent.buffId);
          streakMsg = ` ${flickerName} is On Fire! Buff: ${buff ? buff.name : msg.streakEvent.buffId}`;
        }
      }

      if (msg.consecutiveFlicks === 0 && State.chips.every((c) => c.eligible)) {
        setMessage("Round complete! Chips stay." + streakMsg);
      } else {
        setMessage("Success!" + streakMsg);
      }

      State.flickerIndex = msg.nextFlickerIndex;
      State.tosserIndex = msg.tosserIndex;
      State.phase = "SELECTING_CHIP";
    } else {
      // Failure
      let flickerName = State.players[msg.flickerIndex]?.name || "Player";
      let impMsg = "";
      if (msg.impairmentEvent) {
        const imp = IMPAIRMENTS.find((i) => i.id === msg.impairmentEvent.impairmentId);
        impMsg = ` Gains: ${imp ? imp.name : msg.impairmentEvent.impairmentId}!`;
      }

      setMessage(`${flickerName} fails! ${msg.reason || ""}${impMsg}`);
      State.selectedChipIndex = -1;
      State.tosserIndex = msg.tosserIndex;
      State.flickerIndex = msg.nextFlickerIndex;
      State.consecutiveFlicks = 0;
      State.phase = "EVALUATING";
      // Server handles the 1800ms delay and sends request_toss
    }
  });

  // --- Player State Update ---

  net.on("player_state_update", (msg) => {
    State.myPlayerIndex = msg.yourIndex;
    if (msg.players) {
      for (const pData of msg.players) {
        const localPlayer = State.players[pData.index];
        if (!localPlayer) continue;

        localPlayer.name = pData.name;
        localPlayer.failures = pData.failures;
        localPlayer.streak = pData.streak;

        if (pData.impairments !== undefined) {
          // Full data for self
          localPlayer.impairments = pData.impairments;
          localPlayer.onFireBuffs = pData.onFireBuffs;
          // Clear count fields if present
          delete localPlayer.impairmentCount;
          delete localPlayer.buffCount;
        } else {
          // Counts only for other players
          localPlayer.impairmentCount = pData.impairmentCount;
          localPlayer.buffCount = pData.buffCount;
          // Keep impairments/onFireBuffs as empty arrays so flicker helpers work
          // (they won't match since we don't know the IDs)
          localPlayer.impairments = [];
          localPlayer.onFireBuffs = [];
        }

        if (pData.connected !== undefined) {
          localPlayer.connected = pData.connected;
        }
      }
    }
  });

  // --- Player Disconnected / Reconnected ---

  net.on("player_disconnected", (msg) => {
    setMessage(`${msg.playerName} disconnected`);
    if (State.players[msg.playerIndex]) {
      State.players[msg.playerIndex].connected = false;
    }
  });

  net.on("player_reconnected", (msg) => {
    setMessage(`${msg.playerName} reconnected`);
    if (State.players[msg.playerIndex]) {
      State.players[msg.playerIndex].connected = true;
    }
  });

  // --- Turn Skipped ---

  net.on("turn_skipped", (msg) => {
    setMessage(`${msg.playerName}'s turn was skipped (disconnected)`);
  });

  // --- Game Ended ---

  net.on("game_ended", (msg) => {
    State.phase = "GAME_OVER";
    endGameBtn.classList.remove("visible");

    const scoreboard = document.getElementById("endScoreboard");
    if (msg.scores) {
      const sorted = [...msg.scores].sort((a, b) => a.failures - b.failures);
      const minFails = sorted[0].failures;

      scoreboard.innerHTML = sorted
        .map((p) => {
          const isWinner = p.failures === minFails;
          return `<div class="${isWinner ? "winner" : ""}">${p.name}: ${p.failures} failure${p.failures !== 1 ? "s" : ""}${isWinner ? " ★" : ""}</div>`;
        })
        .join("");
    }

    endOverlay.classList.add("visible");
    removeChips();
  });

  // --- Error ---

  net.on("error", (msg) => {
    if (onlineError) {
      onlineError.textContent = msg.message || "An error occurred.";
    }
  });

  // --- Reconnect State ---

  net.on("reconnect_state", (msg) => {
    // If a game is in progress, restore state
    if (msg.roomState === "PLAYING") {
      // Apply config
      const config = msg.config || {};
      if (config.frictionTable !== undefined) CONFIG.FRICTION_TABLE = config.frictionTable;
      if (config.frictionChipTop !== undefined) CONFIG.FRICTION_CHIP_TOP = config.frictionChipTop;
      if (config.frictionChipBottom !== undefined) CONFIG.FRICTION_CHIP_BOTTOM = config.frictionChipBottom;
      if (config.dampingScale !== undefined) CONFIG.DAMPING_SCALE = config.dampingScale;
      if (config.chipRestitution !== undefined) CONFIG.CHIP_RESTITUTION = config.chipRestitution;

      State.isOnline = true;
      State.myPlayerIndex = msg.playerIndex;
      State.tosserIndex = msg.tosserIndex;
      State.flickerIndex = msg.flickerIndex;
      State.consecutiveFlicks = msg.consecutiveFlicks || 0;

      // Recreate world
      State.chips = [];
      wallBodies = [];
      wallColliders = [];
      gateSensorBody = null;
      gateSensorCollider = null;
      createWorld();
      createWalls();

      // Recreate chips at their positions
      if (msg.chipPositions) {
        for (const cp of msg.chipPositions) {
          const chip = createChipBody(cp.x, cp.y, cp.topUp);
          chip.body.setTranslation({ x: cp.x, y: cp.y }, true);
          chip.body.setLinvel({ x: 0, y: 0 }, true);
          State.chips.push(chip);
        }
      }

      // Apply chip states
      if (msg.chipStates) {
        for (let i = 0; i < State.chips.length && i < msg.chipStates.length; i++) {
          State.chips[i].flicked = msg.chipStates[i].flicked;
          State.chips[i].eligible = msg.chipStates[i].eligible;
        }
      }

      setupOverlay.style.display = "none";
      endOverlay.classList.remove("visible");
      endGameBtn.classList.add("visible");

      // Set phase based on server phase
      const phaseMap = {
        SELECTING_CHIP: "SELECTING_CHIP",
        FLICK_ANGLE: "FLICK_ANGLE",
        FLICK_POWER: "FLICK_POWER",
        FLICK_ANIMATING: "FLICK_ANIMATING",
        EVALUATING: "EVALUATING",
        TOSSING: "TOSSING",
        TOSS_ANIMATING: "TOSS_ANIMATING",
      };
      State.phase = phaseMap[msg.phase] || "SELECTING_CHIP";
      setMessage("Reconnected!");
    } else {
      // Back in lobby
      showView("waitingRoom");
      roomCodeBig.textContent = msg.code;
      lobbyStartBtn.style.display = net.getIsHost() ? "" : "none";
    }
  });
}

// ============================================================================
// INIT
// ============================================================================

function init() {
  createWorld();
  createWalls();
  lastTime = performance.now();
  setupNetworkHandlers();
  net.connect();
  requestAnimationFrame(tick);
}

init();
