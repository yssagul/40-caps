// ============================================================================
// 40 CAPS — Multiplayer Server
// Node.js + Express (static) + WebSocket (ws)
// ============================================================================

const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const publicDir = path.join(__dirname, "public");
console.log("Serving static files from:", publicDir);

app.use(express.static(publicDir));

// Fallback: serve index.html for the root route
app.get("/", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`40 Caps server listening on port ${PORT}`));

// ============================================================================
// CONSTANTS (mirrored from client for server-side game logic)
// ============================================================================

// Timing
const FAILURE_TOSS_DELAY = 1800; // ms before new toss after failure
const DISCONNECT_ADVANCE_DELAY = 3000; // ms to auto-advance disconnected player
const HEARTBEAT_INTERVAL = 30000;
const ROOM_CLEANUP_INTERVAL = 60000;
const ROOM_CLEANUP_TIMEOUT = 300000; // 5 minutes

const IMPAIRMENT_IDS = [
  "wild_shooter",
  "daze",
  "double_vision",
  "blackout",
  "false_confidence",
];

const BUFF_IDS = [
  "skilled_shooter",
  "long_shot",
  "focus",
  "hand_of_god",
  "jump_shot",
];

// ============================================================================
// IN-MEMORY STORE
// ============================================================================

const rooms = new Map(); // roomCode -> Room

// ============================================================================
// HELPERS
// ============================================================================

function generateId() {
  return crypto.randomBytes(8).toString("hex");
}

function generateRoomCode() {
  let code;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
  } while (rooms.has(code));
  return code;
}

function send(ws, data) {
  if (ws && ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(data));
    } catch (e) {
      console.warn("[send] Failed to send to client:", e.message);
    }
  }
}

function broadcastToRoom(room, data) {
  for (const p of room.players) {
    if (p.connected) send(p.ws, data);
  }
}

function broadcastToRoomExcept(room, exceptId, data) {
  for (const p of room.players) {
    if (p.connected && p.id !== exceptId) send(p.ws, data);
  }
}

function findRoomByClient(clientId) {
  for (const [, room] of rooms) {
    if (room.players.some((p) => p.id === clientId)) return room;
  }
  return null;
}

function broadcastLobby(room) {
  const playerList = room.players.map((p, i) => ({
    name: p.name,
    index: i,
    isHost: p.id === room.hostId,
    connected: p.connected,
  }));
  broadcastToRoom(room, {
    type: "lobby_update",
    code: room.code,
    players: playerList,
    hostId: room.hostId,
  });
}

// Send player state to all connected players (impairments/buffs visible to everyone)
function sendPrivatePlayerState(room) {
  const playerView = room.players.map((p, idx) => ({
    index: idx,
    name: p.name,
    failures: p.failures,
    streak: p.streak,
    impairments: [...p.impairments],
    onFireBuffs: [...p.onFireBuffs],
    connected: p.connected,
  }));

  for (const player of room.players) {
    if (!player.connected) continue;
    send(player.ws, {
      type: "player_state_update",
      players: playerView,
      yourIndex: room.players.indexOf(player),
    });
  }
}

/**
 * Validate that the room is in an expected game phase and the sender is the active player.
 * @param {string} clientId - the sender
 * @param {string} expectedPhase - the phase the room must be in
 * @returns {{ room, player }} or null if validation fails
 */
function validatePhase(clientId, expectedPhase) {
  const room = findRoomByClient(clientId);
  if (!room || room.state !== "PLAYING") return null;
  if (room.phase !== expectedPhase) return null;

  if (room.players[room.activePlayerIndex]?.id !== clientId) return null;

  return { room, player: room.players[room.activePlayerIndex] };
}

// ============================================================================
// WEBSOCKET CONNECTION HANDLING
// ============================================================================

wss.on("connection", (ws) => {
  const clientId = generateId();
  ws.clientId = clientId;
  ws.isAlive = true;
  ws.roomCode = null;

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      console.warn(`[ws] Malformed message from ${clientId}:`, e.message);
      return;
    }
    handleMessage(ws, clientId, msg);
  });

  ws.on("close", () => {
    handleDisconnect(ws, clientId);
  });

  send(ws, { type: "welcome", clientId });
});

// Heartbeat: ping every 30s, terminate unresponsive connections
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

