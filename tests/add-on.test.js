// Runs against Luna.MockEngine: no LUNA needed. `npm test`.
import { describe, expect, it } from 'vitest';
import { Luna } from '@uaudio/luna-builder-sdk';

globalThis.Luna = Luna; // logic.js is a classic script that reads the Luna global
await import('../logic.js');
const T = globalThis.TapeStop;

const BEAT = Luna.TICKS_PER_BEAT; // 120 BPM in the mock: one beat is 0.5 s

/**
 * Two tracks, each with one 8-second clip from bar 1, and beats 4-6 (2 s to 3 s, 1 s long)
 * highlighted on the chosen tracks.
 */
async function connected({ tracks = ['Vocal', 'Bass'], vocal: [vs, ve] = [0, 16] } = {}) {
  const engine = new Luna.MockEngine();
  engine.addSession('abc', { name: 'Demo', tracks: ['Vocal', 'Bass', 'Keys'], packageUid: 'pkg' });
  engine.addSource('pkg', 'src1', { name: 'vox.wav', lengthNs: 8e9, sampleRate: 48000, stemFormat: 'mono' });
  engine.addSource('pkg', 'src2', { name: 'bass.wav', lengthNs: 8e9, sampleRate: 48000, stemFormat: 'mono' });
  await engine.settled();
  const luna = await Luna.connect({ port_: engine.port() });
  const session = await luna.session();
  await session.musical.ready();
  const [vocal, bass] = session.tracks.items;
  const vox = await session.insertClip({ trackUid: vocal.id, sourceUid: 'src1', startTick: vs * BEAT, stopTick: ve * BEAT, sourceStartNs: 0, sourceStopNs: (ve - vs) * 0.5e9, name: 'Vox' });
  const bas = await session.insertClip({ trackUid: bass.id, sourceUid: 'src2', startTick: 0, stopTick: 16 * BEAT, sourceStartNs: 0, sourceStopNs: 8e9, name: 'Bass' });
  const chosen = session.tracks.items.filter((t) => tracks.includes(t.name.value));
  await session.selectTimeline({ tracks: chosen, startTick: 4 * BEAT, stopTick: 6 * BEAT });
  await engine.settled();
  return { engine, luna, session, vox, bas };
}

/** Clips on a lane other than `except`, in time order, loaded. */
async function others(lane, except) {
  await lane.clips.membersReady();
  return lane.clips.items.filter((c) => c.id !== except.id).sort((a, b) => a.start.value - b.start.value || a.stop.value - b.stop.value);
}

const posts = (engine, suffix) => engine.requests.filter((r) => r.path.endsWith(suffix));
const fades = (engine) => posts(engine, '/set_fade').map((r) => ({ ...r.data.clips[0], shape: r.data.fade_shape }));
const order = (engine) => engine.requests.map((r) => r.path.split('/').pop()).filter((p) => ['begin_transaction', 'commit_transaction', 'import_file', 'undo'].includes(p));

describe('the speed curve', () => {
  it('runs from full speed to a stop', () => {
    expect(T.speedAt(0)).toBe(1);
    expect(T.speedAt(0.5)).toBe(0.5);
    expect(T.speedAt(1)).toBe(0);
  });

  it('has three presets, tape holding speed longest', () => {
    expect(T.exponent('tape')).toBe(0.4);
    expect(T.exponent('linear')).toBe(1);
    expect(T.exponent('vinyl')).toBeCloseTo(2.22);
    const half = (c) => T.speedAt(0.5, T.exponent(c));
    expect(half('tape')).toBeGreaterThan(half('linear'));
    expect(half('linear')).toBeGreaterThan(half('vinyl'));
  });

  it('plays half the audio over a linear stop or start', () => {
    expect(T.consumedAt(1, 1)).toBeCloseTo(0.5);
    expect(T.modeConsumedAt('start', 1, 1)).toBeCloseTo(0.5);
    expect(T.modeSpeedAt('start', 0)).toBe(0);
    expect(T.modeSpeedAt('start', 1)).toBe(1);
  });
});

