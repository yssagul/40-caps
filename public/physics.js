// ============================================================================
// 40 CAPS — Physics (Rapier 2D)
// ============================================================================

import RAPIER from "https://esm.sh/@dimforge/rapier2d-compat";
import { CONFIG } from './config.js';

await RAPIER.init();

// ============================================================================
// MODULE STATE
// ============================================================================

let world = null;
let eventQueue = null;
let wallBodies = [];
let wallColliders = [];
let gateSensorCollider = null;
let gateSensorBody = null;

// ============================================================================
// WORLD & WALLS
// ============================================================================

export function createWorld() {
  const gravity = { x: 0.0, y: 0.0 };
  world = new RAPIER.World(gravity);
  eventQueue = new RAPIER.EventQueue(true);
}

export function createWalls() {
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

// ============================================================================
// CHIP BODIES
// ============================================================================

export function createChipBody(x, y, topUp) {
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

export function removeChips(chips) {
  for (const chip of chips) {
    world.removeRigidBody(chip.body);
  }
  removeGateSensor();
}

// ============================================================================
// GATE SENSOR
// ============================================================================

export function removeGateSensor() {
  if (gateSensorBody) {
    world.removeRigidBody(gateSensorBody);
    gateSensorBody = null;
    gateSensorCollider = null;
  }
}

export function createGateSensor(chipA, chipB) {
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

/**
 * Check if the flicked chip's path crossed the gate line this frame.
 * @param {object} State - game state (reads/writes chips, selectedChipIndex, previousPositions, passedThroughGate)
 * @param {function} getGateChips - returns the 2 non-selected chips
 */
export function checkGateCrossing(State, getGateChips) {
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

/**
 * Drain Rapier collision events and set State flags for gate-chip and wall contacts.
 * @param {object} State - game state (reads chips, selectedChipIndex; writes touchedGateChip, hitWall)
 * @param {function} getGateChips - returns the 2 non-selected chips
 */
export function processCollisionEvents(State, getGateChips) {
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

/**
 * Check if all chips have settled below the velocity threshold.
 * @param {object} State - game state (reads flickStartTime, chips)
 */
export function allChipsStopped(State) {
  // Don't evaluate too early — wait at least 200ms for the impulse to take effect
  if (performance.now() - State.flickStartTime < 200) return false;

  for (const chip of State.chips) {
    const vel = chip.body.linvel();
    const speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y);
    if (speed > CONFIG.VELOCITY_THRESHOLD) return false;
  }
  return true;
}

// ============================================================================
// PHYSICS STEP
// ============================================================================

export function stepWorld() {
  if (world && eventQueue) {
    world.step(eventQueue);
  }
}