// Room cleanup: remove rooms with all players disconnected for 5+ minutes
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.players.every((p) => !p.connected)) {
      if (!room.cleanupStart) room.cleanupStart = now;
      if (now - room.cleanupStart > ROOM_CLEANUP_TIMEOUT) {
        rooms.delete(code);
        console.log(`Room ${code} cleaned up (all disconnected)`);
      }
    } else {
      room.cleanupStart = null;
    }
  }
}, ROOM_CLEANUP_INTERVAL);

// ============================================================================
// MESSAGE ROUTER
// ============================================================================

function handleMessage(ws, clientId, msg) {
  try {
  switch (msg.type) {
    case "create_room":
      handleCreateRoom(ws, clientId, msg);
      break;
    case "join_room":
      handleJoinRoom(ws, clientId, msg);
      break;
    case "leave_room":
      handleLeaveRoom(ws, clientId);
      break;
    case "reconnect_room":
      handleReconnect(ws, clientId, msg);
      break;
    case "start_game":
      handleStartGame(ws, clientId);
      break;
    case "toss_result":
      handleTossResult(ws, clientId, msg);
      break;
    case "chip_selected":
      handleChipSelected(ws, clientId, msg);
      break;
    case "angle_locked":
      handleAngleLocked(ws, clientId, msg);
      break;
    case "power_locked":
      handlePowerLocked(ws, clientId, msg);
      break;
    case "physics_frame":
      handlePhysicsFrame(ws, clientId, msg);
      break;
    case "flick_result":
      handleFlickResult(ws, clientId, msg);
      break;
    case "end_game":
      handleEndGame(ws, clientId);
      break;
    case "chat_message":
      handleChatMessage(ws, clientId, msg);
      break;
  }
  } catch (e) {
    console.error(`[handleMessage] Error processing "${msg?.type}" from ${clientId}:`, e.message);
  }
}

// ============================================================================
// ROOM MANAGEMENT
// ============================================================================

function handleCreateRoom(ws, clientId, msg) {
  // Leave any existing room first
  const existingRoom = findRoomByClient(clientId);
  if (existingRoom) leaveRoom(existingRoom, clientId);

  const code = generateRoomCode();
  const room = {
    code,
    hostId: clientId,
    config: msg.config || {},
    players: [
      {
        id: clientId,
        name: msg.playerName || "Host",
        ws,
        failures: 0,
        impairments: [],
        onFireBuffs: [],
        streak: 0,
        connected: true,
      },
    ],
    state: "LOBBY",
    activePlayerIndex: 0,
    phase: "LOBBY",
    chipPositions: [],
    chipStates: [],
    cleanupStart: null,
  };
  rooms.set(code, room);
  ws.roomCode = code;

  console.log(`Room ${code} created by ${msg.playerName || "Host"}`);

  send(ws, { type: "room_created", code, playerId: clientId, playerIndex: 0 });
  broadcastLobby(room);
}

function handleJoinRoom(ws, clientId, msg) {
  const code = (msg.code || "").trim();
  const room = rooms.get(code);

  if (!room) return send(ws, { type: "error", message: "Room not found" });
  if (room.state !== "LOBBY")
    return send(ws, { type: "error", message: "Game already in progress" });
  if (room.players.length >= 8)
    return send(ws, { type: "error", message: "Room is full" });

  // Leave any existing room first
  const existingRoom = findRoomByClient(clientId);
  if (existingRoom) leaveRoom(existingRoom, clientId);

  const playerIndex = room.players.length;
  room.players.push({
    id: clientId,
    name: msg.playerName || `Player ${playerIndex + 1}`,
    ws,
    failures: 0,
    impairments: [],
    onFireBuffs: [],
    streak: 0,
    connected: true,
  });
  ws.roomCode = code;

  console.log(
    `${msg.playerName || "Player"} joined room ${code} (${room.players.length} players)`,
  );

  send(ws, {
    type: "room_joined",
    code,
    playerId: clientId,
    playerIndex,
    config: room.config,
  });
  broadcastLobby(room);
}

function handleLeaveRoom(ws, clientId) {
  const room = findRoomByClient(clientId);
  if (room) leaveRoom(room, clientId);
}

function leaveRoom(room, clientId) {
  const playerIndex = room.players.findIndex((p) => p.id === clientId);
  if (playerIndex === -1) return;

  room.players.splice(playerIndex, 1);

  if (room.players.length === 0) {
    rooms.delete(room.code);
    console.log(`Room ${room.code} deleted (empty)`);
    return;
  }

  // Transfer host if needed
  if (room.hostId === clientId) {
    room.hostId = room.players[0].id;
  }

  broadcastLobby(room);
}

