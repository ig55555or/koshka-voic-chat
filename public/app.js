// Кошкина видеосвязь — клиент.
// Звук, камера, экран и чат идут через WebRTC (сквозное шифрование DTLS-SRTP всегда включено).
// Сервер знакомит участников и пересылает зашифрованный трафик (TURN), но прочитать его не может.
import { RnnoiseWorkletNode, loadRnnoise } from './vendor/nsup/index.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ------------------------------------------------------------------ платформа
const UA = navigator.userAgent;
const IS_IOS = /iPhone|iPad|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IS_MOBILE = IS_IOS || /Android|Mobi/i.test(UA);
// Телефоны (iOS и Android) не дают сайтам захватывать экран — там только камера.
const CAN_SHARE = !!navigator.mediaDevices?.getDisplayMedia && !IS_MOBILE;

// ------------------------------------------------------------------ настройки
const DEFAULTS = {
  name: '', room: '',
  inputId: 'default', outputId: 'default', camId: 'default',
  micVolume: 100, outVolume: 100,
  nsMode: 'rnnoise', echo: true, agc: false, gate: -60, leveler: true,
  screenQuality: '1080p30', camQuality: '720p',
  theme: 'dark', cats: false,
  peerVolumes: {},   // по имени: { voice, screen }
};
const settings = (() => {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('vc-settings') || '{}') }; }
  catch { return { ...DEFAULTS }; }
})();
const save = () => { try { localStorage.setItem('vc-settings', JSON.stringify(settings)); } catch {} };

const QUALITY = {
  '720p30':  { w: 1280, h: 720,  fps: 30, bitrate: 2_500_000 },
  '1080p30': { w: 1920, h: 1080, fps: 30, bitrate: 4_500_000 },
  '1080p60': { w: 1920, h: 1080, fps: 60, bitrate: 7_000_000 },
  '1440p60': { w: 2560, h: 1440, fps: 60, bitrate: 10_000_000 },
};
const CAM_QUALITY = {
  '360p':  { w: 640,  h: 360,  bitrate: 500_000 },
  '720p':  { w: 1280, h: 720,  bitrate: 1_500_000 },
  '1080p': { w: 1920, h: 1080, bitrate: 3_000_000 },
};

// ------------------------------------------------------------------ состояние
let ws = null;
let myId = null;
let iceServers = [];
let relayOnly = false;
let muted = false, deafened = false, testing = false;
let screenStream = null;
let camStream = null;
let camFacing = 'user';
let unread = 0;
const peers = new Map();     // id -> peer
const roster = new Map();    // id -> { name, admin, guest } (из сигналинга)
let account = null;          // { login, admin } или null — гость
let myName = '', myFlags = null;
let kicked = false;
const roleMark = (r) => (r?.admin ? ' 👑' : r?.guest ? ' · гость' : '');
const roleText = (r) => (r?.admin ? ' (администратор)' : r?.guest ? ' (гость)' : '');
window.__vc = { peers, get ctx() { return ctx; }, get A() { return A; } };   // для отладки из консоли (F12)

// ------------------------------------------------------------------ внешний вид: темы и коты
function applyLook() {
  const root = document.documentElement;
  root.dataset.theme = settings.theme;
  root.classList.toggle('cats', settings.cats);
  $$('.js-theme').forEach((b) => { b.textContent = settings.theme === 'pink' ? '🌙' : '🌸'; });
  $$('.js-cats').forEach((b) => b.classList.toggle('on', settings.cats));
  document.querySelector('meta[name=theme-color]').content = settings.theme === 'pink' ? '#ffe3ee' : '#1e1f22';
}
function catParade() {
  const cats = ['🐈', '🐈‍⬛', '😺', '🐱', '😸', '😻'];
  for (let i = 0; i < 7; i++) {
    setTimeout(() => {
      const c = document.createElement('div');
      c.className = 'cat-run';
      c.textContent = cats[Math.floor(Math.random() * cats.length)];
      c.style.top = (10 + Math.random() * 75) + 'vh';
      c.style.animationDuration = (2.4 + Math.random() * 1.6) + 's';
      document.body.append(c);
      c.addEventListener('animationend', () => c.remove());
    }, i * 220);
  }
}
$$('.js-theme').forEach((b) => b.addEventListener('click', (e) => {
  e.stopPropagation();
  settings.theme = settings.theme === 'pink' ? 'dark' : 'pink';
  save(); applyLook();
}));
$$('.js-cats').forEach((b) => b.addEventListener('click', (e) => {
  e.stopPropagation();
  settings.cats = !settings.cats;
  save(); applyLook();
  if (settings.cats) { catParade(); meow(); }
}));
applyLook();

// ------------------------------------------------------------------ аудио-движок
//  микрофон → [RNNoise] → громкость → гейт → [выравнивание] → лимитер → mute → собеседникам
//  собеседник → его громкость → общая громкость → лимитер → устройство вывода
let ctx = null;
const A = {};
let rnnoiseWasm = null;

