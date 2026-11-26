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
  profile: null,     // профиль гостя (у аккаунта — на сервере)
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
let myName = '', myFlags = null, myProfile = null;
let profileWaiter = null;    // ждём подтверждения сохранения профиля в комнате
let canModerate = false;     // я админ или создатель этой комнаты
let myRestrict = { voice: 0, chat: 0 };   // мои ограничения: время окончания (мс), Infinity — навсегда
let kicked = false;
const roleMark = (r) => (r?.admin ? ' 👑' : r?.owner ? ' 🏠' : r?.guest ? ' · гость' : '');
// у аккаунтов рядом с ником показываем логин — чтобы ником нельзя было выдать себя за другого
const loginNote = (r) => (r?.login && r.login.toLowerCase() !== (r.name || '').toLowerCase() ? ` (@${r.login})` : '');
const roleText = (r) => (r?.admin ? ' (администратор)' : r?.owner ? ' (создатель комнаты)' : r?.guest ? ' (гость)' : '');
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
    ws.onopen = () => send({ type: 'join', room, password, guest: !account,
      name: account ? undefined : settings.name, profile: account ? undefined : settings.profile });
    ws.onerror = () => reject(new Error('Нет связи с сервером'));
    ws.onclose = () => {
      if (kicked) return;
      if (myId) { setStatus('Нет связи с сервером', true); sysMsg('Соединение с сервером потеряно. Перезагрузите страницу.'); }
    };
    ws.onmessage = async (ev) => {
      const msg = JSON.parse(ev.data);
      switch (msg.type) {
        case 'error':
          if (!myId) { reject(new Error(msg.message)); ws.close(); }
          else if (profileWaiter) profileWaiter.reject(new Error(msg.message));
          else toast(msg.message);
          break;
        case 'kicked':
          kicked = true;
          alert(msg.message);
          location.reload();
          break;
        case 'joined':
          applyMyRestrict.pending = true;
          myId = msg.id;
          myName = msg.name;
          myFlags = msg;
          myProfile = msg.profile || null;
          canModerate = !!msg.canModerate;
          myRestrict = restrictUntil(msg.restrict);
          $('#btnRoomBans').hidden = !canModerate;
          resolve();
          for (const p of msg.peers) {
            p.rs = restrictUntil(p.restrict);
            roster.set(p.id, p);
            const peer = createPeer(p.id, p.name, true);
            peer.state = p.state || {};
          }
          renderUsers(); renderStage();
          break;
        case 'peer-joined':
          msg.rs = restrictUntil(msg.restrict);
          roster.set(msg.id, msg);
          sysMsg(`${msg.name}${loginNote(msg)}${roleText(msg)} в комнате`); joinSound(true);
          break;
        case 'restrict':
          onRestrict(msg);
          break;
        case 'restrictions':
          renderRoomBans(msg.items || []);
          break;
        case 'restrictions-changed':
          if (!$('#rbDlg').hidden) send({ type: 'restrictions' });
          break;
        case 'notice':
          sysMsg(String(msg.text || ''));
          break;
        case 'announce':
          showAnnounce(String(msg.text || ''), String(msg.from || ''));
          break;
        case 'force-mute':
          if (!muted) setMuted(true);
          toast(`🔇 ${msg.by || 'Модератор'} выключил ваш микрофон. Включить снова можно кнопкой «Микрофон».`);
          break;
        case 'renamed':
        case 'profile':
          applyProfileMsg(msg);
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
  const volKey = roster.get(id)?.login || name;   // громкость помним по логину: ник может меняться
  const saved = settings.peerVolumes[volKey] || {};
  const p = {
    id, name, volKey, pc, initiator, tx: null, state: {}, queue: Promise.resolve(), pendingIce: [],
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
      if (m.type === 'chat' && typeof m.text === 'string' && !isBlocked(roster.get(p.id)?.rs, 'chat')) chatMsg(p.name, m.text.slice(0, 2000), false, roster.get(p.id)?.profile);
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
  const banned = isBlocked(roster.get(p.id)?.rs, 'voice');   // запрет голоса в комнате
  p.gain.gain.value = p.localMute || banned ? 0 : p.voice / 100;
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
// фото → эмодзи → первая буква; фон — выбранный градиент или цвет по нику
function makeAvatar(name, el = document.createElement('div'), prof = null, extraClass = '') {
  const speaking = el.classList.contains('speaking');
  el.className = 'avatar' + (extraClass ? ' ' + extraClass : '');
  const bg = profileBg(name, prof);
  if (prof?.photo) {
    el.classList.add('photo');
    el.style.background = `center / cover no-repeat url("${prof.photo}")`;
    el.style.setProperty('--ear', prof.color >= 0 ? GRADIENTS[prof.color][0] : bg);
    el.textContent = '';
  } else {
    el.style.background = bg;
    if (prof?.emoji) { el.classList.add('emoji'); el.textContent = prof.emoji; }
    else el.textContent = ([...(name || '').trim()][0] || '?').toUpperCase();
  }
  if (speaking) el.classList.add('speaking');
  return el;
}

$('#btnRename').onclick = () => openProfile();
$('#btnRename2').onclick = () => openProfile();

function renderUsers() {
  const ul = $('#userList');
  ul.replaceChildren();
  const add = (id, name, st, extra) => {
    const li = document.createElement('li');
    li.className = 'user' + (extra.connecting ? ' connecting' : '');
    li.dataset.id = id;
    const av = makeAvatar(name, undefined, extra.prof);
    av.dataset.speak = id;
    const n = document.createElement('span');
    n.className = 'uname';
    n.textContent = name + loginNote(extra.role ? { ...extra.role, name } : null) + roleMark(extra.role) + (extra.me ? ' (вы)' : '');
    if (extra.me) li.title = 'Мой профиль';
    const tx = document.createElement('div'); tx.className = 'utext'; tx.append(n);
    if (extra.prof?.status) {
      const su = document.createElement('span'); su.className = 'ustatus'; su.textContent = extra.prof.status; tx.append(su);
    }
    li.append(av, tx);
    if (st.sharing) { const l = document.createElement('span'); l.className = 'live'; l.textContent = 'В ЭФИРЕ'; li.append(l); }
    const f = document.createElement('span');
    f.className = 'flags';
    f.textContent = (st.camera ? '📷' : '') + (extra.localMute ? '🔕' : '') +
      (st.deafened ? '🔇' : st.muted ? '🤐' : '') + (extra.connecting ? '⏳' : '') +
      (isBlocked(extra.me ? myRestrict : extra.role?.rs, 'voice') ? '🚫🎙️' : '') +
      (isBlocked(extra.me ? myRestrict : extra.role?.rs, 'chat') ? '🚫💬' : '');
    li.append(f);
    li.addEventListener('click', (ev) => (extra.me ? openProfile() : openPeerMenu(id, ev)));
    ul.append(li);
  };
  add('me', myName, { muted, deafened, sharing: !!screenStream, camera: !!camStream }, { me: true, role: myFlags, prof: myProfile });
  for (const p of peers.values()) {
    add(p.id, p.name, p.state, { role: roster.get(p.id), prof: roster.get(p.id)?.profile, localMute: p.localMute, connecting: p.pc.connectionState !== 'connected' });
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
  fillPeerCard(id);
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
function fillPeerCard(id) {
  const p = peers.get(id), r = roster.get(id) || {};
  if (!p) return;
  const prof = r.profile;
  $('#pmBanner').style.background = profileBg(p.name, prof);
  makeAvatar(p.name, $('#pmAvatar'), prof, 'pm-avatar');
  $('#pmName').textContent = p.name;
  $('#pmSub').textContent = [r.login ? '@' + r.login : 'гость', r.admin ? '👑 администратор' : ''].filter(Boolean).join(' · ');
  $('#pmStatus').textContent = prof?.status || ''; $('#pmStatus').hidden = !prof?.status;
  $('#pmAbout').textContent = prof?.about || ''; $('#pmAbout').hidden = !prof?.about;
  // модерация: администратор и создатель комнаты (админа трогать может только админ, и только глушить)
  const canMod = canModerate && (!r.admin || myFlags?.admin);
  $('#pmMod').hidden = !canMod;
  $('#pmRestrict').hidden = !!r.admin;
  $('#pmBan').hidden = !myFlags?.admin || !!r.admin;
  const box = $('#pmRestricts');
  box.replaceChildren();
  for (const kind of ['voice', 'chat']) {
    if (!isBlocked(r.rs, kind)) continue;
    const row = document.createElement('div'); row.className = 'pm-restrict';
    const t = document.createElement('span');
    t.textContent = (kind === 'voice' ? '🚫🎙️ Без голоса ' : '🚫💬 Без чата ') + leftLabel(r.rs[kind]);
    row.append(t);
    if (canMod) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Снять';
      b.onclick = (e) => { e.stopPropagation(); send({ type: 'unrestrict', id, kind }); };
      row.append(b);
    }
    box.append(row);
  }
  box.hidden = !box.children.length;
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
$('#pmForceMute').onclick = () => { if (openMenuPeer) send({ type: 'force-mute', id: openMenuPeer }); closePeerMenu(); };
$('#pmRestrict').onclick = async () => {
  const id = openMenuPeer, p = peers.get(id), r = roster.get(id) || {};
  if (!p) return;
  closePeerMenu();
  const res = await askRestrict(p.name, r.login ? '@' + r.login : 'гость (по IP-адресу)');
  if (res) send({ type: 'restrict', id, ...res });
};
$('#pmBan').onclick = async () => {
  const id = openMenuPeer, p = peers.get(id), r = roster.get(id) || {};
  if (!p) return;
  closePeerMenu();
  const res = await askBan(p.name, r.login ? 'Аккаунт @' + r.login + ' не сможет войти' : 'Гость — бан по IP-адресу');
  if (res) send({ type: 'ban', id, seconds: res.seconds, reason: res.reason });
};

function peerVolInput(key, valEl) {
  return (e) => {
    const p = peers.get(openMenuPeer);
    if (!p) return;
    p[key] = +e.target.value;
    valEl.textContent = p[key] + '%';
    applyPeerVolume(p);
    settings.peerVolumes[p.volKey] = { voice: p.voice, screen: p.screen };
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
function chatMsg(name, text, mine, prof = null) {
  const log = $('#chatLog');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  const d = document.createElement('div'); d.className = 'msg';
  const t = document.createElement('time'); t.textContent = new Date().toLocaleTimeString().slice(0, 5);
  const b = document.createElement('b'); b.textContent = name; b.style.color = colorFor(name);
  d.append(t, makeAvatar(name, undefined, prof, 'mini'), b, document.createTextNode(text));
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
  if (isBlocked(myRestrict, 'chat')) { toast(`💬 Вам запрещён чат в этой комнате ${leftLabel(myRestrict.chat)}`); return; }
  const payload = JSON.stringify({ type: 'chat', text });
  let sent = 0;
  for (const p of peers.values()) if (p.dc.readyState === 'open') { p.dc.send(payload); sent++; }
  chatMsg(myName, text, true, myProfile);
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
  if (!v && isBlocked(myRestrict, 'voice')) { toast(`🎙️ Вам запрещён голос в этой комнате ${leftLabel(myRestrict.voice)}`); v = true; }
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
    makeAvatar(myName, $('#meAvatar'), myProfile);
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
  updateWho();
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

// ------------------------------------------------------------------ профиль
const GRADIENTS = [
  ['#7b6cff', '#c86bff'], ['#ff5f8f', '#ffa45c'], ['#2bc0e4', '#3a7bd5'], ['#34d27b', '#a8e063'],
  ['#f7971e', '#ffd200'], ['#ff6fb1', '#ffc2dc'], ['#00c6ff', '#0062ff'], ['#3ee8b5', '#0f9b8e'],
  ['#a18cd1', '#fbc2eb'], ['#ff512f', '#dd2476'], ['#5b6378', '#1f232d'], ['#f6d365', '#fda085'],
];
const EMOJIS = ['🐱', '😺', '😼', '🦊', '🐼', '🐸', '🐧', '🦄', '🐙', '🐝', '🦋', '🐶',
  '🌸', '🌙', '⭐', '🔥', '⚡', '🍓', '🍑', '🍕', '🎮', '🎧', '👾', '👻'];
const STATUS_CHIPS = ['🎮 Играю', '🎧 Слушаю музыку', '📚 Учусь', '💼 Работаю', '🍿 Смотрю кино', '💤 Отошёл', '🐱 Глажу кота'];
const MODES = ['photo', 'emoji', 'letter'];
const CROP = 320;            // внутренний размер холста обрезки
const PHOTO_SIZE = 256;      // итоговая аватарка

function profileBg(name, prof) {
  const c = prof?.color ?? -1;
  return c >= 0 && GRADIENTS[c] ? `linear-gradient(135deg, ${GRADIENTS[c][0]}, ${GRADIENTS[c][1]})` : colorFor(name || '?');
}
const inRoom = () => !!(myId && ws && ws.readyState === WebSocket.OPEN);
const currentName = () => (inRoom() ? myName : account ? (account.nick || account.login) : ($('#inName').value.trim() || settings.name || ''));
const currentProfile = () => (inRoom() ? myProfile : account ? account.profile : settings.profile) || {};

function updateWho() {
  updateAdminButtons();
  const name = currentName() || 'Гость';
  makeAvatar(name, $('#whoAvatar'), currentProfile());
  $('#whoText').textContent = (account?.admin ? '👑 ' : '') + name;
  $('.who-me-hint').textContent = (account ? '@' + account.login : 'гость') + ' · профиль ›';
}
$('#inName').addEventListener('input', () => { if (!account) updateWho(); });
$('#btnProfile').onclick = () => openProfile();

function applyProfileMsg(msg) {
  if (msg.id === myId) {
    const was = myName;
    myName = msg.name;
    if (msg.profile) myProfile = msg.profile;
    myFlags = { ...myFlags, name: myName, profile: myProfile };
    if (account) { account.nick = myName; account.profile = myProfile; }
    else { settings.name = myName; settings.profile = myProfile; save(); $('#inName').value = myName; }
    $('#meName').textContent = myName + roleMark(myFlags);
    makeAvatar(myName, $('#meAvatar'), myProfile);
    if (was !== myName) sysMsg(`Теперь вас зовут «${myName}»`);
    profileWaiter?.resolve();
  } else {
    const p = peers.get(msg.id), r = roster.get(msg.id);
    const old = p?.name || r?.name;
    if (r) { r.name = msg.name; if (msg.profile) r.profile = msg.profile; }
    if (p) p.name = msg.name;
    if (old && old !== msg.name) sysMsg(`${old} теперь «${msg.name}»`);
    if (openMenuPeer === msg.id) fillPeerCard(msg.id);
  }
  renderUsers(); renderStage();
}

// --- редактор
let draft = null;     // { name, emoji, color, photo, status, about, mode }
let crop = null;      // { img, w, h, zoom, x, y } — пока выбираем кадр нового фото

function draftProfile() {
  const photo = draft.mode === 'photo' ? draft.photo : '';
  return { emoji: draft.mode === 'emoji' ? draft.emoji : '', color: draft.color, photo,
    status: draft.status.trim(), about: draft.about.trim() };
}

function buildProfileUi() {
  const em = $('#pfEmojis');
  for (const e of EMOJIS) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'pf-emoji'; b.textContent = e;
    b.setAttribute('aria-label', 'Эмодзи ' + e);
    b.onclick = () => { draft.emoji = e; $('#pfEmojiCustom').value = ''; renderProfilePreview(true); };
    em.append(b);
  }
  const cs = $('#pfColors');
  for (let i = -1; i < GRADIENTS.length; i++) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'pf-swatch' + (i < 0 ? ' auto' : '');
    b.setAttribute('role', 'radio'); b.dataset.c = i;
    b.setAttribute('aria-label', i < 0 ? 'Цвет по нику' : 'Цвет ' + (i + 1));
    if (i >= 0) b.style.background = `linear-gradient(135deg, ${GRADIENTS[i][0]}, ${GRADIENTS[i][1]})`;
    b.onclick = () => { draft.color = i; renderProfilePreview(); };
    cs.append(b);
  }
  const ch = $('#pfChips');
  for (const t of STATUS_CHIPS) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'pf-chip'; b.textContent = t;
    b.onclick = () => { draft.status = $('#pfStatus').value = t; renderProfilePreview(); };
    ch.append(b);
  }
  const x = document.createElement('button'); x.type = 'button'; x.className = 'pf-chip'; x.textContent = '✕ Без статуса';
  x.onclick = () => { draft.status = $('#pfStatus').value = ''; renderProfilePreview(); };
  ch.append(x);

  $$('#pfSeg button').forEach((b) => {
    b.onclick = () => {
      const m = b.dataset.mode;
      if (m === 'photo' && !draft.photo && !crop) { $('#pfFile').click(); return; }
      setMode(m);
    };
  });
  $('#pfName').oninput = (e) => { draft.name = e.target.value; renderProfilePreview(); };
  $('#pfStatus').oninput = (e) => { draft.status = e.target.value; renderProfilePreview(); };
  $('#pfAbout').oninput = (e) => { draft.about = e.target.value; renderProfilePreview(); };
  $('#pfEmojiCustom').oninput = (e) => {
    const v = e.target.value.trim();
    if (v) { draft.emoji = [...v].slice(0, 8).join(''); renderProfilePreview(true); }
  };
  $('#pfPick').onclick = () => $('#pfFile').click();
  $('#pfCamBtn').onclick = () => $('#pfFile').click();
  $('#pfRemovePhoto').onclick = () => { draft.photo = ''; crop = null; setMode(draft.emoji ? 'emoji' : 'letter'); };
  $('#pfFile').onchange = onPhotoPicked;
  $('#pfZoom').oninput = (e) => { if (crop) { crop.zoom = +e.target.value; clampCrop(); drawCrop(); } };
  $('#pfCancel').onclick = closeProfile;
  $('#pfSave').onclick = saveProfile;
  $('#profile').addEventListener('click', (e) => { if (e.target.id === 'profile') closeProfile(); });
  document.addEventListener('keydown', (e) => {
    if ($('#profile').hidden) return;
    if (e.key === 'Escape') closeProfile();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveProfile();
  });
  setupCropGestures();
}

function openProfile() {
  const prof = currentProfile();
  draft = {
    name: currentName(), emoji: prof.emoji || '', color: prof.color ?? -1, photo: prof.photo || '',
    status: prof.status || '', about: prof.about || '', mode: prof.photo ? 'photo' : prof.emoji ? 'emoji' : 'letter',
  };
  crop = null;
  $('#pfName').value = draft.name; $('#pfStatus').value = draft.status; $('#pfAbout').value = draft.about;
  $('#pfEmojiCustom').value = draft.emoji && !EMOJIS.includes(draft.emoji) ? draft.emoji : '';
  $('#pfError').hidden = true;
  $('#pfNote').textContent = account
    ? 'Профиль видят все, с кем вы в комнате. Сохраняется в аккаунте и работает на всех устройствах.'
    : 'Вы гость: профиль хранится только в этом браузере. Зарегистрируйтесь, чтобы он был с вами везде.';
  setMode(draft.mode, false);
  closePeerMenu();
  $('#settings').hidden = true;
  if (!$('#app').hidden) setChatOpen(false);
  const sh = $('#profile');
  sh.hidden = false;
  sh.querySelector('.sheet-card').scrollTop = 0;
  requestAnimationFrame(() => requestAnimationFrame(() => sh.classList.add('open')));
}
function closeProfile() {
  const sh = $('#profile');
  if (sh.hidden) return;
  sh.classList.remove('open');
  setTimeout(() => { if (!sh.classList.contains('open')) sh.hidden = true; }, 320);
  crop = null;
}

function setMode(mode, animate = true) {
  draft.mode = mode;
  const seg = $('#pfSeg');
  seg.dataset.i = MODES.indexOf(mode);
  seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === mode)));
  $('#pfPhotoPane').hidden = mode !== 'photo';
  $('#pfEmojiPane').hidden = mode !== 'emoji';
  if (mode === 'emoji' && !draft.emoji) draft.emoji = EMOJIS[0];
  renderProfilePreview(animate);
}

function renderProfilePreview(pop = false) {
  const prof = draftProfile();
  const cropping = !!crop && draft.mode === 'photo';
  $('#pfBanner').style.background = profileBg(draft.name, prof);
  const av = makeAvatar(draft.name || '?', $('#pfAvatar'), cropping ? null : prof, 'pf-avatar');
  if (pop) { av.classList.remove('pop'); void av.offsetWidth; av.classList.add('pop'); }
  av.style.visibility = cropping ? 'hidden' : '';
  $('#pfCrop').hidden = !cropping;
  $('#pfZoomRow').hidden = !cropping;
  $('#pfPreviewName').textContent = draft.name.trim() || 'Без имени';
  $('#pfPreviewSub').textContent = account ? '@' + account.login + (account.admin ? ' · 👑 администратор' : '') : 'гость';
  $('#pfPreviewStatus').textContent = draft.status.trim();
  $('#pfAboutCount').textContent = `${draft.about.length}/160`;
  const hasPhoto = !!(draft.photo || crop);
  $('#pfRemovePhoto').hidden = !hasPhoto;
  $('#pfPick').textContent = hasPhoto ? '🖼️ Другое фото…' : '🖼️ Выбрать фото…';
  $$('#pfEmojis .pf-emoji').forEach((b) => b.setAttribute('aria-pressed', String(b.textContent === draft.emoji)));
  $$('#pfColors .pf-swatch').forEach((b) => {
    b.setAttribute('aria-checked', String(+b.dataset.c === draft.color));
    if (b.classList.contains('auto')) b.style.background = colorFor(draft.name || '?');
  });
}

function pfError(text) { $('#pfError').textContent = text; $('#pfError').hidden = false; }

// --- фото: выбор, кадрирование пальцем/мышью, сжатие
async function onPhotoPicked(e) {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  $('#pfError').hidden = true;
  if (f.type && !f.type.startsWith('image/')) return pfError('Это не картинка');
  if (f.size > 30e6) return pfError('Файл слишком большой (больше 30 МБ)');
  try {
    let img;
    try { img = await createImageBitmap(f, { imageOrientation: 'from-image' }); }
    catch {
      const url = URL.createObjectURL(f);
      img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    }
    const w = img.width || img.naturalWidth, h = img.height || img.naturalHeight;
    if (!w || !h) throw new Error();
    crop = { img, w, h, zoom: 1, x: 0, y: 0 };
    $('#pfZoom').value = 1;
    setMode('photo');
    drawCrop();
  } catch { pfError('Не получилось открыть фото. Попробуйте JPG или PNG.'); }
}
const cropScale = () => Math.max(CROP / crop.w, CROP / crop.h) * crop.zoom;
function clampCrop() {
  const s = cropScale();
  const mx = Math.max(0, (crop.w * s - CROP) / 2), my = Math.max(0, (crop.h * s - CROP) / 2);
  crop.x = Math.min(mx, Math.max(-mx, crop.x));
  crop.y = Math.min(my, Math.max(-my, crop.y));
}
function drawCrop(canvas = $('#pfCrop'), size = CROP) {
  if (!crop) return;
  const c = canvas.getContext('2d');
  const k = size / CROP, s = cropScale() * k;
  const dw = crop.w * s, dh = crop.h * s;
  c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
  c.fillStyle = '#000'; c.fillRect(0, 0, size, size);
  c.drawImage(crop.img, (size - dw) / 2 + crop.x * k, (size - dh) / 2 + crop.y * k, dw, dh);
}
function exportCrop() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = PHOTO_SIZE;
  drawCrop(cv, PHOTO_SIZE);
  let q = 0.9, url;
  do { url = cv.toDataURL('image/jpeg', q); q -= 0.08; } while (url.length > 76000 && q > 0.3);
  return url.startsWith('data:image/jpeg;base64,') ? url : '';
}
function setupCropGestures() {
  const cv = $('#pfCrop');
  const pts = new Map();
  let pinch = null;
  const ratio = () => CROP / cv.getBoundingClientRect().width;
  cv.addEventListener('pointerdown', (e) => { cv.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); });
  cv.addEventListener('pointermove', (e) => {
    if (!crop || !pts.has(e.pointerId)) return;
    const prev = pts.get(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) {   // щипок двумя пальцами — масштаб
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (!pinch) pinch = { d, zoom: crop.zoom };
      crop.zoom = Math.min(4, Math.max(1, pinch.zoom * d / pinch.d));
      $('#pfZoom').value = crop.zoom;
    } else {
      crop.x += (e.clientX - prev.x) * ratio();
      crop.y += (e.clientY - prev.y) * ratio();
    }
    clampCrop(); drawCrop();
  });
  const up = (e) => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
  cv.addEventListener('wheel', (e) => {
    if (!crop) return;
    e.preventDefault();
    crop.zoom = Math.min(4, Math.max(1, crop.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08)));
    $('#pfZoom').value = crop.zoom;
    clampCrop(); drawCrop();
  }, { passive: false });
}