function handleReconnect(ws, newClientId, msg) {
  const room = rooms.get(msg.code);
  if (!room)
    return send(ws, { type: "error", message: "Room no longer exists" });

  const playerIndex = room.players.findIndex((p) => p.id === msg.oldClientId);
  if (playerIndex === -1)
    return send(ws, { type: "error", message: "Player not found in room" });

  // Reassign connection
  room.players[playerIndex].id = newClientId;
  room.players[playerIndex].ws = ws;
  room.players[playerIndex].connected = true;
  ws.roomCode = room.code;

  if (room.hostId === msg.oldClientId) {
    room.hostId = newClientId;
  }

  console.log(
    `${room.players[playerIndex].name} reconnected to room ${room.code}`,
  );

  send(ws, {
    type: "reconnect_state",
    code: room.code,
    playerIndex,
    playerId: newClientId,
    config: room.config,
    roomState: room.state,
    phase: room.phase,
    activePlayerIndex: room.activePlayerIndex,
    chipPositions: room.chipPositions,
    chipStates: room.chipStates,
  });

  sendPrivatePlayerState(room);

  broadcastToRoom(room, {
    type: "player_reconnected",
    playerIndex,
    playerName: room.players[playerIndex].name,
  });
}

// ============================================================================
// GAME START
// ============================================================================

function handleStartGame(ws, clientId) {
  const room = findRoomByClient(clientId);
  if (!room || room.hostId !== clientId) return;
  if (room.players.length < 2)
    return send(ws, { type: "error", message: "Need at least 2 players" });

  room.state = "PLAYING";
  room.activePlayerIndex = 0;
  room.phase = "TOSSING";

  // Reset all player stats
  for (const p of room.players) {
    p.failures = 0;
    p.impairments = [];
    p.onFireBuffs = [];
    p.streak = 0;
  }

  console.log(`Game started in room ${room.code} with ${room.players.length} players`);

  broadcastToRoom(room, {
    type: "game_started",
    players: room.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      index: i,
    })),
    config: room.config,
    activePlayerIndex: room.activePlayerIndex,
  });

  // Tell the active player to generate the toss
  broadcastToRoom(room, {
    type: "request_toss",
    activePlayerIndex: room.activePlayerIndex,
  });
}

// ============================================================================
// TOSS
// ============================================================================

function handleTossResult(ws, clientId, msg) {
  const result = validatePhase(clientId, "TOSSING");
  if (!result) return;
  const { room } = result;
  if (!Array.isArray(msg.positions) || msg.positions.length === 0) return;

  room.chipPositions = msg.positions;
  room.chipStates = msg.positions.map(() => ({
    flicked: false,
    eligible: true,
  }));

  broadcastToRoom(room, {
    type: "toss_broadcast",
    positions: msg.positions,
    activePlayerIndex: room.activePlayerIndex,
  });

  // Advance to the next player who will flick
  room.activePlayerIndex =
    (room.activePlayerIndex + 1) % room.players.length;
  room.phase = "SELECTING_CHIP";
}

// ============================================================================
// FLICK PHASES
// ============================================================================

function handleChipSelected(ws, clientId, msg) {
  const result = validatePhase(clientId, "SELECTING_CHIP");
  if (!result) return;
  const { room } = result;
  if (typeof msg.chipIndex !== "number") return;

  room.phase = "FLICK_ANGLE";

  broadcastToRoom(room, {
    type: "chip_selected_broadcast",
    chipIndex: msg.chipIndex,
    activePlayerIndex: room.activePlayerIndex,
  });
}

function handleAngleLocked(ws, clientId, msg) {
  const result = validatePhase(clientId, "FLICK_ANGLE");
  if (!result) return;
  const { room } = result;
  if (typeof msg.angle !== "number") return;

  room.phase = "FLICK_POWER";

  broadcastToRoom(room, {
    type: "angle_locked_broadcast",
    angle: msg.angle,
    centerAngle: msg.centerAngle,
  });
}

function handlePowerLocked(ws, clientId, msg) {
  const result = validatePhase(clientId, "FLICK_POWER");
  if (!result) return;
  const { room } = result;
  if (typeof msg.power !== "number" || typeof msg.angle !== "number") return;

  room.phase = "FLICK_ANIMATING";

  broadcastToRoom(room, {
    type: "execute_flick_broadcast",
    chipIndex: msg.chipIndex,
    angle: msg.angle,
    power: msg.power,
  });
}

