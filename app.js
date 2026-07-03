/* =====================================================================
   밀폐공간 안전관리 앱 — app.js
   순수 JavaScript / 의존성 없음 / 데이터는 localStorage 저장

   구성
   1) 상태(State) & 저장소(Storage)
   2) 유틸(시간/포맷)
   3) 가스 시뮬레이션 & 상태 판정
   4) 뷰 렌더링 (대시보드 / 작업자 / 체크리스트 / 기록 / 설정)
   5) 액션 (입장/퇴장/안전확인/경보/SOS/CRUD)
   6) 실시간 루프(1초) & 이벤트 바인딩
   ===================================================================== */
'use strict';

/* ============================ 1. 상태 ============================ */
const STORAGE_KEY = 'confined-space-safety-v1';

const CHECK_ITEMS = [
  { key:'gas',     title:'가스 농도 측정',  desc:'O₂·H₂S·CO·LEL 적정 확인' },
  { key:'vent',    title:'환기 실시',       desc:'송풍기 가동 및 지속 환기' },
  { key:'mask',    title:'송기마스크 착용',  desc:'공기호흡기/송기마스크 점검' },
  { key:'harness', title:'안전대·구명줄',    desc:'추락/구조용 안전대 착용' },
  { key:'radio',   title:'무전기 확인',      desc:'감시인-작업자 교신 테스트' },
  { key:'permit',  title:'작업허가서',       desc:'밀폐공간 작업허가 승인' },
];

function defaultState(){
  return {
    workers: [],          // {id,name,location,phone,assignedMh,connState,connAt,inside,enteredAt,lastResponseAt,mh,logId}
    logs: [],             // 작업 일지 {id,name,location,mh,enteredAt,exitedAt,durationSec,checklistPassed}
    alarms: [],           // 경보 이력 {id,ts,level,type,message,who}
    comms: [],            // 무전 교신 {id,ts,workerId,dir:'out'|'in',text}
    checklist: Object.fromEntries(CHECK_ITEMS.map(c=>[c.key,false])),
    settings: {
      intervalMin: 5,
      graceSec: 60,
      gasMode: 'normal',   // normal | alarm
      thresholds: { o2Low:18, o2High:23.5, h2s:10, co:30, lel:10 },
      // 생체(바이탈) 임계치 — 안전/주의/위험 분류 기준
      vitals: {
        bpmWarn:110,  bpmDanger:125,   // 심박(bpm) 상한
        bpmLowWarn:50, bpmLowDanger:40, // 심박 하한(서맥/의식저하)
        tempWarn:37.6, tempDanger:38.3, // 심부체온(℃)
        spo2Warn:94,  spo2Danger:90,    // 산소포화도(%)
      },
    },
  };
}

let state = load();

function load(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return defaultState();
    const parsed = JSON.parse(raw);
    const d = defaultState();
    // 얕은 병합 + settings/checklist 깊은 병합으로 구버전 호환
    return {
      ...d, ...parsed,
      settings:{ ...d.settings, ...(parsed.settings||{}),
        thresholds:{ ...d.settings.thresholds, ...((parsed.settings||{}).thresholds||{}) },
        vitals:{ ...d.settings.vitals, ...((parsed.settings||{}).vitals||{}) },
      },
      checklist:{ ...d.checklist, ...(parsed.checklist||{}) },
    };
  }catch(e){ console.warn('상태 로드 실패, 초기화합니다.', e); return defaultState(); }
}

function save(){ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }

/* ============================ 2. 유틸 ============================ */
const $  = (s,el=document)=>el.querySelector(s);
const $$ = (s,el=document)=>[...el.querySelectorAll(s)];
const now = ()=>Date.now();
const uid = ()=> 'id'+Math.random().toString(36).slice(2,9)+now().toString(36).slice(-3);