async function saveProfile() {
  const btn = $('#pfSave');
  if (btn.disabled) return;
  const name = $('#pfName').value.trim();
  if (!name) { pfError('Введите ник'); $('#pfName').focus(); return; }
  if (crop && draft.mode === 'photo') {
    draft.photo = exportCrop();
    if (!draft.photo) { pfError('Браузер не смог сжать фото'); return; }
  }
  if (draft.mode === 'photo' && !draft.photo) draft.mode = 'letter';
  draft.name = name;
  const prof = draftProfile();
  btn.disabled = true;
  $('#pfError').hidden = true;
  try {
    if (inRoom()) {
      await new Promise((resolve, reject) => {
        profileWaiter = { resolve, reject };
        send({ type: 'profile', name, profile: prof });
        setTimeout(() => reject(new Error('Сервер не ответил, попробуйте ещё раз')), 8000);
      });
    } else if (account) {
      const r = await api('profile', { name, profile: prof });
      account = r.user;
    } else {
      settings.name = name; settings.profile = prof; save();
      $('#inName').value = name;
    }
    crop = null;
    updateWho();
    closeProfile();
    toast('Профиль сохранён ✨');
    if (settings.cats) meow(0.4);
  } catch (e) {
    pfError(e.message);
  } finally {
    btn.disabled = false;
    profileWaiter = null;
  }
}
buildProfileUi();
updateWho();