// iOS разрешает звук только если AudioContext создан/запущен прямо в обработчике нажатия,
// поэтому эта функция синхронная и вызывается первой строкой обработчика «Войти».
function createAudioContext() {
  if (ctx) { ctx.resume().catch(() => {}); return; }
  try { ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' }); }
  catch { ctx = new AudioContext({ latencyHint: 'interactive' }); }
  ctx.resume().catch(() => {});
  ctx.onstatechange = () => {
    if (ctx.state !== 'running' && myId && !document.hidden) toast('Звук на паузе — коснитесь экрана');
  };
}

async function initAudio() {
  await ctx.audioWorklet.addModule('gate-worklet.js');

  A.micGain = ctx.createGain();
  A.gate = new AudioWorkletNode(ctx, 'noise-gate', { channelCount: 1, channelCountMode: 'explicit' });
  // Выравнивание громкости (как автоусиление в Discord): тихий голос подтягивается,
  // громкий прижимается. Стоит после гейта, чтобы не усиливать фоновый шум в паузах.
  // Усиление компрессор добавляет сам — около +21 дБ при этих настройках.
  A.leveler = ctx.createDynamicsCompressor();
  A.leveler.threshold.value = -42; A.leveler.knee.value = 18; A.leveler.ratio.value = 6;
  A.leveler.attack.value = 0.005; A.leveler.release.value = 0.3;
  A.limiter = makeLimiter(-2);
  A.mute = ctx.createGain();
  A.dest = ctx.createMediaStreamDestination();
  A.meter = ctx.createAnalyser(); A.meter.fftSize = 1024;        // до гейта — для индикатора уровня
  A.sendMeter = ctx.createAnalyser(); A.sendMeter.fftSize = 512; // то, что реально уходит

  A.micGain.connect(A.gate);
  A.micGain.connect(A.meter);
  A.leveler.connect(A.limiter);
  applyLeveler();
  A.limiter.connect(A.mute);
  A.mute.connect(A.dest);
  A.mute.connect(A.sendMeter);

  A.master = ctx.createGain();
  A.outLimiter = makeLimiter(-1);    // громкость собеседника до 400% без искажений
  A.master.connect(A.outLimiter);
  A.monitor = ctx.createGain(); A.monitor.gain.value = 0;
  A.mute.connect(A.monitor);

  // Вывод: Chrome/Edge — AudioContext.setSinkId (выбор устройства, мин. задержка);
  // Firefox — через <audio>.setSinkId; Safari/iPhone — напрямую (выбора устройства там нет).
  let out = ctx.destination;
  if (typeof ctx.setSinkId !== 'function' && !IS_IOS && 'setSinkId' in HTMLMediaElement.prototype) {
    out = ctx.createMediaStreamDestination();
    A.outEl = new Audio();
    A.outEl.srcObject = out.stream;
    A.outEl.play().catch(() => {});
  }
  A.outLimiter.connect(out);
  A.monitor.connect(out);

  applyMicVolume(); applyOutVolume(); applyGate();
  A.ready = true;
  await setOutputDevice(settings.outputId);
}

const micTrack = () => A.dest.stream.getAudioTracks()[0];

function makeLimiter(thresholdDb) {
  const c = ctx.createDynamicsCompressor();
  c.threshold.value = thresholdDb; c.knee.value = 0; c.ratio.value = 20;
  c.attack.value = 0.001; c.release.value = 0.1;
  return c;
}

// гейт → [выравнивание] → лимитер
function applyLeveler() {
  if (!A.gate) return;
  A.gate.disconnect();
  A.gate.connect(settings.leveler ? A.leveler : A.limiter);
}

async function getRnnoiseNode() {
  if (!rnnoiseWasm) {
    rnnoiseWasm = await loadRnnoise({ url: 'vendor/nsup/rnnoise.wasm', simdUrl: 'vendor/nsup/rnnoise_simd.wasm' });
    await ctx.audioWorklet.addModule('vendor/nsup/rnnoise/workletProcessor.js');
  }
  return new RnnoiseWorkletNode(ctx, { wasmBinary: rnnoiseWasm, maxChannels: 1 });
}

async function openMic() {
  // RNNoise работает только на 48 кГц; если устройство не дало 48 кГц — используем браузерное.
  const wantRnn = settings.nsMode === 'rnnoise' && ctx.sampleRate === 48000;
  const constraints = {
    audio: {
      deviceId: settings.inputId !== 'default' ? { exact: settings.inputId } : undefined,
      noiseSuppression: settings.nsMode === 'browser' || (settings.nsMode === 'rnnoise' && !wantRnn),
      echoCancellation: settings.echo,
      autoGainControl: settings.agc,
      channelCount: 1,
    },
  };
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (e) {
    if (e.name === 'OverconstrainedError' || e.name === 'NotFoundError') {
      settings.inputId = 'default'; save();
      delete constraints.audio.deviceId;
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } else throw e;
  }

  // отключаем старую цепочку
  A.raw?.getTracks().forEach((t) => t.stop());
  A.src?.disconnect();
  if (A.rnn) { A.rnn.disconnect(); A.rnn.destroy?.(); A.rnn = null; }

  A.raw = stream;
  A.src = ctx.createMediaStreamSource(stream);
  let node = A.src;
  if (wantRnn) {
    try {
      A.rnn = await getRnnoiseNode();
      node.connect(A.rnn);
      node = A.rnn;
    } catch (e) {
      console.warn('RNNoise недоступен', e);
      toast('ИИ-шумоподавление недоступно в этом браузере');
    }
  }
  node.connect(A.micGain);
  // iOS может «убить» микрофон при сворачивании — переоткроем при возврате
  stream.getAudioTracks()[0].addEventListener('ended', () => { A.micEnded = true; });
  A.micEnded = false;
  await refreshDevices();
}

const applyMicVolume = () => { if (A.micGain) A.micGain.gain.value = settings.micVolume / 100; };
const applyOutVolume = () => { if (A.master) A.master.gain.value = deafened ? 0 : settings.outVolume / 100; };
const applyGate = () => A.gate?.port.postMessage({ threshold: settings.gate });
const applyMute = () => { if (A.mute) A.mute.gain.value = (muted || deafened) ? 0 : 1; };

const canPickOutput = () => typeof ctx?.setSinkId === 'function' || !!A.outEl?.setSinkId;
async function setOutputDevice(id) {
  const sink = id === 'default' ? '' : id;
  try {
    if (typeof ctx.setSinkId === 'function') await ctx.setSinkId(sink);
    else if (A.outEl?.setSinkId) await A.outEl.setSinkId(sink);
  } catch (e) {
    console.warn(e);
    toast('Не удалось переключить устройство вывода');
  }
}

async function refreshDevices() {
  const devs = await navigator.mediaDevices.enumerateDevices();
  const fill = (sel, kind, current, prefix) => {
    sel.replaceChildren();
    const list = devs.filter((d) => d.kind === kind && d.deviceId);
    if (!list.some((d) => d.deviceId === 'default')) sel.append(new Option('По умолчанию', 'default'));
    list.forEach((d, i) => sel.append(new Option(d.label || `${prefix} ${i + 1}`, d.deviceId)));
    sel.value = [...sel.options].some((o) => o.value === current) ? current : 'default';
    return list.length;
  };
  fill($('#selInput'), 'audioinput', settings.inputId, 'Микрофон');
  const outs = fill($('#selOutput'), 'audiooutput', settings.outputId, 'Динамики');
  $('#rowOutput').hidden = !outs || !canPickOutput();   // на iPhone выбор вывода недоступен
  fill($('#selCam'), 'videoinput', settings.camId, 'Камера');
  $('#rowCam').hidden = IS_MOBILE;                       // на телефоне — кнопка «Сменить»
}
navigator.mediaDevices?.addEventListener('devicechange', () => { if (A.ready) refreshDevices(); });

// --- iOS/Android: возврат из фона, пауза звука, блокировка экрана
let wakeLock = null;
async function requestWakeLock() {
  try { if ('wakeLock' in navigator && myId && !document.hidden) wakeLock = await navigator.wakeLock.request('screen'); }
  catch { /* не поддерживается — не страшно */ }
}
function kickAudio() { if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {}); }
document.addEventListener('visibilitychange', async () => {
  if (document.hidden || !myId) return;
  kickAudio();
  requestWakeLock();
  if (A.micEnded || A.raw?.getAudioTracks()[0]?.readyState === 'ended') {
    try { await openMic(); } catch {}
  }
  if (camStream && camStream.getVideoTracks()[0]?.readyState === 'ended') startCamera();
});
document.addEventListener('touchend', kickAudio, { passive: true });
document.addEventListener('click', kickAudio);

