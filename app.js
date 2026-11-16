'use strict';

const DEFAULT_MODEL = 'gpt-5';
const API_BASE = 'https://api.openai.com/v1';

// Claude(Anthropic) 키는 sk-ant- 로 시작한다. 그 외는 OpenAI 키로 본다.
const CLAUDE_BASE = 'https://api.anthropic.com/v1';
const CLAUDE_MODEL = 'claude-opus-5-5';
const isClaudeKey = (key) => key.startsWith('sk-ant-');
const claudeHeaders = (key) => ({
  'content-type': 'application/json',
  'x-api-key': key,
  'anthropic-version': '2026-10-21',
  'anthropic-dangerous-direct-browser-access': 'true', // 브라우저에서 직접 호출하려면 필요
});
function autoModel(key) {
  return isClaudeKey(key) ? CLAUDE_MODEL : store.get('ag_best', DEFAULT_MODEL);
}

// ---------- 설정 저장 ----------
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 저장 불가 환경 */ } },
};

// 설정 링크(#key=...)로 열면 키를 저장하고 주소창에서 지운다
function importKeyFromHash() {
  const m = location.hash.match(/key=([^&]+)/);
  if (!m) return;
  store.set('ag_key', decodeURIComponent(m[1]));
  history.replaceState(null, '', location.pathname + location.search);
}
importKeyFromHash();
window.addEventListener('hashchange', importKeyFromHash);

const cfg = {
  get key() { return store.get('ag_key', ''); },
  // 'auto'면 이 키로 쓸 수 있는 가장 좋은 모델을 쓴다
  get modelChoice() { return store.get('ag_model2', 'auto'); },
  get model() {
    const m = this.modelChoice;
    const claude = isClaudeKey(this.key);
    // 고른 모델이 지금 키의 회사 것이 아니면 자동으로 돌아간다
    if (m === 'auto' || claude !== m.startsWith('claude')) return autoModel(this.key);
    return m;
  },
  get effort() { return store.get('ag_effort5', 'low'); },
  get sens() { return Number(store.get('ag_sens', '3')); },
  get voice() { return store.get('ag_voice', '0') === '1'; },
};

// ---------- 상수 ----------
const STILL_MS = 1000;          // 이만큼 멈춰 있으면 촬영
const TICK_MS = 100;            // 움직임 검사 주기
const SMALL_W = 64, SMALL_H = 48;
const THRESHOLDS = [3, 5, 7, 10, 14]; // 민감도 1~5 → 허용 픽셀 차이(0~255)
const MIN_CONTRAST = 8;         // 이보다 밋밋한 화면(렌즈 가림, 빈 벽)은 무시
const MAX_SIDE = 1568;          // 전송 이미지 긴 변
const REQUEST_TIMEOUT_MS = 120000;
const CHANGE_THR = 12;         // 답을 보는 중 화면이 찍은 장면과 이만큼 달라지면 다른 문제로 본다
const CHANGE_MS = 300;          // 그 상태가 이만큼 이어지면 답을 지운다
// 풀이 깊이 설정 → 보내 볼 reasoning_effort 값 (앞에서부터 시도)
const EFFORT_TRIES = { fast: ['minimal', 'none', 'low'], low: ['low'], medium: ['medium'], high: ['high'] };

const SYSTEM_PROMPT = `너는 휴대폰 카메라로 찍은 객관식 문제를 푸는 도우미다. 네 출력은 가공 없이 화면에 아주 큰 글씨로 그대로 표시되고, 사용자는 풀이 없이 정답 번호만 한눈에 보고 싶어 한다.

출력 규칙:
- 문제마다 한 줄씩 "문제번호번: 정답" 형식으로 출력한다. 정답은 선택지 번호를 숫자로만 쓴다(①②③이든 1) 2) 3)이든 숫자). 예를 들어 12번 문제의 정답이 ③이면:
12번: 3
- 사진은 사용자가 풀고 싶은 문제 하나에 박스를 맞춰 찍은 것이다. 위아래나 옆에 다른 문제가 일부 또는 전부 함께 찍혀 있어도, 사진 한가운데에 가장 가깝고 온전히 보이는 문제 하나만 푼다. 나머지 문제는 무시하고 언급하지 않는다. 출력은 반드시 한 줄이다.
- 문제 번호가 사진에 보이지 않으면 "정답: 3" 형식으로 출력한다.
- 선택지가 A, B, C 같은 글자면 정답 자리에 그 글자를 쓴다. 선택지가 없는 주관식·단답형이면 정답 자리에 답만 짧게 쓴다.
- 사진이 흐리거나 잘려서 문제를 읽을 수 없거나 문제가 아예 없으면 NONE 이라고만 출력한다.
- 문제 내용, 풀이, 설명, 인사말, 마크다운은 출력하지 않는다. 신중하게 풀되 출력은 정답뿐이다.`;