// ------------------------------------------------------------------ модерация
// --- выбор срока: готовые варианты или своё число минут/часов/дней
const DUR_PRESETS = [[300, '5 мин'], [900, '15 мин'], [3600, '1 час'], [86400, '1 день'], [604800, '7 дней'], [2592000, '30 дней'], [0, 'Навсегда']];
function makeDurPicker(el) {
  el.replaceChildren();
  const chips = document.createElement('div'); chips.className = 'chips-select'; chips.setAttribute('role', 'radiogroup');
  const custom = document.createElement('div'); custom.className = 'dur-custom'; custom.hidden = true;
  const num = document.createElement('input'); num.type = 'number'; num.min = '1'; num.max = '999'; num.value = '30'; num.inputMode = 'numeric';
  num.setAttribute('aria-label', 'Сколько');
  const unit = document.createElement('select'); unit.setAttribute('aria-label', 'Единица');
  for (const [v, t] of [[60, 'минут'], [3600, 'часов'], [86400, 'дней']]) { const o = document.createElement('option'); o.value = v; o.textContent = t; unit.append(o); }
  custom.append(num, unit);
  let value = 0, isCustom = false;
  const mark = () => chips.querySelectorAll('button').forEach((b) =>
    b.setAttribute('aria-checked', String(b.dataset.custom ? isCustom : !isCustom && +b.dataset.s === value)));
  for (const [s, t] of DUR_PRESETS) {
    const b = document.createElement('button'); b.type = 'button'; b.dataset.s = s; b.textContent = t;
    b.onclick = () => { value = s; isCustom = false; custom.hidden = true; mark(); };
    chips.append(b);
  }
  const cb = document.createElement('button'); cb.type = 'button'; cb.dataset.custom = '1'; cb.textContent = 'Своё…';
  cb.onclick = () => { isCustom = true; custom.hidden = false; mark(); num.focus(); num.select(); };
  chips.append(cb);
  el.append(chips, custom);
  return {
    reset(s) { value = s; isCustom = false; custom.hidden = true; mark(); },
    get() {
      if (!isCustom) return value;
      const n = Math.round(+num.value) * +unit.value;
      return n >= 60 && n <= 366 * 86400 ? n : null;
    },
  };
}
const banPicker = makeDurPicker($('#banDur'));
const rsPicker = makeDurPicker($('#rsDur'));