function handlePhysicsFrame(ws, clientId, msg) {
  const result = validatePhase(clientId, "FLICK_ANIMATING");
  if (!result) return;
  const { room } = result;
  if (!Array.isArray(msg.chips)) return;

  // Relay to all except sender
  broadcastToRoomExcept(room, clientId, {
    type: "physics_frame_broadcast",
    chips: msg.chips,
  });
}

// ============================================================================
// FLICK RESULT (core game logic on server)
// ============================================================================

function handleFlickResult(ws, clientId, msg) {
  const result = validatePhase(clientId, "FLICK_ANIMATING");
  if (!result) return;
  const { room, player: activePlayer } = result;
  if (typeof msg.success !== "boolean") return;
  const prevActivePlayerIndex = room.activePlayerIndex;

  // Store final chip positions
  if (msg.finalPositions) {
    room.chipPositions = msg.finalPositions;
  }

  if (msg.success) {
    // --- SUCCESS ---

    // Snapshot buffs that were active FOR this flick (to consume after)
    const buffsUsedThisFlick = [...activePlayer.onFireBuffs];

    // Consume the buffs that were active for this flick
    activePlayer.onFireBuffs = [];

    activePlayer.streak++;

    // The flicked chip is ineligible for the next turn only;
    // all other chips become eligible again
    for (let i = 0; i < room.chipStates.length; i++) {
      if (i === msg.chipIndex) {
        room.chipStates[i].flicked = true;
        room.chipStates[i].eligible = false;
      } else {
        room.chipStates[i].flicked = false;
        room.chipStates[i].eligible = true;
      }
    }

    const streakEvents = [];

    // Every 3 successes: earn an On Fire buff
    if (activePlayer.streak % 3 === 0) {
      const remaining = BUFF_IDS.filter(
        (b) => !activePlayer.onFireBuffs.includes(b),
      );
      if (remaining.length > 0) {
        const buff = remaining[Math.floor(Math.random() * remaining.length)];
        activePlayer.onFireBuffs.push(buff);
        streakEvents.push({ type: "buff", buffId: buff });
      }
    }

    // Every 5 successes: cure one impairment
    if (activePlayer.streak % 5 === 0 && activePlayer.impairments.length > 0) {
      const idx = Math.floor(Math.random() * activePlayer.impairments.length);
      const cured = activePlayer.impairments.splice(idx, 1)[0];
      streakEvents.push({ type: "cure", impairmentId: cured });
    }

    // Advance active player
    room.activePlayerIndex =
      (room.activePlayerIndex + 1) % room.players.length;
    room.phase = "SELECTING_CHIP";

    broadcastToRoom(room, {
      type: "flick_result_broadcast",
      success: true,
      chipIndex: msg.chipIndex,
      finalPositions: msg.finalPositions,
      activePlayerIndex: prevActivePlayerIndex,
      nextActivePlayerIndex: room.activePlayerIndex,
      chipStates: room.chipStates,
      streakEvents,
      consumedBuffs: buffsUsedThisFlick,
    });

    sendPrivatePlayerState(room);
  } else {
    // --- FAILURE ---
    activePlayer.failures++;
    activePlayer.streak = 0;

    // Consume buffs
    activePlayer.onFireBuffs = [];

    let impairmentEvent = null;
    // Assign impairment every 5 failures
    if (activePlayer.failures % 5 === 0) {
      const remaining = IMPAIRMENT_IDS.filter(
        (i) => !activePlayer.impairments.includes(i),
      );
      if (remaining.length > 0) {
        const imp =
          remaining[Math.floor(Math.random() * remaining.length)];
        activePlayer.impairments.push(imp);
        impairmentEvent = { impairmentId: imp };
      }
    }

    // Active player stays on the failed player — they toss next.
    // The advance to the next flicker happens after the toss completes.
    room.phase = "EVALUATING";

    broadcastToRoom(room, {
      type: "flick_result_broadcast",
      success: false,
      reason: msg.reason,
      chipIndex: msg.chipIndex,
      finalPositions: msg.finalPositions,
      activePlayerIndex: prevActivePlayerIndex,
      nextActivePlayerIndex: room.activePlayerIndex,
      impairmentEvent,
    });

    sendPrivatePlayerState(room);

    // After 1800ms delay, request new toss
    const roomCode = room.code;
    setTimeout(() => {
      if (!rooms.has(roomCode)) return;
      if (room.state !== "PLAYING" || room.phase !== "EVALUATING") return;
      room.phase = "TOSSING";
      broadcastToRoom(room, {
        type: "request_toss",
        activePlayerIndex: room.activePlayerIndex,
      });
    }, FAILURE_TOSS_DELAY);
  }
}

