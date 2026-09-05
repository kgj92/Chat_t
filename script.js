const SOCKET_URL = "https://chat-iey5.onrender.com";
const API_URL = SOCKET_URL;

const socket = io(SOCKET_URL, {
  transports:["websocket","polling"]
});

// Twelve Data의 /stocks를 서버가 프록시해서 내려줍니다.
// 종목 전체 목록은 여기서 받고, 가격/거래량은 서버 API에서 실시간 조회합니다.
let stocks = [];
let stockMap = new Map();

let currentSort = "people";
let currentStock = null;
let nickname = localStorage.getItem("stock24_nickname") || ("익명" + Math.floor(1000 + Math.random()*9000));
let sendCooldown = false;
let quoteTimer = null;

const homeView=document.getElementById("homeView");
const roomView=document.getElementById("roomView");
const stockList=document.getElementById("stockList");
const search=document.getElementById("stockSearch");
const sortSelect=document.getElementById("sortSelect");
const roomChat=document.getElementById("roomChat");
const message=document.getElementById("message");
const imageInput=document.getElementById("imageInput");
const sendBtn=document.getElementById("sendBtn");

function fmtNumber(n){
  return new Intl.NumberFormat("en-US").format(Number(n)||0);
}
function fmtPrice(n){
  if(n === null || n === undefined || Number.isNaN(Number(n))) return "--";
  return "$" + Number(n).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
}
function changeClass(n){ return n>0 ? "up" : n<0 ? "down" : "flat"; }
function changeText(n){ return (n>0?"+":"") + (Number(n)||0).toFixed(2) + "%"; }

async function loadAllStocks(){
  stockList.innerHTML = '<div class="empty">미국주식 종목을 불러오는 중...</div>';
  try{
    const res = await fetch(`${API_URL}/api/stocks`);
    if(!res.ok) throw new Error("stocks api " + res.status);
    const data = await res.json();

    stocks = (data.stocks || []).map((s, i)=>({
      ticker: s.symbol,
      name: s.name || s.symbol,
      exchange: s.exchange || "",
      type: s.type || "Common Stock",
      price: null,
      change: 0,
      volume: 0,
      people: 0,
      favorite: localStorage.getItem("fav_"+s.symbol)==="1",
      rank: i
    }));

    stockMap = new Map(stocks.map(s=>[s.ticker,s]));
    renderStocks();

    // 화면 첫 페이지에서 바로 가격이 보이도록 상위 50개만 먼저 quote 요청.
    // 나머지는 검색/종목방 진입 시 자동으로 조회합니다.
    await refreshQuotes(stocks.slice(0, 50).map(s=>s.ticker));
  }catch(err){
    console.error(err);
    stockList.innerHTML = '<div class="empty">종목 데이터를 불러오지 못했습니다. 서버 주소와 API 키를 확인해주세요.</div>';
  }
}

async function refreshQuotes(tickers){
  const unique = [...new Set((tickers||[]).filter(Boolean))].slice(0, 50);
  if(!unique.length) return;

  try{
    const res = await fetch(`${API_URL}/api/quotes?symbols=${encodeURIComponent(unique.join(","))}`);
    if(!res.ok) return;
    const data = await res.json();

    (data.quotes || []).forEach(q=>{
      const s = stockMap.get(q.symbol);
      if(!s) return;
      if(q.price !== undefined) s.price = Number(q.price);
      if(q.change !== undefined) s.change = Number(q.change);
      if(q.volume !== undefined) s.volume = Number(q.volume);
    });

    renderStocks();
    if(currentStock){
      const fresh = stockMap.get(currentStock.ticker);
      if(fresh){
        currentStock = fresh;
        updateRoomPrice();
      }
    }
  }catch(err){
    console.warn("quote refresh failed", err);
  }
}

async function refreshCurrentQuote(){
  if(!currentStock) return;
  try{
    const res = await fetch(`${API_URL}/api/quote/${encodeURIComponent(currentStock.ticker)}`);
    if(!res.ok) return;
    const q = await res.json();
    if(q.symbol){
      const s = stockMap.get(q.symbol) || currentStock;
      if(q.price !== undefined) s.price = Number(q.price);
      if(q.change !== undefined) s.change = Number(q.change);
      if(q.volume !== undefined) s.volume = Number(q.volume);
      currentStock = s;
      updateRoomPrice();
      renderStocks();
    }
  }catch(err){
    console.warn("current quote failed", err);
  }
}

function sortedStocks(){
  let arr=[...stocks];
  if(currentSort==="people") arr.sort((a,b)=>(b.people||0)-(a.people||0));
  if(currentSort==="volume") arr.sort((a,b)=>(b.volume||0)-(a.volume||0));
  if(currentSort==="up") arr.sort((a,b)=>(b.change||0)-(a.change||0));
  if(currentSort==="down") arr.sort((a,b)=>(a.change||0)-(b.change||0));
  if(currentSort==="favorite") arr=arr.filter(x=>x.favorite);

  const q=search.value.trim().toLowerCase();
  if(q) arr=arr.filter(x=>
    x.ticker.toLowerCase().includes(q) ||
    x.name.toLowerCase().includes(q)
  );
  return arr;
}

