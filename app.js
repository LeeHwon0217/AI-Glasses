'use strict';

const DEFAULT_MODEL = 'gpt-5';
const API_BASE = 'https://api.openai.com/v1';

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
  get model() { return store.get('ag_model', DEFAULT_MODEL); },
  get effort() { return store.get('ag_effort', 'low'); },
  get sens() { return Number(store.get('ag_sens', '3')); },
  get voice() { return store.get('ag_voice', '0') === '1'; },
};

// ---------- 상수 ----------
const STILL_MS = 1000;          // 이만큼 멈춰 있으면 촬영
const TICK_MS = 100;            // 움직임 검사 주기
const SMALL_W = 64, SMALL_H = 48;
const THRESHOLDS = [3, 5, 7, 10, 14]; // 민감도 1~5 → 허용 픽셀 차이(0~255)
const MIN_CONTRAST = 8;         // 이보다 밋밋한 화면(렌즈 가림, 빈 벽)은 무시
const MOVE_TICKS = 4;           // 답을 본 뒤 이만큼 연속으로 크게 움직여야 다음 문제 준비
const MAX_SIDE = 1568;          // 전송 이미지 긴 변
const REQUEST_TIMEOUT_MS = 120000;

const SYSTEM_PROMPT = `너는 휴대폰 카메라로 찍은 객관식 문제를 푸는 도우미다. 네 출력은 프로그램이 [문제]와 [정답] 표시를 기준으로 잘라서 화면에 보여준다. 사용자는 네가 문제를 제대로 읽었는지 [문제] 부분으로 확인하고, [정답] 부분은 아주 큰 글씨로 본다.

반드시 아래 형식으로만 출력한다.

[문제]
사진에 보이는 문제와 선택지를 글자 그대로 옮겨 적는다. 요약하거나 고치지 않는다. 그림·표·그래프는 대괄호 안에 한 줄로 설명한다.
[정답]
정답만 적는다.

[정답] 작성 규칙:
- 문제가 하나면 정답 선택지의 기호만 적는다. 문제지에 쓰인 기호를 그대로 쓴다. 예: ③ 또는 B
- 문제가 여러 개면 한 줄에 하나씩 "문제번호 정답기호" 형식으로 적는다. 예:
12번 ③
13번 ①
- 선택지가 없는 주관식·단답형이면 답만 짧게 적는다.
- 풀이, 설명, 인사말, 마크다운은 적지 않는다. 신중하게 풀되 적는 것은 정답뿐이다.

사진이 흐리거나 잘려서 문제를 읽을 수 없거나 문제가 아예 없으면, 위 형식 대신 NONE 이라고만 출력한다.`;

// ---------- 화면 요소 ----------
const $ = (id) => document.getElementById(id);
const video = $('video');
const statusEl = $('status');
const boxEl = $('box');
const gauge = $('gauge');
const gaugeFg = $('gaugeFg');
const panel = $('panel');
const readEl = $('read');
const answerEl = $('answer');
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
let refGray = null;   // 마지막으로 푼 장면
let stillMs = 0;
let moveTicks = 0;
let cameraReady = false;
let solveTimer = null;

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
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    video.srcObject = stream;
    await video.play().catch(() => {});
    cameraReady = true;
    idleStatus();
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
  else setStatus('박스에 문제를 넣고 1초 멈추세요');
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