// --- ограничения в комнате: голос, чат, выгнать
function restrictUntil(info) {
  const conv = (v) => (v == null ? 0 : v === 0 ? Infinity : Date.now() + v * 1000);
  return { voice: conv(info?.voice), chat: conv(info?.chat) };
}
function isBlocked(rs, kind) { return !!rs && rs[kind] > Date.now(); }
function leftLabel(until) {
  if (until === Infinity || until === 0) return 'навсегда';
  const min = Math.max(1, Math.ceil((until - Date.now()) / 60000));   // вверх до минуты
  const d = Math.floor(min / 1440), h = Math.floor(min % 1440 / 60), m = min % 60;
  if (d) return 'ещё ' + d + ' дн' + (h ? ' ' + h + ' ч' : '');
  if (h) return 'ещё ' + h + ' ч' + (m ? ' ' + m + ' мин' : '');
  return 'ещё ' + m + ' мин';
}
function onRestrict(msg) {
  if (msg.id === myId) {
    myRestrict = restrictUntil(msg.restrict);
    applyMyRestrict();
    if (isBlocked(myRestrict, 'voice')) toast(`🎙️ Вам запретили голос ${leftLabel(myRestrict.voice)}`);
    else if (isBlocked(myRestrict, 'chat')) toast(`💬 Вам запретили чат ${leftLabel(myRestrict.chat)}`);
  } else {
    const r = roster.get(msg.id);
    if (r) { r.restrict = msg.restrict; r.rs = restrictUntil(msg.restrict); }
    const p = peers.get(msg.id);
    if (p) applyPeerVolume(p);
    if (openMenuPeer === msg.id) fillPeerCard(msg.id);
  }
  renderUsers();
}
function applyMyRestrict() {
  const v = isBlocked(myRestrict, 'voice'), c = isBlocked(myRestrict, 'chat');
  if (v && !muted) setMuted(true);
  $('#btnMute').classList.toggle('locked', v);
  $('#btnMute').title = v ? `Голос запрещён ${leftLabel(myRestrict.voice)}` : 'Микрофон (Ctrl+Shift+M)';
  const ci = $('#chatInput');
  ci.disabled = c;
  ci.placeholder = c ? `Чат запрещён ${leftLabel(myRestrict.chat)}` : 'Сообщение (сквозное шифрование)';
}
// сроки истекают сами: раз в 5 секунд пересчитываем, кого снова слышно
setInterval(() => {
  if (!myId) return;
  if (applyMyRestrict.pending) { applyMyRestrict.pending = false; applyMyRestrict(); }
  const any = [...roster.values()].some((r) => r.rs && (r.rs.voice || r.rs.chat)) || myRestrict.voice || myRestrict.chat;
  if (!any) return;
  for (const p of peers.values()) applyPeerVolume(p);
  applyMyRestrict();
  renderUsers();
  if (openMenuPeer) fillPeerCard(openMenuPeer);
}, 5000);