function renderStocks(){
  const arr=sortedStocks();
  if(!arr.length){
    stockList.innerHTML='<div class="empty">검색 결과가 없습니다.</div>';
    return;
  }

  stockList.innerHTML=arr.map(s=>`
    <button class="stockItem" data-ticker="${s.ticker}">
      <div class="stockLeft">
        <div class="tickerLine">
          <span class="ticker">${s.ticker}</span>
          <span class="stockName">${s.name}</span>
        </div>
        <div class="stockSub">
          ${s.exchange ? s.exchange + " · " : ""}거래량 ${s.volume ? fmtNumber(s.volume) : "--"}
        </div>
      </div>
      <div class="stockRight">
        <div class="price">${fmtPrice(s.price)}</div>
        <div class="change ${changeClass(s.change)}">${changeText(s.change)}</div>
        <div class="people">👥 ${fmtNumber(s.people)}</div>
      </div>
    </button>`).join("");

  stockList.querySelectorAll(".stockItem").forEach(btn=>{
    btn.addEventListener("click",()=>openRoom(btn.dataset.ticker));
  });
}

function setSort(sort){
  currentSort=sort;
  sortSelect.value = ["people","volume","up","down"].includes(sort) ? sort : "people";
  document.querySelectorAll(".tab").forEach(t=>t.classList.toggle("active",t.dataset.sort===sort));
  renderStocks();
}
sortSelect.addEventListener("change",e=>setSort(e.target.value));
search.addEventListener("input",()=>{
  renderStocks();
  const q=search.value.trim();
  if(q.length>=1){
    const matches=stocks.filter(s=>s.ticker.startsWith(q.toUpperCase()) || s.name.toLowerCase().includes(q.toLowerCase())).slice(0,10);
    refreshQuotes(matches.map(s=>s.ticker));
  }
});

async function openRoom(ticker){
  currentStock=stockMap.get(ticker);
  if(!currentStock)return;

  homeView.style.display="none";
  roomView.style.display="flex";
  roomChat.innerHTML="";
  document.getElementById("roomTicker").textContent=currentStock.ticker;
  document.getElementById("roomName").textContent=currentStock.name;
  updateRoomPrice();
  drawChart();

  socket.emit("join stock", {ticker:currentStock.ticker});
  await refreshCurrentQuote();

  clearInterval(quoteTimer);
  quoteTimer=setInterval(refreshCurrentQuote, 15000);
}

function closeRoom(){
  if(currentStock) socket.emit("leave stock",{ticker:currentStock.ticker});
  clearInterval(quoteTimer);
  quoteTimer=null;
  currentStock=null;
  roomView.style.display="none";
  homeView.style.display="flex";
  renderStocks();
}

document.getElementById("backBtn").addEventListener("click",closeRoom);

function updateRoomPrice(){
  if(!currentStock)return;
  const price=document.getElementById("roomPrice");
  price.innerHTML=`${fmtPrice(currentStock.price)} <span class="${changeClass(currentStock.change)}">${changeText(currentStock.change)}</span>`;
  document.getElementById("roomPeople").textContent="👥 " + fmtNumber(currentStock.people);
}

function drawChart(){
  const canvas=document.getElementById("chartCanvas");
  if(!canvas || !currentStock) return;
  const box=canvas.parentElement;
  const dpr=window.devicePixelRatio||1;
  canvas.width=box.clientWidth*dpr;
  canvas.height=box.clientHeight*dpr;
  const ctx=canvas.getContext("2d");
  ctx.scale(dpr,dpr);
  const w=box.clientWidth,h=box.clientHeight;
  const base=Number(currentStock.price)||0;
  if(!base) return;

  const points=[];
  for(let i=0;i<28;i++){
    const trend=(Number(currentStock.change)||0)/100*(i/27);
    const noise=(Math.random()-.5)*.018;
    points.push(base*(1-trend*.45+noise));
  }
  const min=Math.min(...points),max=Math.max(...points);
  ctx.beginPath();
  points.forEach((p,i)=>{
    const x=i*(w-8)/(points.length-1)+4;
    const y=h-8-((p-min)/(max-min||1))*(h-16);
    i?ctx.lineTo(x,y):ctx.moveTo(x,y);
  });
  ctx.lineWidth=2;
  ctx.strokeStyle=currentStock.change>=0?"#e53935":"#1976d2";
  ctx.stroke();
}

function getTime(){
  return new Date().toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});
}