// 손떨림으로 조금 밀린 같은 장면을 알아보기 위해, 몇 픽셀씩 밀어 보며 가장 작은 차이를 구한다
function minShiftDiff(a, b, max = 4) {
  let best = Infinity;
  for (let dy = -max; dy <= max; dy++) {
    for (let dx = -max; dx <= max; dx++) {
      let s = 0, n = 0;
      for (let y = Math.max(0, dy); y < SMALL_H + Math.min(0, dy); y++) {
        const ra = y * SMALL_W, rb = (y - dy) * SMALL_W;
        for (let x = Math.max(0, dx); x < SMALL_W + Math.min(0, dx); x++) {
          s += Math.abs(a[ra + x] - b[rb + x - dx]);
          n++;
        }
      }
      if (s / n < best) best = s / n;
    }
  }
  return best;
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
  if (!cameraReady || state === 'solving' || settings.open || document.hidden) return;
  if (video.readyState < 2 || !video.videoWidth) return;

  const gray = readGray();
  const thr = THRESHOLDS[cfg.sens - 1] ?? 7;
  const diff = prevGray ? meanDiff(gray, prevGray) : Infinity;
  prevGray = gray;

  if (state === 'shown') {
    // 답을 보는 동안의 손떨림은 무시하고, 폰을 확실히 옮겼을 때만 다음 문제를 준비한다
    moveTicks = diff > thr * 2.5 ? moveTicks + 1 : 0;
    if (moveTicks >= MOVE_TICKS) {
      state = 'watch';
      stillMs = 0;
      moveTicks = 0;
      panel.classList.add('stale');
      setBox('');
      setStatus('다음 문제를 박스에 넣고 멈추세요');
    }
    return;
  }

  if (diff > thr || contrast(gray) < MIN_CONTRAST || !cfg.key) {
    stillMs = 0;
    setGauge(0);
    setBox('');
    return;
  }

  stillMs += TICK_MS;
  setGauge(stillMs / STILL_MS);
  setBox('hold');
  if (stillMs < STILL_MS) return;

  if (refGray && minShiftDiff(gray, refGray) < thr * 1.5) {
    // 방금 푼 문제를 그대로 비추고 있으면 다시 풀지 않는다
    state = 'shown';
    stillMs = 0;
    setGauge(0);
    setBox('done');
    panel.classList.remove('stale');
    setStatus('이미 푼 문제예요 · 다시 풀려면 화면을 탭');
    return;
  }
  capture(gray);
}

// ---------- 촬영과 풀이 ----------
function grabJpegBase64() {
  const r = boxSourceRect();
  const scale = Math.min(1, MAX_SIDE / Math.max(r.w, r.h));
  big.width = Math.round(r.w * scale);
  big.height = Math.round(r.h * scale);
  big.getContext('2d').drawImage(video, r.x, r.y, r.w, r.h, 0, 0, big.width, big.height);
  return big.toDataURL('image/jpeg', 0.9).split(',')[1];
}

async function capture(gray) {
  if (state === 'solving') return;
  if (!cfg.key) { openSettings(); return; }

  state = 'solving';
  stillMs = 0;
  moveTicks = 0;
  refGray = gray || readGray();
  const image = grabJpegBase64();

  panel.hidden = true;
  setGauge(0);
  gauge.classList.add('spin');
  setBox('busy');
  navigator.vibrate?.(40);

  const started = Date.now();
  const showElapsed = () => setStatus('찍었어요 · 푸는 중… ' + Math.round((Date.now() - started) / 1000) + '초', 'busy');
  showElapsed();
  solveTimer = setInterval(showElapsed, 1000);

  try {
    const text = await solve(image);
    const solved = showAnswer(text);
    setBox(solved ? 'done' : '');
    setStatus(solved ? '✅ 풀이 끝 · 다음 문제로 이동' : '못 읽었어요 · 탭하면 다시 찍어요', solved ? '' : 'err');
    if (!solved) refGray = null;
  } catch (e) {
    showMessage(e.userMessage || '풀이에 실패했어요. 화면을 탭하면 다시 시도해요.');
    setBox('');
    setStatus('오류 · 탭하면 다시 찍어요', 'err');
    refGray = null;
    if (e.needsKey) openSettings();
  } finally {
    clearInterval(solveTimer);
    gauge.classList.remove('spin');
    prevGray = null;
    state = 'shown';
  }
}

function fail(userMessage, extra = {}) {
  return Object.assign(new Error(userMessage), { userMessage }, extra);
}

async function solve(imageBase64) {
  const body = {
    model: cfg.model,
    reasoning_effort: cfg.effort,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: '이 사진의 문제를 옮겨 적고 정답을 알려줘.' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + imageBase64, detail: 'high' } },
        ],
      },
    ],
  };

  let { res, err } = await postChat(body);
  // 추론 깊이 옵션을 받지 않는 모델이면 그 옵션만 빼고 한 번 더 보낸다
  if (res.status === 400 && /reasoning/i.test(err.message || '')) {
    delete body.reasoning_effort;
    ({ res, err } = await postChat(body));
  }

  if (!res.ok) {
    if (res.status === 401) throw fail('API 키가 올바르지 않아요.', { needsKey: true });
    if (res.status === 404 || err.code === 'model_not_found') {
      throw fail('이 키로는 "' + cfg.model + '" 모델을 쓸 수 없어요.\n설정에서 다른 모델을 고르세요.', { needsKey: true });
    }
    if (err.code === 'insufficient_quota') throw fail('OpenAI 크레딧이 없어요. 결제 설정을 확인하세요.');
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
  const list = ids.includes(selected) ? ids : [selected, ...ids];
  sel.replaceChildren(...list.map((id) => new Option(id, id, false, id === selected)));
}

