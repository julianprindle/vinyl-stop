// Vinyl Stop: DOM wiring. Connects to LUNA, follows the focused session, shows what the
// highlighted range and selected tracks would get, and runs TapeStop.apply (logic.js).

const ADD_ON_ID = 'com.julianprindle.vinyl_stop';
const $ = (id) => document.getElementById(id);
let luna;
let session;
let releases = [];
let laneReleases = [];
let busy = false;
const keep = (u) => releases.push(u);
const releaseLanes = () => {
  for (const u of laneReleases) u();
  laneReleases = [];
};
const release = () => {
  for (const u of releases) u();
  releases = [];
  releaseLanes();
};

// ---- Settings (page-only, so localStorage namespaced by the Add On id) ----

const settings = { ...TapeStop.DEFAULTS };
try {
  const saved = JSON.parse(localStorage.getItem(`${ADD_ON_ID}.settings.v3`) || '{}');
  for (const k of ['mode', 'curve', 'selection', 'fade']) if (k in saved) settings[k] = saved[k];
} catch {}
const save = () => {
  try { localStorage.setItem(`${ADD_ON_ID}.settings.v3`, JSON.stringify(settings)); } catch {}
};
const changed = () => {
  save();
  paintModes();
  describe();
};

// ---- The deck ----

// Fit the deck to the page. Inside LUNA the window is fixed at the deck's size (manifest
// fixed_size); this keeps it whole in a browser tab during development.
function fit() {
  const k = Math.min(window.innerWidth / 600, window.innerHeight / 470);
  $('deck').style.transform = `scale(${k})`;
}
window.addEventListener('resize', fit);
fit();

// Speed rows in the art (centre y, CSS px), keyed by the curve each one sets.
const DOT_Y = { tape: 231, linear: 250, vinyl: 269 };

$('direction').onclick = () => { settings.mode = settings.mode === 'start' ? 'stop' : 'start'; changed(); };
for (const b of document.querySelectorAll('.speed')) b.onclick = () => { settings.curve = b.dataset.v; changed(); };
$('fade').onclick = () => { settings.fade = !settings.fade; changed(); };
$('extend').onclick = () => { settings.selection = settings.selection === 'extend' ? 'fit' : 'extend'; changed(); };

function paintModes() {
  $('knob-start').hidden = settings.mode !== 'start';
  $('knob-stop').hidden = settings.mode === 'start';
  $('dot').style.top = `${(DOT_Y[settings.curve] ?? DOT_Y.linear) - 4}px`;
  $('led-fade').hidden = !settings.fade;
  $('led-extend').hidden = settings.selection !== 'extend';
  for (const b of document.querySelectorAll('.speed')) b.setAttribute('aria-pressed', String(b.dataset.v === settings.curve));
  $('fade').setAttribute('aria-pressed', String(!!settings.fade));
  $('extend').setAttribute('aria-pressed', String(settings.selection === 'extend'));
  $('direction').setAttribute('aria-label', `Direction: ${settings.mode}`);
}
paintModes();

// Only problems are printed on the deck, in the deck's lowercase style. A setup problem (no
// range, no tracks, no audio...) shows only when start · stop is pressed and can't run, and
// clears as soon as anything changes.
function say(text) {
  const t = (text || '').replace(/\.\s*$/, '');
  $('message').textContent = t && t[0].toLowerCase() + t.slice(1);
}

// ---- Target: the highlighted range on the selected tracks ----

let lastInfo;
function describe() {
  if (!session) return undefined;
  const info = TapeStop.target(session, settings);
  lastInfo = info;
  if (!busy) say('');
  $('go').disabled = busy;
  watchLanes(info);
  return info;
}

// Follow the clips of the selected tracks' lanes, so edits in LUNA update the page.
let watchedKey = '';
function watchLanes(info) {
  const lanes = info.tracks.map((t) => t.lane).filter(Boolean);
  const key = lanes.map((l) => l.id).join(',');
  if (key === watchedKey) return;
  releaseLanes();
  watchedKey = key;
  for (const lane of lanes) laneReleases.push(lane.clips.onChange(describe));
}

async function bindSession() {
  release();
  watchedKey = '';
  session = luna.sessions.current();
  if (!session) {
    say('no session open');
    $('go').disabled = true;
    return;
  }
  await session.ready();
  await session.musical.ready();
  const ctx = session.context;
  keep(ctx.selectionStart.onChange(describe));
  keep(ctx.selectionStop.onChange(describe));
  keep(ctx.selectionTracks.onChange(describe));
  keep(session.tracks.onChange(describe));
  keep(session.musical.timeline.onChange(describe));
  describe();
}

$('go').onclick = async () => {
  const info = describe();
  if (!info) return;
  if (info.problem) {
    say(info.problem);
    return;
  }
  busy = true;
  $('go').disabled = true;
  $('go').classList.add('busy');
  say('');
  const verb = settings.mode === 'start' ? 'vinyl start' : 'vinyl stop';
  try {
    if (!(await luna.gui.available())) throw new Error('reading audio works only inside LUNA');
    const readAudio = TapeStop.makeReader({ session, serve: (path) => luna.gui.serveMediaFile(ADD_ON_ID, path), fetchBytes });
    await TapeStop.apply(session, info, settings, { readAudio });
  } catch (e) {
    busy = false;
    $('go').classList.remove('busy');
    describe();
    say(`could not make the ${verb}: ${e.message}`);
    return;
  }
  busy = false;
  $('go').classList.remove('busy');
  describe();
};

// Bytes of a file LUNA serves to this page. XMLHttpRequest, not fetch: on Windows the URL is
// file:///, which fetch() refuses. Asks for a byte range; a server that ignores it sends the
// whole file, which TapeStop.wavFile handles.
function fetchBytes(url, [first, last]) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.responseType = 'arraybuffer';
    xhr.setRequestHeader('Range', `bytes=${first}-${last}`);
    xhr.onload = () => (xhr.response && xhr.status < 400 ? resolve(xhr.response) : reject(new Error(`cannot read the audio file (${xhr.status})`)));
    xhr.onerror = () => reject(new Error('cannot read the audio file'));
    xhr.send();
  });
}

async function connect() {
  for (;;) {
    try {
      luna = await Luna.connect();
      break;
    } catch (e) {
      say(e instanceof Luna.NotRunning ? 'waiting for LUNA' : e.message);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  Luna.bindShortcuts(luna);
  await luna.sessions.ready();
  luna.sessions.focused.onChange(bindSession);
  luna.sessions.items.onChange(bindSession);
  luna.status.onChange(() => {
    if (luna.status.value === 'disconnected') say('reconnecting to LUNA');
    else describe();
  });
  await bindSession();
}

connect();