// ------------------------------------------------------------------ сигналинг
function connect(room, password) {
  return new Promise((resolve, reject) => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => send({ type: 'join', room, password, guest: !account, name: account ? undefined : settings.name });
    ws.onerror = () => reject(new Error('Нет связи с сервером'));
    ws.onclose = () => {
      if (kicked) return;
      if (myId) { setStatus('Нет связи с сервером', true); sysMsg('Соединение с сервером потеряно. Перезагрузите страницу.'); }
    };
    ws.onmessage = async (ev) => {
      const msg = JSON.parse(ev.data);
      switch (msg.type) {
        case 'error':
          if (!myId) { reject(new Error(msg.message)); ws.close(); } else toast(msg.message);
          break;
        case 'kicked':
          kicked = true;
          alert(msg.message);
          location.reload();
          break;
        case 'joined':
          myId = msg.id;
          myName = msg.name;
          myFlags = msg;
          resolve();
          for (const p of msg.peers) {
            roster.set(p.id, p);
            const peer = createPeer(p.id, p.name, true);
            peer.state = p.state || {};
          }
          renderUsers(); renderStage();
          break;
        case 'peer-joined':
          roster.set(msg.id, msg);
          sysMsg(`${msg.name}${roleText(msg)} в комнате`); joinSound(true);
          break;
        case 'peer-left': {
          const p = peers.get(msg.id);
          sysMsg(`${p?.name || roster.get(msg.id)?.name || 'Кто-то'}: связь завершена`); joinSound(false);
          removePeer(msg.id);
          roster.delete(msg.id);
          break;
        }
        case 'state': {
          const p = peers.get(msg.id);
          if (p) { p.state = msg.state; renderUsers(); renderStage(); }
          break;
        }
        case 'signal': {
          let p = peers.get(msg.from);
          if (!p) p = createPeer(msg.from, roster.get(msg.from)?.name || '?', false);
          p.queue = p.queue.then(() => handleSignal(p, msg.data)).catch((e) => signalError(p, e));
          break;
        }
      }
    };
  });
}
const send = (m) => ws?.readyState === 1 && ws.send(JSON.stringify(m));
const sendSignal = (to, data) => send({ type: 'signal', to, data });
const broadcastState = () => send({ type: 'state', state: { muted, deafened, sharing: !!screenStream, camera: !!camStream } });

// ------------------------------------------------------------------ WebRTC
// Порядок транссиверов фиксирован: [0] голос, [1] видео экрана, [2] звук экрана, [3] камера.
// Оффер всегда делает тот, кто зашёл позже, поэтому «гонок» оффер/оффер нет,
// а включение/выключение камеры и экрана — это просто replaceTrack без переговоров.
const TX = { MIC: 0, SCREEN: 1, SCREEN_AUDIO: 2, CAM: 3 };

function createPeer(id, name, initiator) {
  const pc = new RTCPeerConnection({
    iceServers, bundlePolicy: 'max-bundle',
    iceTransportPolicy: relayOnly ? 'relay' : 'all',   // relay = только через сервер
  });
  const saved = settings.peerVolumes[name] || {};
  const p = {
    id, name, pc, initiator, tx: null, state: {}, queue: Promise.resolve(), pendingIce: [],
    voice: saved.voice ?? 100, screen: saved.screen ?? 100, localMute: false,
    gain: ctx.createGain(), screenGain: ctx.createGain(), analyser: ctx.createAnalyser(),
    holders: [], videoTrack: null, camTrack: null, code: null, rtt: null, connected: false,
  };
  p.analyser.fftSize = 512;
  p.gain.connect(A.master);
  p.screenGain.connect(A.master);
  applyPeerVolume(p);
  peers.set(id, p);

  p.localCands = 0;
  pc.onicecandidate = (e) => {
    if (e.candidate) { if (e.candidate.candidate) p.localCands++; sendSignal(id, { ice: e.candidate }); }
  };
  // Сбор маршрутов закончился, а ни одного нет — значит, устройство не достучалось до сервера.
  pc.onicegatheringstatechange = () => {
    if (pc.iceGatheringState === 'complete' && p.localCands === 0) diagnose(p, 'нет маршрутов');
  };
  // Подстраховка: если за 15 с соединение так и не пошло — запускаем проверку.
  p.diagTimer = setTimeout(() => {
    if (!['connected', 'closed'].includes(pc.connectionState)) diagnose(p, 'долго нет соединения');
  }, 15000);
  pc.ontrack = (e) => onTrack(p, e);
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === 'connected') {
      p.failNotified = false;
      if (!p.connected) sysMsg(`🔒 Защищённое соединение с ${p.name} установлено`);
      p.connected = true;
      tuneSenders(p);
      computeSafetyCode(p);
    } else if (s === 'failed') {
      if (!p.failNotified) {
        p.failNotified = true;
        const hasTurn = iceServers.some((x) => [].concat(x.urls).some((u) => u.startsWith('turn')));
        sysMsg(`⚠️ Не удалось соединиться с ${p.name}. ` + (hasTurn
          ? 'Проверьте, что на сервере открыты порты 3478/udp+tcp и 49160-49200/udp.'
          : 'Нужен TURN-сервер (см. README).'));
      }
      diagnose(p, 'failed');
      if (p.initiator) makeOffer(p, true).catch(console.error);       // ICE restart
    }
    if (openMenuPeer === p.id && !p.code) $('#pmCode').textContent = connText(p);
    renderUsers();
  };

  p.dc = pc.createDataChannel('chat', { negotiated: true, id: 0 });
  p.dc.onmessage = (e) => {
    try {
      const m = JSON.parse(e.data);
      if (m.type === 'chat' && typeof m.text === 'string') chatMsg(p.name, m.text.slice(0, 2000), false);
    } catch {}
  };

  if (initiator) {
    p.tx = [
      pc.addTransceiver(micTrack(), { direction: 'sendrecv' }),
      pc.addTransceiver('video', { direction: 'sendrecv' }),
      pc.addTransceiver('audio', { direction: 'sendrecv' }),
      pc.addTransceiver('video', { direction: 'sendrecv' }),
    ];
    attachMediaTo(p);
    p.queue = p.queue.then(() => makeOffer(p)).catch((e) => signalError(p, e));
  }
  renderUsers();
  return p;
}

function signalError(p, e) {
  console.error('signal', e);
  sysMsg(`⚠️ Ошибка соединения с ${p.name}: ${e?.message || e}`);
}

// ------------------------------------------------------------------ диагностика связи
// Проверяем, может ли ЭТО устройство получить маршрут через TURN-сервер — отдельно по UDP и TCP.
async function testTurn() {
  const turn = iceServers.find((x) => [].concat(x.urls).some((u) => u.startsWith('turn')));
  if (!turn) return null;
  const probe = (url) => new Promise((resolve) => {
    let pc;
    const done = (ok) => { clearTimeout(t); try { pc.close(); } catch {} resolve(ok); };
    const t = setTimeout(() => done(false), 8000);
    try {
      pc = new RTCPeerConnection({
        iceServers: [{ urls: [url], username: turn.username, credential: turn.credential }],
        iceTransportPolicy: 'relay',
      });
      pc.createDataChannel('probe');
      pc.onicecandidate = (e) => {
        if (e.candidate && / relay /.test(e.candidate.candidate || '')) done(true);
        else if (!e.candidate) done(false);
      };
      pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => done(false));
    } catch { done(false); }
  });
  const urls = [].concat(turn.urls);
  const plain = (tr) => urls.find((u) => u.startsWith('turn:') && u.includes('transport=' + tr));
  const tlsUrl = urls.find((u) => u.startsWith('turns:'));
  const run = (u) => (u ? probe(u) : Promise.resolve(null));
  const [udp, tcp, tls] = await Promise.all([run(plain('udp')), run(plain('tcp')), run(tlsUrl)]);
  return { udp, tcp, tls };
}
const mark = (v) => (v == null ? '—' : v ? '✅' : '❌');
const diagOk = (r) => !!(r && (r.udp || r.tcp || r.tls));
const diagShort = (r) => `UDP ${mark(r.udp)}, TCP ${mark(r.tcp)}, TLS ${mark(r.tls)}`;
function diagText(r) {
  if (!r) return 'TURN-сервер не настроен.';
  if (diagOk(r)) return `${diagShort(r)} — связь с сервером есть.`;
  return `${diagShort(r)} — сеть этого устройства не пускает к серверу пересылки. ` +
    (r.tls == null ? 'На сервере не включён TURN по TLS — запустите run.sh с доменом. ' : '') +
    'Попробуйте другую сеть (Wi-Fi ↔ мобильный интернет) или выключите VPN/«экономию трафика».';
}
let lastDiag = null;
async function diagnose(p, why) {
  if (p.diagDone) return;
  p.diagDone = true;
  console.warn('diagnose', p.name, why);
  if (!lastDiag) lastDiag = testTurn();
  const r = await lastDiag;
  if (p.pc.connectionState === 'connected') return;
  sysMsg(`🩺 Проверка связи с сервером: ${diagText(r)}`);
  sendSignal(p.id, { diag: r });     // пусть и собеседник увидит, у кого проблема
}

