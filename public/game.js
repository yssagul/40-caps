// ============================================================================
// 40 CAPS — A chip-flicking browser game
// ============================================================================

import { CONFIG, IMPAIRMENTS, BUFFS } from './config.js';
import * as physics from './physics.js';
import { State, getFlicker, flickerHas, flickerHasImpairment, flickerHasBuff, flickerImpairmentCount, assignRandomImpairment, assignRandomBuff, removeRandomImpairment, consumeBuffs, getEffectiveAngleRange, getEffectiveAngleSpeed, getEffectivePowerSpeed, updateDazeBlink, shouldDazeHide, setMessage, currentTosserName, currentFlickerName, generateTossPositions, rollOrientations, performToss, computeCenterAngle, getGateChips, startAngleSelection, lockAngle, lockPowerAndFlick, executeFlick, evaluateFlick, onFlickSuccess, onFlickFailure } from './state.js';
import * as net from './net.js';
import { setupNetworkHandlers } from './handlers.js';

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
      // Other players in online mode:
      // Impairments are private — show anonymous count badge
      const impCount = p.impairmentCount !== undefined ? p.impairmentCount : (p.impairments ? p.impairments.length : 0);
      if (impCount > 0) {
        bx += drawAnonymousBadge(bx, by, impCount, "#8b2020");
      }
      // Buffs are public — show actual badge with abbreviation
      for (const buffId of (p.onFireBuffs || [])) {
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

  // Badge tooltips (drawn last so they paint on top of everything)
  drawBadgeTooltip();
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
  physics.checkGateCrossing(State, getGateChips);
  physics.processCollisionEvents(State, getGateChips);

  if (physics.allChipsStopped(State)) {
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
      physics.stepWorld();
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
// HELPERS
// ============================================================================

function applyConfig(config) {
  if (config.frictionTable      !== undefined) CONFIG.FRICTION_TABLE       = config.frictionTable;
  if (config.frictionChipTop    !== undefined) CONFIG.FRICTION_CHIP_TOP    = config.frictionChipTop;
  if (config.frictionChipBottom !== undefined) CONFIG.FRICTION_CHIP_BOTTOM = config.frictionChipBottom;
  if (config.dampingScale       !== undefined) CONFIG.DAMPING_SCALE        = config.dampingScale;
  if (config.chipRestitution    !== undefined) CONFIG.CHIP_RESTITUTION     = config.chipRestitution;
}

function renderScoreboard(players) {
  const sorted = [...players].sort((a, b) => a.failures - b.failures);
  const minFails = sorted[0].failures;
  return sorted.map((p) => {
    const isWinner = p.failures === minFails;
    return `<div class="${isWinner ? "winner" : ""}">${p.name}: ${p.failures} failure${p.failures !== 1 ? "s" : ""}${isWinner ? " ★" : ""}</div>`;
  }).join("");
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
const closeRoomBtn = document.getElementById("closeRoomBtn");
const onlineError = document.getElementById("onlineError");

// ---- View Management ----

function showView(viewId) {
  // Hide all views — reset both class and inline display
  [modeSelect, localSetup, onlineMenu, waitingRoom].forEach(v => {
    if (v) {
      v.classList.remove("active");
      v.style.display = "none";
    }
  });

  // Show requested view
  const el = document.getElementById(viewId);
  if (el) {
    el.classList.add("active");
    el.style.display = "flex";
  }
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

// Wire up slider value displays
function wireSliders(ids) {
  for (const id of ids) {
    const slider = document.getElementById(id);
    const valSpan = document.getElementById(id + "Val");
    if (slider && valSpan) {
      slider.addEventListener("input", () => {
        valSpan.textContent = parseFloat(slider.value).toFixed(slider.step < 1 ? 2 : 1);
      });
    }
  }
}

wireSliders(["frictionTable", "frictionChipTop", "frictionChipBottom", "dampingScale", "chipRestitution"]);
wireSliders(["onFrictionTable", "onFrictionChipTop", "onFrictionChipBottom", "onDampingScale", "onChipRestitution"]);

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
  applyConfig({
    frictionTable:      parseFloat(document.getElementById("frictionTable").value),
    frictionChipTop:    parseFloat(document.getElementById("frictionChipTop").value),
    frictionChipBottom: parseFloat(document.getElementById("frictionChipBottom").value),
    dampingScale:       parseFloat(document.getElementById("dampingScale").value),
    chipRestitution:    parseFloat(document.getElementById("chipRestitution").value),
  });

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

closeRoomBtn.addEventListener("click", () => {
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
    const amHost = net.getIsHost();
    closeRoomBtn.style.display = amHost ? "" : "none";
    leaveRoomBtn.style.display = amHost ? "none" : "";
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

  document.getElementById("endScoreboard").innerHTML = renderScoreboard(State.players);

  endOverlay.classList.add("visible");

  // Clean up physics
  physics.removeChips(State.chips);
  State.chips = [];
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
  physics.createWorld();
  physics.createWalls();

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
  if (config) applyConfig(config);

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
  physics.createWorld();
  physics.createWalls();
}

// ============================================================================
// INIT
// ============================================================================

function init() {
  physics.createWorld();
  physics.createWalls();
  lastTime = performance.now();
  setupNetworkHandlers(
    { roomCodeBig, lobbyPlayerList, lobbyStartBtn, leaveRoomBtn,
      closeRoomBtn, onlineError, setupOverlay, endOverlay, endGameBtn },
    { showView, applyConfig, renderScoreboard, startGameOnline },
  );
  net.connect();
  requestAnimationFrame(tick);
}

init();