const MATERIAL_INTRO = `

아래는 이 시험 과목의 교안 전문이다. 시험 문제는 이 교안에서 출제된다. 교안에서 문제와 관련된 부분을 찾아 그것을 최우선 근거로 정답을 고른다. 교안의 표현·분류·용어가 일반적인 지식과 다르면 교안을 따른다. 교안에 관련 내용이 없을 때만 일반 지식으로 푼다. 교안은 슬라이드에서 뽑은 글이라 띄어쓰기가 빠진 곳이 있다.

===== 교안 =====
`;

// ---------- 교안 (이 폰에만 저장) ----------
const MAT_STORE = 'mat';
function openDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('ag', 1);
    r.onupgradeneeded = () => r.result.createObjectStore(MAT_STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function matRun(mode, fn) {
  const d = await openDb();
  return new Promise((res, rej) => {
    const tx = d.transaction(MAT_STORE, mode);
    const out = fn(tx.objectStore(MAT_STORE));
    tx.oncomplete = () => res(out && out.result);
    tx.onerror = () => rej(tx.error);
  });
}
const matNames = () => matRun('readonly', (s) => s.getAllKeys());
const matGet = (name) => matRun('readonly', (s) => s.get(name));
const matReplace = (subjects) => matRun('readwrite', (s) => {
  s.clear();
  for (const x of subjects) s.put(String(x.text), String(x.name));
});

let subjectText = ''; // 지금 고른 과목의 교안 전문

async function loadSubject() {
  const name = store.get('ag_subject', '');
  try { subjectText = name ? (await matGet(name)) || '' : ''; } catch { subjectText = ''; }
}

// 화면 위 과목 선택 상자를 채운다
async function fillSubjects() {
  const sel = document.getElementById('subject');
  let names = [];
  try { names = await matNames(); } catch { /* 저장소를 못 쓰는 환경 */ }
  const current = store.get('ag_subject', '');
  sel.replaceChildren(new Option(names.length ? '교안 없이' : '교안 없음', ''), ...names.map((n) => new Option(n, n, false, n === current)));
  sel.hidden = names.length === 0;
  if (current && !names.includes(current)) store.set('ag_subject', '');
  await loadSubject();
  return names;
}

// ---------- 화면 요소 ----------
const $ = (id) => document.getElementById(id);
const video = $('video');
const statusEl = $('status');
const boxEl = $('box');
const gauge = $('gauge');
const gaugeFg = $('gaugeFg');
const panel = $('panel');
const answerEl = $('answer');
const shotEl = $('shot');
const settings = $('settings');
const GAUGE_LEN = 276.46;

const small = document.createElement('canvas');
small.width = SMALL_W; small.height = SMALL_H;
const smallCtx = small.getContext('2d', { willReadFrequently: true });
const big = document.createElement('canvas');

// ---------- 상태 ----------
// watch: 멈춤 감지 중 / solving: 풀이 중 / shown: 답 표시 중(폰을 옮길 때까지 대기)
let state = 'watch';
let prevGray = null;
let stillMs = 0;
let cameraReady = false;
let solveTimer = null;
let refGray = null;   // 마지막으로 찍은 장면 (다른 문제를 비췄는지 비교용)
let changedMs = 0;
let shownAt = 0;

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
}

function setBox(kind) {
  boxEl.className = 'box' + (kind ? ' ' + kind : '');
}

function setGauge(ratio) {
  gauge.classList.toggle('on', ratio > 0.05);
  gaugeFg.style.strokeDashoffset = String(GAUGE_LEN * (1 - Math.min(1, ratio)));
}