const RS_KINDS = ['voice', 'chat', 'kick'];
const RS_TEXT = {
  voice: { icon: '🎙️', ok: 'Запретить голос', hint: 'Его перестанут слышать в этой комнате. Микрофон у него выключится.' },
  chat: { icon: '💬', ok: 'Запретить чат', hint: 'Его сообщения перестанут показываться, писать он не сможет.' },
  kick: { icon: '🚪', ok: 'Выгнать', hint: 'Его отключат, и он не сможет зайти в эту комнату, пока срок не выйдет.' },
};
let rsResolve = null, rsKind = 'voice';
function setRsKind(kind) {
  rsKind = kind;
  const seg = $('#rsSeg');
  seg.dataset.i = RS_KINDS.indexOf(kind);
  seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.kind === kind)));
  $('#rsIcon').textContent = RS_TEXT[kind].icon;
  $('#rsOk').textContent = RS_TEXT[kind].ok;
  $('#rsHint').textContent = RS_TEXT[kind].hint;
}
function askRestrict(name, sub) {
  $('#rsTitle').textContent = 'Ограничить ' + name;
  $('#rsSub').textContent = sub;
  $('#rsReason').value = '';
  setRsKind('voice');
  rsPicker.reset(900);
  openSheet($('#rsDlg'));
  return new Promise((res) => { rsResolve = res; });
}
function finishRestrict(result) { closeSheet($('#rsDlg')); rsResolve?.(result); rsResolve = null; }
$$('#rsSeg button').forEach((b) => { b.onclick = () => setRsKind(b.dataset.kind); });
$('#rsCancel').onclick = () => finishRestrict(null);
$('#rsDlg').addEventListener('click', (e) => { if (e.target.id === 'rsDlg') finishRestrict(null); });
$('#rsOk').onclick = () => {
  const seconds = rsPicker.get();
  if (seconds == null) { toast('Срок: от 1 минуты до 366 дней'); return; }
  finishRestrict({ kind: rsKind, seconds, reason: $('#rsReason').value.trim() });
};