describe('the speed curve', () => {
  it('runs from full speed to a stop', () => {
    expect(T.speedAt(0)).toBe(1);
    expect(T.speedAt(0.5)).toBe(0.5);
    expect(T.speedAt(1)).toBe(0);
  });

  it('has three presets, tape holding speed longest', () => {
    expect(T.exponent('tape')).toBe(0.4);
    expect(T.exponent('linear')).toBe(1);
    expect(T.exponent('vinyl')).toBeCloseTo(2.22);
    const half = (c) => T.speedAt(0.5, T.exponent(c));
    expect(half('tape')).toBeGreaterThan(half('linear'));
    expect(half('linear')).toBeGreaterThan(half('vinyl'));
  });

  it('plays half the audio over a linear stop or start', () => {
    expect(T.consumedAt(1, 1)).toBeCloseTo(0.5);
    expect(T.modeConsumedAt('start', 1, 1)).toBeCloseTo(0.5);
    expect(T.modeSpeedAt('start', 0)).toBe(0);
    expect(T.modeSpeedAt('start', 1)).toBe(1);
  });
});

describe('the fade', () => {
  it('is shaped like the curve and ends in silence', () => {
    expect(T.fadeAt('stop', 0.5, 1)).toBe(1);
    expect(T.fadeAt('stop', 0.9, 1)).toBeCloseTo(0.5); // halfway through the fade: half level
    expect(T.fadeAt('stop', 0.9, 0.4)).toBeGreaterThan(0.5); // tape holds level longer
    expect(T.fadeAt('stop', 0.9, 2.22)).toBeLessThan(0.5); // vinyl drops faster
    expect(T.fadeAt('stop', 1, 1)).toBe(0);
    expect(T.fadeAt('start', 0, 1)).toBe(0);
    expect(T.fadeAt('start', 0.1, 1)).toBeCloseTo(0.5);
  });
});

const RATE = 48000;
const sine = (hz, seconds, rate = RATE) => Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => Math.sin((2 * Math.PI * hz * i) / rate));

/** Times (in samples, interpolated) where `x` crosses zero going up. */
function upCrossings(x) {
  const at = [];
  for (let i = 1; i < x.length; i++) if (x[i - 1] < 0 && x[i] >= 0) at.push(i - 1 + -x[i - 1] / (x[i] - x[i - 1]));
  return at;
}