// ---------- 카메라 ----------
async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('이 브라우저는 카메라를 쓸 수 없어요', 'err');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
    });
    // 가까이 댄 글자에 계속 초점을 맞추도록 요청 (지원하는 폰만)
    stream.getVideoTracks()[0]?.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    video.srcObject = stream;
    await video.play().catch(() => {});
    cameraReady = true;
    idleStatus();
    showGuide();
    keepAwake();
  } catch (e) {
    const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    setStatus(denied ? '카메라 권한을 허용해 주세요' : '카메라를 켤 수 없어요', 'err');
  }
}

let wakeLock = null;
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* 지원 안 함 */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && cameraReady) keepAwake();
});

function idleStatus() {
  if (!cfg.key) setStatus('설정(⚙)에서 API 키를 넣어주세요', 'err');
  else setStatus('박스에 문제를 넣고 탭하세요');
}

// ---------- 박스 영역 ----------
// 화면의 박스가 카메라 원본 영상에서 차지하는 영역 (영상은 화면을 꽉 채우며 잘려 보인다)
function boxSourceRect() {
  const vw = video.videoWidth, vh = video.videoHeight;
  const W = video.clientWidth, H = video.clientHeight;
  const s = Math.max(W / vw, H / vh);
  const ox = (W - vw * s) / 2, oy = (H - vh * s) / 2;
  const b = boxEl.getBoundingClientRect();
  const x = Math.max(0, (b.left - ox) / s);
  const y = Math.max(0, (b.top - oy) / s);
  const w = Math.min(vw - x, b.width / s);
  const h = Math.min(vh - y, b.height / s);
  return { x, y, w, h };
}

// 박스 아래 손잡이를 위아래로 끌어 높이를 바꾼다. 가로로 긴 문제는 낮게, 세로로 긴 문제는 높게.
const BOX_MIN_H = 90;
let dragging = false;

function boxMaxH() {
  return window.innerHeight - boxEl.getBoundingClientRect().top - 120; // 정답 자리 확보
}

function setBoxHeight(h) {
  const clamped = Math.round(Math.max(BOX_MIN_H, Math.min(boxMaxH(), h)));
  document.documentElement.style.setProperty('--box-h', clamped + 'px');
  return clamped;
}

function restoreBoxHeight() {
  const saved = Number(store.get('ag_box_h', '0'));
  setBoxHeight(saved || window.innerWidth * 0.6);
}
restoreBoxHeight();
window.addEventListener('resize', restoreBoxHeight);

const handle = $('boxHandle');
handle.addEventListener('pointerdown', (e) => {
  dragging = true;
  handle.setPointerCapture(e.pointerId);
});
handle.addEventListener('pointermove', (e) => {
  if (dragging) setBoxHeight(e.clientY - boxEl.getBoundingClientRect().top);
});
const endDrag = () => {
  if (!dragging) return;
  dragging = false;
  store.set('ag_box_h', String(boxEl.getBoundingClientRect().height));
  stillMs = 0;
  prevGray = null;
};
handle.addEventListener('pointerup', endDrag);
handle.addEventListener('pointercancel', endDrag);

// ---------- 움직임 감지 ----------
function readGray() {
  const r = boxSourceRect();
  smallCtx.drawImage(video, r.x, r.y, r.w, r.h, 0, 0, SMALL_W, SMALL_H);
  const d = smallCtx.getImageData(0, 0, SMALL_W, SMALL_H).data;
  const g = new Uint8Array(SMALL_W * SMALL_H);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    g[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
  }
  return g;
}