function addMessage(data){
  const wrapper=document.createElement("div");
  wrapper.className="message";

  const meta=document.createElement("div");
  meta.className="messageMeta";
  meta.textContent=data.nickname || "익명";
  wrapper.appendChild(meta);

  if(data.type==="image"){
    const img=document.createElement("img");
    img.src=data.content;
    wrapper.appendChild(img);
  }else{
    const body=document.createElement("div");
    body.className="messageBody";
    body.textContent=data.content || "";
    wrapper.appendChild(body);
  }

  const time=document.createElement("div");
  time.className="timestamp";
  time.textContent=data.time || getTime();
  wrapper.appendChild(time);

  roomChat.appendChild(wrapper);
  roomChat.scrollTop=roomChat.scrollHeight;
}

function emitMessage(type,content){
  socket.emit("chat message",{
    type,
    content,
    time:getTime(),
    nickname,
    ticker:currentStock ? currentStock.ticker : null
  });
}

function sendSticker(src){
  if(!currentStock)return;
  emitMessage("text",src);
  document.getElementById("stickerBox").style.display="none";
}

function sendMessage(){
  if(sendCooldown || !currentStock)return;
  const msg=message.value.trim();
  const file=imageInput.files[0];
  if(!msg && !file)return;

  sendCooldown=true;
  sendBtn.disabled=true;
  sendBtn.style.opacity=".5";

  if(msg){
    emitMessage("text",msg);
    message.value="";
  }

  if(file){
    const reader=new FileReader();
    reader.onload=e=>emitMessage("image",e.target.result);
    reader.readAsDataURL(file);
    imageInput.value="";
  }

  const end=performance.now()+2000;
  function tick(){
    const left=Math.max(0,end-performance.now());
    if(left>0){
      sendBtn.textContent=(left/1000).toFixed(1);
      requestAnimationFrame(tick);
    }else{
      sendCooldown=false;
      sendBtn.disabled=false;
      sendBtn.style.opacity="";
      sendBtn.textContent="전송";
    }
  }
  tick();
}

sendBtn.addEventListener("click",sendMessage);
message.addEventListener("keydown",e=>{
  if(e.key==="Enter"){
    e.preventDefault();
    sendMessage();
  }
});
document.getElementById("imageSelectBtn").addEventListener("click",()=>imageInput.click());

const emojiBtn=document.getElementById("emojiBtn");
const stickerBox=document.getElementById("stickerBox");
emojiBtn.addEventListener("click",e=>{
  e.stopPropagation();
  stickerBox.style.display=stickerBox.style.display==="grid"?"none":"grid";
});
document.addEventListener("click",()=>stickerBox.style.display="none");
stickerBox.addEventListener("click",e=>e.stopPropagation());

socket.on("chat message",data=>{
  if(currentStock && data.ticker && data.ticker!==currentStock.ticker)return;
  if(currentStock)addMessage(data);
});

socket.on("stock users",data=>{
  if(!data)return;
  const s=stockMap.get(data.ticker);
  if(s) s.people=Number(data.count)||0;
  if(currentStock && data.ticker===currentStock.ticker) updateRoomPrice();
  renderStocks();
});

socket.on("market update",data=>{
  if(!data || !data.symbol)return;
  const s=stockMap.get(data.symbol);
  if(!s)return;
  if(data.price!==undefined) s.price=Number(data.price);
  if(data.change!==undefined) s.change=Number(data.change);
  if(data.volume!==undefined) s.volume=Number(data.volume);
  renderStocks();
  if(currentStock && currentStock.ticker===data.symbol){
    currentStock=s;
    updateRoomPrice();
  }
});

socket.on("stock list",list=>{
  if(!Array.isArray(list)) return;
  list.forEach(x=>{
    const s=stockMap.get(x.ticker);
    if(s) s.people=Number(x.people)||0;
  });
  renderStocks();
});

function sendFavorite(ticker){
  const s=stockMap.get(ticker);
  if(!s)return;
  s.favorite=!s.favorite;
  localStorage.setItem("fav_"+ticker,s.favorite?"1":"0");
  renderStocks();
}

/* 메뉴 */
const menuBtn=document.getElementById("menuBtn");
const sideMenu=document.getElementById("sideMenu");
const overlay=document.getElementById("menuOverlay");
function toggleMenu(){
  if(!sideMenu || !overlay)return;
  const open=sideMenu.classList.toggle("open");
  overlay.classList.toggle("open",open);
}
menuBtn?.addEventListener("click",toggleMenu);
overlay?.addEventListener("click",toggleMenu);

/* 로그인/닉네임 */
const modal=document.getElementById("loginModal");
document.getElementById("loginBtn").addEventListener("click",()=>{
  document.getElementById("nickname").value=nickname.startsWith("익명")?"":nickname;
  modal.classList.add("open");
  document.getElementById("nickname").focus();
});
document.getElementById("cancelLogin").addEventListener("click",()=>modal.classList.remove("open"));
document.getElementById("confirmLogin").addEventListener("click",()=>{
  const value=document.getElementById("nickname").value.trim();
  if(value){
    nickname=value;
    localStorage.setItem("stock24_nickname",nickname);
  }
  modal.classList.remove("open");
});
document.getElementById("nickname").addEventListener("keydown",e=>{
  if(e.key==="Enter")document.getElementById("confirmLogin").click();
});

loadAllStocks();