// --- список ограничений комнаты (снять раньше срока, в том числе с выгнанных)
const RB_LABEL = { voice: '🚫🎙️ без голоса', chat: '🚫💬 без чата', kick: '🚪 выгнан' };
$('#btnRoomBans').onclick = () => {
  $('#rbList').innerHTML = '<li class="adm-empty">Загружаю…</li>';
  openSheet($('#rbDlg'));
  send({ type: 'restrictions' });
};
$('#rbClose').onclick = () => closeSheet($('#rbDlg'));
$('#rbDlg').addEventListener('click', (e) => { if (e.target.id === 'rbDlg') closeSheet($('#rbDlg')); });
function renderRoomBans(items) {
  const ul = $('#rbList');
  ul.replaceChildren();
  if (!items.length) { const li = document.createElement('li'); li.className = 'adm-empty'; li.textContent = 'Ограничений нет 🎉'; ul.append(li); return; }
  for (const it of items) {
    const li = document.createElement('li'); li.className = 'adm-row';
    const main = document.createElement('div'); main.className = 'adm-main';
    const nm = document.createElement('div'); nm.className = 'adm-name'; nm.textContent = it.name || '?';
    const meta = document.createElement('div'); meta.className = 'adm-meta';
    meta.textContent = `${RB_LABEL[it.kind] || it.kind} · ${it.left ? leftLabel(Date.now() + it.left * 1000) : 'навсегда'} · ${it.by || '?'}` + (it.reason ? ` · ${it.reason}` : '');
    main.append(nm, meta);
    const acts = document.createElement('div'); acts.className = 'adm-acts';
    const b = document.createElement('button'); b.type = 'button'; b.textContent = '✅ Снять';
    b.onclick = () => { b.disabled = true; send({ type: 'unrestrict', target: it.target, kind: it.kind }); };
    acts.append(b);
    li.append(makeAvatar(it.name || '?'), main, acts);
    ul.append(li);
  }
}