function meanDiff(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

function contrast(g) {
  let sum = 0;
  for (let i = 0; i < g.length; i++) sum += g[i];
  const mean = sum / g.length;
  let dev = 0;
  for (let i = 0; i < g.length; i++) dev += Math.abs(g[i] - mean);
  return dev / g.length;
}

function tick() {
  if (!cameraReady || state === 'solving' || dragging || settings.open || document.hidden) return;
  if (video.readyState < 2 || !video.videoWidth) return;

  const gray = readGray();
  const thr = THRESHOLDS[cfg.sens - 1] ?? 7;
  const diff = prevGray ? meanDiff(gray, prevGray) : Infinity;
  prevGray = gray;

  if (state !== 'shown') return; // 촬영은 화면을 탭할 때만 한다

  { // 답을 보는 동안: 다른 문제를 비추면 답을 지우고 다음 문제를 기다린다
    if (Date.now() - shownAt < 600) return; // 답이 뜰 때의 진동으로 흔들린 것은 무시
    // 폰이 움직이고 있거나, 찍은 장면과 달라졌으면 다른 문제로 넘어가는 것으로 본다
    const moved = diff > thr || (refGray && meanDiff(gray, refGray) > CHANGE_THR);
    changedMs = moved ? changedMs + TICK_MS : 0;
    if (changedMs >= CHANGE_MS) nextProblem();
  }
}

// ---------- 촬영과 풀이 ----------
const sharpCanvas = document.createElement('canvas');
sharpCanvas.width = 256; sharpCanvas.height = 192;
const sharpCtx = sharpCanvas.getContext('2d', { willReadFrequently: true });

// 지금 프레임의 박스 영역이 얼마나 또렷한지 (이웃 픽셀 밝기 차이의 합, 클수록 또렷)
function sharpness(r) {
  sharpCtx.drawImage(video, r.x, r.y, r.w, r.h, 0, 0, 256, 192);
  const d = sharpCtx.getImageData(0, 0, 256, 192).data;
  let s = 0;
  for (let i = 4; i < d.length; i += 4) s += Math.abs(d[i + 1] - d[i - 3]);
  return s;
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// 탭할 때 폰이 흔들리므로 잠깐 기다린 뒤, 연속 프레임 중 가장 또렷한 것을 고른다
async function grabJpegBase64() {
  const r = boxSourceRect();
  const scale = Math.min(1, MAX_SIDE / Math.max(r.w, r.h));
  big.width = Math.round(r.w * scale);
  big.height = Math.round(r.h * scale);
  const ctx = big.getContext('2d');
  await sleep(250);
  let best = -1;
  for (let i = 0; i < 5; i++) {
    if (i) await sleep(70);
    const s = sharpness(r);
    if (s > best) {
      best = s;
      ctx.drawImage(video, r.x, r.y, r.w, r.h, 0, 0, big.width, big.height);
    }
  }
  return big.toDataURL('image/jpeg', 0.9);
}

async function capture() {
  if (state === 'solving') return;
  if (!cfg.key) { openSettings(); return; }
  if (!video.videoWidth) return; // 카메라 영상이 아직 없음

  state = 'solving';
  stillMs = 0;
  panel.hidden = true;
  setGauge(0);
  setBox('busy');
  setStatus('찍는 중… 움직이지 마세요', 'busy');
  $('busySec').textContent = '';

  const dataUrl = await grabJpegBase64();
  const image = dataUrl.split(',')[1];
  shotEl.src = dataUrl; // 무엇이 찍혔는지 답 아래에 보여준다
  refGray = video.videoWidth ? readGray() : null;
  changedMs = 0;
  navigator.vibrate?.(40);

  const started = Date.now();
  const showElapsed = () => {
    const sec = Math.round((Date.now() - started) / 1000) + '초';
    $('busySec').textContent = sec;
    setStatus('찍었어요 · 푸는 중… ' + sec, 'busy');
  };
  showElapsed();
  solveTimer = setInterval(showElapsed, 1000);

  try {
    const text = await solve(image);
    const solved = showAnswer(text);
    setBox(solved ? 'done' : '');
    setStatus(solved ? '✅ 풀이 끝 · 다음 문제 넣고 탭' : '못 읽었어요 · 탭하면 다시 찍어요', solved ? '' : 'err');
  } catch (e) {
    showMessage(e.userMessage || '풀이에 실패했어요. 화면을 탭하면 다시 시도해요.');
    setBox('');
    setStatus('오류 · 탭하면 다시 찍어요', 'err');
    if (e.needsKey) openSettings();
  } finally {
    clearInterval(solveTimer);
    prevGray = null;
    changedMs = 0;
    shownAt = Date.now();
    state = 'shown';
  }
}

function fail(userMessage, extra = {}) {
  return Object.assign(new Error(userMessage), { userMessage }, extra);
}

// Claude로 풀기. 교안은 캐시 표시를 해서 같은 과목을 연달아 풀 때 빠르고 싸게 읽힌다.
async function solveClaude(imageBase64) {
  const model = cfg.model;
  const system = [{ type: 'text', text: SYSTEM_PROMPT }];
  if (subjectText) {
    system.push({ type: 'text', text: MATERIAL_INTRO + subjectText, cache_control: { type: 'ephemeral', ttl: '1h' } });
  }
  const body = {
    model,
    max_tokens: 16000,
    output_config: { effort: cfg.effort === 'fast' ? 'low' : cfg.effort },
    system,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
        { type: 'text', text: '이 사진 가운데에 있는 문제 하나만 풀고 정답만 출력해.' },
      ],
    }],
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let r, data = null;
  try {
    r = await fetch(CLAUDE_BASE + '/messages', {
      method: 'POST', headers: claudeHeaders(cfg.key), body: JSON.stringify(body), signal: ctrl.signal,
    });
    try { data = await r.json(); } catch { /* 본문 없음 */ }
  } catch (e) {
    if (e.name === 'AbortError') throw fail('시간이 너무 오래 걸려요. 탭해서 다시 시도하세요.');
    throw fail('인터넷 연결을 확인해 주세요.');
  } finally {
    clearTimeout(timer);
  }

  if (!r.ok) {
    const m = data?.error?.message || '';
    if (r.status === 401) throw fail('API 키가 올바르지 않아요.', { needsKey: true });
    if (r.status === 404) throw fail('이 키로는 "' + model + '" 모델을 쓸 수 없어요.\n설정에서 다른 모델을 고르세요.', { needsKey: true });
    if (/credit balance/i.test(m)) throw fail('Claude API 크레딧이 없어요. 결제 설정을 확인하세요.');
    if (r.status === 413 || /too long|too large/i.test(m)) throw fail('교안이 너무 커서 보낼 수 없어요.\n' + m);
    if (r.status === 429) throw fail('요청이 너무 많아요. 잠시 뒤 다시 시도하세요.\n' + m);
    if (r.status >= 500) throw fail('AI 서버가 바빠요. 잠시 뒤 다시 시도하세요.');
    throw fail('요청 오류 (' + r.status + ')' + (m ? '\n' + m : ''));
  }
  if (data?.stop_reason === 'refusal') throw fail('이 문제는 풀 수 없어요.');
  const text = (data?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  if (!text) throw fail('답을 받지 못했어요. 탭해서 다시 시도하세요.');
  return text;
}

async function solve(imageBase64) {
  if (isClaudeKey(cfg.key)) return solveClaude(imageBase64);
  const model = cfg.model;
  const body = {
    model,
    messages: [
      // 교안을 맨 앞에 두면 같은 과목을 연달아 풀 때 OpenAI가 앞부분을 캐시해서 더 빠르고 싸다
      { role: 'system', content: SYSTEM_PROMPT + (subjectText ? MATERIAL_INTRO + subjectText : '') },
      {
        role: 'user',
        content: [
          { type: 'text', text: '이 사진 가운데에 있는 문제 하나만 풀고 정답만 출력해.' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + imageBase64, detail: 'high' } },
        ],
      },
    ],
  };

  // 모델마다 받는 추론 깊이 값이 달라서, 가벼운 값부터 차례로 시도하고 통한 값을 기억해 둔다
  const cacheKey = 'ag_eff_ok:' + model + ':' + cfg.effort;
  const cached = store.get(cacheKey, null);
  const tries = cached !== null ? [cached] : [...(EFFORT_TRIES[cfg.effort] || ['low']), ''];
  let res, err;
  for (const effort of tries) {
    if (effort) body.reasoning_effort = effort; else delete body.reasoning_effort;
    ({ res, err } = await postChat(body));
    if (res.status === 400 && effort && /reasoning/i.test(err.message || '')) {
      if (cached !== null) { // 기억해 둔 값이 더는 안 통하면 옵션 없이 보내고 다음에 다시 찾는다
        try { localStorage.removeItem(cacheKey); } catch { /* 무시 */ }
        delete body.reasoning_effort;
        ({ res, err } = await postChat(body));
      } else continue;
    } else if (res.ok && cached === null) store.set(cacheKey, effort);
    break;
  }

  if (!res.ok) {
    if (res.status === 401) throw fail('API 키가 올바르지 않아요.', { needsKey: true });
    if (res.status === 404 || err.code === 'model_not_found') {
      throw fail('이 키로는 "' + model + '" 모델을 쓸 수 없어요.\n설정에서 다른 모델을 고르세요.', { needsKey: true });
    }
    if (err.code === 'insufficient_quota') throw fail('OpenAI 크레딧이 없어요. 결제 설정을 확인하세요.');
    if ((res.status === 429 || res.status === 400) && /too large|maximum context|tokens/i.test(err.message || '')) {
      throw fail('교안이 너무 커서 이 모델·계정으로는 보낼 수 없어요.\n' + (err.message || ''));
    }
    if (res.status === 429) throw fail('요청이 너무 많아요. 잠시 뒤 다시 시도하세요.');
    if (res.status >= 500) throw fail('AI 서버가 바빠요. 잠시 뒤 다시 시도하세요.');
    throw fail('요청 오류 (' + res.status + ')' + (err.message ? '\n' + err.message : ''));
  }

  const msg = res.data?.choices?.[0]?.message;
  if (msg?.refusal) throw fail('이 문제는 풀 수 없어요.');
  const text = (typeof msg?.content === 'string' ? msg.content : '').trim();
  if (!text) throw fail('답을 받지 못했어요. 탭해서 다시 시도하세요.');
  return text;
}

