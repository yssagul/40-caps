// ============================================================================
// 40 CAPS — Network Event Handlers
// ============================================================================
// Registers all net.on() callbacks for online play.
// Called once from init() in game.js.
// ============================================================================

import { CONFIG, IMPAIRMENTS, BUFFS } from './config.js';
import { State, setMessage, currentTosserName, startAngleSelection, executeFlick, performToss } from './state.js';
import * as net from './net.js';
import * as physics from './physics.js';

// ui:      { roomCodeBig, lobbyPlayerList, lobbyStartBtn, onlineError,
//            setupOverlay, endOverlay, endGameBtn }
// helpers: { showView, applyConfig, renderScoreboard, startGameOnline }
export function setupNetworkHandlers(ui, helpers) {
  const { roomCodeBig, lobbyPlayerList, lobbyStartBtn, onlineError,
          setupOverlay, endOverlay, endGameBtn } = ui;
  const { showView, applyConfig, renderScoreboard, startGameOnline } = helpers;

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
    physics.removeChips(State.chips);
    State.chips = [];

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
      const chip = physics.createChipBody(center, center, positions[i].topUp);
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

    physics.removeGateSensor();

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

    if (msg.scores) {
      document.getElementById("endScoreboard").innerHTML = renderScoreboard(msg.scores);
    }

    endOverlay.classList.add("visible");
    physics.removeChips(State.chips);
    State.chips = [];
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
      applyConfig(msg.config || {});

      State.isOnline = true;
      State.myPlayerIndex = msg.playerIndex;
      State.tosserIndex = msg.tosserIndex;
      State.flickerIndex = msg.flickerIndex;
      State.consecutiveFlicks = msg.consecutiveFlicks || 0;

      // Recreate world
      State.chips = [];
      physics.createWorld();
      physics.createWalls();

      // Recreate chips at their positions
      if (msg.chipPositions) {
        for (const cp of msg.chipPositions) {
          const chip = physics.createChipBody(cp.x, cp.y, cp.topUp);
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

      State.phase = msg.phase || "SELECTING_CHIP";
      setMessage("Reconnected!");
    } else {
      // Back in lobby
      showView("waitingRoom");
      roomCodeBig.textContent = msg.code;
      lobbyStartBtn.style.display = net.getIsHost() ? "" : "none";
    }
  });
}
