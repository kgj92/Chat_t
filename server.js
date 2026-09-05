import "dotenv/config";
import express from "express";
import cors from "cors";
import http from "http";
import { Server } from "socket.io";
import WebSocket from "ws";

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.TWELVE_DATA_API_KEY;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "https://chatting-24.netlify.app";
const TD_BASE = "https://api.twelvedata.com";

if (!API_KEY) console.warn("TWELVE_DATA_API_KEY is not set.");

const app = express();
app.use(cors({ origin: FRONTEND_ORIGIN === "*" ? true : [FRONTEND_ORIGIN], credentials: true }));
app.use(express.json({ limit: "1mb" }));

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: FRONTEND_ORIGIN === "*" ? "*" : [FRONTEND_ORIGIN], methods: ["GET","POST"] }
});

const stocks = new Map();
const roomHistory = new Map();
const roomUsers = new Map();

function roomName(ticker){ return `stock:${String(ticker).toUpperCase()}`; }

async function td(path, params={}){
  const u = new URL(TD_BASE + path);
  u.searchParams.set("apikey", API_KEY);
  for(const [k,v] of Object.entries(params)){
    if(v !== undefined && v !== null && v !== "") u.searchParams.set(k,String(v));
  }
  const r = await fetch(u);
  const data = await r.json();
  if(!r.ok || data.status === "error") throw new Error(data.message || `Twelve Data ${r.status}`);
  return data;
}

async function loadSymbols(){
  const data = await td("/stocks");
  const list = Array.isArray(data) ? data : (data.data || []);
  stocks.clear();

  for(const s of list){
    if(String(s.country || "").toLowerCase() !== "united states") continue;
    if(s.type && !["Common Stock","Depositary Receipt"].includes(s.type)) continue;
    if(!s.symbol) continue;
    stocks.set(s.symbol, {
      symbol:s.symbol,
      name:s.name || s.symbol,
      exchange:s.exchange || "",
      country:s.country || "United States",
      type:s.type || "Common Stock",
      price:null,
      change:0,
      volume:0
    });
  }
  console.log(`Loaded ${stocks.size} US stocks.`);
}

async function quoteOne(symbol){
  const q = await td("/quote", {symbol});
  const s = stocks.get(symbol) || {symbol,name:symbol};
  s.price = q.close != null ? Number(q.close) : (q.price != null ? Number(q.price) : null);
  s.change = q.percent_change != null ? Number(q.percent_change) : 0;
  s.volume = q.volume != null ? Number(q.volume) : 0;
  stocks.set(symbol,s);
  return s;
}

async function quoteMany(symbols){
  const out=[];
  for(const symbol of [...new Set(symbols)].slice(0,50)){
    try { out.push(await quoteOne(symbol)); }
    catch(e){ console.warn("quote",symbol,e.message); }
  }
  return out;
}

app.get("/health",(req,res)=>res.json({ok:true,stocks:stocks.size}));

app.get("/api/stocks",(req,res)=>{
  res.json({
    count: stocks.size,
    stocks:[...stocks.values()].map(({symbol,name,exchange,country,type})=>({symbol,name,exchange,country,type}))
  });
});