async function makeOffer(p, iceRestart = false) {
  const offer = await p.pc.createOffer({ iceRestart });
  await p.pc.setLocalDescription(offer);
  sendSignal(p.id, { sdp: p.pc.localDescription });
}

async function handleSignal(p, data) {
  const pc = p.pc;
  if (data.diag !== undefined) {
    const r = data.diag;
    if (r && !diagOk(r)) sysMsg(`🩺 У ${p.name} сеть не пускает к серверу пересылки (${diagShort(r)}) — проблема в сети собеседника.`);
    return;
  }
  if (data.sdp) {
    await pc.setRemoteDescription(data.sdp);
    if (data.sdp.type === 'offer') {
      if (!p.tx) {
        p.tx = pc.getTransceivers().slice(0, 4);
        p.tx.forEach((t) => { t.direction = 'sendrecv'; });
        await p.tx[TX.MIC].sender.replaceTrack(micTrack());
        attachMediaTo(p);
      }
      await pc.setLocalDescription(await pc.createAnswer());
      sendSignal(p.id, { sdp: pc.localDescription });
    }
    for (const c of p.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
  } else if (data.ice) {
    if (pc.remoteDescription) await pc.addIceCandidate(data.ice).catch(() => {});
    else p.pendingIce.push(data.ice);
  }
}

function onTrack(p, e) {
  const idx = p.pc.getTransceivers().indexOf(e.transceiver);
  const track = e.track;
  if (idx === TX.SCREEN) { p.videoTrack = track; renderStage(); return; }
  if (idx === TX.CAM) { p.camTrack = track; renderStage(); return; }
  if (idx !== TX.MIC && idx !== TX.SCREEN_AUDIO) return;

  // Chrome: удалённый поток отдаёт звук в Web Audio, только если он привязан к media-элементу.
  const stream = new MediaStream([track]);
  const holder = new Audio();
  holder.muted = true;
  holder.playsInline = true;
  holder.srcObject = stream;
  holder.play().catch(() => {});
  p.holders.push(holder);

  // Громкость идёт через Web Audio — на iPhone у <audio> громкость не регулируется вообще.
  const src = ctx.createMediaStreamSource(stream);
  if (idx === TX.MIC) { src.connect(p.gain); src.connect(p.analyser); }
  else { src.connect(p.screenGain); }
}

function applyPeerVolume(p) {
  p.gain.gain.value = p.localMute ? 0 : p.voice / 100;
  p.screenGain.gain.value = p.localMute ? 0 : p.screen / 100;
}

async function tuneSender(sender, maxBitrate, extra = {}) {
  if (!sender) return;
  try {
    const prm = sender.getParameters();
    if (!prm.encodings || !prm.encodings.length) prm.encodings = [{}];
    prm.encodings[0].maxBitrate = maxBitrate;
    Object.assign(prm, extra);
    await sender.setParameters(prm);
  } catch (e) { /* не все браузеры дают менять параметры — не критично */ }
}

function tuneSenders(p) {
  if (!p.tx) return;
  tuneSender(p.tx[TX.MIC].sender, 128_000);            // голос — Opus высокого качества
  tuneSender(p.tx[TX.SCREEN_AUDIO].sender, 160_000);   // звук трансляции
  const q = QUALITY[settings.screenQuality];
  tuneSender(p.tx[TX.SCREEN].sender, q.bitrate,
    { degradationPreference: q.fps >= 60 ? 'maintain-framerate' : 'maintain-resolution' });
  tuneSender(p.tx[TX.CAM]?.sender, (CAM_QUALITY[settings.camQuality] || CAM_QUALITY['720p']).bitrate,
    { degradationPreference: 'balanced' });
}

function attachMediaTo(p) {
  if (!p.tx) return;
  const rt = (i, track) => p.tx[i]?.sender.replaceTrack(track || null).catch(console.error);
  rt(TX.SCREEN, screenStream?.getVideoTracks()[0]);
  rt(TX.SCREEN_AUDIO, screenStream?.getAudioTracks()[0]);
  rt(TX.CAM, camStream?.getVideoTracks()[0]);
}

function removePeer(id) {
  const p = peers.get(id);
  if (!p) return;
  clearTimeout(p.diagTimer);
  p.pc.close();
  p.gain.disconnect(); p.screenGain.disconnect();
  p.holders.forEach((h) => { h.srcObject = null; });
  peers.delete(id);
  if (openMenuPeer === id) closePeerMenu();
  renderUsers(); renderStage();
}

// Код безопасности: хэш от DTLS-отпечатков обеих сторон. Если у вас и у друга он совпадает —
// посредника (MITM) между вами нет, даже если сервер скомпрометирован.
async function computeSafetyCode(p) {
  const fp = (sdp) => (sdp.match(/a=fingerprint:\S+ (\S+)/) || [])[1] || '';
  const a = fp(p.pc.localDescription?.sdp || ''), b = fp(p.pc.remoteDescription?.sdp || '');
  if (!a || !b) return;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode([a, b].sort().join('|')));
  const bytes = new Uint8Array(buf);
  const groups = [];
  for (let i = 0; i < 4; i++) {
    const n = ((bytes[i * 3] << 16) | (bytes[i * 3 + 1] << 8) | bytes[i * 3 + 2]) % 100000;
    groups.push(String(n).padStart(5, '0'));
  }
  p.code = groups.join(' ');
  if (openMenuPeer === p.id) $('#pmCode').textContent = p.code;
}

// пинг до собеседников
setInterval(async () => {
  for (const p of peers.values()) {
    if (p.pc.connectionState !== 'connected') continue;
    try {
      const stats = await p.pc.getStats();
      stats.forEach((r) => {
        if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded' && r.currentRoundTripTime != null) {
          p.rtt = Math.round(r.currentRoundTripTime * 1000);
          const lc = stats.get(r.localCandidateId), rc = stats.get(r.remoteCandidateId);
          p.relay = lc?.candidateType === 'relay' || rc?.candidateType === 'relay';
        }
      });
    } catch {}
  }
  if (openMenuPeer) updatePeerMenuStats();
}, 2000);

