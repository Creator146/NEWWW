const express = require("express");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

const chatMessages = [];
const clients = new Set();
const profiles = new Map();
const pendingRequests = new Map();

function cleanText(value, max) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}
function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(data);
}
function onlineCount() {
  let n = 0;
  for (const ws of clients) if (ws.readyState === WebSocket.OPEN) n++;
  return n;
}
function getProfile(id) {
  id = cleanText(id, 18).toUpperCase();
  if (!profiles.has(id)) {
    profiles.set(id, { id, name: "Racer", public: true, online: false, lastSeen: Date.now(), friends: new Set(), ws: null });
  }
  return profiles.get(id);
}
function publicProfile(id) {
  const p = profiles.get(id);
  if (!p) return { id, name: "Unknown", online: false };
  return { id: p.id, name: p.name || "Racer", online: !!p.online, lastSeen: p.lastSeen || Date.now() };
}
function sendFriendsData(id) {
  const p = getProfile(id);
  const requestsSet = pendingRequests.get(p.id) || new Set();
  send(p.ws, { t: "friends_data", friends: [...p.friends].map(publicProfile), requests: [...requestsSet].map(publicProfile), online: onlineCount() });
}
function notifyProfile(id, message) {
  const p = profiles.get(id);
  if (p && p.ws) send(p.ws, { t: "friend_notice", message });
  if (p) sendFriendsData(id);
}

const MAX_MATCH_PLAYERS = 5;
const matches = new Map();
let waitingMatchId = null;
let matchCounter = 1;

function newMatchId() { return "AUTO-" + String(matchCounter++).padStart(3, "0"); }
function matchMembers(matchId) { return matches.get(matchId) || new Set(); }
function broadcastMatch(matchId, obj) {
  const set = matchMembers(matchId);
  for (const p of set) send(p, obj);
}
function sendMatchPeers(matchId) {
  const set = matchMembers(matchId);
  const ids = [...set].map(p => p.id);
  for (const p of set) send(p, { t: "peers", ids });
}
function leaveMatch(ws) {
  if (!ws.matchId) return;
  const matchId = ws.matchId;
  const set = matches.get(matchId);
  if (set) {
    set.delete(ws);
    for (const p of set) send(p, { t: "left", id: ws.id });
    if (set.size === 0) {
      matches.delete(matchId);
      if (waitingMatchId === matchId) waitingMatchId = null;
    } else {
      sendMatchPeers(matchId);
      if (set.size >= 2) {
        if (waitingMatchId === matchId) waitingMatchId = null;
        broadcastMatch(matchId, { t: "match_started", matchId, count: set.size });
      } else {
        waitingMatchId = matchId;
        broadcastMatch(matchId, { t: "match_waiting", matchId, count: set.size });
      }
    }
  }
  ws.matchId = null;
  ws.room = null;
}
function joinMatch(ws, matchId) {
  const set = matchMembers(matchId);
  if (set.size >= MAX_MATCH_PLAYERS) return false;
  leaveMatch(ws);
  set.add(ws);
  matches.set(matchId, set);
  ws.matchId = matchId;
  ws.room = matchId;
  sendMatchPeers(matchId);
  if (set.size === 1) {
    waitingMatchId = matchId;
    send(ws, { t: "match_waiting", matchId, count: 1 });
  } else {
    if (waitingMatchId === matchId) waitingMatchId = null;
    broadcastMatch(matchId, { t: "match_started", matchId, count: set.size });
  }
  return true;
}
function chooseAutoMatch() {
  for (const [id, set] of matches) if (set.size >= 2 && set.size < MAX_MATCH_PLAYERS) return id;
  if (waitingMatchId && matches.has(waitingMatchId) && matches.get(waitingMatchId).size < MAX_MATCH_PLAYERS) return waitingMatchId;
  const id = newMatchId();
  matches.set(id, new Set());
  waitingMatchId = id;
  return id;
}

// hidden old room support, kept so nothing breaks internally
const rooms = new Map();
function roomPin() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let pin = "";
  for (let i = 0; i < 6; i++) pin += chars[Math.floor(Math.random() * chars.length)];
  return pin;
}
function leaveRoom(ws) {
  if (!ws.room || ws.matchId === ws.room) return;
  const set = rooms.get(ws.room);
  if (set) {
    set.delete(ws);
    for (const p of set) send(p, { t: "left", id: ws.id });
    if (set.size === 0) rooms.delete(ws.room);
    else {
      const ids = [...set].map(p => p.id);
      for (const p of set) send(p, { t: "peers", ids });
    }
  }
  ws.room = null;
}
function broadcastRoom(ws, obj) {
  if (ws.matchId) {
    broadcastMatch(ws.matchId, obj);
    return;
  }
  if (!ws.room) return;
  const set = rooms.get(ws.room);
  if (!set) return;
  for (const p of set) if (p !== ws) send(p, obj);
}