function pad(n){ return String(n).padStart(2,'0'); }
function fmtClock(ts){ const d=new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
function fmtHM(ts){ const d=new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function fmtDur(sec){
  sec=Math.max(0,Math.floor(sec));
  const h=Math.floor(sec/3600), m=Math.floor((sec%3600)/60), s=sec%60;
  return h>0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
function fmtDurKo(sec){
  sec=Math.max(0,Math.floor(sec));
  const h=Math.floor(sec/3600), m=Math.floor((sec%3600)/60);
  return h>0 ? `${h}시간 ${m}분` : `${m}분`;
}
function dateKey(ts){ const d=new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function escapeHtml(s){ return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

/* ============================ 3. 가스 시뮬레이션 ============================ */
/* 작업자별로 안정적인 시드값을 두고 미세 변동을 준다. */
const gasCache = new Map();   // workerId -> {o2,h2s,co,lel}

function simGas(worker){
  const th = state.settings.thresholds;
  const alarmMode = state.settings.gasMode === 'alarm';
  let g = gasCache.get(worker.id);
  if(!g){ g = { o2:20.9, h2s:0.5, co:2, lel:1 }; gasCache.set(worker.id,g); }

  // 목표값(정상 vs 경보) 으로 서서히 수렴 + 소량 노이즈
  const jitter=(v,amt)=> v + (Math.random()-0.5)*amt;
  const target = alarmMode
    ? { o2:17.2, h2s:th.h2s+8, co:th.co+22, lel:th.lel+6 }
    : { o2:20.9, h2s:1.2,      co:3,        lel:1.5 };

  g.o2  = clamp(jitter(g.o2 +(target.o2 -g.o2 )*0.15, 0.10), 12, 24);
  g.h2s = clamp(jitter(g.h2s+(target.h2s-g.h2s)*0.15, 0.30),  0, 60);
  g.co  = clamp(jitter(g.co +(target.co -g.co )*0.15, 0.60),  0, 90);
  g.lel = clamp(jitter(g.lel+(target.lel-g.lel)*0.15, 0.30),  0, 40);
  return g;
}
function clamp(v,min,max){ return Math.min(max,Math.max(min,v)); }

/* 작업자 생체신호(심박·체온·산소포화도) 시뮬레이션
   — 화면 표시용 장식이 아니라, 상태 분류(안전/주의/위험)의 실제 입력값.
   주변 가스(저산소·유해가스)와 체류 시간에 따라 스스로 변한다. */
const vitalsCache = new Map();   // id -> {bpm,temp,spo2} (부드럽게 변하는 실수 상태)

function seedVitals(w){
  let v = vitalsCache.get(w.id);
  if(!v){ v = { bpm:78, temp:36.6, spo2:98 }; vitalsCache.set(w.id, v); }
  return v;
}
/* 환경 스트레스 지수 0~1 — 심박/체온↑, 산소포화도↓ 를 유발 */
function bodyStress(w){
  const th = state.settings.thresholds;
  const g  = gasCache.get(w.id) || simGas(w);
  const o2Def = clamp((th.o2Low + 2 - g.o2) / 4, 0, 1);                 // 산소 결핍
  const toxic = clamp((Math.max(g.h2s/th.h2s, g.co/th.co, g.lel/th.lel) - 0.5) / 0.5, 0, 1); // 유해가스
  const dwell = clamp(((now()-(w.enteredAt||now()))/60000) / 90, 0, 1) * 0.18;               // 장시간 체류(최대 +0.18)
  return clamp(Math.max(o2Def, toxic) + dwell, 0, 1);
}
/* 한 스텝 진행 후 반올림한 측정값 반환 */
function simVitals(w){
  const v = seedVitals(w);
  const S = bodyStress(w);
  const tBpm  = 78 + S*52;      // 78 → 130
  const tTemp = 36.6 + S*1.7;   // 36.6 → 38.3
  const tSpo2 = 98 - S*13;      // 98 → 85
  v.bpm  += (tBpm -v.bpm )*0.15 + (Math.random()-0.5)*1.6;
  v.temp += (tTemp-v.temp)*0.08 + (Math.random()-0.5)*0.04;
  v.spo2 += (tSpo2-v.spo2)*0.12 + (Math.random()-0.5)*0.4;
  return readVitals(w);
}
function readVitals(w){
  const v = seedVitals(w);
  return { bpm:Math.round(clamp(v.bpm,55,165)), temp:+clamp(v.temp,35.5,40).toFixed(1), spo2:Math.round(clamp(v.spo2,80,100)) };
}

/* 개별 생체지표 상태: 'ok' | 'warn' | 'danger' */
function bpmStat(bpm){ const vt=state.settings.vitals;
  if(bpm>=vt.bpmDanger || bpm<=vt.bpmLowDanger) return 'danger';
  if(bpm>=vt.bpmWarn   || bpm<=vt.bpmLowWarn)   return 'warn';
  return 'ok';
}
function tempStat(t){ const vt=state.settings.vitals; return t>=vt.tempDanger?'danger':t>=vt.tempWarn?'warn':'ok'; }
function spo2Stat(s){ const vt=state.settings.vitals; return s<=vt.spo2Danger?'danger':s<=vt.spo2Warn?'warn':'ok'; }
const worseLevel = (a,b)=> (a==='danger'||b==='danger')?'danger' : (a==='warn'||b==='warn')?'warn' : 'ok';

/* 작업자 생체 종합 상태 → {level, note, reading} */
function vitalStatus(w){
  const r = readVitals(w);
  const parts = [
    { s:bpmStat(r.bpm),   d:r.bpm >= state.settings.vitals.bpmWarn ? '심박 급상승' : '서맥(심박 저하)' },
    { s:tempStat(r.temp), d:'체온 상승' },
    { s:spo2Stat(r.spo2), d:'산소포화도 저하' },
  ];
  let level='ok', note='';
  // danger 우선, 없으면 warn 사유를 노트로
  const dg = parts.find(p=>p.s==='danger'); const wn = parts.find(p=>p.s==='warn');
  parts.forEach(p=>{ level = worseLevel(level, p.s); });
  if(dg) note = dg.d; else if(wn) note = wn.d;
  return { level, note, reading:r };
}

/* 개별 가스 상태: 'ok' | 'warn' | 'danger' */
function gasStatus(kind, val){
  const th = state.settings.thresholds;
  if(kind==='o2'){
    if(val < th.o2Low || val > th.o2High) return 'danger';
    if(val < th.o2Low+1 || val > th.o2High-1) return 'warn';
    return 'ok';
  }
  const limit = th[kind];
  if(val >= limit) return 'danger';
  if(val >= limit*0.8) return 'warn';
  return 'ok';
}

/* 작업자 종합 상태 판정 → {level, note} */
function evalWorker(w){
  if(w.connState==='connecting') return { level:'ok', note:'AR·태블릿 연결 중', connecting:true };
  if(w.returning) return { level:'ok', note:'복귀 중', returning:true };
  const g = gasCache.get(w.id) || simGas(w);
  const gasLevels = [gasStatus('o2',g.o2),gasStatus('h2s',g.h2s),gasStatus('co',g.co),gasStatus('lel',g.lel)];
  const gasDanger = gasLevels.includes('danger');
  const gasWarn   = gasLevels.includes('warn');

  const vs = vitalStatus(w);   // 생체신호 종합

  const intervalMs = state.settings.intervalMin*60*1000;
  const graceMs    = state.settings.graceSec*1000;
  const sinceResp  = now() - (w.lastResponseAt || w.enteredAt || now());
  const overdue    = sinceResp - intervalMs;   // >0 이면 확인 요청 시점 경과
  const still      = isStill(w);               // 무움직임(정지) 여부

  // ── 위험(danger) 판정 ──
  // 가스·생체 위험은 즉시 위험. 안전확인 무응답은 '움직임이 없고 위험 수준'일 때만 119·구조로 격상한다.
  if(gasDanger) return { level:'danger', note:'가스 임계치 초과' };
  if(vs.level==='danger') return { level:'danger', note:'생체 위험 · '+vs.note };
  if(overdue > graceMs && still) return { level:'danger', note:'119 연락 · 무응답·무움직임', noMove:true };

  // ── 안전확인 응답(작업자 몫) 단계적 경고 ──
  //   ① 요청 중(응답 대기) → ② 무전 확인 → ③ 퇴장 권고
  if(overdue > 0){
    if(overdue <= graceMs)   return { level:'warn', note:'안전확인 요청 중', needRespond:true, remain:Math.ceil((graceMs-overdue)/1000) };
    if(overdue <= graceMs*2) return { level:'warn', note:'무전 확인 중', radioCall:true };
    return { level:'warn', note:'퇴장 권고 · 안전확인 무응답', exitUrge:true };
  }
  // ── 그 외 주의(warn) 판정 ──
  if(gasWarn) return { level:'warn', note:'가스 농도 주의' };
  if(vs.level==='warn') return { level:'warn', note:'생체 주의 · '+vs.note };

  const untilCheck = Math.ceil((intervalMs - sinceResp)/1000);
  return { level:'ok', note:`다음 확인 ${fmtDur(untilCheck)}` };
}

/* ============================ 4. 렌더링 ============================ */
let currentView = 'dashboard';
const VIEW_TITLES = { dashboard:'실시간 감시', prep:'작업 준비', records:'기록', settings:'설정' };
const PHASE_LABELS = { dashboard:'감시', prep:'준비', records:'기록', settings:'설정' };

function insideWorkers(){ return state.workers.filter(w=>w.inside); }

function switchView(view){
  currentView = view;
  closeDetail();
  $$('.view').forEach(v=>v.hidden = (v.id !== 'view-'+view));
  $$('.tab').forEach(t=>t.classList.toggle('is-active', t.dataset.view===view));
  $('#settings-btn').classList.toggle('is-active', view==='settings');
  $('#view-title').textContent = VIEW_TITLES[view] || '';
  const ph = $('#statstrip-phase'); if(ph) ph.textContent = PHASE_LABELS[view] || '';
  renderView(view);
  const appEl = $('#app'); if(appEl) appEl.scrollTop = 0;
}

function renderView(view){
  if(view==='dashboard') renderDashboard(true);
  else if(view==='prep') renderPrep();
  else if(view==='records') renderRecords();
  else if(view==='settings') renderSettings();
}

/* ---------- 공통: 내부 인원 · 상단 상태 스트립 ---------- */
function renderInsideCounts(){
  const n = insideWorkers().length;
  const badge = $('#tab-inside-badge');
  if(badge){ badge.textContent = n; badge.hidden = n===0; }
  updateStatStrip();
}

/* 상단 상시 상태 스트립: 모든 화면에서 내부 인원·등급 노출 */
function updateStatStrip(){
  const list = insideWorkers();
  const c = {ok:0,warn:0,danger:0};
  list.forEach(w=>c[evalWorker(w).level]++);
  const set=(id,v)=>{ const e=$(id); if(e) e.textContent=v; };
  set('#ss-inside', list.length);
  set('#ss-ok', c.ok); set('#ss-warn', c.warn); set('#ss-danger', c.danger);
  const strip = $('#statstrip'); if(strip) strip.classList.toggle('has-danger', c.danger>0);
}

/* ---------- 대시보드 (관제 뷰) ---------- */
let alertGrade = 'all';             // 경보등급 필터 all|danger|warn
let selectedId = null;              // 상세 팝오버 대상
let lastInsideKey = '';             // 마커 재생성 판단
let lastAlarmSig  = '';             // 경보 리스트 재렌더 판단

/* 하수관로 종단면도 — 맨홀 수직구(shaft)와 심도(depth)로 표현
   세로축: 지표면(SURF %)에서 1m 당 SCALE % 씩 내려감 → 심도가 위치로 보임 */
const SURF = 20;        // 지표면 위치(%)
const SCALE = 10;       // 1m 당 세로 비율(%)
const DEPTH_MAX = 6;    // 심도 축 최대(m)
const TUBE = 9;         // 본관 터널 내부 높이(%) ≈ 관경
const WATER = 2.6;      // 관 바닥 물 높이(%)
const SHAFT_HW = 1.9;   // 맨홀 수직구 반폭(%)
const depthY = d => SURF + d*SCALE;    // 심도(m) → 관 바닥(invert) 세로위치(%)

/* 가로 축척: 종단면도 폭(맨홀 A~J = x 14~78%)에 실제 거리 합(ΣSEG_DIST)이 대응
   → 1% ≈ 3.7 m. 세로는 1% = 1/SCALE m (=0.1 m). 이동 속도/반경을 실제 m 기준으로 환산 */
const M_PER_PCT_X = 3.7;               // 가로 1% 당 실제 거리(m)
const PCT_PER_M_X = 1 / M_PER_PCT_X;   // 실제 1m 당 가로 %

const MANHOLES = [
  { id:'A', label:'MH-01', x:14, depth:2.4 },
  { id:'B', label:'MH-02', x:20, depth:2.9 },
  { id:'C', label:'MH-03', x:26, depth:3.4 },
  { id:'D', label:'MH-04', x:32, depth:3.9 },
  { id:'E', label:'MH-05', x:38, depth:4.3 },
  { id:'F', label:'MH-06', x:44, depth:4.8 },
  { id:'G', label:'MH-07', x:49, depth:5.2 },
  { id:'H', label:'MH-08', x:58, depth:5.6 },
  { id:'I', label:'MH-09', x:68, depth:6.0 },
  { id:'J', label:'MH-10', x:78, depth:6.3 },
];
const MH_BY_ID = Object.fromEntries(MANHOLES.map(m=>[m.id,m]));

/* x위치(%) → 그 지점의 관로 심도(m) : 인접 맨홀 사이를 선형 보간(관로 경사 반영) */
function depthAtX(x){
  const P = MANHOLES;
  if(x <= P[0].x) return P[0].depth;
  if(x >= P[P.length-1].x) return P[P.length-1].depth;
  for(let i=0;i<P.length-1;i++){
    if(x>=P[i].x && x<=P[i+1].x){
      const t=(x-P[i].x)/(P[i+1].x-P[i].x);
      return P[i].depth + t*(P[i+1].depth-P[i].depth);
    }
  }
  return P[0].depth;
}
/* x위치(%) → 관로 내부 중심의 세로위치(%) : 작업자는 항상 이 선 위(관로 안)에 머문다 */
const pipeCenterY = x => depthY(depthAtX(x)) - TUBE/2;
const MH_CHAIN = MANHOLES.map(m=>m.id);
const WORKER_SLOTS = ['A','D','G','B','E','C','F'];  // 서로 벌려 배치(겹침 방지)
let workerMH = new Map();            // workerId -> 배정된 맨홀

/* 하수관로 종단면도(내부 상세) 1회 생성 — CAD 스타일 */
const GL = 45.00;                                              // 지반고(m, 평탄 가정)
const SEG_DIST = [25,28,30,26,24,30,27,25,22];                 // 맨홀 간 거리(m)
const SEG_DIA  = [300,300,400,400,450,450,500,500,600];        // 관경 ø(mm)

function buildSewer(){
  const P = MANHOLES.map(m=>({ id:m.id, label:m.label, x:m.x, depth:m.depth, yb:depthY(m.depth) }));
  const n = P.length;
  const top    = P.map(p=>`${p.x},${(p.yb-TUBE).toFixed(2)}`);   // 관 상단(crown)
  const bot    = P.map(p=>`${p.x},${p.yb.toFixed(2)}`);          // 관 바닥(invert)
  const watTop = P.map(p=>`${p.x},${(p.yb-WATER).toFixed(2)}`);  // 수면
  const botAxis = depthY(DEPTH_MAX);
  const x0=P[0].x, xN=P[n-1].x, dimY=90, axX=4;

  let svg = '';
  // 지층
  svg += `<rect class="soil"  x="0" y="${SURF}" width="100" height="${100-SURF}"/>`;
  svg += `<rect class="soil2" x="0" y="${SURF+40}" width="100" height="${Math.max(0,60-SURF)}"/>`;
  svg += `<rect class="asphalt" x="0" y="${SURF}" width="100" height="1.6"/>`;
  // 심도 눈금선 / 측점 수직선
  for(let m=1;m<=DEPTH_MAX;m++){ const y=SURF+m*SCALE; svg += `<line class="depthline" x1="${axX}" y1="${y}" x2="100" y2="${y}"/>`; }
  P.forEach(p=>{ svg += `<line class="grid-sta" x1="${p.x}" y1="12" x2="${p.x}" y2="${dimY}"/>`; });
  svg += `<line class="surface" x1="0" y1="${SURF}" x2="100" y2="${SURF}"/>`;
  // 본관 단면: 내부 → 물 → 관벽
  svg += `<polygon class="tube-fill"  points="${top.join(' ')} ${bot.slice().reverse().join(' ')}"/>`;
  svg += `<polygon class="tube-water" points="${watTop.join(' ')} ${bot.slice().reverse().join(' ')}"/>`;
  svg += `<polyline class="tube-wall" points="${top.join(' ')}"/>`;
  svg += `<polyline class="tube-wall" points="${bot.join(' ')}"/>`;
  svg += `<polyline class="tube-water-line" points="${watTop.join(' ')}"/>`;
  // 맨홀 상세: 수직구(riser) + 콘(cone) + 작업실(chamber) + 발판 + 뚜껑
  const Wr=2.0, Wc=3.4;
  P.forEach(p=>{
    const chTop = Math.max(SURF+4, p.yb-(TUBE+7));   // 작업실 상단
    const riserBot = chTop-3;                        // 콘 시작
    svg += `<rect class="mh-fill" x="${(p.x-Wr/2).toFixed(2)}" y="${SURF}" width="${Wr}" height="${Math.max(0,riserBot-SURF).toFixed(2)}"/>`;
    svg += `<rect class="mh-fill" x="${(p.x-Wc/2).toFixed(2)}" y="${chTop.toFixed(2)}" width="${Wc}" height="${(p.yb-chTop).toFixed(2)}"/>`;
    // 벽체
    const w=[
      [p.x-Wr/2,SURF, p.x-Wr/2,riserBot], [p.x+Wr/2,SURF, p.x+Wr/2,riserBot],
      [p.x-Wr/2,riserBot, p.x-Wc/2,chTop], [p.x+Wr/2,riserBot, p.x+Wc/2,chTop],
      [p.x-Wc/2,chTop, p.x-Wc/2,p.yb], [p.x+Wc/2,chTop, p.x+Wc/2,p.yb],
    ];
    w.forEach(([x1,y1,x2,y2])=> svg += `<line class="mh-wall" x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}"/>`);
    for(let y=SURF+3; y<p.yb-1; y+=2.6){ svg += `<line class="rung" x1="${(p.x-0.9).toFixed(2)}" y1="${y.toFixed(2)}" x2="${(p.x+0.9).toFixed(2)}" y2="${y.toFixed(2)}"/>`; }
    svg += `<rect class="frame" x="${(p.x-3.0).toFixed(2)}" y="${(SURF-0.5).toFixed(2)}" width="6.0" height="0.9"/>`;
    svg += `<rect class="cover" x="${(p.x-2.4).toFixed(2)}" y="${(SURF-1.7).toFixed(2)}" width="4.8" height="1.5"/>`;
  });
  // 좌측 심도 치수선
  svg += `<line class="dim-line" x1="${axX}" y1="${SURF}" x2="${axX}" y2="${botAxis}"/>`;
  for(let m=0;m<=DEPTH_MAX;m++){ const y=SURF+m*SCALE; svg += `<line class="dim-tick" x1="${axX-0.8}" y1="${y}" x2="${axX+0.8}" y2="${y}"/>`; }
  // 하단 거리 치수선 + 보조선
  svg += `<line class="dim-line" x1="${x0}" y1="${dimY}" x2="${xN}" y2="${dimY}"/>`;
  P.forEach(p=>{
    svg += `<line class="dim-tick" x1="${p.x}" y1="${(dimY-0.9).toFixed(2)}" x2="${p.x}" y2="${(dimY+0.9).toFixed(2)}"/>`;
    svg += `<line class="dim-ext" x1="${p.x}" y1="${p.yb.toFixed(2)}" x2="${p.x}" y2="${dimY}"/>`;
  });
  $('#stage-pipes').innerHTML = svg;

  // ---- HTML 주기(텍스트) ----
  let html = '';
  for(let m=0;m<=DEPTH_MAX;m++){ html += `<div class="depth-tick" style="top:${SURF+m*SCALE}%">${m===0?'G.L':'-'+m+'.0'}</div>`; }
  P.forEach(p=>{ html += `<div class="mh-bubble" style="left:${p.x}%;top:13%">${p.label.replace('MH-','')}</div>`; });
  for(let i=0;i<n-1;i++){
    const mx=(P[i].x+P[i+1].x)/2, my=((P[i].yb+P[i+1].yb)/2)-TUBE-2.2;
    const slope=((P[i+1].depth-P[i].depth)/SEG_DIST[i]*100).toFixed(1);
    html += `<div class="seg-label" style="left:${mx}%;top:${my}%">ø${SEG_DIA[i]} · ${slope}%</div>`;
    html += `<div class="dist-label" style="left:${mx}%;top:91.6%">${SEG_DIST[i].toFixed(1)}</div>`;
  }
  P.forEach(p=>{ html += `<div class="mh-il" data-mh="${p.id}" style="left:${p.x}%;top:${(p.yb+1.6)}%">IL ${(GL-p.depth).toFixed(2)}</div>`; });
  $('#stage-nodes').innerHTML = html;
}

/* 작업자 → 맨홀 배정 (입장 시 정한 맨홀 w.mh 유지 → 안정적) */
function assignManholes(list){
  workerMH = new Map();
  const used = new Set();
  list.forEach(w=>{ if(w.mh && MH_BY_ID[w.mh] && !used.has(w.mh)){ used.add(w.mh); workerMH.set(w.id, MH_BY_ID[w.mh]); } });
  list.forEach(w=>{ if(!workerMH.has(w.id)){
    const slot = WORKER_SLOTS.find(s=>!used.has(s)) || WORKER_SLOTS[used.size % WORKER_SLOTS.length];
    used.add(slot); w.mh = slot; workerMH.set(w.id, MH_BY_ID[slot]);
  }});
}
function freeSlot(){
  const used = new Set(insideWorkers().map(w=>w.mh).filter(Boolean));
  return WORKER_SLOTS.find(s=>!used.has(s)) || WORKER_SLOTS[used.size % WORKER_SLOTS.length];
}

/* 작업자 실시간 위치/이동 상태 (입구 하강 + 무작위 이동/정지) */
const wpos = new Map();                 // id -> {x,y,cx,cy,tx,ty,st,until}
/* 이동 파라미터(화면상 또렷하게 보이도록 조정) */
const DESCEND_SPEED = 2.6;              // 입구→작업심도 하강 속도(세로 %/s)
const MOVE_SPEED    = 1.2;              // 관로 내 이동 속도(가로 %/s) — 천천히 걷는 느낌
const WANDER_X = 3.6;                   // 작업 반경(맨홀 기준 좌우 ±%)
const WANDER_Y = 1.4;                   // 관 내부 상하 여유(±%)
const WANDER_MIN_X = 11, WANDER_MAX_X = 53;   // 이동 허용 구간(좌우 패널·가장자리 회피)
const rnd = (a,b)=> a + Math.random()*(b-a);

/* 무움직임(정지) 감지 — 이 시간 동안 위치 변화가 없으면 '움직임 없음'으로 간주.
   무의식·쓰러짐의 신호로, 안전확인 무응답과 겹치면 119·구조로 격상하는 조건이 된다. */
const STILL_MS = 12000;
function isStill(w){
  const p = wpos.get(w.id);
  if(!p || p.st==='connect') return false;          // 연결 대기 중엔 판정 보류
  return now() - (p.lastMoveAt || w.enteredAt || now()) >= STILL_MS;
}
/* 안전확인이 얼마나 지났는지(ms). >0 이면 확인 주기 경과 */
function overdueMs(w){ return now() - (w.lastResponseAt || w.enteredAt || now()) - state.settings.intervalMin*60*1000; }
/* 무전 확인 단계까지 지나도 무응답이면 작업자가 이동을 멈춘 것으로 본다(정지 유지 → 무움직임 격상) */
function nonRespondFrozen(w){ return overdueMs(w) > state.settings.graceSec*1000*2; }

function ensureWpos(id, mh){
  let p = wpos.get(id);
  if(!p){ const cy = depthY(mh.depth)-TUBE/2; p = { x:mh.x, y:cy, cx:mh.x, cy, tx:mh.x, ty:cy, st:'pause', until:0, lastMoveAt:now() }; wpos.set(id, p); }
  return p;
}
/* 입장 직후: AR·태블릿 연결 대기 (지표면에서 대기, 하강 보류) */
function startConnect(id, mh){
  const cy = depthY(mh.depth)-TUBE/2;
  wpos.set(id, { x:mh.x, y:SURF+1, cx:mh.x, cy, tx:mh.x, ty:SURF+1, st:'connect', until:0, lastMoveAt:now() });
}
/* 연결 완료: 입구(지표면)에서 작업 심도까지 하강 시작 */
function startDescent(id, mh){
  const cy = depthY(mh.depth)-TUBE/2;
  const p = wpos.get(id);
  const y = p ? p.y : SURF+1;
  wpos.set(id, { x:mh.x, y, cx:mh.x, cy, tx:mh.x, ty:cy, st:'descend', until:0, lastMoveAt:now() });
}
function curDepthOf(id, fallback){
  const p = wpos.get(id);
  return p ? Math.max(0, (p.y-SURF)/SCALE) : fallback;
}

/* structure=true 면 마커 DOM 재생성, 아니면 값만 갱신 */
function renderDashboard(structure){
  renderInsideCounts();
  const list = insideWorkers();
  const key = list.map(w=>w.id).join(',');
  if(structure || key !== lastInsideKey){ buildMarkers(list); lastInsideKey = key; }

  list.forEach(w=>{
    const g = simGas(w), vr = simVitals(w), ev = evalWorker(w);
    const el = $(`#mk-${w.id}`); if(!el) return;
    el.className = `mk is-${ev.level}${ev.connecting?' is-connecting':''}`;
    const mh = workerMH.get(w.id);
    $('.mk__meta',el).textContent = `${mh?mh.label:''} · 심도 ${curDepthOf(w.id, mh?mh.depth:0).toFixed(1)}m · ${fmtDur((now()-w.enteredAt)/1000)}`;
    $('.mk__gas',el).textContent  = `O₂ ${g.o2.toFixed(1)} · H₂S ${g.h2s.toFixed(0)} · CO ${g.co.toFixed(0)}`;
    const vt = $('.mk__vital',el);
    vt.innerHTML = `심박 <b class="is-${bpmStat(vr.bpm)}">${vr.bpm}</b> · SpO₂ <b class="is-${spo2Stat(vr.spo2)}">${vr.spo2}</b> · 체온 <b class="is-${tempStat(vr.temp)}">${vr.temp}°</b>`;
    const nt = $('.mk__note',el); nt.textContent = ev.note; nt.className = 'mk__note is-'+ev.level;
  });

  renderEnvPanel(list);
  renderAlertPanel();
  if(selectedId) syncDetail();
}

function buildMarkers(list){
  assignManholes(list);
  const wrap = $('#stage-markers');
  $('#stage-empty').hidden = list.length>0;
  // 작업자가 있는 맨홀은 심도 라벨을 감춤(마커가 대신 표시)
  const occ = new Set([...workerMH.values()].map(m=>m.id));
  $$('#stage-nodes .mh-il').forEach(n=>n.classList.toggle('is-occupied', occ.has(n.dataset.mh)));
  wrap.innerHTML = list.map(w=>{
    const m = workerMH.get(w.id);
    const p = ensureWpos(w.id, m);
    return `<button class="mk is-ok" id="mk-${w.id}" data-mk="${w.id}" style="left:${p.x}%;top:${p.y}%">
      <span class="mk__pin"><span class="mk__ring"></span><span class="mk__ico"></span></span>
      <span class="mk__label">
        <span class="mk__name">${escapeHtml(w.name)}</span>
        <span class="mk__meta"></span>
        <span class="mk__gas"></span>
        <span class="mk__vital"></span>
        <span class="mk__note is-ok"></span>
      </span>
    </button>`;
  }).join('');
}

/* 좌상단 현장 정보 */
function renderEnvPanel(list){
  const c = {ok:0,warn:0,danger:0};
  const sum = {o2:0,h2s:0,co:0,lel:0};
  const n = list.length;
  list.forEach(w=>{
    c[evalWorker(w).level]++;
    const g = gasCache.get(w.id) || simGas(w);
    sum.o2+=g.o2; sum.h2s+=g.h2s; sum.co+=g.co; sum.lel+=g.lel;
  });
  $('#env-inside').textContent = n;
  $('#env-ok').textContent = c.ok;
  $('#env-warn').textContent = c.warn;
  $('#env-danger').textContent = c.danger;
  const setGas=(id,kind,val,dec)=>{
    const e = $(id);
    if(!n){ e.textContent='--'; e.parentElement.className='env-gas'; return; }
    e.textContent = val.toFixed(dec);
    e.parentElement.className = 'env-gas is-'+gasStatus(kind,val);
  };
  setGas('#env-o2', 'o2',  n?sum.o2/n:0, 1);
  setGas('#env-h2s','h2s', n?sum.h2s/n:0, 0);
  setGas('#env-co', 'co',  n?sum.co/n:0, 0);
  setGas('#env-lel','lel', n?sum.lel/n:0, 1);
}

/* 우상단 경고 패널 (카운트는 매번, 리스트는 변경 시에만) */
function renderAlertPanel(){
  const c = {danger:0,warn:0,ok:0};
  insideWorkers().forEach(w=>c[evalWorker(w).level]++);
  $('#al-danger').textContent = c.danger;
  $('#al-warn').textContent   = c.warn;
  $('#al-ok').textContent     = c.ok;

  let rows = [...state.alarms].sort((a,b)=>b.ts-a.ts);
  if(alertGrade!=='all') rows = rows.filter(a=>a.level===alertGrade);
  rows = rows.slice(0,40);
  const sig = alertGrade+'|'+rows.map(r=>r.id).join(',');
  if(sig === lastAlarmSig) return;
  lastAlarmSig = sig;
  $('#al-empty').hidden = rows.length>0;
  $('#al-list').innerHTML = rows.map(a=>`
    <div class="al-row">
      <span class="al-dot is-${a.level}"></span>
      <div class="al-msg">
        <div class="al-msg__t">${escapeHtml(a.message)}</div>
        ${a.who?`<div class="al-msg__s">${escapeHtml(a.who)}</div>`:''}
      </div>
      <div class="al-time">${fmtHM(a.ts)}<br><span>${dateKey(a.ts)}</span></div>
    </div>`).join('');
}

/* 마커 선택 → AR 카메라 뷰(마커 대각선 위) */
function openDetail(id){ selectedId=id; $('#stage-detail').hidden=false; syncDetail(); positionAR(); }
function closeDetail(){
  selectedId=null;
  $('#stage-detail').hidden=true;
  const l=$('#ar-link'); if(l) l.hidden=true;
}

/* AR 카드를 마커(현재 위치)의 대각선 위쪽에 배치 */
function positionAR(){
  const p=wpos.get(selectedId); if(!p) return;
  const S=$('.stage').getBoundingClientRect();
  const el=$('#stage-detail');
  const cw=el.offsetWidth, ch=el.offsetHeight, gap=14;
  const mx=S.width*p.x/100, my=S.height*p.y/100;
  let left=mx+gap, top=my-ch-gap;
  if(left+cw > S.width-8)  left=mx-cw-gap;
  if(left<8) left=8;
  if(top<8) top=my+gap;
  if(top+ch > S.height-8) top=S.height-8-ch;
  el.style.left=left+'px'; el.style.top=top+'px';
  updateARLink();
}
/* 마커 ↔ 카드 연결선 갱신(이동 추종) */
function updateARLink(){
  const p=wpos.get(selectedId); if(!p) return;
  const S=$('.stage').getBoundingClientRect();
  const el=$('#stage-detail');
  const cl=el.offsetLeft, ct=el.offsetTop, cw=el.offsetWidth, ch=el.offsetHeight;
  const mx=S.width*p.x/100, my=S.height*p.y/100;
  const ax=Math.max(cl+8, Math.min(cl+cw-8, mx));
  const ay=(my>=ct+ch)?ct+ch : (my<=ct?ct:my);
  const ln=$('#ar-link-l'), dot=$('#ar-link-d');
  ln.setAttribute('x1',mx); ln.setAttribute('y1',my); ln.setAttribute('x2',ax); ln.setAttribute('y2',ay);
  dot.setAttribute('cx',mx); dot.setAttribute('cy',my);
  $('#ar-link').hidden=false;
}

/* 위치 애니메이션 루프: 입구 하강 → 무작위 이동/정지(작업) */
let _lastFrame=null;
function animateWorkers(t){
  requestAnimationFrame(animateWorkers);
  if(_lastFrame==null){ _lastFrame=t; return; }
  const dt=Math.min(0.05,(t-_lastFrame)/1000); _lastFrame=t;
  if(currentView!=='dashboard') return;
  insideWorkers().forEach(w=>{
    const p=wpos.get(w.id); if(!p) return;
    if(p.st==='connect'){
      // AR·태블릿 연결 대기 — 지표면에서 정지
    } else if(p.st==='ascend'){
      // 복귀 — 맨홀 위(지표면)로 천천히 상승
      p.x=p.cx;
      p.y=Math.max(SURF+1, p.y - ASCEND_SPEED*dt);
      p.lastMoveAt=now();
      if(p.y<=SURF+1.1){ p.y=SURF+1; finalizeReturn(w.id); return; }
    } else if(p.st==='descend'){
      p.x=p.cx;
      p.y=Math.min(p.cy, p.y + DESCEND_SPEED*dt);
      p.lastMoveAt=now();
      if(p.y>=p.cy-0.15){ p.y=p.cy; p.st='pause'; p.until=t+rnd(3000,6000); }
    } else if(p.st==='pause'){
      // 안전확인 무응답이 무전 단계까지 지속되면 이동을 멈춘다(정지 유지 → 무움직임 격상)
      if(nonRespondFrozen(w)){ p.until=t+1500; }
      else if(t>=p.until){
        p.tx = clamp(p.cx + rnd(-WANDER_X, WANDER_X), WANDER_MIN_X, WANDER_MAX_X);
        p.ty = pipeCenterY(p.tx) + rnd(-WANDER_Y, WANDER_Y);  // 관로 경사를 따라가 항상 관 안에 머문다
        p.st='move';
      }
    } else {
      const dx=p.tx-p.x, dy=p.ty-p.y, d=Math.hypot(dx,dy), step=MOVE_SPEED*dt;
      if(d<=step){ p.x=p.tx; p.y=p.ty; p.st='pause'; p.until=t+rnd(4500,9000); }
      else { p.x+=dx/d*step; p.y+=dy/d*step; }
      p.lastMoveAt=now();
    }
    const el=document.getElementById('mk-'+w.id);
    if(el){ el.style.left=p.x+'%'; el.style.top=p.y+'%'; }
  });
  if(selectedId && !$('#stage-detail').hidden) updateARLink();
}
function syncDetail(){
  const w = state.workers.find(x=>x.id===selectedId);
  if(!w || !w.inside){ closeDetail(); return; }
  const g = simGas(w), ev = evalWorker(w), mh = workerMH.get(selectedId);

  // 헤더
  $('#sd-name').textContent = w.name;
  $('#sd-loc').textContent  = mh ? mh.label : (w.location||'');
  $('#ar-cam').className = 'ar-cam is-'+ev.level;

  // O₂ (헤더 표시)
  const o2st = gasStatus('o2', g.o2);
  $('#ar-o2').textContent = g.o2.toFixed(1);
  $('#ar-o2-dot').className = 'is-'+o2st;

  // 상태 칩
  const chip = $('#ar-status');
  chip.className = 'ar-chip is-'+ev.level;
  chip.textContent = ev.connecting ? 'AR 연결 중' : (ev.level==='danger'?'위험':ev.level==='warn'?'주의':'정상');

  // 가스 스트립
  const setG = (wrapId, valId, kind, val, dec)=>{
    $(wrapId).className = 'is-'+gasStatus(kind, val);
    $(valId).textContent = val.toFixed(dec);
  };
  setG('#ar-h2s-w','#ar-h2s','h2s', g.h2s, 0);
  setG('#ar-co-w', '#ar-co', 'co',  g.co,  0);
  setG('#ar-lel-w','#ar-lel','lel', g.lel, 0);

  // 생체신호 (심박·산소포화도·체온) — 색상으로 등급 표시
  const vr = readVitals(w);
  $('#ar-bpm').textContent  = vr.bpm;
  $('#ar-spo2').textContent = vr.spo2;
  $('#ar-temp').textContent = vr.temp;
  $('#ar-bpm-w').className  = 'ar-strip__v is-'+bpmStat(vr.bpm);
  $('#ar-spo2-w').className = 'ar-strip__v is-'+spo2Stat(vr.spo2);
  $('#ar-temp-w').className = 'ar-strip__v is-'+tempStat(vr.temp);
  $('#ar-depthv').textContent = curDepthOf(selectedId, mh?mh.depth:0).toFixed(1);

  // 경고 배너: 위험=119·구조 / 무전 확인 / 퇴장 권고
  const warn = $('#ar-warn');
  if(ev.level==='danger'){ warn.hidden=false; warn.className='ar-warn is-danger'; warn.textContent=ev.noMove ? ev.note : ('구조 필요 · '+ev.note); }
  else if(ev.radioCall){ warn.hidden=false; warn.className='ar-warn is-warn'; warn.textContent='무전으로 안전확인 요청 중 — 작업자 응답 대기'; }
  else if(ev.level==='warn' && ev.note!=='안전확인 요청 중'){ warn.hidden=false; warn.className='ar-warn is-warn'; warn.textContent=ev.exitUrge ? ev.note : ('주의 · '+ev.note); }
  else { warn.hidden=true; }

  // 복귀 버튼 상태 / 구조 버튼 강조
  const exitBtn = $('#sd-exit');
  exitBtn.disabled = !!w.returning;
  exitBtn.textContent = w.returning ? '복귀 중…' : '복귀';
  // 구조 버튼: 주의·위험일 때만 노출, 정상으로 돌아오면 사라짐
  const rescueBtn = $('#sd-rescue');
  rescueBtn.hidden = ev.level==='ok';
  rescueBtn.classList.toggle('is-hot', ev.level==='danger');
}

/* ---------- 준비: 입장 전 점검 + 작업자 입장 (통합) ---------- */
function renderPrep(){
  renderInsideCounts();
  renderChecklist();
  renderWorkerList();
}

/* 작업자 목록(입장/퇴장/수정/삭제). 입장은 체크리스트 완료 시에만 활성 */
function renderWorkerList(){
  const wrap = $('#worker-list');
  if(!wrap) return;
  $('#workers-empty').hidden = state.workers.length>0;
  const canEnter = allChecked();
  wrap.innerHTML = state.workers.map(w=>{
    const dur = w.inside ? fmtDurKo((now()-w.enteredAt)/1000) : null;
    return `
    <div class="wrow ${w.inside?'is-inside':''}">
      <div class="wrow__top">
        <div>
          <div class="wrow__name">${escapeHtml(w.name)}</div>
          <div class="wrow__loc">${w.assignedMh&&MH_BY_ID[w.assignedMh]?`<b class="wrow__mh">${MH_BY_ID[w.assignedMh].label}</b> · `:'<b class="wrow__mh is-unset">맨홀 미지정</b> · '}${escapeHtml(w.location||'구역 상세 없음')}</div>
          ${w.phone?`<div class="wrow__phone">${escapeHtml(w.phone)}</div>`:''}
        </div>
        ${w.inside?`<span class="badge-inside${w.connState==='connecting'?' is-connecting':''}">${w.connState==='connecting'?'AR 연결 중':w.returning?'복귀 중':'내부 · '+dur}</span>`:''}
      </div>
      <div class="wrow__actions">
        ${w.inside
          ? `<button class="btn btn--exit" data-act="return" data-id="${w.id}" ${w.returning?'disabled':''}>${w.returning?'복귀 중…':'복귀'}</button>`
          : `<button class="btn btn--enter" data-act="enter" data-id="${w.id}" ${canEnter?'':'disabled'}>입장</button>`}
        <div class="wrow__edit">
          <button class="btn btn--sm btn--ghost" data-act="edit" data-id="${w.id}">수정</button>
          <button class="btn btn--sm btn--ghost" data-act="delete" data-id="${w.id}">삭제</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

/* ---------- 체크리스트(준비 1단계) ---------- */
function renderChecklist(){
  const wrap = $('#checklist');
  if(!wrap) return;
  wrap.innerHTML = CHECK_ITEMS.map(c=>`
    <div class="check-item ${state.checklist[c.key]?'is-done':''}" data-check="${c.key}">
      <div class="check-box">
        <svg viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="#04220f" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
      <div class="check-text">
        <div class="check-text__title">${c.title}</div>
        <div class="check-text__desc">${c.desc}</div>
      </div>
    </div>`).join('');
  updatePrepGate();
}
function checklistDone(){ return CHECK_ITEMS.filter(c=>state.checklist[c.key]).length; }
function allChecked(){ return checklistDone()===CHECK_ITEMS.length; }

/* 점검 진행률 → 2단계(입장) 잠금/해제 */
function updatePrepGate(){
  const done = checklistDone(), total = CHECK_ITEMS.length, ok = done===total;
  const gate = $('#prep-gate');
  if(gate){ gate.textContent = `${done} / ${total}`; gate.classList.toggle('is-done', ok); }
  const step = $('#prep-workers-step'); if(step) step.classList.toggle('is-locked', !ok);
  const sub = $('#prep-workers-sub');
  if(sub) sub.textContent = ok ? '점검 완료 — 입장할 수 있습니다.' : `점검 ${total-done}개 남음 — 완료하면 입장이 열립니다.`;
  $$('#worker-list [data-act="enter"]').forEach(b=>{ b.disabled = !ok; });
}

/* ---------- 기록 ---------- */
let recordTab = 'journal';
function renderRecords(){
  $$('.record-tab').forEach(t=>t.classList.toggle('is-active', t.dataset.rtab===recordTab));
  $('#rpanel-journal').hidden = recordTab!=='journal';
  $('#rpanel-alarms').hidden  = recordTab!=='alarms';
  if(recordTab==='journal') renderJournal();
  else renderAlarms();
}
function renderJournal(){
  const di = $('#record-date');
  if(!di.value) di.value = dateKey(now());
  const key = di.value;
  const rows = state.logs.filter(l=>dateKey(l.enteredAt)===key).sort((a,b)=>b.enteredAt-a.enteredAt);
  $('#journal-empty').hidden = rows.length>0;
  $('#journal-list').innerHTML = rows.map(l=>`
    <div class="jrow">
      <div class="jrow__top">
        <div class="jrow__name">${escapeHtml(l.name)}</div>
        <div class="jrow__dur">${l.exitedAt?fmtDurKo(l.durationSec):'작업 중'}</div>
      </div>
      <div class="jrow__loc" style="font-size:14px;color:var(--txt-3);margin-top:2px">${l.mh&&MH_BY_ID[l.mh]?MH_BY_ID[l.mh].label+(l.location?' · ':''):''}${escapeHtml(l.location||'')}</div>
      <div class="jrow__times">입장 ${fmtHM(l.enteredAt)} ${l.exitedAt?`· 퇴장 ${fmtHM(l.exitedAt)}`:''}</div>
      <div class="jrow__chk ${l.checklistPassed?'ok':'no'}">체크리스트 ${l.checklistPassed?'완료 후 시작':'미기록'}</div>
    </div>`).join('');
}
function renderAlarms(){
  const rows = [...state.alarms].sort((a,b)=>b.ts-a.ts);
  $('#alarm-empty').hidden = rows.length>0;
  $('#alarm-list').innerHTML = rows.map(a=>`
    <div class="arow lvl-${a.level}">
      <div class="arow__top">
        <div class="arow__msg">${escapeHtml(a.message)}</div>
        <div class="arow__time">${fmtHM(a.ts)}<br>${dateKey(a.ts)}</div>
      </div>
      ${a.who?`<div class="arow__who">${escapeHtml(a.who)}</div>`:''}
    </div>`).join('');
}

/* ---------- 설정 ---------- */
function renderSettings(){
  const s = state.settings;
  $('#set-interval').value = s.intervalMin;
  $('#set-grace').value    = s.graceSec;
  $('#set-gasmode').value  = s.gasMode;
  $('#th-o2low').value  = s.thresholds.o2Low;
  $('#th-o2high').value = s.thresholds.o2High;
  $('#th-h2s').value    = s.thresholds.h2s;
  $('#th-co').value     = s.thresholds.co;
  $('#th-lel').value    = s.thresholds.lel;
  $('#vt-bpmwarn').value    = s.vitals.bpmWarn;
  $('#vt-bpmdanger').value  = s.vitals.bpmDanger;
  $('#vt-tempwarn').value   = s.vitals.tempWarn;
  $('#vt-tempdanger').value = s.vitals.tempDanger;
  $('#vt-spo2warn').value   = s.vitals.spo2Warn;
  $('#vt-spo2danger').value = s.vitals.spo2Danger;
}

/* ============================ 5. 액션 ============================ */
function addAlarm(level, message, who){
  state.alarms.push({ id:uid(), ts:now(), level, type:'', message, who:who||'' });
  if(state.alarms.length>500) state.alarms = state.alarms.slice(-500);
  save();
}

function enterWorker(id){
  const w = state.workers.find(x=>x.id===id); if(!w||w.inside) return;
  if(!allChecked()){
    toast('입장 전 안전점검 6개 항목을 모두 완료하세요.', 'danger');
    if(currentView!=='prep') switchView('prep');
    const cl = $('#checklist');
    if(cl){ cl.scrollIntoView({behavior:'smooth', block:'center'}); cl.classList.add('flash'); setTimeout(()=>cl.classList.remove('flash'), 1200); }
    return;
  }
  // 맨홀 지정 필수 + 중복 점유 차단
  if(!w.assignedMh || !MH_BY_ID[w.assignedMh]){
    toast('맨홀 번호를 먼저 지정하세요. [수정]에서 설정할 수 있습니다.','danger');
    openModal(w.id); return;
  }
  const mhId = w.assignedMh;
  if(insideWorkers().some(o=>o.mh===mhId)){
    toast(`${MH_BY_ID[mhId].label} 맨홀에 이미 작업 중인 작업자가 있습니다.`,'danger'); return;
  }

  w.inside = true;
  w.enteredAt = now();
  w.lastResponseAt = now();                // (연결 완료 시 재설정 → 안전확인 주기 시작)
  w.logId = uid();
  w.mh = mhId;                             // 지정 맨홀 사용
  w.connState = 'connecting';              // AR·태블릿 연결 대기
  w.connAt = now();
  startConnect(w.id, MH_BY_ID[w.mh]);      // 지표면에서 연결 대기(하강 보류)
  state.logs.push({ id:w.logId, name:w.name, location:w.location, mh:w.mh, enteredAt:w.enteredAt, exitedAt:null, durationSec:0, checklistPassed:true });
  gasCache.delete(w.id);
  save();
  toast(`${w.name} 입장 · ${MH_BY_ID[w.mh].label} · AR·태블릿 연결 중…`, 'ok');
  refreshAll();
}

/* AR·태블릿 연결 완료 시 실제 작업(하강/감시) 시작 */
const CONNECT_MS = 2600;
function promoteConnections(){
  let changed = false;
  insideWorkers().forEach(w=>{
    if(w.connState==='connecting' && now()-(w.connAt||0) >= CONNECT_MS){
      w.connState = 'connected';
      w.lastResponseAt = now();                 // 안전확인 주기는 작업 시작(연결) 시점부터
      startDescent(w.id, MH_BY_ID[w.mh]);       // 연결 완료 → 하강 시작
      addComm(w.id, 'in', '연결 완료 · 작업 시작, 이상 없음');
      toast(`${w.name} AR·태블릿 연결 완료 · 작업 시작`, 'ok');
      changed = true;
    }
  });
  if(changed){ save(); if(currentView==='dashboard') renderDashboard(true); }
}
function mhLabel(w){ return (w && MH_BY_ID[w.mh] && MH_BY_ID[w.mh].label) || (w&&w.location) || ''; }

/* 복귀 요청 — 맨홀 위(지표면)로 천천히 상승 시작. 도달 시 finalizeReturn */
const ASCEND_SPEED = 1.4;   // 상승 속도(세로 %/s) — 하강보다 느리게(천천히 복귀)
function requestReturn(id){
  const w = state.workers.find(x=>x.id===id); if(!w||!w.inside||w.returning) return;
  // 연결 중(아직 하강 전)이면 즉시 복귀 확정
  if(w.connState==='connecting'){ finalizeReturn(id); return; }
  w.returning = true;
  const p = wpos.get(id);
  if(p){ p.st='ascend'; p.tx=p.cx; p.ty=SURF+1; } else { finalizeReturn(id); return; }
  clearWorkerFlags(id);
  if(rescueTargetId===id) closeRescue();
  save();
  toast(`${w.name} 복귀 중 — 맨홀로 상승`, 'ok');
  refreshAll();
}

/* 지표면 도달 → 완전 복귀(입출입 기록 마감·상태 정리) */
function finalizeReturn(id){
  const w = state.workers.find(x=>x.id===id); if(!w||!w.inside) return;
  w.inside = false; w.returning = false;
  const exitedAt = now();
  const log = state.logs.find(l=>l.id===w.logId);
  if(log){ log.exitedAt = exitedAt; log.durationSec = Math.floor((exitedAt-log.enteredAt)/1000); }
  toast(`${w.name} 복귀 완료 · 작업 ${fmtDurKo((exitedAt-(w.enteredAt||exitedAt))/1000)}`, 'ok');
  w.enteredAt = null; w.logId = null; w.mh = null; w.connState = 'idle'; w.connAt = null;
  gasCache.delete(w.id); vitalsCache.delete(w.id); wpos.delete(w.id);
  clearWorkerFlags(w.id);
  if(rescueTargetId===id) closeRescue();
  if(selectedId===id) closeDetail();
  save();
  refreshAll();
}

/* 안전확인 응답은 '작업자'만 한다 — 관제(관리자)가 대신 눌러 확인 처리하지 않는다.
   작업자의 무전 응답(addComm 'in')이 오면 lastResponseAt 가 갱신되어 정상으로 복귀한다. */

function saveWorkerFromModal(){
  const name = $('#wf-name').value.trim();
  const mh = $('#wf-mh').value;
  const location = $('#wf-location').value.trim();
  const phone = $('#wf-phone').value.trim();
  if(!name){ toast('이름을 입력하세요.','danger'); return; }
  if(!mh || !MH_BY_ID[mh]){ toast('맨홀 번호를 선택하세요.','danger'); return; }
  if(editingId){
    const w = state.workers.find(x=>x.id===editingId);
    if(w){ w.name=name; w.assignedMh=mh; w.location=location; w.phone=phone; }
    toast('작업자 정보를 수정했습니다.','ok');
  }else{
    state.workers.push({ id:uid(), name, assignedMh:mh, location, phone, inside:false, connState:'idle', enteredAt:null, lastResponseAt:null, logId:null });
    toast('작업자를 등록했습니다.','ok');
  }
  save();
  closeModal();
  renderPrep();
}

function deleteWorker(id){
  const w = state.workers.find(x=>x.id===id); if(!w) return;
  if(w.inside){ toast('내부 작업 중인 작업자는 삭제할 수 없습니다. 먼저 퇴장 처리하세요.','danger'); return; }
  if(!confirm(`'${w.name}' 작업자를 삭제하시겠습니까?`)) return;
  state.workers = state.workers.filter(x=>x.id!==id);
  gasCache.delete(id); vitalsCache.delete(id); wpos.delete(id);
  save();
  renderPrep();
}

/* ---------- SOS / 전체 대피 ---------- */
function triggerSOS(){
  const inside = insideWorkers();
  if(!confirm('전체 대피 경보를 발령하고 전원 복귀시킵니다. 계속하시겠습니까?')) return;
  addAlarm('danger', '전체 대피(SOS) 발령', inside.length?`내부 인원 ${inside.length}명`:'현재 내부 인원 없음');
  addAlarm('danger', '119 신고 전화 발신', '전체 대피');
  // 상단만 빨간 테마 점멸 + 배너
  document.body.classList.add('sos-active');
  $('#sos-banner').hidden = false;
  // 전원 대피 → 맨홀 위로 상승 후 복귀(눈에 보이게)
  inside.forEach(w=>requestReturn(w.id));
  if(navigator.vibrate) navigator.vibrate([300,120,300,120,300]);
  toast(inside.length?`전체 대피 발령 · 119 신고 · ${inside.length}명 복귀`:'전체 대피 발령 · 119 신고', 'danger');
}
function clearSOS(){
  document.body.classList.remove('sos-active');
  $('#sos-banner').hidden = true;
}

/* ---------- 초기화/내보내기 ---------- */
function exportData(){
  const blob = new Blob([JSON.stringify(state,null,2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `안전관리_${dateKey(now())}.json`;
  a.click(); URL.revokeObjectURL(url);
}
function resetAll(){
  if(!confirm('모든 작업자·기록·경보 데이터를 삭제하고 초기화합니다. 계속하시겠습니까?')) return;
  state = defaultState(); gasCache.clear(); save();
  toast('초기화되었습니다.','ok');
  refreshAll(); renderSettings();
}

/* ============================ 경보 자동 감지 ============================ */
/* 루프에서 호출: 상태 전이 순간 1회만 기록.
   주의(warn) → 퇴장 권고 / 위험(danger) → 구조 알림 */
const alarmedSet = new Set();   // danger 이력 중복 방지 (id::type)
const warnedSet  = new Set();   // 퇴장 권고 중복 방지 (id::warn)
const rescueSet  = new Set();   // 구조 알림 중복 방지 (id)
function clearWorkerFlags(id){
  ['::gas','::resp','::vital','::warn','::radio'].forEach(s=>{ alarmedSet.delete(id+s); warnedSet.delete(id+s); });
  rescueSet.delete(id);
}

function autoDetectAlarms(){
  insideWorkers().forEach(w=>{
    if(w.connState==='connecting') return;   // 연결 중엔 판정 보류
    const ev = evalWorker(w);
    const vs = vitalStatus(w);
    const g  = gasCache.get(w.id) || simGas(w);
    const gasWarn = [gasStatus('o2',g.o2),gasStatus('h2s',g.h2s),gasStatus('co',g.co),gasStatus('lel',g.lel)].includes('warn');
    const loc = mhLabel(w);
    const gasKey=w.id+'::gas', respKey=w.id+'::resp', vitalKey=w.id+'::vital', warnKey=w.id+'::warn', radioKey=w.id+'::radio';

    // ── 위험(danger) 이력 ──
    if(ev.level==='danger' && ev.note==='가스 임계치 초과'){
      if(!alarmedSet.has(gasKey)){ alarmedSet.add(gasKey); addAlarm('danger','가스 임계치 초과 · 연락+구조',`${w.name} · ${loc}`); flashToast(`${w.name} 가스 위험 — 연락·구조!`); }
    } else alarmedSet.delete(gasKey);

    // 안전확인 무응답 + 무움직임 → 119 연락·구조
    if(ev.noMove){
      if(!alarmedSet.has(respKey)){ alarmedSet.add(respKey); addAlarm('danger','안전확인 무응답·무움직임 · 119 연락',`${w.name} · ${loc}`); flashToast(`${w.name} 무응답·무움직임 — 119!`); }
    } else alarmedSet.delete(respKey);

    if(vs.level==='danger'){
      if(!alarmedSet.has(vitalKey)){ alarmedSet.add(vitalKey); addAlarm('danger','생체신호 위험 · 구조',`${w.name} · ${vs.note}`); flashToast(`${w.name} 생체신호 위험!`); }
    } else alarmedSet.delete(vitalKey);

    // ── 구조·119 알림: 가스/생체 위험, 그리고 '무응답+무움직임'은 모두 자동 발령 ──
    const autoRescue = ev.level==='danger';
    if(autoRescue){
      if(!rescueSet.has(w.id)){ rescueSet.add(w.id); triggerRescue(w, ev.note); }
    } else rescueSet.delete(w.id);

    // ── 무전 확인 단계: 안전확인이 유예를 넘기면 관제가 '자동 무전 호출' 1회 ──
    if(ev.radioCall){
      if(!warnedSet.has(radioKey)){
        warnedSet.add(radioKey);
        addComm(w.id, 'out', '[자동] 안전확인 응답 요청 — 위치·상태 보고 바랍니다');
        addAlarm('warn', '안전확인 무응답 · 무전 호출', `${w.name} · ${loc}`);
        flashToast(`${w.name} 안전확인 무응답 — 무전 호출`, 'warn');
      }
    } else warnedSet.delete(radioKey);

    // ── 주의(warn) → 퇴장 권고 (무전에도 무응답 지속 / 생체 / 가스) ──
    const recommendExit = ev.exitUrge || (ev.level==='warn' && (vs.level==='warn' || gasWarn));
    if(recommendExit){
      if(!warnedSet.has(warnKey)){
        warnedSet.add(warnKey);
        const why = ev.exitUrge ? '안전확인 무응답 지속' : (vs.level==='warn' ? ('생체 주의 · '+vs.note) : '가스 농도 주의');
        addAlarm('warn', '퇴장 권고 — '+why, `${w.name} · ${loc}`);
        flashToast(`${w.name} 퇴장 권고: ${why}`, 'warn');
      }
    } else warnedSet.delete(warnKey);
  });
}

/* 구조 알림 — 119 연계 + 지시자 대응 절차 오버레이 */
let rescueTargetId = null;
const RESCUE_STEPS = [
  '무전으로 작업자 의식·상태를 즉시 확인',
  '119 신고 — 위치·맨홀·심도·상황·가스 수치 전달',
  '단독 진입 금지 — 2차 재해 방지 (전문 구조대 대기)',
  '송풍기 최대 가동 · 지속 환기 유지',
  '주변 작업자 즉시 대피 유도',
  '구조대 도착 시 현장 정보·경보 이력 인계',
];
function triggerRescue(w, reason){
  addAlarm('danger', '구조 알림 발령 · 119 연계', `${w.name} · ${mhLabel(w)} · ${reason}`);
  showRescue(w, reason);
}
function showRescue(w, reason){
  rescueTargetId = w.id;
  const g  = gasCache.get(w.id) || simGas(w);
  const vr = readVitals(w);
  const mh = MH_BY_ID[w.mh];
  const depth = curDepthOf(w.id, mh?mh.depth:0).toFixed(1);
  const elapsed = w.enteredAt ? fmtDurKo((now()-w.enteredAt)/1000) : '-';
  $('#rescue-sub').textContent = `${w.name} · ${mhLabel(w)} · ${reason}`;
  const relay = [
    ['위치',     `${mhLabel(w)} · 심도 ${depth} m`],
    ['상황',     reason],
    ['가스',     `O₂ ${g.o2.toFixed(1)} · H₂S ${g.h2s.toFixed(0)} · CO ${g.co.toFixed(0)} · LEL ${g.lel.toFixed(0)}`],
    ['생체',     `심박 ${vr.bpm} · SpO₂ ${vr.spo2}% · 체온 ${vr.temp}°`],
    ['작업 경과', elapsed],
    ['연락처',   w.phone || '미등록'],
  ];
  $('#rescue-relay-list').innerHTML = relay.map(([k,v])=>`<li><span class="rl-k">${k}</span><span class="rl-v">${escapeHtml(v)}</span></li>`).join('');
  $('#rescue-steps-list').innerHTML = RESCUE_STEPS.map(s=>`<li>${escapeHtml(s)}</li>`).join('');
  $('#rescue-overlay').hidden = false;
  if(navigator.vibrate) navigator.vibrate([400,150,400,150,400]);
}
function closeRescue(){ $('#rescue-overlay').hidden = true; rescueTargetId = null; }

let lastFlash = 0;
function flashToast(msg, kind){
  const t = now();
  if(t-lastFlash < 4000) return;   // 과도한 반복 방지
  lastFlash = t; toast(msg, kind||'danger');
}

/* ---------- 무전 (지시 전달/수신) ---------- */
const RADIO_PRESETS = ['현재 위치·상태 보고','가스 재측정 요청','작업 중지·대기','즉시 퇴장 지시'];
let radioTargetId = null;
function addComm(workerId, dir, text){
  state.comms.push({ id:uid(), ts:now(), workerId, dir, text });
  if(state.comms.length>800) state.comms = state.comms.slice(-800);
  save();
}
function openRadio(id){
  const w = state.workers.find(x=>x.id===id); if(!w) return;
  radioTargetId = id;
  $('#radio-title').textContent = `${w.name} · ${mhLabel(w)||'-'}`;
  $('#radio-presets').innerHTML = RADIO_PRESETS.map(p=>`<button class="radio-preset" data-preset="${escapeHtml(p)}">${escapeHtml(p)}</button>`).join('');
  $('#radio-text').value = '';
  renderRadioLog();
  $('#radio-modal').hidden = false;
  setTimeout(()=>$('#radio-text').focus(), 60);
}
function closeRadio(){ $('#radio-modal').hidden = true; radioTargetId = null; }
function renderRadioLog(){
  const rows = state.comms.filter(c=>c.workerId===radioTargetId).sort((a,b)=>a.ts-b.ts);
  $('#radio-empty').hidden = rows.length>0;
  $('#radio-log').innerHTML = rows.map(c=>`
    <div class="rmsg rmsg--${c.dir}">
      <div class="rmsg__b">${escapeHtml(c.text)}</div>
      <div class="rmsg__t">${c.dir==='out'?'관제 → 작업자':'작업자 → 관제'} · ${fmtHM(c.ts)}</div>
    </div>`).join('');
  const log = $('#radio-log'); if(log) log.scrollTop = log.scrollHeight;
}
function sendComm(text){
  const t = (text||'').trim(); if(!t || !radioTargetId) return;
  const id = radioTargetId;
  addComm(id, 'out', t);
  $('#radio-text').value=''; renderRadioLog();
  toast(`무전 전송: ${t}`, 'ok');
  const ack = ackFor(t);
  setTimeout(()=>{
    const cur = state.workers.find(x=>x.id===id);
    if(!cur || !cur.inside) return;
    addComm(id, 'in', ack);
    // 무전 응답 = 생존·상태 확인 → 안전확인 갱신(미응답 해제, 정상 상태)
    cur.lastResponseAt = now();
    alarmedSet.delete(id+'::resp');
    save();
    if(radioTargetId===id && !$('#radio-modal').hidden) renderRadioLog();
    else toast(`${cur.name} 무전 응답: ${ack}`, 'ok');
    if(currentView==='dashboard') renderDashboard(true);
  }, 1800 + Math.floor(Math.random()*1600));
}
function ackFor(text){
  if(/퇴장/.test(text)) return '수신, 즉시 퇴장 이동 중';
  if(/위치|보고/.test(text)) return '수신, 현재 위치 이상 없음';
  if(/가스|재측정/.test(text)) return '수신, 가스 재측정 실시';
  if(/중지|대기/.test(text)) return '수신, 작업 중지·대기';
  return '수신 완료, 이상 없음';
}

/* ============================ 6. 루프 & 이벤트 ============================ */
function refreshAll(){
  renderInsideCounts();
  if(currentView==='dashboard') renderDashboard(true);
  else if(currentView==='prep') renderPrep();
}

function tick(){
  $('#topbar-clock').textContent = fmtClock(now());
  promoteConnections();
  autoDetectAlarms();
  updateStatStrip();
  if(currentView==='dashboard') renderDashboard(false);
  else if(currentView==='prep'){
    // 내부 인원 경과시간·입장 잠금 갱신(가벼운 재렌더)
    renderWorkerList();
  }
}

let toastTimer=null;
function toast(msg, kind){
  const el=$('#toast');
  el.textContent=msg;
  el.className='toast'+(kind?` is-${kind}`:'');
  el.hidden=false;
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>{ el.hidden=true; }, 2600);
}

/* ---------- 모달 ---------- */
let editingId=null;
function openModal(id){
  editingId = id||null;
  fillManholeOptions();
  $('#worker-modal-title').textContent = id? '작업자 수정' : '작업자 등록';
  const w = id? state.workers.find(x=>x.id===id) : null;
  $('#wf-name').value     = w? w.name : '';
  $('#wf-mh').value       = w? (w.assignedMh||'') : '';
  $('#wf-location').value = w? (w.location||'') : '';
  $('#wf-phone').value    = w? (w.phone||'') : '';
  $('#worker-modal').hidden = false;
  setTimeout(()=>$('#wf-name').focus(), 60);
}
function closeModal(){ $('#worker-modal').hidden = true; editingId=null; }

/* 맨홀 select 옵션 — 이미 작업 중인 맨홀은 비활성 */
function fillManholeOptions(){
  const sel = $('#wf-mh'); if(!sel) return;
  const editing = editingId ? state.workers.find(x=>x.id===editingId) : null;
  const occupied = new Set(insideWorkers().filter(w=>!editing || w.id!==editing.id).map(w=>w.mh));
  sel.innerHTML = '<option value="">맨홀 선택…</option>' + MANHOLES.map(m=>{
    const busy = occupied.has(m.id);
    return `<option value="${m.id}"${busy?' disabled':''}>${m.label} · 심도 ${m.depth}m${busy?' · 작업 중':''}</option>`;
  }).join('');
}

/* ---------- 이벤트 바인딩 ---------- */
function bindEvents(){
  // 탭
  $('#tabbar').addEventListener('click', e=>{
    const tab = e.target.closest('.tab'); if(!tab) return;
    switchView(tab.dataset.view);
  });

  // SOS · 설정(상단 ⚙)
  $('#sos-btn').addEventListener('click', triggerSOS);
  $('#sos-clear').addEventListener('click', clearSOS);
  $('#settings-btn').addEventListener('click', ()=>switchView(currentView==='settings'?'dashboard':'settings'));

  // 위임: 작업자/대시보드 액션
  $('#app').addEventListener('click', e=>{
    const mk = e.target.closest('[data-mk]');
    if(mk){ openDetail(mk.dataset.mk); return; }
    const btn = e.target.closest('[data-act]');
    if(btn){
      const {act,id}=btn.dataset;
      if(act==='enter')  enterWorker(id);
      if(act==='return') requestReturn(id);
      if(act==='edit')   openModal(id);
      if(act==='delete') deleteWorker(id);
      return;
    }
    // 체크리스트 항목
    const ci = e.target.closest('[data-check]');
    if(ci){
      const k = ci.dataset.check;
      state.checklist[k] = !state.checklist[k];
      ci.classList.toggle('is-done', state.checklist[k]);
      save(); updatePrepGate();
    }
    // 기록 서브탭
    const rt = e.target.closest('.record-tab');
    if(rt){ recordTab = rt.dataset.rtab; renderRecords(); }
  });

  // 대시보드 상세 팝오버
  $('#sd-close').addEventListener('click', closeDetail);
  $('#sd-exit').addEventListener('click', ()=>{ if(selectedId){ requestReturn(selectedId); syncDetail(); } });
  $('#sd-radio').addEventListener('click', ()=>{ if(selectedId) openRadio(selectedId); });
  $('#sd-rescue').addEventListener('click', ()=>{
    if(!selectedId) return;
    const w = state.workers.find(x=>x.id===selectedId); if(!w) return;
    const ev = evalWorker(w);
    showRescue(w, ev.level==='ok' ? '수동 구조 요청' : ev.note);
  });

  // 무전 모달
  $('#radio-send').addEventListener('click', ()=>sendComm($('#radio-text').value));
  $('#radio-text').addEventListener('keydown', e=>{ if(e.key==='Enter') sendComm($('#radio-text').value); });
  $('#radio-presets').addEventListener('click', e=>{ const b=e.target.closest('[data-preset]'); if(b) sendComm(b.dataset.preset); });
  $$('[data-close-radio]').forEach(el=>el.addEventListener('click', closeRadio));

  // 구조 알림 오버레이 (119 연계)
  $('#rescue-close').addEventListener('click', closeRescue);
  $('#rescue-radio').addEventListener('click', ()=>{ if(rescueTargetId){ const id=rescueTargetId; closeRescue(); openRadio(id); } });
  $('#rescue-call').addEventListener('click', ()=>{
    if(!rescueTargetId) return;
    const w = state.workers.find(x=>x.id===rescueTargetId);
    addAlarm('danger', '119 신고 전화 발신', `${w?w.name:''} · ${w?mhLabel(w):''}`);
    toast('119 신고 전화 연결', 'danger');
  });
  // 경보등급 필터 / 패널 접기
  $('#al-grade').addEventListener('change', e=>{ alertGrade=e.target.value; lastAlarmSig=''; renderAlertPanel(); });
  $('#al-collapse').addEventListener('click', ()=>$('#panel-alerts').classList.toggle('is-collapsed'));

  // 작업자 등록 버튼
  $('#add-worker-btn').addEventListener('click', ()=>openModal(null));
  $('#wf-save').addEventListener('click', saveWorkerFromModal);
  $$('[data-close-modal]').forEach(el=>el.addEventListener('click', closeModal));

  // 기록 날짜
  $('#record-date').addEventListener('change', renderJournal);

  // 설정 변경 (즉시 반영)
  const bindNum=(id,path,parse)=> $(id).addEventListener('change', e=>{
    const v=parse(e.target.value); if(isNaN(v)) return;
    setByPath(path,v); save();
    toast('설정을 저장했습니다.','ok');
  });
  bindNum('#set-interval','settings.intervalMin', v=>Math.max(1,parseInt(v)||5));
  bindNum('#set-grace','settings.graceSec', v=>Math.max(10,parseInt(v)||60));
  bindNum('#th-o2low','settings.thresholds.o2Low', parseFloat);
  bindNum('#th-o2high','settings.thresholds.o2High', parseFloat);
  bindNum('#th-h2s','settings.thresholds.h2s', parseFloat);
  bindNum('#th-co','settings.thresholds.co', parseFloat);
  bindNum('#th-lel','settings.thresholds.lel', parseFloat);
  bindNum('#vt-bpmwarn','settings.vitals.bpmWarn', v=>parseInt(v)||110);
  bindNum('#vt-bpmdanger','settings.vitals.bpmDanger', v=>parseInt(v)||125);
  bindNum('#vt-tempwarn','settings.vitals.tempWarn', parseFloat);
  bindNum('#vt-tempdanger','settings.vitals.tempDanger', parseFloat);
  bindNum('#vt-spo2warn','settings.vitals.spo2Warn', v=>parseInt(v)||94);
  bindNum('#vt-spo2danger','settings.vitals.spo2Danger', v=>parseInt(v)||90);
  $('#set-gasmode').addEventListener('change', e=>{
    state.settings.gasMode = e.target.value; save();
    toast(e.target.value==='alarm'?'경보 테스트 모드로 전환했습니다.':'정상 모드로 전환했습니다.', e.target.value==='alarm'?'danger':'ok');
  });

  // 데이터
  $('#export-btn').addEventListener('click', exportData);
  $('#reset-btn').addEventListener('click', resetAll);

  // Enter 로 모달 저장
  $('#worker-modal').addEventListener('keydown', e=>{ if(e.key==='Enter') saveWorkerFromModal(); });
}

function setByPath(path,val){
  const parts=path.split('.'); let o=state;
  for(let i=0;i<parts.length-1;i++) o=o[parts[i]];
  o[parts[parts.length-1]]=val;
}

/* ---------- 부팅 ---------- */
function boot(){
  buildSewer();
  bindEvents();
  switchView('dashboard');
  tick();
  setInterval(tick, 1000);
  requestAnimationFrame(animateWorkers);   // 작업자 이동 애니메이션
}
document.addEventListener('DOMContentLoaded', boot);