async function postChat(body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(API_BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.key },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    let data = null;
    try { data = await r.json(); } catch { /* 본문 없음 */ }
    return { res: { ok: r.ok, status: r.status, data }, err: data?.error || {} };
  } catch (e) {
    if (e.name === 'AbortError') throw fail('시간이 너무 오래 걸려요. 탭해서 다시 시도하세요.');
    throw await explainBlockedRequest();
  } finally {
    clearTimeout(timer);
  }
}

// OpenAI는 일부 오류 응답(잘못된 키 등)을 브라우저가 읽지 못하게 보내서 연결 실패처럼 보인다.
// 읽을 수 있는 모델 목록 요청으로 실제 원인을 가려낸다.
async function explainBlockedRequest() {
  try {
    const r = await fetch(API_BASE + '/models', { headers: { authorization: 'Bearer ' + cfg.key } });
    if (r.status === 401) return fail('API 키가 올바르지 않아요.', { needsKey: true });
    return fail('요청이 거절됐어요.\n설정에서 모델과 OpenAI 크레딧을 확인하세요.', { needsKey: true });
  } catch {
    return fail('인터넷 연결을 확인해 주세요.');
  }
}

// 입력한 키로 쓸 수 있는 대화형 모델 목록을 불러와 선택 상자를 채운다
const NOT_CHAT = /audio|realtime|tts|transcribe|image|embedding|moderation|instruct|search|codex|whisper|dall-e|sora/i;
function fillModels(ids, selected) {
  const sel = $('model');
  const list = selected === 'auto' || ids.includes(selected) ? ids : [selected, ...ids];
  const auto = new Option('자동 · 가장 좋은 모델 (' + autoModel(cfg.key) + ')', 'auto', false, selected === 'auto');
  sel.replaceChildren(auto, ...list.map((id) => new Option(id, id, false, id === selected)));
}

