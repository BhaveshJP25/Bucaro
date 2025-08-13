/*
Bucaro Online – Phase 2: Socket.IO Server
Author: ChatGPT for Bhavesh Parakh

What this provides
------------------
- A complete Node/TypeScript Socket.IO server that hosts multiple "rooms" of Bucaro games.
- Integrates the Phase 1 engine (see: Bucaro Game Engine – Phase 1) for rules & scoring.
- Reconnection-safe (players can rejoin with their playerId).
- Minimal REST to create a room; everything else over WebSocket.
- Emits per-player state (hides other hands) after every action.

Prereqs
-------
- Node 18+
- npm i express socket.io cors uuid
- Make sure the Phase 1 engine file is compiled/available. Update the import path below.

Build & Run
-----------
- tsc (or tsx/esbuild) then node dist/server.js
- or ts-node src/server.ts

Client Event Flow (high level)
------------------------------
- connect → joinRoom({ roomId, name, playerId? })
  -> server replies: joined({ roomId, playerId, seat, teamId, status }) + state snapshot
- when 4 players are present, any player can call startGame()
- on your turn call: drawClosed() or drawOpen()
- optionally: placeMelds(melds) and/or addToMeld(additions)
- then: discard(cardId)
- when ready to show: show({ melds })
- server broadcasts fresh getPlayerState() to each seated player after every action

*/

import express from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';

// IMPORTANT: adjust import path to your Phase 1 engine file
import { BucaroGame, type Card, type MeldPayload, type MeldAdditionPayload, type ShowPayload } from './engine/BucaroGame';

// ---------------- Types for network events ----------------

type RoomId = string;

type ClientToServerEvents = {
  joinRoom: (payload: { roomId: RoomId; name: string; playerId?: string }) => void;
  startGame: () => void;
  drawClosed: () => void;
  drawOpen: () => void;
  placeMelds: (payload: { melds: MeldPayload[] }) => void;
  addToMeld: (payload: { additions: MeldAdditionPayload[] }) => void;
  discard: (payload: { cardId: string }) => void;
  show: (payload: ShowPayload) => void;
  getState: () => void;
};

type ServerToClientEvents = {
  joined: (info: { roomId: RoomId; playerId: string; seat: number; teamId: number; status: string }) => void;
  state: (state: any) => void; // Player-specific view
  lobby: (info: LobbySummary) => void;
  errorMsg: (msg: string) => void;
  toast: (msg: string) => void;
};

type InterServerEvents = {};

type SocketData = {
  roomId?: RoomId;
  playerId?: string;
  seat?: number;
};

// ---------------- Room & Player tracking ----------------

interface SeatedPlayer {
  playerId: string;
  name: string;
  seat: number; // 0..3 by join order
  teamId: number; // 0 or 1 (opposites are partners)
  socketId?: string; // for connectivity tracking
}

interface Room {
  id: RoomId;
  game: BucaroGame;
  players: SeatedPlayer[]; // seat index === position
  status: 'LOBBY' | 'ACTIVE' | 'ENDED';
  createdAt: number;
}

interface LobbySummary {
  roomId: string;
  status: string;
  seats: Array<{ seat: number; name?: string; playerId?: string; connected: boolean }>;
}

const rooms = new Map<RoomId, Room>();

// ---------------- Helpers ----------------

function createRoom(): Room {
  const id = uuidv4().slice(0, 8).toUpperCase();
  const room: Room = {
    id,
    game: new BucaroGame(),
    players: [],
    status: 'LOBBY',
    createdAt: Date.now(),
  };
  rooms.set(id, room);
  return room;
}

function getRoomOrThrow(id: RoomId): Room {
  const r = rooms.get(id);
  if (!r) throw new Error('Room not found');
  return r;
}

function broadcastLobby(io: Server, room: Room) {
  const summary: LobbySummary = {
    roomId: room.id,
    status: room.status,
    seats: Array.from({ length: 4 }).map((_, seat) => {
      const p = room.players.find(pp => pp.seat === seat);
      return {
        seat,
        name: p?.name,
        playerId: p?.playerId,
        connected: !!p?.socketId,
      };
    })
  };
  io.to(room.id).emit('lobby', summary);
}

function emitStateToAll(io: Server, room: Room) {
  if (room.status === 'LOBBY') { broadcastLobby(io, room); return; }
  for (const p of room.players) {
    if (!p.playerId) continue;
    try {
      const view = room.game.getPlayerState(p.playerId);
      if (p.socketId) io.to(p.socketId).emit('state', view);
    } catch (e) {
      // ignore if player not in game yet
    }
  }
}

function seatForNextJoin(room: Room): number {
  const taken = new Set(room.players.map(p => p.seat));
  for (let i = 0; i < 4; i++) if (!taken.has(i)) return i;
  throw new Error('Room full');
}

function ensureSeated(room: Room, name: string, playerId?: string): SeatedPlayer {
  // Reconnect path
  if (playerId) {
    const existing = room.players.find(p => p.playerId === playerId);
    if (existing) return existing;
  }
  if (room.players.length >= 4) throw new Error('Room already full');
  const seat = seatForNextJoin(room);
  const teamId = seat % 2; // 0,1,0,1
  const p: SeatedPlayer = { playerId: uuidv4(), name, seat, teamId };
  room.players.push(p);
  return p;
}