function openSheet(el) {
  el.hidden = false;
  el.querySelector('.sheet-card').scrollTop = 0;
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('open')));
}
function closeSheet(el) {
  if (el.hidden) return;
  el.classList.remove('open');
  setTimeout(() => { if (!el.classList.contains('open')) el.hidden = true; }, 320);
}

let banResolve = null;
function askBan(name, sub) {
  $('#banTitle').textContent = 'Забанить ' + name + '?';
  $('#banSub').textContent = sub;
  $('#banReason').value = '';
  banPicker.reset(86400);
  openSheet($('#banDlg'));
  return new Promise((res) => { banResolve = res; });
}
function finishBan(result) { closeSheet($('#banDlg')); banResolve?.(result); banResolve = null; }
$('#banCancel').onclick = () => finishBan(null);
$('#banDlg').addEventListener('click', (e) => { if (e.target.id === 'banDlg') finishBan(null); });
$('#banOk').onclick = () => {
  const seconds = banPicker.get();
  if (seconds == null) { toast('Срок: от 1 минуты до 366 дней'); return; }
  finishBan({ seconds, reason: $('#banReason').value.trim() });
};

let announceTimer = null;
function showAnnounce(text, from) {
  $('#announceText').textContent = `📢 ${from ? from + ': ' : ''}${text}`;
  $('#announce').hidden = false;
  sysMsg(`📢 Объявление${from ? ' от ' + from : ''}: ${text}`);
  settings.cats ? meow(0.7) : beep(660, 880, 0.12);
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => { $('#announce').hidden = true; }, 15000);
}
$('#announceClose').onclick = () => { $('#announce').hidden = true; };

// ------------------------------------------------------------------ админ-панель
let admData = null, admTab = 'users', admFilter = 'all';
const ADM_TABS = ['users', 'guests', 'announce'];

function agoText(t) {
  if (!t) return 'давно';
  const s = Date.now() / 1000 - t;
  if (s < 90) return 'только что';
  if (s < 3600) return Math.round(s / 60) + ' мин назад';
  if (s < 86400) return Math.round(s / 3600) + ' ч назад';
  if (s < 86400 * 30) return Math.round(s / 86400) + ' дн назад';
  return new Date(t * 1000).toLocaleDateString();
}
function leftText(until) {
  if (!until) return 'навсегда';
  const s = until - Date.now() / 1000;
  if (s < 3600) return 'ещё ' + Math.max(1, Math.round(s / 60)) + ' мин';
  if (s < 86400) return 'ещё ' + Math.round(s / 3600) + ' ч';
  return 'ещё ' + Math.round(s / 86400) + ' дн';
}