// 목록에서 가장 좋은 범용 모델을 고른다: 접미사 없는 gpt-N, gpt-N.M 중 버전이 가장 높은 것
// (mini·nano는 약하고, pro는 매우 느리고 이 방식으로는 호출이 안 될 수 있어 제외)
function pickBest(ids) {
  let best = null, bestVer = [-1, -1];
  for (const id of ids) {
    const m = id.match(/^gpt-([0-9]+)(?:[.]([0-9]+))?$/);
    if (!m) continue;
    const ver = [Number(m[1]), Number(m[2] || 0)];
    if (ver[0] > bestVer[0] || (ver[0] === bestVer[0] && ver[1] > bestVer[1])) { best = id; bestVer = ver; }
  }
  return best;
}

async function fetchModelIds(key) {
  if (isClaudeKey(key)) {
    const rc = await fetch(CLAUDE_BASE + '/models?limit=100', { headers: claudeHeaders(key) });
    if (!rc.ok) throw Object.assign(new Error(String(rc.status)), { status: rc.status });
    return ((await rc.json()).data || []).map((m) => m.id);
  }
  const r = await fetch(API_BASE + '/models', { headers: { authorization: 'Bearer ' + key } });
  if (!r.ok) throw Object.assign(new Error(String(r.status)), { status: r.status });
  const ids = ((await r.json()).data || []).map((m) => m.id);
  const best = pickBest(ids);
  if (best && key === cfg.key) store.set('ag_best', best);
  return ids;
}