app.get("/api/quotes",async(req,res)=>{
  try{
    const symbols=String(req.query.symbols||"").split(",").map(x=>x.trim().toUpperCase()).filter(Boolean);
    const quotes=await quoteMany(symbols);
    res.json({quotes});
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.get("/api/quote/:ticker",async(req,res)=>{
  try{
    const symbol=req.params.ticker.toUpperCase();
    if(!stocks.has(symbol)) return res.status(404).json({error:"Unknown US stock"});
    res.json(await quoteOne(symbol));
  }catch(e){ res.status(500).json({error:e.message}); }
});

io.on("connection",socket=>{
  socket.on("join stock",({ticker}={})=>{
    ticker=String(ticker||"").toUpperCase();
    if(!ticker || !stocks.has(ticker)) return;

    for(const r of socket.rooms){
      if(r.startsWith("stock:")) socket.leave(r);
    }

    const room=roomName(ticker);
    socket.join(room);
    socket.data.stock=ticker;

    socket.emit("stock joined",{ticker});
    socket.emit("stock history",{ticker,messages:roomHistory.get(ticker)||[]});
    emitRoomCounts();
  });

  socket.on("leave stock",({ticker}={})=>{
    ticker=String(ticker||socket.data.stock||"").toUpperCase();
    if(ticker) socket.leave(roomName(ticker));
    socket.data.stock=null;
    emitRoomCounts();
  });

  socket.on("chat message",data=>{
    const ticker=String(data?.ticker||socket.data.stock||"").toUpperCase();
    if(!ticker || ticker!==socket.data.stock || !stocks.has(ticker)) return;

    const type=data?.type==="image" ? "image" : "text";
    const content=String(data?.content||"");
    if(!content) return;
    if(type==="text" && content.length>500) return;
    if(type==="image" && content.length>1500000) return;

    const message={
      type,
      content,
      nickname:String(data?.nickname||"익명").slice(0,20),
      time:data?.time || new Date().toLocaleTimeString("ko-KR",{hour:"2-digit",minute:"2-digit"}),
      ticker
    };

    const arr=roomHistory.get(ticker)||[];
    arr.push(message);
    while(arr.length>100) arr.shift();
    roomHistory.set(ticker,arr);

    io.to(roomName(ticker)).emit("chat message",message);
  });

  socket.on("disconnect",()=>{
    emitRoomCounts();
  });
});

function emitRoomCounts(){
  const list=[];
  for(const [ticker,s] of stocks){
    const count=io.sockets.adapter.rooms.get(roomName(ticker))?.size || 0;
    list.push({ticker,people:count});
    io.to(roomName(ticker)).emit("stock users",{ticker,count});
  }
  io.emit("stock list",list);
}

/*
  Twelve Data WebSocket:
  - API key는 서버에서만 사용
  - 실제 실시간 스트리밍은 계정/플랜의 WebSocket 권한과 symbol 제한을 따릅니다.
  - 모든 미국 종목을 한 번에 스트리밍하는 것은 무료/저가 플랜으로는 불가능할 수 있으므로
    방에 들어간 종목의 quote는 REST로 갱신하고, 고급 플랜에서는 아래 스트림을 확장합니다.
*/
let tdws=null;
function connectTD(){
  if(!API_KEY) return;
  tdws=new WebSocket(`wss://ws.twelvedata.com/v1/quotes/price?apikey=${API_KEY}`);

  tdws.on("open",()=>{
    // 기본 인기 종목만 스트리밍. 필요하면 TD_STREAM_SYMBOLS 환경변수로 변경.
    const symbols=(process.env.TD_STREAM_SYMBOLS || "NVDA,TSLA,AMD,PLTR,AAPL,AMZN,META,MSFT").split(",").map(s=>s.trim()).filter(Boolean);
    tdws.send(JSON.stringify({action:"subscribe",params:{symbols}}));
    console.log("Twelve Data WebSocket connected");
  });

  tdws.on("message",raw=>{
    try{
      const d=JSON.parse(raw.toString());
      if(d.event!=="price") return;
      const symbol=String(d.symbol||"").toUpperCase();
      const s=stocks.get(symbol);
      if(!s) return;
      if(d.price!=null) s.price=Number(d.price);
      if(d.day_volume!=null) s.volume=Number(d.day_volume);
      io.emit("market update",{
        symbol,
        price:s.price,
        change:s.change,
        volume:s.volume
      });
    }catch(e){}
  });

  tdws.on("close",()=>setTimeout(connectTD,5000));
  tdws.on("error",e=>console.warn("Twelve Data WS:",e.message));
}

async function start(){
  try{
    await loadSymbols();
    await quoteMany(["NVDA","TSLA","AMD","PLTR","AAPL","AMZN","META","MSFT"]);
  }catch(e){
    console.error("Initial Twelve Data load failed:",e.message);
  }

  httpServer.listen(PORT,()=>console.log(`STOCK24 server listening on ${PORT}`));
  connectTD();
}

start();
