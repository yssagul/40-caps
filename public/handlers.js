// ============================================================================
// 40 CAPS — Network Event Handlers
// ============================================================================
// Registers all net.on() callbacks for online play.
// Called once from init() in game.js.
// ============================================================================

import { CONFIG, IMPAIRMENTS, BUFFS } from './config.js';
import { State, setMessage, currentActivePlayerName, startAngleSelection, executeFlick, performToss, applyChipStates, getImpairmentById, getBuffById } from './state.js';
import * as net from './net.js';
import * as physics from './physics.js';

// ui:      { roomCodeBig, lobbyPlayerList, lobbyStartBtn, leaveRoomBtn,
//            closeRoomBtn, onlineError, setupOverlay, endOverlay, endGameBtn }
// helpers: { showView, applyConfig, renderScoreboard, startGameOnline }
export function setupNetworkHandlers(ui, helpers) {
  const { roomCodeBig, lobbyPlayerList, lobbyStartBtn, leaveRoomBtn,
          closeRoomBtn, onlineError, setupOverlay, endOverlay, endGameBtn } = ui;
  const { showView, applyConfig, renderScoreboard, startGameOnline } = helpers;

  function buildStreakMessage(activePlayerName, streakEvents) {
    if (!streakEvents) return "";
    let msg = "";
    for (const evt of streakEvents) {
      if (evt.type === "buff") {
        const buff = getBuffById(evt.buffId);
        msg += ` ${activePlayerName} is On Fire! Buff: ${buff ? buff.name : evt.buffId}`;
      } else if (evt.type === "cure") {
        const imp = getImpairmentById(evt.impairmentId);
        msg += ` ${activePlayerName} cured: ${imp ? imp.name : evt.impairmentId}!`;
      }
    }
    return msg;
  }

  function setLobbyButtons(isHost) {
    lobbyStartBtn.style.display = isHost ? "" : "none";
    closeRoomBtn.style.display = isHost ? "" : "none";
    leaveRoomBtn.style.display = isHost ? "none" : "";
  }

  // --- Lobby events ---

  net.on("room_created", (msg) => {
    showView("waitingRoom");
    roomCodeBig.textContent = msg.code;
    setLobbyButtons(true);
  });

  net.on("room_joined", (msg) => {
    showView("waitingRoom");
    roomCodeBig.textContent = msg.code;
    setLobbyButtons(false);
  });

  net.on("lobby_update", (msg) => {
    // Update player list display
    if (lobbyPlayerList) {
      lobbyPlayerList.innerHTML = msg.players
        .map(
          (p) =>
            `<div class="lobby-player${p.isHost ? " host" : ""}${!p.connected ? " disconnected" : ""}">${p.name}${!p.connected ? " (disconnected)" : ""}</div>`,
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
    startGameOnline(msg.players, msg.config, msg.activePlayerIndex);
  });

  // --- Toss ---

  net.on("request_toss", (msg) => {
    State.activePlayerIndex = msg.activePlayerIndex;
    State.phase = "TOSSING";

    // If I am the active player, generate toss positions and send
    if (net.isMyTurn(State.activePlayerIndex)) {
      performToss();
    }
    // Otherwise, wait for toss_broadcast
  });

  net.on("toss_broadcast", (msg) => {
    if (!Array.isArray(msg.positions) || msg.positions.length === 0) {
      console.warn("[handler] toss_broadcast: missing or empty positions");
      return;
    }

    // All clients create chips and animate scatter
    physics.removeChips(State.chips);
    State.chips = [];

    State.activePlayerIndex = msg.activePlayerIndex;

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
    setMessage(`${currentActivePlayerName()} tosses the chips!`);
  });

  // --- Chip Selected ---

  net.on("chip_selected_broadcast", (msg) => {
    if (typeof msg.chipIndex !== "number") return;
    State.selectedChipIndex = msg.chipIndex;
    startAngleSelection();
  });

  // --- Angle Locked ---

  net.on("angle_locked_broadcast", (msg) => {
    if (typeof msg.angle !== "number") return;
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
    if (typeof msg.chipIndex !== "number" || typeof msg.angle !== "number" || typeof msg.power !== "number") return;
    State.selectedChipIndex = msg.chipIndex;
    State.flickAngle = msg.angle;
    State.flickPower = msg.power;

    if (net.isMyTurn(State.activePlayerIndex)) {
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
    if (!Array.isArray(msg.chips)) return;
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
      State.chips[msg.chipIndex].collider.setCollisionGroups(CONFIG.COLLISION_GROUP_CHIPS);
    }

    physics.removeGateSensor();

    const activePlayerName = State.players[msg.activePlayerIndex]?.name || "Player";

    if (msg.success) {
      applyChipStates(msg.chipStates);
      State.selectedChipIndex = -1;
      setMessage("Success!" + buildStreakMessage(activePlayerName, msg.streakEvents));
      State.activePlayerIndex = msg.nextActivePlayerIndex;
      State.phase = "SELECTING_CHIP";
    } else {
      let impMsg = "";
      if (msg.impairmentEvent) {
        const imp = getImpairmentById(msg.impairmentEvent.impairmentId);
        impMsg = ` Gains: ${imp ? imp.name : msg.impairmentEvent.impairmentId}!`;
      }
      setMessage(`${activePlayerName} fails! ${msg.reason || ""}${impMsg}`);
      State.selectedChipIndex = -1;
      State.activePlayerIndex = msg.nextActivePlayerIndex;
      State.phase = "EVALUATING";
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

        // All players receive full impairment/buff data (visible to everyone)
        // Effects only apply to the owning player's UI/turn
        localPlayer.impairments = pData.impairments || [];
        localPlayer.onFireBuffs = pData.onFireBuffs || [];

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
      State.activePlayerIndex = msg.activePlayerIndex;

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
      applyChipStates(msg.chipStates);

      setupOverlay.style.display = "none";
      endOverlay.classList.remove("visible");
      endGameBtn.classList.add("visible");

      State.phase = msg.phase || "SELECTING_CHIP";
      setMessage("Reconnected!");
    } else {
      // Back in lobby
      showView("waitingRoom");
      roomCodeBig.textContent = msg.code;
      setLobbyButtons(net.getIsHost());
    }
  });
}