// ------------------------------------------------------------------ камера
async function startCamera() {
  const q = CAM_QUALITY[settings.camQuality] || CAM_QUALITY['720p'];
  const video = { width: { ideal: q.w }, height: { ideal: q.h }, frameRate: { ideal: 30, max: 30 } };
  if (IS_MOBILE) video.facingMode = { ideal: camFacing };
  else if (settings.camId !== 'default') video.deviceId = { exact: settings.camId };

  // iPhone не может держать две камеры сразу — сначала освобождаем старую
  const old = camStream;
  old?.getTracks().forEach((t) => t.stop());

  let s;
  try {
    s = await navigator.mediaDevices.getUserMedia({ video });
  } catch (e) {
    try {
      if (e.name !== 'OverconstrainedError' && e.name !== 'NotFoundError') throw e;
      s = await navigator.mediaDevices.getUserMedia({ video: true });
    } catch (e2) {
      camStream = null;
      toast(e2.name === 'NotAllowedError' ? 'Нужно разрешить доступ к камере' : 'Не удалось включить камеру: ' + e2.message);
      for (const p of peers.values()) attachMediaTo(p);
      updateMediaButtons(); broadcastState(); renderStage(); renderUsers();
      return;
    }
  }
  const track = s.getVideoTracks()[0];
  track.contentHint = 'motion';
  track.addEventListener('ended', () => { if (camStream === s && !document.hidden) stopCamera(); });
  const st = track.getSettings?.() || {};
  if (st.facingMode) camFacing = st.facingMode === 'environment' ? 'environment' : 'user';
  camStream = s;
  for (const p of peers.values()) { attachMediaTo(p); tuneSenders(p); }
  updateMediaButtons(); broadcastState(); renderStage(); renderUsers();
  refreshDevices();
}

function stopCamera() {
  if (!camStream) return;
  camStream.getTracks().forEach((t) => t.stop());
  camStream = null;
  for (const p of peers.values()) attachMediaTo(p);
  updateMediaButtons(); broadcastState(); renderStage(); renderUsers();
}

async function flipCamera() {
  if (!camStream) return;
  if (IS_MOBILE) {
    camFacing = camFacing === 'user' ? 'environment' : 'user';
  } else {
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    if (cams.length < 2) { toast('Другой камеры не найдено'); return; }
    const cur = camStream.getVideoTracks()[0]?.getSettings().deviceId;
    const i = cams.findIndex((c) => c.deviceId === cur);
    settings.camId = cams[(i + 1) % cams.length].deviceId; save();
  }
  await startCamera();
}

// ------------------------------------------------------------------ трансляция экрана (компьютер)
async function startShare() {
  const q = QUALITY[settings.screenQuality];
  let s;
  try {
    s = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: q.w }, height: { ideal: q.h }, frameRate: { ideal: q.fps, max: q.fps } },
      audio: {
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        suppressLocalAudioPlayback: false,
        restrictOwnAudio: true,       // не захватывать звук самого чата (чтобы друг не слышал себя)
      },
      systemAudio: 'include',
      surfaceSwitching: 'include',
    });
  } catch (e) {
    if (e.name !== 'NotAllowedError') toast('Не удалось начать трансляцию: ' + e.message);
    return;
  }
  const v = s.getVideoTracks()[0];
  v.contentHint = q.fps >= 60 ? 'motion' : 'detail';
  v.addEventListener('ended', stopShare);
  screenStream = s;
  for (const p of peers.values()) { attachMediaTo(p); tuneSenders(p); }
  updateMediaButtons(); broadcastState(); renderStage(); renderUsers();
}

function stopShare() {
  if (!screenStream) return;
  screenStream.getTracks().forEach((t) => t.stop());
  screenStream = null;
  for (const p of peers.values()) attachMediaTo(p);
  updateMediaButtons(); broadcastState(); renderStage(); renderUsers();
}

// ------------------------------------------------------------------ интерфейс
const COLORS = ['#5865f2', '#eb459e', '#3ba55c', '#faa61a', '#ed4245', '#9b59b6', '#1abc9c', '#e67e22'];
function colorFor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}
function makeAvatar(name, el = document.createElement('div')) {
  el.className = 'avatar';
  el.style.background = colorFor(name);
  el.textContent = (name.trim()[0] || '?').toUpperCase();
  return el;
}

function renderUsers() {
  const ul = $('#userList');
  ul.replaceChildren();
  const add = (id, name, st, extra) => {
    const li = document.createElement('li');
    li.className = 'user' + (extra.connecting ? ' connecting' : '');
    li.dataset.id = id;
    const av = makeAvatar(name);
    av.dataset.speak = id;
    const n = document.createElement('span');
    n.className = 'uname';
    n.textContent = name + roleMark(extra.role) + (extra.me ? ' (вы)' : '');
    li.append(av, n);
    if (st.sharing) { const l = document.createElement('span'); l.className = 'live'; l.textContent = 'В ЭФИРЕ'; li.append(l); }
    const f = document.createElement('span');
    f.className = 'flags';
    f.textContent = (st.camera ? '📷' : '') + (extra.localMute ? '🔕' : '') +
      (st.deafened ? '🔇' : st.muted ? '🤐' : '') + (extra.connecting ? '⏳' : '');
    li.append(f);
    if (!extra.me) li.addEventListener('click', (ev) => openPeerMenu(id, ev));
    ul.append(li);
  };
  add('me', myName, { muted, deafened, sharing: !!screenStream, camera: !!camStream }, { me: true, role: myFlags });
  for (const p of peers.values()) {
    add(p.id, p.name, p.state, { role: roster.get(p.id), localMute: p.localMute, connecting: p.pc.connectionState !== 'connected' });
  }
}

function toggleFullscreen(tile, video) {
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  if (fsEl) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
  if (tile.requestFullscreen) tile.requestFullscreen().catch(() => video.webkitEnterFullscreen?.());
  else if (tile.webkitRequestFullscreen) tile.webkitRequestFullscreen();
  else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();   // iPhone
}

function renderStage() {
  const stage = $('#stage');
  const want = new Map();
  const me = myName + ' (вы)';
  if (camStream) want.set('me:cam', { name: me, stream: camStream, cam: true, mirror: camFacing === 'user' });
  if (screenStream) want.set('me:screen', { name: me + ' — экран', stream: screenStream });
  for (const p of peers.values()) {
    if (p.state.camera && p.camTrack) want.set(p.id + ':cam', { name: p.name, track: p.camTrack, cam: true });
    if (p.state.sharing && p.videoTrack) want.set(p.id + ':screen', { name: p.name + ' — экран', track: p.videoTrack });
  }
  stage.querySelectorAll('.tile').forEach((t) => { if (!want.has(t.dataset.id)) t.remove(); });
  for (const [id, info] of want) {
    let tile = stage.querySelector(`.tile[data-id="${CSS.escape(id)}"]`);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'tile';
      tile.dataset.id = id;
      const v = document.createElement('video');
      v.autoplay = true; v.playsInline = true; v.muted = true;  // звук идёт через Web Audio
      v.setAttribute('playsinline', '');                         // iPhone: не открывать на весь экран сам
      const label = document.createElement('div'); label.className = 'tlabel';
      const fs = document.createElement('button'); fs.className = 'tfs'; fs.textContent = '⛶'; fs.title = 'На весь экран';
      fs.onclick = () => toggleFullscreen(tile, v);
      v.ondblclick = fs.onclick;
      tile.append(v, label, fs);
      stage.append(tile);
    }
    tile.classList.toggle('cam', !!info.cam);
    tile.classList.toggle('mirror', !!info.mirror);
    const v = tile.querySelector('video');
    const track = info.track || info.stream.getVideoTracks()[0];
    if (v.srcObject?.getVideoTracks()[0] !== track) {
      v.srcObject = info.stream || new MediaStream([track]);
      v.play().catch(() => {});
    }
    tile.querySelector('.tlabel').textContent = info.name;
  }
  $('#stageEmpty').hidden = want.size > 0;
}