describe('the render', () => {
  it('glides the pitch of a 400 Hz sine smoothly, with no steps', () => {
    // A 2 s linear stop of a 400 Hz sine, fade off: the frequency should follow 400 Hz x speed.
    const input = sine(400, 2);
    const [out] = T.renderVarispeed({ channels: [input], sampleRate: RATE, baseFrame: 4800, durationSec: 2, curve: 'linear', fade: false });
    expect(out.length).toBe(2 * RATE);
    const ups = upCrossings(out);
    let worst = 0;
    let periods = 0;
    for (let i = 1; i < ups.length; i++) {
      const mid = (ups[i] + ups[i - 1]) / 2 / out.length;
      const expected = 400 * T.speedAt(mid, 1);
      if (expected < 40) continue;
      const measured = RATE / (ups[i] - ups[i - 1]);
      worst = Math.max(worst, Math.abs(measured / expected - 1));
      periods++;
    }
    expect(periods).toBeGreaterThan(300);
    // Within 0.1% of the ideal glide everywhere (a 64-slice stop is off by up to ~1.6% at the top).
    expect(worst).toBeLessThan(0.001);
  });

  it('is clean: a slowed sine stays a sine', () => {
    const input = sine(400, 2);
    const [out] = T.renderVarispeed({ channels: [input], sampleRate: RATE, baseFrame: 4800, durationSec: 1, curve: 'tape', fade: false });
    // Compare each output sample with the exact value of the sine at the position read.
    let err = 0;
    for (let i = 0; i < out.length; i++) {
      const pos = 4800 + T.consumedAt(i / out.length, 0.4) * RATE;
      err = Math.max(err, Math.abs(out[i] - Math.sin((2 * Math.PI * 400 * pos) / RATE)));
    }
    expect(err).toBeLessThan(1e-3); // better than -60 dB everywhere
  });

  it('starts a stop exactly on the original audio', () => {
    const input = sine(400, 2);
    const [out] = T.renderVarispeed({ channels: [input], sampleRate: RATE, baseFrame: 4800, durationSec: 1 });
    for (let i = 0; i < 10; i++) expect(out[i]).toBeCloseTo(input[4800 + i], 2);
  });

  it('ends a start exactly on the original audio', () => {
    const input = sine(400, 2);
    const consumed = T.consumedAt(1, 1) * RATE; // frames a 1 s linear start plays
    const edge = 72000;
    const [out] = T.renderVarispeed({ channels: [input], sampleRate: RATE, baseFrame: edge - consumed, durationSec: 1, mode: 'start' });
    for (let i = 1; i <= 10; i++) expect(out[out.length - i]).toBeCloseTo(input[edge - i], 2);
  });

  it('fades smoothly to silence at the end of a stop, and in from silence at a start', () => {
    const input = new Float32Array(RATE * 2).fill(0.5);
    const [stop] = T.renderVarispeed({ channels: [input], sampleRate: RATE, baseFrame: 1000, durationSec: 1 });
    expect(stop[0]).toBeCloseTo(0.5, 3);
    expect(stop[0.9 * RATE]).toBeCloseTo(0.25, 2);
    expect(Math.abs(stop.at(-1))).toBeLessThan(1e-4);
    for (let i = 0.8 * RATE + 1; i < RATE; i++) expect(stop[i]).toBeLessThanOrEqual(stop[i - 1] + 1e-6);
    const [start] = T.renderVarispeed({ channels: [input], sampleRate: RATE, baseFrame: 1000, durationSec: 1, mode: 'start' });
    expect(start[0]).toBe(0);
    expect(start.at(-1)).toBeCloseTo(0.5, 3);
  });

  it('keeps stereo channels apart', () => {
    const [l, r] = T.renderVarispeed({ channels: [new Float32Array(RATE).fill(0.5), new Float32Array(RATE).fill(-0.25)], sampleRate: RATE, baseFrame: 100, durationSec: 0.5, fade: false });
    expect(l[100]).toBeCloseTo(0.5, 3);
    expect(r[100]).toBeCloseTo(-0.25, 3);
  });
});

/** A WAV file of `channels` as `bits`-bit PCM (or float for 32f), with a junk chunk first. */
function pcmWav(channels, rate, bits) {
  const nc = channels.length;
  const frames = channels[0].length;
  const size = bits === '32f' ? 4 : bits / 8;
  const junk = 100;
  const data = frames * nc * size;
  const buf = new ArrayBuffer(12 + 8 + junk + 24 + 8 + data);
  const v = new DataView(buf);
  const tag = (o, s) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  tag(0, 'RIFF'); v.setUint32(4, buf.byteLength - 8, true); tag(8, 'WAVE');
  tag(12, 'JUNK'); v.setUint32(16, junk, true);
  let o = 20 + junk;
  tag(o, 'fmt '); v.setUint32(o + 4, 16, true);
  v.setUint16(o + 8, bits === '32f' ? 3 : 1, true); v.setUint16(o + 10, nc, true); v.setUint32(o + 12, rate, true);
  v.setUint32(o + 16, rate * nc * size, true); v.setUint16(o + 20, nc * size, true); v.setUint16(o + 22, bits === '32f' ? 32 : bits, true);
  o += 24;
  tag(o, 'data'); v.setUint32(o + 4, data, true);
  o += 8;
  for (let f = 0; f < frames; f++) for (let c = 0; c < nc; c++) {
    const x = channels[c][f];
    if (bits === '32f') v.setFloat32(o, x, true);
    else if (bits === 16) v.setInt16(o, Math.round(x * 32767), true);
    else { const n = Math.round(x * 8388607); v.setUint8(o, n & 255); v.setUint8(o + 1, (n >> 8) & 255); v.setUint8(o + 2, (n >> 16) & 255); }
    o += size;
  }
  return buf;
}

