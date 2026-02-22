// ============================================================================
// 40 CAPS — Client-side Networking Module
// ES module: import * as net from './net.js';
// ============================================================================

import { CONFIG } from './config.js';

const NET = {
  ws: null,
  clientId: null,
  roomCode: null,
  playerIndex: -1,
  isHost: false,
  connected: false,
  handlers: {},
  physicsFrameInterval: null,
};

// ============================================================================
// EVENT SYSTEM
// ============================================================================

function emit(event, data) {
  (NET.handlers[event] || []).forEach((cb) => cb(data));
}

export function on(event, callback) {
  if (!NET.handlers[event]) NET.handlers[event] = [];
  NET.handlers[event].push(callback);
}

export function off(event, callback) {
  NET.handlers[event] = (NET.handlers[event] || []).filter(
    (cb) => cb !== callback,
  );
}

function onOnce(event, callback) {
  const wrapper = (data) => {
    off(event, wrapper);
    callback(data);
  };
  on(event, wrapper);
}

// ============================================================================
// CONNECTION
// ============================================================================

function sendToServer(data) {
  if (NET.ws && NET.ws.readyState === WebSocket.OPEN) {
    NET.ws.send(JSON.stringify(data));
  }
}

export function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => {
    NET.ws = ws;
    NET.connected = true;
    emit("connected");
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (e) {
      console.warn("[net] Failed to parse server message:", e.message);
      return;
    }
    handleServerMessage(msg);
  };

  ws.onclose = () => {
    NET.connected = false;
    NET.ws = null;
    emit("disconnected");

    // Auto-reconnect after 2 seconds
    setTimeout(() => {
      if (!NET.connected) {
        const oldId = NET.clientId;
        const oldCode = NET.roomCode;
        connect();
        // After reconnect, try to rejoin room
        if (oldCode && oldId) {
          onOnce("welcome_received", () => {
            sendToServer({
              type: "reconnect_room",
              code: oldCode,
              oldClientId: oldId,
            });
          });
        }
      }
    }, CONFIG.NET_RECONNECT_DELAY);
  };

  ws.onerror = () => {
    // Will trigger onclose
  };
}

// ============================================================================
// SERVER MESSAGE HANDLER
// ============================================================================

function handleServerMessage(msg) {
  switch (msg.type) {
    case "welcome":
      NET.clientId = msg.clientId;
      try {
        sessionStorage.setItem("40caps_clientId", msg.clientId);
      } catch {}
      emit("welcome_received", msg);
      break;

    case "room_created":
      NET.roomCode = msg.code;
      NET.playerIndex = msg.playerIndex;
      NET.isHost = true;
      try {
        sessionStorage.setItem("40caps_roomCode", msg.code);
      } catch {}
      emit("room_created", msg);
      break;

    case "room_joined":
      NET.roomCode = msg.code;
      NET.playerIndex = msg.playerIndex;
      NET.isHost = false;
      try {
        sessionStorage.setItem("40caps_roomCode", msg.code);
      } catch {}
      emit("room_joined", msg);
      break;

    case "lobby_update":
      emit("lobby_update", msg);
      break;

    case "game_started":
      emit("game_started", msg);
      break;

    case "request_toss":
      emit("request_toss", msg);
      break;

    case "toss_broadcast":
      emit("toss_broadcast", msg);
      break;

    case "chip_selected_broadcast":
      emit("chip_selected_broadcast", msg);
      break;

    case "angle_locked_broadcast":
      emit("angle_locked_broadcast", msg);
      break;

    case "execute_flick_broadcast":
      emit("execute_flick_broadcast", msg);
      break;

    case "physics_frame_broadcast":
      emit("physics_frame_broadcast", msg);
      break;

    case "flick_result_broadcast":
      emit("flick_result_broadcast", msg);
      break;

    case "player_state_update":
      NET.playerIndex = msg.yourIndex;
      emit("player_state_update", msg);
      break;

    case "player_disconnected":
      emit("player_disconnected", msg);
      break;

    case "player_reconnected":
      emit("player_reconnected", msg);
      break;

    case "reconnect_state":
      NET.roomCode = msg.code;
      NET.playerIndex = msg.playerIndex;
      emit("reconnect_state", msg);
      break;

    case "turn_skipped":
      emit("turn_skipped", msg);
      break;

    case "error":
      emit("error", msg);
      break;

    case "game_ended":
      emit("game_ended", msg);
      break;
  }
}

// ============================================================================
// PUBLIC API — actions sent to server
// ============================================================================

export function createRoom(playerName, config) {
  sendToServer({ type: "create_room", playerName, config });
}

export function joinRoom(code, playerName) {
  sendToServer({ type: "join_room", code, playerName });
}

export function leaveRoom() {
  sendToServer({ type: "leave_room" });
  NET.roomCode = null;
  NET.isHost = false;
  NET.playerIndex = -1;
}

export function startGame() {
  sendToServer({ type: "start_game" });
}

export function sendTossResult(positions) {
  sendToServer({ type: "toss_result", positions });
}

export function sendChipSelected(chipIndex) {
  sendToServer({ type: "chip_selected", chipIndex });
}

export function sendAngleLocked(angle, centerAngle) {
  sendToServer({ type: "angle_locked", angle, centerAngle });
}

export function sendPowerLocked(chipIndex, angle, power) {
  sendToServer({ type: "power_locked", chipIndex, angle, power });
}

export function sendFlickResult(success, reason, chipIndex, finalPositions) {
  sendToServer({
    type: "flick_result",
    success,
    reason,
    chipIndex,
    finalPositions,
  });
}

export function sendEndGame() {
  sendToServer({ type: "end_game" });
}

// ============================================================================
// PHYSICS FRAME STREAMING
// ============================================================================

export function startPhysicsStreaming(getChipPositions) {
  stopPhysicsStreaming();
  NET.physicsFrameInterval = setInterval(() => {
    const chips = getChipPositions();
    if (chips) sendToServer({ type: "physics_frame", chips });
  }, CONFIG.PHYSICS_STREAM_INTERVAL);
}

export function stopPhysicsStreaming() {
  if (NET.physicsFrameInterval) {
    clearInterval(NET.physicsFrameInterval);
    NET.physicsFrameInterval = null;
  }
}

// ============================================================================
// QUERY HELPERS
// ============================================================================

export function isMyTurn(activePlayerIndex) {
  return NET.playerIndex === activePlayerIndex;
}

export function getMyIndex() {
  return NET.playerIndex;
}

export function getIsHost() {
  return NET.isHost;
}

export function isConnected() {
  return NET.connected;
}

export function getRoomCode() {
  return NET.roomCode;
}
