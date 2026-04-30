const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { WebSocketServer } = require("ws");

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 8787;

app.use(express.static(__dirname));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

const wss = new WebSocketServer({ server });
const rooms = new Map();
const DATA_FILE = path.join(__dirname, "rainbow_claims.json");
const MAX_RAINBOW = 500;

function loadClaims(){
  try{
    const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    if(Array.isArray(data.tokens)) return new Set(data.tokens);
  }catch{}
  return new Set();
}
let rainbowClaims = loadClaims();
function saveClaims(){
  try{ fs.writeFileSync(DATA_FILE, JSON.stringify({tokens:[...rainbowClaims]}, null, 2)); }catch{}
}
function makeId(){ return Math.random().toString(36).slice(2, 10); }
function makeRoom(){
  let pin;
  do{ pin = Math.random().toString(36).slice(2, 8).toUpperCase(); }while(rooms.has(pin));
  return pin;
}
function send(ws, obj){
  if(ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}
function broadcast(room, obj, except){
  const set = rooms.get(room);
  if(!set) return;
  for(const client of set){
    if(client !== except) send(client, obj);
  }
}
function peers(room){
  const set = rooms.get(room);
  return set ? [...set].map(c => c.id) : [];
}
function leave(ws){
  if(!ws.room) return;
  const room = ws.room;
  const set = rooms.get(room);
  if(set){
    set.delete(ws);
    if(set.size === 0) rooms.delete(room);
    else{
      broadcast(room, {t:"left", id:ws.id});
      broadcast(room, {t:"peers", ids:peers(room)});
    }
  }
  ws.room = null;
}

wss.on("connection", (ws) => {
  ws.id = makeId();
  ws.room = null;
  send(ws, {t:"hello", id:ws.id});

  ws.on("message", (raw) => {
    let msg;
    try{ msg = JSON.parse(raw); }catch{ return; }
    if(!msg || typeof msg.t !== "string") return;

    if(msg.t === "claimRainbow"){
      const token = String(msg.token || "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 80);
      if(!token) return send(ws, {t:"rainbowReward", unlocked:false, count:rainbowClaims.size, max:MAX_RAINBOW});
      if(rainbowClaims.has(token)) return send(ws, {t:"rainbowReward", unlocked:true, count:rainbowClaims.size, max:MAX_RAINBOW});
      if(rainbowClaims.size < MAX_RAINBOW){
        rainbowClaims.add(token);
        saveClaims();
        return send(ws, {t:"rainbowReward", unlocked:true, count:rainbowClaims.size, max:MAX_RAINBOW});
      }
      return send(ws, {t:"rainbowReward", unlocked:false, count:rainbowClaims.size, max:MAX_RAINBOW});
    }

    if(msg.t === "create"){
      leave(ws);
      const room = makeRoom();
      rooms.set(room, new Set([ws]));
      ws.room = room;
      send(ws, {t:"created", room});
      send(ws, {t:"peers", ids:peers(room)});
      return;
    }

    if(msg.t === "join"){
      const room = String(msg.room || "").trim().toUpperCase().slice(0, 12);
      if(!room) return;
      if(!rooms.has(room)) rooms.set(room, new Set());
      leave(ws);
      rooms.get(room).add(ws);
      ws.room = room;
      send(ws, {t:"joined", room});
      broadcast(room, {t:"peers", ids:peers(room)});
      send(ws, {t:"peers", ids:peers(room)});
      return;
    }

    if(msg.t === "leave") return leave(ws);

    if(msg.t === "state" && ws.room){
      broadcast(ws.room, {t:"state", from:ws.id, s:msg.s}, ws);
    }
  });

  ws.on("close", () => leave(ws));
});

server.listen(PORT, () => {
  console.log(`Mini Racer server running on port ${PORT}`);
});