/** A fake server for `url`: honours byte ranges, or sends the whole file when `ranges` is false. */
function server(file, { ranges = true } = {}) {
  const calls = [];
  const fetchBytes = async (url, [a, b]) => {
    calls.push([a, b]);
    return ranges ? file.slice(a, b + 1) : file.slice(0);
  };
  return { fetchBytes, calls };
}

describe('reading audio files', () => {
  for (const bits of [16, 24, '32f']) {
    it(`reads ${bits}-bit WAV frames from the middle of a file`, async () => {
      const left = sine(100, 1);
      const right = left.map((x) => -x / 2);
      const { fetchBytes } = server(pcmWav([left, right], RATE, bits));
      const got = await T.wavFile('u', fetchBytes).frames(1000, 1100);
      expect(got.sampleRate).toBe(RATE);
      expect(got.startFrame).toBe(1000);
      expect(got.channels).toHaveLength(2);
      expect(got.channels[0]).toHaveLength(100);
      for (let i = 0; i < 100; i += 7) {
        expect(got.channels[0][i]).toBeCloseTo(left[1000 + i], 3);
        expect(got.channels[1][i]).toBeCloseTo(right[1000 + i], 3);
      }
    });
  }

  it('reads only the bytes it needs when the server takes ranges', async () => {
    const file = pcmWav([sine(100, 10)], RATE, 24); // about 1.4 MB
    const { fetchBytes, calls } = server(file);
    await T.wavFile('u', fetchBytes).frames(240000, 240100);
    const total = calls.reduce((n, [a, b]) => n + b - a + 1, 0);
    expect(total).toBeLessThan(70000);
  });

  it('copes with a server that ignores ranges', async () => {
    const input = sine(100, 1);
    const { fetchBytes, calls } = server(pcmWav([input], RATE, 16), { ranges: false });
    const got = await T.wavFile('u', fetchBytes).frames(-50, 200); // clipped at the file start
    expect(got.startFrame).toBe(0);
    expect(got.channels[0]).toHaveLength(200);
    expect(got.channels[0][150]).toBeCloseTo(input[150], 3);
    expect(calls).toHaveLength(1);
  });

  it('round-trips its own float WAV output', async () => {
    const input = sine(440, 0.1);
    const bytes = T.encodeWav([input, input], RATE);
    const { fetchBytes } = server(bytes.buffer);
    const got = await T.wavFile('u', fetchBytes).frames(0, input.length);
    expect(got.float).toBe(true);
    expect(got.channels[1][123]).toBe(input[123]);
  });

  it("finds a source's file inside the session package", async () => {
    const session = {
      sources: { path: '/workspace/sessions/pkg/audio' },
      client: { raw: { get: async (path) => (path.endsWith('/pkg')
        ? { properties: { directory_path: { value: '/Music/Song' }, file_name: { value: 'Song.luna' } } }
        : { properties: { format: { value: 'wav' } } }) } },
    };
    expect(await T.sourcePaths(session, 'abc')).toEqual(['/Music/Song/Song.luna/audio/abc.wav', '/Music/Song/Song.luna/audio_staging/abc.wav']);
    const file = pcmWav([sine(100, 1)], RATE, 16);
    const served = [];
    const read = T.makeReader({ session, serve: async (p) => { served.push(p); if (p.includes('staging')) throw new Error('missing'); return 'ua-content://x'; }, fetchBytes: server(file).fetchBytes });
    const got = await read('abc', 0.5, 0.6);
    expect(served).toEqual(['/Music/Song/Song.luna/audio/abc.wav']);
    // Padded either side for the interpolator.
    expect(got.startFrame).toBe(24000 - T.SINC_HALF - 2);
    expect(got.channels[0].length).toBe(4800 + 2 * (T.SINC_HALF + 2));
  });
});