// --- меню участника (громкость и т.д.)
let openMenuPeer = null;
function openPeerMenu(id, ev) {
  const p = peers.get(id);
  if (!p) return;
  openMenuPeer = id;
  const m = $('#peerMenu');
  $('#pmName').textContent = p.name + roleMark(roster.get(id));
  $('#pmVol').value = p.voice; $('#pmVolVal').textContent = p.voice + '%';
  $('#pmScreenVol').value = p.screen; $('#pmScreenVal').textContent = p.screen + '%';
  $('#pmScreenRow').hidden = IS_MOBILE && !p.state.sharing;
  $('#pmMute').checked = p.localMute;
  $('#pmCode').textContent = p.code || connText(p);
  updatePeerMenuStats();
  m.hidden = false;
  const r = ev.currentTarget.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(r.right + 8, innerWidth - m.offsetWidth - 8)) + 'px';
  m.style.top = Math.max(8, Math.min(r.top, innerHeight - m.offsetHeight - 8)) + 'px';
  ev.stopPropagation();
}
function connText(p) {
  const s = p.pc.connectionState;
  const map = { new: 'обмен данными…', connecting: 'ищу путь до собеседника…', failed: 'не удалось соединиться', disconnected: 'связь потеряна, переподключаюсь…' };
  return map[s] || `ожидание соединения… (${s})`;
}
function closePeerMenu() { $('#peerMenu').hidden = true; openMenuPeer = null; }
function updatePeerMenuStats() {
  const p = peers.get(openMenuPeer);
  if (!p) return;
  $('#pmPing').textContent = p.rtt != null ? `Пинг: ${p.rtt} мс${p.relay ? ' (через сервер)' : ' (напрямую)'}` : '';
}
document.addEventListener('click', (e) => { if (!e.target.closest('#peerMenu')) closePeerMenu(); });
$('#pmClose').onclick = closePeerMenu;

function peerVolInput(key, valEl) {
  return (e) => {
    const p = peers.get(openMenuPeer);
    if (!p) return;
    p[key] = +e.target.value;
    valEl.textContent = p[key] + '%';
    applyPeerVolume(p);
    settings.peerVolumes[p.name] = { voice: p.voice, screen: p.screen };
    save();
  };
}
$('#pmVol').addEventListener('input', peerVolInput('voice', $('#pmVolVal')));
$('#pmScreenVol').addEventListener('input', peerVolInput('screen', $('#pmScreenVal')));
$('#pmMute').addEventListener('change', (e) => {
  const p = peers.get(openMenuPeer);
  if (!p) return;
  p.localMute = e.target.checked;
  applyPeerVolume(p); renderUsers();
});

// --- индикаторы речи и уровень микрофона
const buf = new Float32Array(1024);
function rmsDb(an) {
  const n = an.fftSize;
  const data = n <= buf.length ? buf.subarray(0, n) : new Float32Array(n);
  an.getFloatTimeDomainData(data);
  let s = 0;
  for (let i = 0; i < n; i++) s += data[i] * data[i];
  return 10 * Math.log10(s / n + 1e-12);
}
function animate() {
  requestAnimationFrame(animate);
  if (!A.ready) return;
  const set = (id, on) => document.querySelector(`[data-speak="${id}"]`)?.classList.toggle('speaking', on);
  const meSpeaking = rmsDb(A.sendMeter) > -50;
  set('me', meSpeaking); set('me-panel', meSpeaking);
  for (const p of peers.values()) set(p.id, !p.localMute && !deafened && rmsDb(p.analyser) > -50);
  if (!$('#settings').hidden) {
    const db = rmsDb(A.meter);
    const pct = (v) => Math.max(0, Math.min(100, (v + 100) / 90 * 100));
    const bar = $('#meterBar');
    bar.style.width = pct(db) + '%';
    bar.classList.toggle('below', settings.gate > -100 && db < settings.gate);
    $('#meterTh').style.left = pct(settings.gate) + '%';
  }
}
requestAnimationFrame(animate);

// --- чат
const isMobileLayout = () => matchMedia('(max-width: 768px)').matches;
const chatVisible = () => !isMobileLayout() || $('#app').classList.contains('chat-open');
function setChatOpen(v) {
  $('#app').classList.toggle('chat-open', v);
  if (v) { unread = 0; updateBadge(); $('#chatLog').scrollTop = $('#chatLog').scrollHeight; }
  else $('#chatInput').blur();
}
function updateBadge() {
  $('#chatBadge').hidden = unread === 0;
  $('#chatBadge').textContent = unread > 9 ? '9+' : String(unread);
}
function chatMsg(name, text, mine) {
  const log = $('#chatLog');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  const d = document.createElement('div'); d.className = 'msg';
  const t = document.createElement('time'); t.textContent = new Date().toLocaleTimeString().slice(0, 5);
  const b = document.createElement('b'); b.textContent = name; b.style.color = colorFor(name);
  d.append(t, b, document.createTextNode(text));
  log.append(d);
  if (atBottom || mine) log.scrollTop = log.scrollHeight;
  if (!mine) {
    if (!chatVisible()) { unread++; updateBadge(); }
    if (document.hidden || !chatVisible()) settings.cats ? meow(0.5) : beep(880, 990, 0.05);
  }
}
function sysMsg(text) {
  const d = document.createElement('div'); d.className = 'msg sys'; d.textContent = text;
  $('#chatLog').append(d); $('#chatLog').scrollTop = $('#chatLog').scrollHeight;
}
$('#chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('#chatInput').value.trim();
  if (!text) return;
  const payload = JSON.stringify({ type: 'chat', text });
  let sent = 0;
  for (const p of peers.values()) if (p.dc.readyState === 'open') { p.dc.send(payload); sent++; }
  chatMsg(myName, text, true);
  if (!sent && peers.size === 0) sysMsg('В комнате пока никого нет');
  $('#chatInput').value = '';
});
$('#btnChat').onclick = (e) => { e.stopPropagation(); setChatOpen(!$('#app').classList.contains('chat-open')); };
$('#btnChatClose').onclick = () => setChatOpen(false);

// --- звуки
function beep(f1, f2, vol = 0.08) {
  if (!A.ready || deafened) return;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.setValueAtTime(f1, ctx.currentTime);
  o.frequency.setValueAtTime(f2, ctx.currentTime + 0.09);
  g.gain.setValueAtTime(vol, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22);
  o.connect(g); g.connect(A.master);
  o.start(); o.stop(ctx.currentTime + 0.25);
}
// синтезированное «мяу»: пилообразный тон через полосовой фильтр с плавающей частотой
function meow(vol = 1, pitch = 1) {
  if (!ctx || deafened) return;
  ctx.resume().catch(() => {});
  const t = ctx.currentTime, d = 0.55;
  const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
  o.type = 'sawtooth';
  o.frequency.setValueAtTime(480 * pitch, t);
  o.frequency.linearRampToValueAtTime(820 * pitch, t + d * 0.35);
  o.frequency.linearRampToValueAtTime(560 * pitch, t + d);
  f.type = 'bandpass'; f.Q.value = 6;
  f.frequency.setValueAtTime(900, t);
  f.frequency.linearRampToValueAtTime(2200, t + d * 0.35);
  f.frequency.linearRampToValueAtTime(1100, t + d);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.35 * vol, t + 0.06);
  g.gain.setValueAtTime(0.35 * vol, t + d * 0.6);
  g.gain.exponentialRampToValueAtTime(0.0001, t + d);
  o.connect(f); f.connect(g); g.connect(A.master || ctx.destination);
  o.start(t); o.stop(t + d + 0.05);
}
const joinSound = (joined) => settings.cats ? meow(0.8, joined ? 1.1 : 0.8) : (joined ? beep(660, 880) : beep(660, 440));