async function loadModels() {
  const key = $('key').value.trim();
  const msg = $('modelMsg');
  const current = $('model').value || cfg.model;
  if (!key) { msg.textContent = '키를 넣으면 쓸 수 있는 모델 목록을 불러옵니다.'; return; }
  msg.textContent = '모델 목록 불러오는 중…';
  try {
    const r = await fetch(API_BASE + '/models', { headers: { authorization: 'Bearer ' + key } });
    if (r.status === 401) { msg.textContent = 'API 키가 올바르지 않아요.'; return; }
    if (!r.ok) throw new Error(String(r.status));
    const ids = ((await r.json()).data || [])
      .map((m) => m.id)
      .filter((id) => /^(gpt-|o\d|chatgpt)/.test(id) && !NOT_CHAT.test(id))
      .sort()
      .reverse();
    fillModels(ids, current);
    msg.textContent = ids.includes(current)
      ? '모델 ' + ids.length + '개를 불러왔어요.'
      : '"' + current + '" 모델은 이 키로 쓸 수 없어요. 목록에서 다른 모델을 고르세요.';
  } catch {
    msg.textContent = '모델 목록을 불러오지 못했어요.';
  }
}

// ---------- 답 표시 ----------
// AI 출력을 [문제]와 [정답] 부분으로 나눈다. 표시가 없으면 전체를 정답으로 본다.
function parseOutput(text) {
  const m = text.match(/\[문제\]\s*([\s\S]*?)\s*\[정답\]\s*([\s\S]*)$/);
  return m ? { read: m[1].trim(), answer: m[2].trim() } : { read: '', answer: text.trim() };
}

// 정답을 화면에 띄운다. 문제를 못 읽은 경우 false를 돌려준다.
function showAnswer(text) {
  const { read, answer } = parseOutput(text);
  if (!answer || /^NONE\.?$/i.test(answer)) {
    showMessage('문제를 읽지 못했어요.\n박스 안에 더 가까이, 또렷하게 넣어주세요.');
    return false;
  }
  const lines = answer.split('\n').map((l) => l.trim()).filter(Boolean);
  const longest = Math.max(...lines.map((l) => l.length));
  let size = 'sm';
  if (lines.length === 1 && longest <= 2) size = 'xl';
  else if (lines.length <= 3 && longest <= 8) size = 'lg';
  else if (lines.length <= 6 && longest <= 14) size = 'md';

  readEl.textContent = read;
  readEl.hidden = !read;
  readEl.scrollTop = 0;
  answerEl.textContent = lines.join('\n');
  answerEl.className = 'answer ' + size;
  panel.classList.remove('stale');
  panel.hidden = false;
  navigator.vibrate?.([60, 60, 60]);
  speak(lines.join(', '));
  return true;
}

function showMessage(text) {
  readEl.hidden = true;
  answerEl.textContent = text;
  answerEl.className = 'answer msg';
  panel.classList.remove('stale');
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

// ---------- 화면 탭: 바로 촬영 ----------
document.addEventListener('click', (e) => {
  if (settings.open || e.target.closest('.top') || e.target.closest('.read')) return;
  if (!cameraReady || state === 'solving') return;
  if (cfg.voice && window.speechSynthesis) speechSynthesis.resume(); // iOS 음성 잠금 해제
  capture(null);
});

// ---------- 설정 화면 ----------
function openSettings() {
  if (settings.open) return;
  $('key').value = cfg.key;
  fillModels([], cfg.model);
  loadModels();
  $('effort').value = cfg.effort;
  $('sens').value = String(cfg.sens);
  $('voice').checked = cfg.voice;
  $('settingsMsg').textContent = '';
  settings.showModal();
}

$('openSettings').addEventListener('click', openSettings);
$('key').addEventListener('change', loadModels);

$('settingsForm').addEventListener('submit', () => {
  store.set('ag_key', $('key').value.trim());
  store.set('ag_model', $('model').value);
  store.set('ag_effort', $('effort').value);
  store.set('ag_sens', $('sens').value);
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
startCamera().then(() => { if (!cfg.key) openSettings(); });