describe('what it acts on', () => {
  it('reads the highlighted range and every selected track', async () => {
    const { session } = await connected();
    const info = T.target(session);
    expect(info.problem).toBeUndefined();
    expect([info.start, info.stop, info.outStart, info.outStop]).toEqual([4 * BEAT, 6 * BEAT, 4 * BEAT, 6 * BEAT]);
    expect(info.durationSec).toBeCloseTo(1);
    expect(info.tracks.map((t) => [t.name, t.skip])).toEqual([['Vocal', undefined], ['Bass', undefined]]);
  });

  it('extends a stop past the selection end, and a start before its start, by style', async () => {
    const { session } = await connected();
    const stop = T.target(session, { selection: 'extend', curve: 'vinyl' });
    expect(stop.durationSec).toBeCloseTo(1.5);
    expect([stop.outStart, stop.outStop]).toEqual([4 * BEAT, 7 * BEAT]);
    const start = T.target(session, { mode: 'start', selection: 'extend', curve: 'vinyl' });
    expect([start.outStart, start.outStop]).toEqual([3 * BEAT, 6 * BEAT]);
    expect(T.target(session, { selection: 'extend', curve: 'tape' }).durationSec).toBeCloseTo(1.1);
    expect(T.target(session, { selection: 'extend', curve: 'linear' }).durationSec).toBeCloseTo(1.3);
    expect(T.target(session, { selection: 'fit', curve: 'vinyl' }).durationSec).toBeCloseTo(1);
  });

  it('skips a selected track with no audio in the range', async () => {
    const { session } = await connected({ tracks: ['Vocal', 'Keys'] });
    const info = T.target(session);
    expect(info.problem).toBeUndefined();
    expect(info.tracks.find((t) => t.name === 'Keys').skip).toMatch(/no audio/);
  });

  it('asks for a range when none is highlighted', async () => {
    const { engine, session } = await connected();
    await session.context.selectionStop.set(null);
    await engine.settled();
    expect(T.target(session).problem).toMatch(/Highlight a range/);
  });
});


/** A readAudio that serves a 400 Hz sine for every source, recording what was asked. */
function fakeReader(asks = []) {
  return async (uid, startSec, stopSec) => {
    asks.push({ uid, startSec, stopSec });
    const startFrame = Math.max(0, Math.floor(startSec * RATE) - 20);
    const n = Math.ceil(stopSec * RATE) + 20 - startFrame;
    return { sampleRate: RATE, startFrame, channels: [Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 400 * (startFrame + i)) / RATE))] };
  };
}

const lastUploadName = (engine) => posts(engine, '/import_file').find((r) => r.data.phase === 'begin' || r.data.name)?.data.name;

