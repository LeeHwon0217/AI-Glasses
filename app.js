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
  get effort() { return store.get('ag_effort', 'medium'); },
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
const REQUEST_TIMEOUT_MS = 90000;

const SYSTEM_PROMPT = `너는 휴대폰 카메라로 찍은 객관식 문제를 푸는 도우미다. 네 출력은 가공 없이 화면에 아주 큰 글씨로 그대로 표시되고, 사용자는 풀이 없이 정답만 한눈에 보고 싶어 한다.

출력 규칙:
- 사진에 문제가 하나면 정답 선택지의 기호만 출력한다. 문제지에 쓰인 기호를 그대로 쓴다. 예: ③ 또는 B
- 문제가 여러 개 보이면 한 줄에 하나씩 "문제번호 정답기호" 형식으로 출력한다. 예:
12번 ③
13번 ①
- 선택지가 없는 주관식·단답형이면 답만 짧게 출력한다.
- 사진이 흐리거나 잘려서 문제를 읽을 수 없거나, 문제가 아예 없으면 NONE 이라고만 출력한다.
- 풀이, 설명, 인사말, 마크다운은 출력하지 않는다. 신중하게 풀되 출력은 정답만이다.`;

// ---------- 화면 요소 ----------
const $ = (id) => document.getElementById(id);
const video = $('video');
const statusEl = $('status');
const gauge = $('gauge');
const gaugeFg = $('gaugeFg');
const answerEl = $('answer');
const settings = $('settings');
const GAUGE_LEN = 276.46;

const small = document.createElement('canvas');
small.width = SMALL_W; small.height = SMALL_H;
const smallCtx = small.getContext('2d', { willReadFrequently: true });
const big = document.createElement('canvas');

// ---------- 상태 ----------
// watch: 멈춤 감지 중 / solving: 풀이 중 / shown: 답 표시 중(장면이 바뀔 때까지 대기)
let state = 'watch';
let prevGray = null;
let refGray = null;   // 마지막으로 촬영한 장면
let stillMs = 0;
let cameraReady = false;

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
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
  else setStatus('문제를 비추고 1초 멈추세요');
}

// ---------- 움직임 감지 ----------
function readGray() {
  smallCtx.drawImage(video, 0, 0, SMALL_W, SMALL_H);
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
  if (!cameraReady || state === 'solving' || settings.open || document.hidden) return;
  if (video.readyState < 2 || !video.videoWidth) return;

  const gray = readGray();
  const thr = THRESHOLDS[cfg.sens - 1] ?? 7;

  if (state === 'shown') {
    // 다른 장면으로 옮겨가야 다음 촬영을 준비한다 (같은 문제 반복 촬영 방지)
    if (refGray && meanDiff(gray, refGray) > thr * 3) {
      state = 'watch';
      stillMs = 0;
      answerEl.classList.add('stale');
      idleStatus();
    }
    prevGray = gray;
    return;
  }

  const moving = !prevGray || meanDiff(gray, prevGray) > thr;
  prevGray = gray;

  if (moving || contrast(gray) < MIN_CONTRAST || !cfg.key) {
    stillMs = 0;
    setGauge(0);
    return;
  }

  stillMs += TICK_MS;
  setGauge(stillMs / STILL_MS);
  if (stillMs >= STILL_MS) capture(gray);
}

// ---------- 촬영과 풀이 ----------
function grabJpegBase64() {
  const w = video.videoWidth, h = video.videoHeight;
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  big.width = Math.round(w * scale);
  big.height = Math.round(h * scale);
  big.getContext('2d').drawImage(video, 0, 0, big.width, big.height);
  return big.toDataURL('image/jpeg', 0.85).split(',')[1];
}

async function capture(gray) {
  if (state === 'solving') return;
  if (!cfg.key) { openSettings(); return; }

  state = 'solving';
  stillMs = 0;
  refGray = gray || readGray();
  const image = grabJpegBase64();

  setGauge(0);
  gauge.classList.add('spin');
  setStatus('푸는 중…', 'busy');
  navigator.vibrate?.(40);

  try {
    const text = await solve(image);
    showAnswer(text);
    setStatus('다른 문제를 비추면 다시 풀어요');
  } catch (e) {
    showMessage(e.userMessage || '풀이에 실패했어요. 화면을 탭하면 다시 시도해요.');
    setStatus('오류', 'err');
    if (e.needsKey) openSettings();
  } finally {
    gauge.classList.remove('spin');
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
          { type: 'text', text: '이 사진의 문제를 풀고 정답만 출력해.' },
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
function showAnswer(text) {
  if (/^NONE\.?$/i.test(text)) {
    showMessage('문제를 읽지 못했어요.\n더 가까이, 또렷하게 비춰주세요.');
    return;
  }
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const longest = Math.max(...lines.map((l) => l.length));
  let size = 'sm';
  if (lines.length === 1 && longest <= 2) size = 'xl';
  else if (lines.length <= 4 && longest <= 8) size = 'lg';
  else if (lines.length <= 8 && longest <= 14) size = 'md';

  answerEl.textContent = lines.join('\n');
  answerEl.className = 'answer ' + size;
  answerEl.hidden = false;
  navigator.vibrate?.([60, 60, 60]);
  speak(lines.join(', '));
}

function showMessage(text) {
  answerEl.textContent = text;
  answerEl.className = 'answer msg';
  answerEl.hidden = false;
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
  if (settings.open || e.target.closest('.top')) return;
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
  if (cameraReady && state !== 'solving') idleStatus();
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
