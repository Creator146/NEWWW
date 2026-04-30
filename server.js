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

// Public profile + friends system.
// This is in-memory on Render. It stays while the server is running.
// Browser keeps its own permanent Player ID in localStorage.
const profiles = new Map(); // id -> {id,name,public,online,lastSeen,friends:Set,requests:Set,ws}
const pendingRequests = new Map(); // targetId -> Set(fromId)

function cleanText(value, max) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max);
}
function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}
function onlineCount() {
  let n = 0;
  for (const ws of clients) if (ws.readyState === WebSocket.OPEN) n++;
  return n;
}
function getProfile(id) {
  id = cleanText(id, 18).toUpperCase();
  if (!profiles.has(id)) {
    profiles.set(id, {
      id,
      name: "Racer",
      public: true,
      online: false,
      lastSeen: Date.now(),
      friends: new Set(),
      requests: new Set(),
      ws: null
    });
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
  const friends = [...p.friends].map(publicProfile);
  const requests = [...requestsSet].map(publicProfile);
  send(p.ws, { t: "friends_data", friends, requests, online: onlineCount() });
}
function notifyProfile(id, message) {
  const p = profiles.get(id);
  if (p && p.ws) send(p.ws, { t: "friend_notice", message });
  if (p) sendFriendsData(id);
}

// Multiplayer room relay kept so existing multiplayer messages still work.
const rooms = new Map();
function roomPin() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let pin = "";
  for (let i = 0; i < 6; i++) pin += chars[Math.floor(Math.random() * chars.length)];
  return pin;
}
function leaveRoom(ws) {
  if (!ws.room) return;
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

    // Global chat
    if (msg.t === "chat") {
      const name = cleanText(msg.name, 14) || "Racer";
      const text = cleanText(msg.text, 140);
      if (!text) return send(ws, { t: "chat_error", message: "Empty message." });

      const lower = text.toLowerCase();
      const blocked = ["nigger", "nigga", "fuck your mom", "kill yourself"];
      if (blocked.some(w => lower.includes(w))) {
        return send(ws, { t: "chat_error", message: "Message blocked. Keep chat clean." });
      }

      const entry = { t: "chat", name, text, time: Date.now() };
      chatMessages.push({ name, text, time: entry.time });
      while (chatMessages.length > 50) chatMessages.shift();
      broadcast(entry);
      return;
    }

    // Player public profile register/update
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
      const targetP = getProfile(target);

      if (fromP.friends.has(target)) {
        return send(ws, { t: "friend_notice", message: "Already friends." });
      }

      if (!pendingRequests.has(target)) pendingRequests.set(target, new Set());
      pendingRequests.get(target).add(from);
      send(ws, { t: "friend_notice", message: "Friend request sent to " + target + "." });
      notifyProfile(target, (fromP.name || from) + " sent you a friend request.");
      sendFriendsData(from);
      return;
    }

    if (msg.t === "friend_accept") {
      const from = cleanText(msg.from, 18).toUpperCase();     // accepter
      const target = cleanText(msg.target, 18).toUpperCase(); // requester
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

    // Existing multiplayer relay support
    if (msg.t === "create") {
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