wss.on("connection", (ws) => {
  ws.id = Math.random().toString(36).slice(2, 10);
  clients.add(ws);
  send(ws, { t: "hello", id: ws.id });
  send(ws, { t: "chat_history", messages: chatMessages });
  broadcast({ t: "chat_online", count: onlineCount() });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.t !== "string") return;

    if (msg.t === "chat") {
      const name = cleanText(msg.name, 14) || "Racer";
      const text = cleanText(msg.text, 140);
      if (!text) return send(ws, { t: "chat_error", message: "Empty message." });
      const lower = text.toLowerCase();
      const blocked = ["nigger", "nigga", "fuck your mom", "kill yourself"];
      if (blocked.some(w => lower.includes(w))) return send(ws, { t: "chat_error", message: "Message blocked. Keep chat clean." });
      const entry = { t: "chat", name, text, time: Date.now() };
      chatMessages.push({ name, text, time: entry.time });
      while (chatMessages.length > 50) chatMessages.shift();
      broadcast(entry);
      return;
    }

    if (msg.t === "profile_register") {
      const id = cleanText(msg.id, 18).toUpperCase();
      if (!id) return;
      const p = getProfile(id);
      p.name = cleanText(msg.name, 14) || p.name || "Racer";
      p.public = true;
      p.online = true;
      p.lastSeen = Date.now();
      p.ws = ws;
      ws.playerId = id;
      if (Array.isArray(msg.friends)) {
        for (const fidRaw of msg.friends) {
          const fid = cleanText(fidRaw, 18).toUpperCase();
          if (fid && fid !== id) p.friends.add(fid);
        }
      }
      send(ws, { t: "profile_ok", id: p.id, name: p.name, online: onlineCount() });
      sendFriendsData(id);
      return;
    }

    if (msg.t === "friends_get") {
      const id = cleanText(msg.id, 18).toUpperCase();
      if (id) sendFriendsData(id);
      return;
    }

    if (msg.t === "friend_request") {
      const from = cleanText(msg.from, 18).toUpperCase();
      const target = cleanText(msg.target, 18).toUpperCase();
      if (!from || !target || from === target) return;
      const fromP = getProfile(from);
      getProfile(target);
      if (fromP.friends.has(target)) return send(ws, { t: "friend_notice", message: "Already friends." });
      if (!pendingRequests.has(target)) pendingRequests.set(target, new Set());
      pendingRequests.get(target).add(from);
      send(ws, { t: "friend_notice", message: "Friend request sent to " + target + "." });
      notifyProfile(target, (fromP.name || from) + " sent you a friend request.");
      sendFriendsData(from);
      return;
    }

    if (msg.t === "friend_accept") {
      const from = cleanText(msg.from, 18).toUpperCase();
      const target = cleanText(msg.target, 18).toUpperCase();
      if (!from || !target) return;
      const reqs = pendingRequests.get(from);
      if (reqs) reqs.delete(target);
      const a = getProfile(from);
      const b = getProfile(target);
      a.friends.add(target);
      b.friends.add(from);
      notifyProfile(from, "Friend added.");
      notifyProfile(target, (a.name || from) + " accepted your friend request.");
      return;
    }

    if (msg.t === "friend_decline") {
      const from = cleanText(msg.from, 18).toUpperCase();
      const target = cleanText(msg.target, 18).toUpperCase();
      const reqs = pendingRequests.get(from);
      if (reqs) reqs.delete(target);
      notifyProfile(from, "Request declined.");
      return;
    }

    if (msg.t === "friend_remove") {
      const from = cleanText(msg.from, 18).toUpperCase();
      const target = cleanText(msg.target, 18).toUpperCase();
      const a = getProfile(from);
      const b = getProfile(target);
      a.friends.delete(target);
      b.friends.delete(from);
      notifyProfile(from, "Friend removed.");
      notifyProfile(target, (a.name || from) + " removed you from friends.");
      return;
    }

    if (msg.t === "match_play") {
      const matchId = chooseAutoMatch();
      const ok = joinMatch(ws, matchId);
      if (!ok) return send(ws, { t: "match_full" });
      return;
    }

    if (msg.t === "match_leave") {
      leaveMatch(ws);
      send(ws, { t: "match_cancelled" });
      return;
    }

    if (msg.t === "create") {
      leaveMatch(ws);
      leaveRoom(ws);
      let pin = roomPin();
      while (rooms.has(pin)) pin = roomPin();
      rooms.set(pin, new Set([ws]));
      ws.room = pin;
      send(ws, { t: "created", room: pin });
      send(ws, { t: "peers", ids: [ws.id] });
      return;
    }

    if (msg.t === "join") {
      leaveMatch(ws);
      const pin = cleanText(msg.room, 8).toUpperCase();
      const set = rooms.get(pin);
      if (!set) return send(ws, { t: "error", message: "Room not found" });
      leaveRoom(ws);
      set.add(ws);
      ws.room = pin;
      send(ws, { t: "joined", room: pin });
      const ids = [...set].map(p => p.id);
      for (const p of set) send(p, { t: "peers", ids });
      return;
    }

    if (msg.t === "leave") {
      leaveRoom(ws);
      return;
    }

    if (msg.t === "state") {
      broadcastRoom(ws, { t: "state", from: ws.id, s: msg.s });
      return;
    }
  });

  ws.on("close", () => {
    leaveMatch(ws);
    leaveRoom(ws);
    if (ws.playerId && profiles.has(ws.playerId)) {
      const p = profiles.get(ws.playerId);
      p.online = false;
      p.lastSeen = Date.now();
      p.ws = null;
    }
    clients.delete(ws);
    broadcast({ t: "chat_online", count: onlineCount() });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log("Mini Racer server running on port " + PORT);
});