function toast(text) {
  const t = $('#toast');
  t.textContent = text; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3500);
}
function setStatus(text, bad = false) {
  $('#connStatus').textContent = text;
  $('#connStatus').style.color = bad ? 'var(--red)' : '';
}

// --- кнопки
function setMuted(v) {
  muted = v;
  if (!muted && deafened) { deafened = false; applyOutVolume(); }
  applyMute(); updateMediaButtons(); broadcastState(); renderUsers();
}
function setDeafened(v) {
  deafened = v;
  applyOutVolume(); applyMute(); updateMediaButtons(); broadcastState(); renderUsers();
}
function updateMediaButtons() {
  const set = (id, cls, on, ico, lbl) => {
    const b = $(id);
    b.classList.toggle(cls, on);
    if (ico) b.querySelector('.ico').textContent = ico;
    if (lbl) b.querySelector('.lbl').textContent = lbl;
  };
  set('#btnMute', 'off', muted || deafened, (muted || deafened) ? '🔇' : '🎙️', (muted || deafened) ? 'Выкл.' : 'Микрофон');
  set('#btnDeafen', 'off', deafened, deafened ? '🙉' : '🎧', deafened ? 'Не слышу' : 'Звук');
  set('#btnCam', 'on', !!camStream, null, 'Камера');
  set('#btnShare', 'on', !!screenStream, null, screenStream ? 'Стоп' : 'Экран');
  $('#btnFlip').hidden = !camStream;
  $('#btnShare').hidden = !CAN_SHARE;
}
$('#btnMute').onclick = () => setMuted(!(muted || deafened));
$('#btnDeafen').onclick = () => setDeafened(!deafened);
$('#btnCam').onclick = () => (camStream ? stopCamera() : startCamera());
$('#btnFlip').onclick = () => flipCamera();
$('#btnShare').onclick = () => (screenStream ? stopShare() : startShare());
const leave = () => { send({ type: 'leave' }); location.reload(); };
$('#btnLeave').onclick = leave;
$('#btnLeave2').onclick = () => { if (confirm('Выйти из комнаты?')) leave(); };
document.addEventListener('keydown', (e) => {
  if (!myId || !e.ctrlKey || !e.shiftKey) return;
  if (e.code === 'KeyM') { e.preventDefault(); $('#btnMute').click(); }
  if (e.code === 'KeyD') { e.preventDefault(); $('#btnDeafen').click(); }
});

// --- окно настроек
function bindRange(id, key, valId, apply, fmt = (v) => v + '%') {
  const el = $(id);
  el.value = settings[key];
  $(valId).textContent = fmt(settings[key]);
  el.addEventListener('input', () => {
    settings[key] = +el.value;
    $(valId).textContent = fmt(settings[key]);
    apply(); save();
  });
}
bindRange('#micVol', 'micVolume', '#micVolVal', applyMicVolume);
bindRange('#outVol', 'outVolume', '#outVolVal', applyOutVolume);
bindRange('#gate', 'gate', '#gateVal', applyGate, (v) => (v <= -100 ? 'выкл.' : v + ' дБ'));

$('#selNs').value = settings.nsMode;
$('#chkEcho').checked = settings.echo;
$('#chkAgc').checked = settings.agc;
$('#chkLeveler').checked = settings.leveler;
$('#chkLeveler').onchange = (e) => { settings.leveler = e.target.checked; save(); applyLeveler(); };
$('#selQuality').value = settings.screenQuality;
$('#selCamQuality').value = settings.camQuality;

const reopenMic = async () => {
  save();
  try { await openMic(); } catch (e) { toast('Ошибка микрофона: ' + e.message); }
};
$('#selInput').onchange = (e) => { settings.inputId = e.target.value; reopenMic(); };
$('#selOutput').onchange = (e) => { settings.outputId = e.target.value; save(); setOutputDevice(settings.outputId); };
$('#selCam').onchange = (e) => { settings.camId = e.target.value; save(); if (camStream) startCamera(); };
$('#selCamQuality').onchange = (e) => { settings.camQuality = e.target.value; save(); if (camStream) startCamera(); };
$('#selNs').onchange = (e) => { settings.nsMode = e.target.value; reopenMic(); };
$('#chkEcho').onchange = (e) => { settings.echo = e.target.checked; reopenMic(); };
$('#chkAgc').onchange = (e) => { settings.agc = e.target.checked; reopenMic(); };
$('#selQuality').onchange = (e) => {
  settings.screenQuality = e.target.value; save();
  if (screenStream) toast('Новое качество применится при следующем запуске трансляции');
};

function setTesting(v) {
  testing = v;
  A.monitor.gain.value = v ? 1 : 0;
  $('#btnTest').textContent = v ? 'Остановить проверку' : 'Проверить микрофон (слышать себя)';
  $('#btnTest').classList.toggle('active', v);
}
$('#btnTest').onclick = () => setTesting(!testing);
$('#btnNetTest').onclick = async () => {
  const out = $('#netResult');
  out.textContent = 'Проверяю…';
  $('#btnNetTest').disabled = true;
  try {
    const cfg = await fetch('config').then((r) => r.json());   // свежие временные пароли
    iceServers = cfg.iceServers; relayOnly = !!cfg.relayOnly;
    lastDiag = null;
    out.textContent = diagText(await testTurn());
  } catch (e) { out.textContent = 'Ошибка проверки: ' + e.message; }
  $('#btnNetTest').disabled = false;
};
$('#btnSettings').onclick = (e) => { e.stopPropagation(); setChatOpen(false); $('#settings').hidden = false; };
const closeSettings = () => { $('#settings').hidden = true; setTesting(false); };
$('#btnCloseSettings').onclick = closeSettings;
$('#settings').addEventListener('click', (e) => { if (e.target.id === 'settings') closeSettings(); });

// ------------------------------------------------------------------ вход
$('#inName').value = settings.name;
$('#inRoom').value = new URLSearchParams(location.search).get('room') || settings.room || '';
updateMediaButtons();

$('#loginForm').addEventListener('submit', (e) => {
  e.preventDefault();
  createAudioContext();              // строго первой строкой — иначе iPhone не даст звук
  if (!account) settings.name = $('#inName').value.trim();
  enterRoom($('#inRoom').value.trim(), $('#inPass').value);
});