async function loadModels() {
  const key = $('key').value.trim();
  const msg = $('modelMsg');
  let current = $('model').value || cfg.modelChoice;
  if (current !== 'auto' && isClaudeKey(key) !== current.startsWith('claude')) current = 'auto'; // 다른 회사 모델이 골라져 있으면 자동으로
  if (!key) { msg.textContent = '키를 넣으면 쓸 수 있는 모델 목록을 불러옵니다.'; return; }
  msg.textContent = '모델 목록 불러오는 중…';
  try {
    const all = await fetchModelIds(key);
    const claude = isClaudeKey(key);
    const best = claude ? CLAUDE_MODEL : pickBest(all);
    const ids = all
      .filter((id) => claude ? id.startsWith('claude') : /^(gpt-|o\d|chatgpt)/.test(id) && !NOT_CHAT.test(id))
      .sort()
      .reverse();
    fillModels(ids, current);
    if (best) $('model').options[0].textContent = '자동 · 가장 좋은 모델 (' + best + ')';
    msg.textContent = current === 'auto' || ids.includes(current)
      ? '모델 ' + ids.length + '개를 불러왔어요.'
      : '"' + current + '" 모델은 이 키로 쓸 수 없어요. 목록에서 다른 모델을 고르세요.';
  } catch (e) {
    msg.textContent = e.status === 401 ? 'API 키가 올바르지 않아요.' : '모델 목록을 불러오지 못했어요.';
  }
}

// ---------- 답 표시 ----------
// 정답을 화면에 띄운다. 문제를 못 읽은 경우 false를 돌려준다.
function showAnswer(text) {
  const answer = text.trim();
  if (!answer || /^NONE\.?$/i.test(answer)) {
    showMessage('문제를 읽지 못했어요.\n박스 안에 더 가까이, 또렷하게 넣어주세요.');
    return false;
  }
  // 문제 하나만 풀게 했지만, 여러 줄이 오면 "N번: 답" 꼴의 줄은 첫 줄만 남긴다
  let lines = answer.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1 && lines.every((l) => /^.{1,12}:/.test(l))) lines = lines.slice(0, 1);
  const longest = Math.max(...lines.map((l) => l.length));
  let size = 'sm';
  if (lines.length === 1 && longest <= 8) size = 'xl';
  else if (lines.length <= 4 && longest <= 9) size = 'lg';
  else if (lines.length <= 7 && longest <= 14) size = 'md';

  answerEl.textContent = lines.join('\n');
  answerEl.className = 'answer ' + size;
  shotEl.hidden = false;
  panel.hidden = false;
  navigator.vibrate?.([60, 60, 60]);
  speak(lines.join(', '));
  addHist(lines);
  return true;
}

// ---------- 풀이 기록 (오른쪽 위) ----------
const histEl = $('hist');
const histList = $('histList');
let hist = [];
try { hist = JSON.parse(store.get('ag_hist', '[]')) || []; } catch { hist = []; }

function renderHist() {
  histEl.hidden = hist.length === 0;
  histList.replaceChildren(...hist.slice().reverse().map((t) => {
    const d = document.createElement('div');
    d.textContent = t;
    return d;
  }));
}

function addHist(lines) {
  for (const line of lines) {
    // 같은 문제를 방금 다시 풀었으면 예전 줄을 새 답으로 바꾼다
    const m = line.match(/^(.+?번)[ ]*:/);
    const i = m ? hist.findIndex((h, idx) => idx >= hist.length - 5 && h.startsWith(m[1])) : -1;
    if (i >= 0) hist.splice(i, 1);
    hist.push(line);
  }
  hist = hist.slice(-200);
  store.set('ag_hist', JSON.stringify(hist));
  renderHist();
}

$('histClear').addEventListener('click', () => {
  if (!confirm('풀이 기록을 모두 지울까요?')) return;
  hist = [];
  store.set('ag_hist', '[]');
  renderHist();
});
renderHist();

// 답을 지우고 다음 문제를 기다린다
function nextProblem() {
  state = 'watch';
  stillMs = 0;
  changedMs = 0;
  prevGray = null;
  setBox('');
  idleStatus();
  showGuide();
}