function startGameIfPossible(room: Room) {
  if (room.status !== 'LOBBY') throw new Error('Game already started');
  if (room.players.length !== 4) throw new Error('Need 4 players to start');

  // Register players into engine
  for (const p of room.players) {
    room.game.addPlayer(p.playerId, p.name);
  }
  room.game.startGame();
  room.status = 'ACTIVE';
}

// ---------------- Server bootstrap ----------------

const app = express();
app.use(cors());
app.use(express.json());

// Minimal REST: create a room
app.post('/rooms', (req, res) => {
  try {
    const room = createRoom();
    res.json({ roomId: room.id });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

const server = http.createServer(app);
const io = new Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>(server, {
  cors: { origin: '*'}
});

io.on('connection', (socket: Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>) => {
  // ---- joinRoom ----
  socket.on('joinRoom', (payload) => {
    try {
      const room = getRoomOrThrow(payload.roomId);
      socket.join(room.id);
      const seated = ensureSeated(room, payload.name, payload.playerId);
      seated.socketId = socket.id;
      socket.data.roomId = room.id;
      socket.data.playerId = seated.playerId;
      socket.data.seat = seated.seat;

      socket.emit('joined', { roomId: room.id, playerId: seated.playerId, seat: seated.seat, teamId: seated.teamId, status: room.status });
      broadcastLobby(io, room);
      emitStateToAll(io, room);
    } catch (e: any) {
      socket.emit('errorMsg', e.message);
    }
  });

  // ---- startGame ----
  socket.on('startGame', () => {
    try {
      const room = getRoomOrThrow(socket.data.roomId!);
      startGameIfPossible(room);
      emitStateToAll(io, room);
    } catch (e: any) {
      socket.emit('errorMsg', e.message);
    }
  });

  // ---- drawClosed ----
  socket.on('drawClosed', () => {
    try {
      const room = getRoomOrThrow(socket.data.roomId!);
      room.game.drawFromClosed(socket.data.playerId!);
      emitStateToAll(io, room);
    } catch (e: any) { socket.emit('errorMsg', e.message); }
  });

  // ---- drawOpen ----
  socket.on('drawOpen', () => {
    try {
      const room = getRoomOrThrow(socket.data.roomId!);
      room.game.drawFromOpen(socket.data.playerId!);
      emitStateToAll(io, room);
    } catch (e: any) { socket.emit('errorMsg', e.message); }
  });

  // ---- placeMelds ----
  socket.on('placeMelds', ({ melds }) => {
    try {
      const room = getRoomOrThrow(socket.data.roomId!);
      room.game.placeMelds(socket.data.playerId!, melds);
      emitStateToAll(io, room);
    } catch (e: any) { socket.emit('errorMsg', e.message); }
  });

  // ---- addToMeld ----
  socket.on('addToMeld', ({ additions }) => {
    try {
      const room = getRoomOrThrow(socket.data.roomId!);
      room.game.addCardsToMeld(socket.data.playerId!, additions);
      emitStateToAll(io, room);
    } catch (e: any) { socket.emit('errorMsg', e.message); }
  });

  // ---- discard ----
  socket.on('discard', ({ cardId }) => {
    try {
      const room = getRoomOrThrow(socket.data.roomId!);
      const playerView = room.game.getPlayerState(socket.data.playerId!);
      const card = playerView.yourHand.find(c => c.id === cardId);
      if (!card) throw new Error('Card not in your hand');
      room.game.discard(socket.data.playerId!, card as Card);

      if (room.game.getPublicState().status === 'ENDED') {
        const results = room.game.computeFinalScores();
        io.to(room.id).emit('toast', 'Game ended. Computing scores...');
        // Emit final per-player view one last time, then results
        emitStateToAll(io, room);
        io.to(room.id).emit('state', { results });
        room.status = 'ENDED';
      } else {
        emitStateToAll(io, room);
      }
    } catch (e: any) { socket.emit('errorMsg', e.message); }
  });

  // ---- show ----
  socket.on('show', (payload) => {
    try {
      const room = getRoomOrThrow(socket.data.roomId!);
      room.game.show(socket.data.playerId!, payload);

      const pub = room.game.getPublicState();
      if (pub.status === 'ENDED') {
        const results = room.game.computeFinalScores();
        io.to(room.id).emit('toast', 'Second show completed. Game over.');
        emitStateToAll(io, room);
        io.to(room.id).emit('state', { results });
        room.status = 'ENDED';
      } else {
        emitStateToAll(io, room);
      }
    } catch (e: any) { socket.emit('errorMsg', e.message); }
  });

  // ---- getState ----
  socket.on('getState', () => {
    try {
      const room = getRoomOrThrow(socket.data.roomId!);
      const p = room.players.find(pp => pp.playerId === socket.data.playerId);
      if (!p) throw new Error('Not seated');
      const view = room.game.getPlayerState(p.playerId);
      socket.emit('state', view);
    } catch (e: any) { socket.emit('errorMsg', e.message); }
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const p = room.players.find(pp => pp.playerId === socket.data.playerId);
    if (p && p.socketId === socket.id) {
      p.socketId = undefined; // mark offline; allow reconnection later
      broadcastLobby(io, room);
    }
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Bucaro Socket.IO server listening on :${PORT}`);
});