let entering = false;
async function enterRoom(room, password) {
  if (entering) return;
  entering = true;
  const btn = $('#loginForm button[type=submit]');
  const err = $('#loginError');
  err.hidden = true;
  btn.disabled = true;
  settings.room = room;
  save();
  try {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('Браузер даёт доступ к микрофону только по HTTPS. Откройте адрес, начинающийся с https://' +
        (IS_IOS ? ' (на iPhone — в Safari)' : ''));
    }
    const cfg = await fetch('config').then((r) => r.json());
    iceServers = cfg.iceServers;
    relayOnly = !!cfg.relayOnly;
    if (!A.ready) await initAudio();
    if (!A.raw) await openMic();
    await ctx.resume().catch(() => {});
    await connect(room, password);
    $('#login').hidden = true;
    $('#app').hidden = false;
    $('#roomName').textContent = settings.room;
    $('#meName').textContent = myName + roleMark(myFlags);
    makeAvatar(myName, $('#meAvatar')).id = 'meAvatar';
    $('#meAvatar').dataset.speak = 'me-panel';
    applyMute(); updateMediaButtons(); broadcastState(); renderUsers();
    requestWakeLock();
    if (settings.cats) meow(0.6);
    sysMsg(`Вы вошли в комнату «${settings.room}». Пригласите друга — пусть откроет этот же адрес и введёт то же имя комнаты и пароль.`);
    if (IS_IOS) sysMsg('Совет для iPhone: не сворачивайте Safari и не блокируйте экран во время звонка — iOS ставит звук на паузу.');
  } catch (ex) {
    console.error(ex);
    err.textContent = ex.name === 'NotAllowedError' ? 'Нужно разрешить доступ к микрофону' : ex.message;
    err.hidden = false;
    btn.disabled = false;
    ws?.close(); ws = null; myId = null;
    refreshRooms();
  }
  entering = false;
}

// ------------------------------------------------------------------ аккаунт и список комнат
async function api(path, body) {
  const r = await fetch('api/' + path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Ошибка сервера (' + r.status + ')');
  return data;
}

let authMode = null;          // null | 'login' | 'register'
let registrationOpen = true;
function showAuth(mode) {
  authMode = mode;
  const reg = mode === 'register';
  $('#authForm').hidden = !mode;
  $('#whoRow').hidden = $('#loginForm').hidden = !!mode;
  $('#roomsBox').hidden = true;
  $('#authError').hidden = true;
  $('#authTitle').textContent = reg ? 'Регистрация' : 'Вход в аккаунт';
  $('#btnAuth').textContent = reg ? 'Зарегистрироваться' : 'Войти';
  $('#btnAuthMode').textContent = reg ? 'Уже есть аккаунт' : 'Создать аккаунт';
  $('#btnAuthMode').hidden = !reg && !registrationOpen;
  $('#inLoginPass').autocomplete = reg ? 'new-password' : 'current-password';
  $('#inLoginPass').placeholder = reg ? 'не короче 8 символов' : '';
  if (mode) $('#inLogin').focus();
}
function applyAccount() {
  showAuth(null);
  $('#whoText').textContent = account ? (account.admin ? '👑 ' : '👤 ') + account.login : 'Вы гость';
  $('#btnShowLogin').hidden = !!account;
  $('#btnShowReg').hidden = !!account || !registrationOpen;
  $('#btnLogout').hidden = !account;
  $('#rowName').hidden = !!account;
  $('#inName').required = !account;
  refreshRooms();
}
async function loadAccount() {
  try {
    const me = await api('me');
    account = me.user; registrationOpen = me.registration;
  } catch (e) { console.error(e); }
  applyAccount();
}
$('#btnShowLogin').onclick = () => showAuth('login');
$('#btnShowReg').onclick = () => showAuth('register');
$('#btnAuthMode').onclick = () => showAuth(authMode === 'register' ? 'login' : 'register');
$('#btnAuthBack').onclick = () => applyAccount();
$('#btnLogout').onclick = async () => {
  try { await api('logout', {}); account = null; applyAccount(); } catch (e) { toast(e.message); }
};
$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#authError');
  err.hidden = true;
  $('#btnAuth').disabled = true;
  try {
    account = (await api(authMode, { login: $('#inLogin').value, password: $('#inLoginPass').value })).user;
    $('#inLoginPass').value = '';
    applyAccount();
  } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  $('#btnAuth').disabled = false;
});

async function refreshRooms() {
  const visible = account && !authMode && !$('#login').hidden;
  $('#roomsBox').hidden = !visible;
  if (!visible) return;
  let data;
  try { data = await api('rooms'); } catch { return; }
  if (!account || authMode) return;
  $('#roomsTitle').textContent = (data.all ? '👑 ' : '') + `Все комнаты (${data.rooms.length})`;
  const ul = $('#roomList');
  ul.replaceChildren();
  if (!data.rooms.length) {
    const li = document.createElement('li');
    li.className = 'muted small';
    li.textContent = 'Комнат пока нет. Введите название выше — комната создастся и сохранится за вами';
    ul.append(li);
  }
  for (const r of data.rooms) {
    const li = document.createElement('li'); li.className = 'room-item';
    const box = document.createElement('div'); box.className = 'ri-text';
    const n = document.createElement('div'); n.className = 'ri-name'; n.textContent = r.name;
    const sub = document.createElement('div'); sub.className = 'ri-sub';
    if (r.online.length) {
      const on = document.createElement('span'); on.className = 'ri-online';
      on.textContent = `● ${r.online.length}: ${r.online.join(', ')}`;
      sub.append(on);
    } else sub.append('пусто');
    sub.append(' · ' + (r.mine ? 'ваша' : 'создатель: ' + (r.guest ? 'гость' : r.owner)));
    if (!r.free) n.textContent = (r.known ? '🔓 ' : '🔒 ') + r.name;
    box.append(n, sub);
    const go = document.createElement('button'); go.type = 'button'; go.className = 'btn'; go.textContent = 'Войти';
    go.onclick = () => {
      if (!r.free && !r.known) {   // чужая комната, ещё не входили: нужен пароль — подставляем название в форму
        $('#inRoom').value = r.name; $('#inPass').value = '';
        $('#loginError').hidden = true;
        $('#inPass').scrollIntoView({ block: 'center' }); $('#inPass').focus();
        toast(`Введите пароль комнаты «${r.name}» и нажмите «Войти в комнату»`);
        return;
      }
      createAudioContext(); enterRoom(r.name, '');   // звук на iPhone — только из нажатия
    };
    const del = document.createElement('button'); del.type = 'button'; del.className = 'icon-btn'; del.textContent = '🗑️';
    del.title = 'Удалить комнату'; del.setAttribute('aria-label', 'Удалить комнату ' + r.name);
    del.onclick = async () => {
      if (!confirm(`Удалить комнату «${r.name}»?` + (r.online.length ? ' Все, кто в ней сейчас, будут отключены.' : ''))) return;
      try { await api(`rooms/${r.id}/delete`, {}); } catch (e) { toast(e.message); }
      refreshRooms();
    };
    li.append(box, go);
    if (r.free) li.append(del);
    else if (r.known) {   // забыть пароль: дальше снова спросит
      const fg = document.createElement('button'); fg.type = 'button'; fg.className = 'icon-btn'; fg.textContent = '✕';
      fg.title = 'Забыть пароль'; fg.setAttribute('aria-label', 'Забыть пароль комнаты ' + r.name);
      fg.onclick = async () => {
        try { await api(`rooms/${r.id}/forget`, {}); } catch (e) { toast(e.message); }
        refreshRooms();
      };
      li.append(fg);
    }
    ul.append(li);
  }
}
setInterval(() => { if (!document.hidden && !entering && !$('#login').hidden) refreshRooms(); }, 5000);
loadAccount();