// ============================================================================
// END GAME
// ============================================================================

function handleEndGame(ws, clientId) {
  const room = findRoomByClient(clientId);
  if (!room) return;
  // Only host can end the game
  if (room.hostId !== clientId) return;

  room.state = "GAME_OVER";
  room.phase = "GAME_OVER";

  const scores = room.players.map((p, i) => ({
    index: i,
    name: p.name,
    failures: p.failures,
  }));

  broadcastToRoom(room, { type: "game_ended", scores });

  console.log(`Game ended in room ${room.code}`);

  // Return to lobby state so "Play Again" can work
  room.state = "LOBBY";
  room.phase = "LOBBY";
}

// ============================================================================
// CHAT
// ============================================================================

function handleChatMessage(ws, clientId, msg) {
  const room = findRoomByClient(clientId);
  if (!room) return;

  const playerIndex = room.players.findIndex((p) => p.id === clientId);
  if (playerIndex === -1) return;

  const text = typeof msg.text === "string" ? msg.text.trim().slice(0, 500) : "";
  if (!text) return;

  broadcastToRoom(room, {
    type: "chat_broadcast",
    playerIndex,
    playerName: room.players[playerIndex].name,
    text,
  });
}

// ============================================================================
// DISCONNECTION HANDLING
// ============================================================================

function handleDisconnect(ws, clientId) {
  const room = findRoomByClient(clientId);
  if (!room) return;

  const playerIndex = room.players.findIndex((p) => p.id === clientId);
  if (playerIndex === -1) return;

  room.players[playerIndex].connected = false;
  room.players[playerIndex].ws = null;

  console.log(
    `${room.players[playerIndex].name} disconnected from room ${room.code}`,
  );

  if (room.state === "LOBBY") {
    // Remove from lobby entirely
    room.players.splice(playerIndex, 1);
    if (room.players.length === 0) {
      rooms.delete(room.code);
      console.log(`Room ${room.code} deleted (empty)`);
      return;
    }
    if (room.hostId === clientId) {
      room.hostId = room.players[0].id;
    }
    broadcastLobby(room);
  } else {
    // During gameplay: notify others
    broadcastToRoom(room, {
      type: "player_disconnected",
      playerIndex,
      playerName: room.players[playerIndex].name,
    });

    // If disconnected player was the active player, auto-advance after 3s
    const isActivePlayer =
      room.activePlayerIndex === playerIndex &&
      [
        "TOSSING",
        "TOSS_ANIMATING",
        "SELECTING_CHIP",
        "FLICK_ANGLE",
        "FLICK_POWER",
        "FLICK_ANIMATING",
      ].includes(room.phase);

    if (isActivePlayer) {
      const roomCode = room.code;
      setTimeout(() => {
        if (!rooms.has(roomCode)) return;
        if (!room.players[playerIndex]?.connected) {
          autoAdvanceTurn(room, playerIndex);
        }
      }, DISCONNECT_ADVANCE_DELAY);
    }
  }
}

function autoAdvanceTurn(room, disconnectedIndex) {
  if (room.state !== "PLAYING") return;

  // Find next connected player
  let next = (disconnectedIndex + 1) % room.players.length;
  let attempts = 0;
  while (!room.players[next].connected && attempts < room.players.length) {
    next = (next + 1) % room.players.length;
    attempts++;
  }

  if (attempts >= room.players.length) {
    // No connected players
    return;
  }

  // Treat as failure for the disconnected player
  room.players[disconnectedIndex].failures++;
  room.players[disconnectedIndex].streak = 0;

  room.activePlayerIndex = next;
  room.phase = "TOSSING";

  sendPrivatePlayerState(room);

  broadcastToRoom(room, {
    type: "turn_skipped",
    skippedIndex: disconnectedIndex,
    playerName: room.players[disconnectedIndex].name,
  });

  broadcastToRoom(room, {
    type: "request_toss",
    activePlayerIndex: room.activePlayerIndex,
  });
}