describe('a tape stop', () => {
  it('uploads one rendered file per track and places it in one undo step', async () => {
    const { engine, session } = await connected();
    const asks = [];
    const info = T.target(session);
    const stages = [];
    const done = await T.apply(session, info, {}, { readAudio: fakeReader(asks), onStage: (s) => stages.push(s) });
    await engine.settled();
    expect(done).toEqual({ tracks: 2 });
    expect(stages.at(-1)).toBe('Placing...');
    // In sync at the start edge: the file is 2 s in there; a linear 1 s stop reads 0.5 s of it,
    // plus a few ms either side for the interpolator.
    const m = T.READ_MARGIN_SEC;
    expect(asks.map((a) => a.uid)).toEqual(['src1', 'src2']);
    for (const a of asks) {
      expect(a.startSec).toBeCloseTo(2 - m, 9);
      expect(a.stopSec).toBeCloseTo(2.5 + m, 9);
    }
    // Uploads happen before the one transaction; nothing is undone.
    const o = order(engine);
    expect(o.filter((p) => p === 'begin_transaction')).toHaveLength(1);
    expect(o.lastIndexOf('import_file')).toBeLessThan(o.indexOf('begin_transaction'));
    expect(o).not.toContain('undo');
    const inserts = posts(engine, '/insert_clip').slice(2).map((r) => r.data);
    expect(inserts).toHaveLength(2);
    for (const d of inserts) {
      expect(d).toMatchObject({ start: 4 * BEAT, stop: 6 * BEAT, source_start: 0, source_stop: 1e9 });
      expect(d.alg_type).not.toBe('varispeed');
      expect(session.sources.byId(d.source_uid)).toBeTruthy();
    }
  });

  it('joins the original with no crossfade at its start, and crossfades 5 ms where it stops', async () => {
    const { engine, session, vox } = await connected({ tracks: ['Vocal'] });
    const info = T.target(session);
    await T.apply(session, info, {}, { readAudio: fakeReader() });
    await engine.settled();
    const placed = (await others(info.tracks[0].lane, vox))[0];
    const fiveMs = (0.005 / 0.5) * BEAT;
    const f = fades(engine);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ fade_type: 'cross_fade', clip_uid: placed.id, contributor_clip_uid: vox.id, start_offset: -fiveMs, stop_offset: 0 });
  });

  it('keeps the original clip gain', async () => {
    const { engine, session, vox } = await connected({ tracks: ['Vocal'] });
    await vox.gain.set(-6);
    await engine.settled();
    const info = T.target(session);
    await T.apply(session, info, {}, { readAudio: fakeReader() });
    await engine.settled();
    const placed = (await others(info.tracks[0].lane, vox))[0];
    expect(placed.gain.value).toBe(-6);
  });

  it('extends past the selection end: 150% for Vinyl', async () => {
    const { engine, session } = await connected({ tracks: ['Vocal'] });
    const asks = [];
    const o = { selection: 'extend', curve: 1 };
    const info = T.target(session, o);
    await T.apply(session, info, o, { readAudio: fakeReader(asks) });
    await engine.settled();
    const len = T.extendFor(1); // a linear exponent lands between Tape and Vinyl
    expect(asks[0].stopSec).toBeCloseTo(2 + len / 2 + T.READ_MARGIN_SEC); // a linear stop plays half its length
    expect(posts(engine, '/insert_clip').at(-1).data).toMatchObject({ start: 4 * BEAT, source_stop: Math.round(len * 1e9) });
  });

  it('leaves the session alone if the audio cannot be read', async () => {
    const { engine, session } = await connected({ tracks: ['Vocal'] });
    const info = T.target(session);
    await expect(T.apply(session, info, {}, { readAudio: async () => { throw new Error('cannot read'); } })).rejects.toThrow('cannot read');
    expect(order(engine)).toEqual([]);
  });

  it('needs a reader', async () => {
    const { session } = await connected({ tracks: ['Vocal'] });
    await expect(T.apply(session, T.target(session), {})).rejects.toThrow(/LUNA/);
  });
});

describe('a tape start', () => {
  it('reads the audio that lands in sync at the selection end', async () => {
    const { engine, session } = await connected({ tracks: ['Vocal'] });
    const asks = [];
    const info = T.target(session, { mode: 'start' });
    await T.apply(session, info, { mode: 'start' }, { readAudio: fakeReader(asks) });
    await engine.settled();
    // The selection end is 3 s into the file; a linear 1 s start plays the 0.5 s before it.
    expect(asks[0].startSec).toBeCloseTo(2.5 - T.READ_MARGIN_SEC);
    expect(asks[0].stopSec).toBeCloseTo(3 + T.READ_MARGIN_SEC);
  });

  it('extends before the selection start and still lands at its end', async () => {
    const { engine, session } = await connected({ tracks: ['Vocal'] });
    const asks = [];
    const o = { mode: 'start', selection: 'extend', curve: 'vinyl' };
    const info = T.target(session, o);
    await T.apply(session, info, o, { readAudio: fakeReader(asks) });
    await engine.settled();
    expect(asks[0].stopSec).toBeCloseTo(3 + T.READ_MARGIN_SEC);
    expect(posts(engine, '/insert_clip').at(-1).data).toMatchObject({ start: 3 * BEAT, stop: 6 * BEAT });
    // A start crossfades only where it begins from a standstill; its end joins the original.
    expect(fades(engine)).toHaveLength(1);
    expect(fades(engine)[0]).toMatchObject({ start_offset: 0 });
  });
});