async function openAdmin() {
  closePeerMenu();
  $('#settings').hidden = true;
  if (!$('#app').hidden) setChatOpen(false);
  openSheet($('#adminPanel'));
  setAdmTab(admTab);
  await loadAdmin();
}
async function loadAdmin() {
  try { admData = await api('admin/users'); } catch (e) { toast(e.message); return; }
  const st = admData.stats;
  const stat = (n, label) => `<div class="adm-stat"><b>${n}</b><span>${label}</span></div>`;
  $('#admStats').innerHTML = stat(st.users, 'аккаунтов') + stat(st.online, 'сейчас онлайн') + stat(st.rooms, 'активных комнат') + stat(st.banned, 'забанено');
  renderAdmin();
}
function setAdmTab(tab) {
  admTab = tab;
  const seg = $('#admSeg');
  seg.dataset.i = ADM_TABS.indexOf(tab);
  seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  $('#admUsers').hidden = tab !== 'users';
  $('#admGuests').hidden = tab !== 'guests';
  $('#admAnnounce').hidden = tab !== 'announce';
}
function admButton(text, onclick, danger = false) {
  const b = document.createElement('button'); b.type = 'button'; b.textContent = text;
  if (danger) b.className = 'danger';
  b.onclick = onclick;
  return b;
}
async function admAction(body, okText) {
  try { await api('admin/action', body); if (okText) toast(okText); } catch (e) { toast(e.message); }
  await loadAdmin();
}
function renderAdmin() {
  if (!admData) return;
  const q = $('#admSearch').value.trim().toLowerCase();
  const ul = $('#admUserList');
  ul.replaceChildren();
  const users = admData.users.filter((u) =>
    (!q || u.login.toLowerCase().includes(q) || u.nick.toLowerCase().includes(q)) &&
    (admFilter === 'all' || (admFilter === 'online' && u.online.length) || (admFilter === 'admins' && u.admin) || (admFilter === 'banned' && u.banned)));
  if (!users.length) { const li = document.createElement('li'); li.className = 'adm-empty'; li.textContent = 'Никого не нашлось'; ul.append(li); }
  for (const u of users) {
    const li = document.createElement('li'); li.className = 'adm-row';
    const main = document.createElement('div'); main.className = 'adm-main';
    const nm = document.createElement('div'); nm.className = 'adm-name';
    nm.textContent = u.nick + (u.admin ? ' 👑' : '') + (u.nick.toLowerCase() !== u.login.toLowerCase() ? ` (@${u.login})` : '');
    const meta = document.createElement('div'); meta.className = 'adm-meta';
    const bits = [];
    if (u.online.length) { const s = document.createElement('span'); s.className = 'on'; s.textContent = '🟢 в «' + u.online.join('», «') + '»'; bits.push(s); }
    else bits.push(u.lastSeen ? 'был(а) ' + agoText(u.lastSeen) : 'создан ' + agoText(u.created));
    if (u.banned) { const s = document.createElement('span'); s.className = 'ban'; s.textContent = '⛔ бан ' + leftText(u.bannedUntil) + (u.banReason ? ` · ${u.banReason}` : ''); bits.push(s); }
    bits.push(`комнат: ${u.rooms}`);
    bits.forEach((b, i) => { if (i) meta.append(' · '); meta.append(b); });
    main.append(nm, meta);
    const acts = document.createElement('div'); acts.className = 'adm-acts';
    const isMe = account && u.login === account.login;
    if (!isMe) {
      if (u.banned) acts.append(admButton('✅ Разбан', () => admAction({ action: 'unban', login: u.login }, `${u.nick} разбанен`)));
      else acts.append(admButton('⛔ Бан', async () => {
        const r = await askBan(u.nick, '@' + u.login + ' не сможет войти, пока бан не закончится');
        if (r) admAction({ action: 'ban', login: u.login, ...r }, `${u.nick} забанен`);
      }, true));
      acts.append(admButton(u.admin ? 'Снять 👑' : 'Дать 👑', () => {
        if (confirm(u.admin ? `Снять права администратора у ${u.nick}?` : `Сделать ${u.nick} администратором? Он сможет банить и заходить в любые комнаты.`))
          admAction({ action: u.admin ? 'demote' : 'promote', login: u.login }, 'Готово');
      }));
      acts.append(admButton('🗑', () => {
        if (confirm(`Удалить аккаунт @${u.login} навсегда?\nЕго комнаты тоже удалятся. Это нельзя отменить.`))
          admAction({ action: 'delete', login: u.login }, 'Аккаунт удалён');
      }, true));
    } else {
      const me = document.createElement('span'); me.className = 'adm-meta'; me.textContent = 'это вы'; acts.append(me);
    }
    li.append(makeAvatar(u.nick, undefined, u.profile), main, acts);
    ul.append(li);
  }

  const gl = $('#admGuestList');
  gl.replaceChildren();
  if (!admData.guests.length) { const li = document.createElement('li'); li.className = 'adm-empty'; li.textContent = 'Сейчас гостей нет'; gl.append(li); }
  for (const g of admData.guests) {
    const li = document.createElement('li'); li.className = 'adm-row';
    const main = document.createElement('div'); main.className = 'adm-main';
    const nm = document.createElement('div'); nm.className = 'adm-name'; nm.textContent = g.name + ' · гость';
    const meta = document.createElement('div'); meta.className = 'adm-meta'; meta.textContent = `в «${g.room}» · IP ${g.ip}`;
    main.append(nm, meta);
    const acts = document.createElement('div'); acts.className = 'adm-acts';
    acts.append(admButton('⛔ Бан по IP', async () => {
      const r = await askBan(g.name, 'Бан по IP ' + g.ip + ': с этого адреса не войдёт никто');
      if (r) admAction({ action: 'ban-ip', ip: g.ip, ...r }, 'IP забанен');
    }, true));
    li.append(makeAvatar(g.name), main, acts);
    gl.append(li);
  }

  const bl = $('#admBanList');
  bl.replaceChildren();
  if (!admData.bans.length) { const li = document.createElement('li'); li.className = 'adm-empty'; li.textContent = 'Банов по IP нет'; bl.append(li); }
  for (const b of admData.bans) {
    const li = document.createElement('li'); li.className = 'adm-row';
    const main = document.createElement('div'); main.className = 'adm-main';
    const nm = document.createElement('div'); nm.className = 'adm-name'; nm.textContent = b.ip;
    const meta = document.createElement('div'); meta.className = 'adm-meta';
    meta.textContent = `⛔ ${leftText(b.until)} · забанил ${b.by || '?'}${b.reason ? ' · ' + b.reason : ''}`;
    main.append(nm, meta);
    const acts = document.createElement('div'); acts.className = 'adm-acts';
    acts.append(admButton('✅ Разбан', () => admAction({ action: 'unban-ip', ip: b.ip }, 'IP разбанен')));
    li.append(main, acts);
    bl.append(li);
  }
}
$$('#admSeg button').forEach((b) => { b.onclick = () => setAdmTab(b.dataset.tab); });
$$('.adm-filters .pf-chip').forEach((b) => {
  b.onclick = () => { admFilter = b.dataset.f; $$('.adm-filters .pf-chip').forEach((x) => x.classList.toggle('on', x === b)); renderAdmin(); };
});
$('#admSearch').oninput = renderAdmin;
$('#admRefresh').onclick = loadAdmin;
$('#admClose').onclick = () => closeSheet($('#adminPanel'));
$('#adminPanel').addEventListener('click', (e) => { if (e.target.id === 'adminPanel') closeSheet($('#adminPanel')); });
$('#admSend').onclick = async () => {
  const text = $('#admText').value.trim();
  if (!text) return;
  try {
    const r = await api('admin/action', { action: 'announce', text });
    toast(r.delivered ? `📢 Доставлено: ${r.delivered} чел.` : 'Сейчас никого нет в комнатах');
    $('#admText').value = '';
  } catch (e) { toast(e.message); }
};
$('#btnAdmin').onclick = openAdmin;
$('#btnAdmin2').onclick = openAdmin;
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#rsDlg').hidden) finishRestrict(null);
  else if (!$('#rbDlg').hidden) closeSheet($('#rbDlg'));
  else if (!$('#banDlg').hidden) finishBan(null);
  else if (!$('#adminPanel').hidden) closeSheet($('#adminPanel'));
});
function updateAdminButtons() {
  $('#btnAdmin').hidden = !account?.admin;
  $('#btnAdmin2').hidden = !account?.admin;
}