function showGuide() {
  answerEl.textContent = '문제를 박스에 맞춘 뒤\n화면을 탭하세요.';
  answerEl.className = 'answer guide';
  shotEl.hidden = true;
  panel.hidden = false;
}

function showMessage(text) {
  answerEl.textContent = text;
  answerEl.className = 'answer msg';
  shotEl.hidden = !shotEl.getAttribute('src');
  panel.hidden = false;
}

const CIRCLED = '①②③④⑤⑥⑦⑧⑨';
function speak(text) {
  if (!cfg.voice || !window.speechSynthesis) return;
  const spoken = text.replace(/[①-⑨]/g, (c) => (CIRCLED.indexOf(c) + 1) + '번');
  const u = new SpeechSynthesisUtterance(spoken);
  u.lang = 'ko-KR';
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

// ---------- 화면 탭 ----------
// 탭하면 박스 안을 찍어서 푼다. 답이 떠 있을 때 탭해도 곧바로 다음 문제를 찍는다.
// 대기 중일 때: 기다리지 않고 바로 찍는다
document.addEventListener('click', (e) => {
  if (settings.open || e.target.closest('.top') || e.target.closest('.box-handle') || e.target.closest('.hist')) return;
  if (!cameraReady || state === 'solving') return;
  if (cfg.voice && window.speechSynthesis) speechSynthesis.resume(); // iOS 음성 잠금 해제
  capture();
});

// ---------- 설정 화면 ----------
function openSettings() {
  if (settings.open) return;
  $('key').value = cfg.key;
  fillModels([], cfg.modelChoice);
  loadModels();
  $('effort').value = cfg.effort;
  $('voice').checked = cfg.voice;
  $('settingsMsg').textContent = '';
  showMatStatus();
  settings.showModal();
}

$('openSettings').addEventListener('click', openSettings);

$('subject').addEventListener('change', (e) => {
  store.set('ag_subject', e.target.value);
  loadSubject();
});

// 교안.json 파일을 골라 이 폰에 저장한다
$('matFile').addEventListener('change', async (e) => {
  const msg = $('matMsg');
  const file = e.target.files[0];
  if (!file) return;
  msg.textContent = '불러오는 중…';
  try {
    const subjects = (JSON.parse(await file.text()).subjects || []).filter((x) => x && x.name && x.text);
    if (!subjects.length) throw new Error('empty');
    await matReplace(subjects);
    const names = await fillSubjects();
    msg.textContent = '과목 ' + names.length + '개를 저장했어요. 화면 위에서 과목을 고르세요.';
  } catch {
    msg.textContent = '교안 파일을 읽지 못했어요. 교안.json 파일이 맞는지 확인하세요.';
  }
  e.target.value = '';
});

async function showMatStatus() {
  let names = [];
  try { names = await matNames(); } catch { /* 무시 */ }
  $('matMsg').textContent = names.length ? '저장된 과목 ' + names.length + '개: ' + names.join(', ') : '아직 불러온 교안이 없어요.';
}
$('key').addEventListener('change', loadModels);

$('settingsForm').addEventListener('submit', () => {
  store.set('ag_key', $('key').value.trim());
  store.set('ag_model2', $('model').value);
  store.set('ag_effort5', $('effort').value);
  store.set('ag_voice', $('voice').checked ? '1' : '0');
});

settings.addEventListener('close', () => {
  stillMs = 0;
  prevGray = null;
  if (cameraReady && state === 'watch') idleStatus();
});

$('copyLink').addEventListener('click', async () => {
  const key = $('key').value.trim();
  const msg = $('settingsMsg');
  if (!key) { msg.textContent = '먼저 API 키를 입력하세요.'; return; }
  const link = location.origin + location.pathname + '#key=' + encodeURIComponent(key);
  try {
    await navigator.clipboard.writeText(link);
    msg.textContent = '복사했어요. 이 링크를 연 폰에 키가 저장됩니다. 믿을 수 있는 사람에게만 보내세요.';
  } catch {
    msg.textContent = '복사하지 못했어요. 이 폰에서 직접 키를 입력해 주세요.';
  }
});

// ---------- 시작 ----------
setInterval(tick, TICK_MS);
fillSubjects();
startCamera().then(() => { if (!cfg.key) openSettings(); });
if (cfg.key) fetchModelIds(cfg.key).catch(() => {}); // 가장 좋은 모델 이름을 최신으로