/** Render one track's effect and decode it: the samples of the clip that gets placed. */
async function rendered(session, info, o) {
  const row = info.tracks.find((t) => !t.skip);
  const { bytes } = await T.renderTrack(session, info, row, { ...T.DEFAULTS, fade: false, ...o }, fakeReader());
  const buf = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const file = T.wavFile('x', server(buf).fetchBytes);
  const h = await file.header();
  return (await file.frames(0, h.frames)).channels[0];
}
const peak = (x, a, b) => x.slice(a, b).reduce((m, v) => Math.max(m, Math.abs(v)), 0);

describe('empty space in the range', () => {
  it('plays it as silence when a stop starts before the clip, which comes in already slowing', async () => {
    // The clip starts at beat 5 (2.5 s). A linear 1.5 s stop from beat 4.5 (2.25 s) reads
    // 0.75 s of timeline; it reaches the clip after 0.25 s of it, about 0.28 s into the stop.
    const { engine, session } = await connected({ tracks: ['Vocal'], vocal: [5, 16] });
    await session.selectTimeline({ tracks: [session.tracks.items[0]], startTick: 4.5 * BEAT, stopTick: 7.5 * BEAT });
    await engine.settled();
    const info = T.target(session);
    expect(info.problem).toBeUndefined();
    const x = await rendered(session, info);
    expect(peak(x, 0, 0.2 * RATE)).toBe(0);
    expect(peak(x, 0.4 * RATE, 0.6 * RATE)).toBeGreaterThan(0.5);
  });

  it('goes quiet where a stop runs past the end of the clip, and still writes the whole range', async () => {
    // The clip ends at beat 5 (2.5 s); a 2 s stop from beat 4 reads 1 s, half of it past the end.
    const { engine, session } = await connected({ tracks: ['Vocal'], vocal: [0, 5] });
    await session.selectTimeline({ tracks: [session.tracks.items[0]], startTick: 4 * BEAT, stopTick: 8 * BEAT });
    await engine.settled();
    const info = T.target(session);
    expect(info.problem).toBeUndefined();
    const x = await rendered(session, info);
    expect(x.length).toBe(2 * RATE);
    expect(peak(x, 0, 0.3 * RATE)).toBeGreaterThan(0.5);
    // Half the timeline is read by u = 1 - sqrt(0.5), about 0.29 of the way (0.59 s).
    expect(peak(x, 0.62 * RATE, x.length)).toBe(0);
    await T.apply(session, info, {}, { readAudio: fakeReader() });
    await engine.settled();
    expect(posts(engine, '/insert_clip').at(-1).data).toMatchObject({ start: 4 * BEAT, stop: 8 * BEAT });
  });

  it('only reads the clip, not the file past its trimmed end', async () => {
    const { engine, session } = await connected({ tracks: ['Vocal'], vocal: [0, 5] });
    await session.selectTimeline({ tracks: [session.tracks.items[0]], startTick: 4 * BEAT, stopTick: 8 * BEAT });
    await engine.settled();
    const asks = [];
    await T.apply(session, T.target(session), {}, { readAudio: fakeReader(asks) });
    expect(asks[0].stopSec).toBeCloseTo(2.5);
  });

  it('says so when no selected track has audio where the effect plays', async () => {
    const { engine, session } = await connected({ tracks: ['Vocal'], vocal: [10, 16] });
    await engine.settled();
    const info = T.target(session);
    expect(info.tracks[0].skip).toBe('no audio in the range');
    expect(info.problem).toBe('No audio in the highlighted range on the selected tracks.');
  });
});

describe('the synced edge', () => {
  it('carries the original wave straight on, sample for sample', async () => {
    const { session } = await connected({ tracks: ['Vocal'] });
    const x = await rendered(session, T.target(session));
    // The stop starts 2 s into the file at full speed: the first samples are the file's own.
    const want = (i) => Math.sin((2 * Math.PI * 400 * (2 * RATE + i)) / RATE);
    let worst = 0;
    for (let i = 0; i < 24; i++) worst = Math.max(worst, Math.abs(x[i] - want(i)));
    expect(worst).toBeLessThan(2e-3);
  });
});
