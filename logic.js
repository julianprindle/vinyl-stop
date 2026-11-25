// Vinyl Stop: logic that does not touch the DOM, so tests can exercise it against Luna.MockEngine.
//
// The effect is rendered in the page, sample by sample. For each selected track the page reads
// the original audio file (LUNA serves the session's own source files to the Add On), plays it
// back through a continuously changing speed with high-quality (windowed-sinc) interpolation, so
// the pitch glides with no steps at all, and builds the fade into the samples. The result goes
// into the session as a new audio file and is placed as one clip over the processed range, its
// edges crossfaded with the audio beneath. Only that last step edits the session: one undo.
//
// Sync rule: the audio always lines up on the adjacent edge. A tape stop starts on the audio
// that plays at its start (so what comes before it carries on into it); a tape start ends on
// the audio that plays at its end (so it rolls straight into what comes after).

const TapeStop = {
  /** Styles (the `curve` setting): the exponent of the speed ramp. */
  CURVES: Object.freeze({
    tape: 0.4, // holds speed, then dies: a tape motor cut off
    linear: 1,
    vinyl: 2.22, // drops fast, then drags: a platter pulled to a stop
  }),

  /**
   * How much longer Extend makes the processed audio than the selection, by style: a tape motor
   * dies quickly, a platter drags on. Linear sits halfway.
   */
  EXTENDS: Object.freeze({ tape: 1.1, linear: 1.3, vinyl: 1.5 }),

  /** The Extend length for a style (a number passes through as an exponent, for tests). */
  extendFor(curve) {
    if (typeof curve !== 'number') return TapeStop.EXTENDS[curve] ?? TapeStop.EXTENDS.linear;
    const { tape, vinyl } = TapeStop.CURVES;
    const t = Math.min(1, Math.max(0, (curve - tape) / (vinyl - tape)));
    return TapeStop.EXTENDS.tape + t * (TapeStop.EXTENDS.vinyl - TapeStop.EXTENDS.tape);
  },

  /** Share of the processed length the fade covers, at the slow end. */
  FADE_SHARE: 0.2,

  /** Interpolator: taps either side of the read point, phases in its table, cutoff, Kaiser beta. */
  SINC_HALF: 16,
  SINC_PHASES: 512,
  SINC_CUTOFF: 0.97,
  SINC_BETA: 9,

  /** Audio read past each end of the played stretch, so the interpolator sees what's there. */
  READ_MARGIN_SEC: 0.005,

  DEFAULTS: Object.freeze({
    mode: 'stop', // 'stop' | 'start'
    curve: 'linear', // the Style: 'tape' | 'linear' | 'vinyl'
    selection: 'fit', // 'fit' keeps the selection's length; 'extend' lengthens it by style
    fade: true,
    crossfadeMs: 5, // the crossfade where the tape has stopped; shortened to half the clip for tiny selections
  }),

  /** The ramp exponent for a curve preset (a number passes through, for tests). */
  exponent(curve) {
    return typeof curve === 'number' ? curve : TapeStop.CURVES[curve] ?? 1;
  },

  /**
   * Playback speed at `u` (0 = the stop starts, 1 = the tape has stopped), between 1 and 0.
   * `k` 1 is a straight ramp; below 1 the speed holds and then dies; above 1 it drops quickly
   * and then drags.
   */
  speedAt(u, k = 1) {
    return Math.pow(1 - Math.min(1, Math.max(0, u)), k);
  },

  /**
   * How much of the original audio (as a fraction of the duration) has played by `u`: the
   * integral of {@link speedAt} from 0 to `u`. Exact, so the render never drifts.
   */
  consumedAt(u, k = 1) {
    const x = Math.min(1, Math.max(0, u));
    return (1 - Math.pow(1 - x, k + 1)) / (k + 1);
  },

  /** Speed at `u` for a mode: a tape start is a tape stop played backwards in time. */
  modeSpeedAt(mode, u, k = 1) {
    return mode === 'start' ? TapeStop.speedAt(1 - u, k) : TapeStop.speedAt(u, k);
  },

  /** Audio played by `u` for a mode, as a fraction of the duration. */
  modeConsumedAt(mode, u, k = 1) {
    if (mode !== 'start') return TapeStop.consumedAt(u, k);
    return TapeStop.consumedAt(1, k) - TapeStop.consumedAt(1 - u, k);
  },

  /**
   * The fade's level (0..1, linear) at `u` for a mode: 1 until the last {@link FADE_SHARE} of a
   * stop (the first of a start), then down to silence, shaped like the speed curve (`k`).
   */
  fadeAt(mode, u, k = 1) {
    const F = TapeStop.FADE_SHARE;
    const x = mode === 'start' ? (F - u) / F : (u - (1 - F)) / F; // 0 at the fade's loud edge, 1 at silence
    if (x <= 0) return 1;
    if (x >= 1 - 1e-9) return 0;
    return Math.pow(1 - x, k);
  },

  // ---- Rendering ----

  _kernel: undefined,

  /** The windowed-sinc table: `SINC_PHASES + 1` rows of `2 * SINC_HALF` taps, each summing to 1. */
  kernel() {
    if (TapeStop._kernel) return TapeStop._kernel;
    const { SINC_HALF: H, SINC_PHASES: P, SINC_CUTOFF: c, SINC_BETA: beta } = TapeStop;
    const i0 = (x) => {
      let sum = 1;
      let term = 1;
      for (let i = 1; i < 40; i++) {
        term *= (x / (2 * i)) ** 2;
        sum += term;
      }
      return sum;
    };
    const norm = i0(beta);
    const taps = 2 * H;
    const table = new Float64Array((P + 1) * taps);
    for (let p = 0; p <= P; p++) {
      const f = p / P;
      let sum = 0;
      for (let j = 0; j < taps; j++) {
        const t = j - H + 1 - f; // distance from the read point to tap j
        const r = t / H;
        const w = Math.abs(r) >= 1 ? 0 : i0(beta * Math.sqrt(1 - r * r)) / norm;
        const x = Math.PI * c * t;
        const h = (t === 0 ? 1 : Math.sin(x) / x) * w;
        table[p * taps + j] = h;
        sum += h;
      }
      for (let j = 0; j < taps; j++) table[p * taps + j] /= sum;
    }
    return (TapeStop._kernel = table);
  },

  /**
   * Render one tape stop or start. `channels` are the original samples, `channels[c][0]` being
   * file frame `startFrame`; `baseFrame` (fractional) is the file frame the effect starts reading
   * at. Output is `round(durationSec * sampleRate)` frames, read along the exact integral of the
   * speed curve, so the speed (and pitch) changes on every sample. With `fade`, the level falls
   * (or rises) along {@link fadeAt}. Frames outside `channels` read as silence.
   */
  renderVarispeed({ channels, sampleRate, startFrame = 0, baseFrame, durationSec, mode = 'stop', curve = 'linear', fade = true }) {
    const k = TapeStop.exponent(curve);
    const H = TapeStop.SINC_HALF;
    const P = TapeStop.SINC_PHASES;
    const taps = 2 * H;
    const table = TapeStop.kernel();
    const n = Math.max(1, Math.round(durationSec * sampleRate));
    const span = durationSec * sampleRate; // output frames per unit of `u`, and source frames per unit of consumed
    const out = channels.map(() => new Float32Array(n));
    const len = channels[0]?.length ?? 0;
    for (let i = 0; i < n; i++) {
      const u = i / n;
      const pos = baseFrame + TapeStop.modeConsumedAt(mode, u, k) * span - startFrame;
      const gain = fade ? TapeStop.fadeAt(mode, u, k) : 1;
      if (gain === 0) continue;
      const base = Math.floor(pos);
      const pf = (pos - base) * P;
      const p = Math.min(P - 1, Math.floor(pf));
      const a = pf - p;
      const row0 = p * taps;
      const row1 = row0 + taps;
      const first = base - H + 1;
      const j0 = Math.max(0, -first);
      const j1 = Math.min(taps, len - first);
      for (let c = 0; c < channels.length; c++) {
        const src = channels[c];
        let acc = 0;
        for (let j = j0; j < j1; j++) acc += src[first + j] * (table[row0 + j] + (table[row1 + j] - table[row0 + j]) * a);
        out[c][i] = acc * gain;
      }
    }
    return out;
  },

  // ---- WAV files ----

  /** A 32-bit float WAV of `channels` (Float32Arrays of equal length). */
  encodeWav(channels, sampleRate) {
    const nc = channels.length;
    const frames = channels[0]?.length ?? 0;
    const dataBytes = frames * nc * 4;
    const buf = new ArrayBuffer(58 + dataBytes);
    const v = new DataView(buf);
    const tag = (off, s) => { for (let i = 0; i < 4; i++) v.setUint8(off + i, s.charCodeAt(i)); };
    tag(0, 'RIFF'); v.setUint32(4, 50 + dataBytes, true); tag(8, 'WAVE');
    tag(12, 'fmt '); v.setUint32(16, 18, true);
    v.setUint16(20, 3, true); // IEEE float
    v.setUint16(22, nc, true);
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * nc * 4, true);
    v.setUint16(32, nc * 4, true);
    v.setUint16(34, 32, true);
    v.setUint16(36, 0, true);
    tag(38, 'fact'); v.setUint32(42, 4, true); v.setUint32(46, frames, true);
    tag(50, 'data'); v.setUint32(54, dataBytes, true);
    let o = 58;
    for (let f = 0; f < frames; f++) for (let c = 0; c < nc; c++, o += 4) v.setFloat32(o, channels[c][f], true);
    return new Uint8Array(buf);
  },

  /** Decode `frames` interleaved frames of WAV sample data (`bytes`) to one Float32Array per channel. */
  decodeFrames(bytes, fmt, frames) {
    const v = new DataView(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength);
    const { channels: nc, bits, float } = fmt;
    const size = bits / 8;
    const out = Array.from({ length: nc }, () => new Float32Array(frames));
    for (let f = 0; f < frames; f++) {
      for (let c = 0; c < nc; c++) {
        const o = (f * nc + c) * size;
        let x;
        if (float) x = bits === 64 ? v.getFloat64(o, true) : v.getFloat32(o, true);
        else if (bits === 16) x = v.getInt16(o, true) / 32768;
        else if (bits === 24) x = (((v.getUint8(o + 2) << 24) | (v.getUint8(o + 1) << 16) | (v.getUint8(o) << 8)) >> 8) / 8388608;
        else if (bits === 32) x = v.getInt32(o, true) / 2147483648;
        else x = (v.getUint8(o) - 128) / 128;
        out[c][f] = x;
      }
    }
    return out;
  },

  /**
   * A reader of WAV frames at `url`. `fetchBytes(url, [first, last])` resolves to an ArrayBuffer:
   * that byte range, or the whole file when the server ignores ranges (cached, then sliced).
   */
  wavFile(url, fetchBytes) {
    let whole;
    const range = async (a, b) => {
      if (whole) return whole.slice(a, b + 1);
      const r = await fetchBytes(url, [a, b]);
      if (r.byteLength > b - a + 1) {
        // The server ignored the range and sent the whole file: keep it.
        whole = r;
        return r.slice(a, b + 1);
      }
      if (a === 0 && r.byteLength < b + 1) whole = r; // the whole file is shorter than the range
      return r; // the range, or less where the file ends
    };
    let fmt;
    const header = async () => {
      if (fmt) return fmt;
      const chunk = 65536;
      let at = 0;
      let buf = await range(0, chunk - 1);
      const view = (off, len) => (off >= at && off + len <= at + buf.byteLength ? new DataView(buf, off - at, len) : undefined);
      const read = async (off, len) => {
        let v = view(off, len);
        if (!v) {
          at = off;
          buf = await range(off, off + Math.max(len, chunk) - 1);
          v = view(off, len);
        }
        if (!v) throw new Error('the audio file ends early');
        return v;
      };
      const str = (v, o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
      const riff = await read(0, 12);
      if (str(riff, 0) !== 'RIFF' || str(riff, 8) !== 'WAVE') throw new Error('the audio file is not a WAV file');
      let off = 12;
      let f;
      for (let guard = 0; guard < 1000; guard++) {
        const h = await read(off, 8);
        const id = str(h, 0);
        const size = h.getUint32(4, true);
        if (id === 'fmt ') {
          const d = await read(off + 8, Math.min(size, 40));
          let tagNo = d.getUint16(0, true);
          if (tagNo === 0xfffe && size >= 26) tagNo = d.getUint16(24, true); // WAVE_FORMAT_EXTENSIBLE: the sub-format
          f = { channels: d.getUint16(2, true), sampleRate: d.getUint32(4, true), bits: d.getUint16(14, true), float: tagNo === 3 };
          if (tagNo !== 1 && tagNo !== 3) throw new Error(`unsupported WAV encoding (${tagNo})`);
        } else if (id === 'data') {
          if (!f) throw new Error('the WAV file has no format');
          const block = f.channels * (f.bits / 8);
          const frames = size === 0 || size === 0xffffffff ? Infinity : Math.floor(size / block);
          return (fmt = { ...f, block, dataOffset: off + 8, frames });
        }
        off += 8 + size + (size & 1);
      }
      throw new Error('no audio data in the WAV file');
    };
    return {
      header,
      /** Frames `[first, last)`, clipped to the file; `startFrame` is the first actually read. */
      async frames(first, last) {
        const h = await header();
        const a = Math.max(0, first);
        const b = Math.min(last, h.frames);
        if (b <= a) return { ...h, startFrame: a, channels: Array.from({ length: h.channels }, () => new Float32Array(0)) };
        const bytes = await range(h.dataOffset + a * h.block, h.dataOffset + b * h.block - 1);
        const count = Math.floor(bytes.byteLength / h.block);
        return { ...h, startFrame: a, channels: TapeStop.decodeFrames(new Uint8Array(bytes), h, count) };
      },
    };
  },

  /**
   * Where a session source's file lives: `<session folder>/<name>.luna/audio/<uid>.<format>`,
   * then the staging folder LUNA writes new audio to. Read from the workspace (no typed API).
   */
  async sourcePaths(session, sourceUid) {
    const pkg = session.sources.path.replace(/\/audio$/, '');
    const node = await session.client.raw.get(pkg);
    const src = await session.client.raw.get(`${pkg}/audio/${sourceUid}`);
    const p = node?.properties ?? {};
    const dir = `${p.directory_path?.value}/${p.file_name?.value}`;
    const ext = src?.properties?.format?.value || 'wav';
    return [`${dir}/audio/${sourceUid}.${ext}`, `${dir}/audio_staging/${sourceUid}.${ext}`];
  },

  /**
   * A `readAudio(sourceUid, startSec, stopSec)` that reads a session source's frames over that
   * span of its file. `serve(path)` resolves to a URL the page can read (LUNA's
   * `gui.serveMediaFile`); `fetchBytes` is as in {@link wavFile}.
   */
  makeReader({ session, serve, fetchBytes }) {
    const files = new Map();
    const open = async (uid) => {
      if (files.has(uid)) return files.get(uid);
      let last;
      for (const path of await TapeStop.sourcePaths(session, uid)) {
        try {
          const file = TapeStop.wavFile(await serve(path), fetchBytes);
          await file.header();
          files.set(uid, file);
          return file;
        } catch (e) {
          last = e;
        }
      }
      throw last ?? new Error('cannot find the audio file');
    };
    return async (uid, startSec, stopSec) => {
      const file = await open(uid);
      const { sampleRate } = await file.header();
      const pad = TapeStop.SINC_HALF + 2;
      return file.frames(Math.floor(startSec * sampleRate) - pad, Math.ceil(stopSec * sampleRate) + pad);
    };
  },

  // ---- The session ----

  /** The active playlist (lane) of a track. */
  laneOf(session, track) {
    const uid = track.playlistUid.value;
    return uid ? session.playlists.byId(uid) : undefined;
  },

  /** The audio clip on `lane` playing at `tick` (the top layer where clips overlap). */
  clipAt(lane, tick) {
    let best;
    for (const c of lane.clips.items) {
      const s = c.start.value;
      const e = c.stop.value;
      if (s === undefined || e === undefined || tick < s || tick >= e) continue;
      if ((c.clipType.value ?? 'audio') !== 'audio' || c.muted.value) continue;
      if (!best || (c.layer.value ?? 0) > (best.layer.value ?? 0)) best = c;
    }
    return best;
  },

  /** True when LUNA plays the clip from a time-stretched render (no simple tick -> file map). */
  isStretched(clip) {
    return clip.renderState.value === 'current' && !!clip.renderSourceUid.value;
  },

  /** File offset (ns) that plays at `tick` in an unstretched clip, through the tempo map. */
  sourceNsAt(timeline, clip, tick) {
    return clip.sourceStart.value + (timeline.seconds(tick) - timeline.seconds(clip.start.value)) * 1e9;
  },

  /**
   * The audio the timeline plays on `lane` between `t0` and `t1` (seconds): one piece per
   * stretch of a single clip, gaps left out (they play as silence). Each piece says which file
   * it reads, from where (`src0`, seconds into the file), and the clip's gain.
   */
  pieces(lane, timeline, t0, t1) {
    const k0 = timeline.tickAtSeconds(t0);
    const k1 = timeline.tickAtSeconds(t1);
    const cuts = new Set([k0, k1]);
    for (const c of lane.clips.items) {
      for (const e of [c.start.value, c.stop.value]) if (e !== undefined && e > k0 && e < k1) cuts.add(e);
    }
    const pts = [...cuts].sort((a, b) => a - b);
    const runs = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const [a, b] = [pts[i], pts[i + 1]];
      const clip = TapeStop.clipAt(lane, (a + b) / 2);
      if (!clip) continue;
      const last = runs.at(-1);
      if (last && last.clip === clip && last.b === a) last.b = b;
      else runs.push({ clip, a, b });
    }
    return runs.map(({ clip, a, b }) => {
      const p0 = a === k0 ? t0 : timeline.seconds(a);
      const p1 = b === k1 ? t1 : timeline.seconds(b);
      return {
        clip,
        uid: clip.sourceUid.value,
        t0: p0,
        t1: p1,
        src0: clip.sourceStart.value / 1e9 + (p0 - timeline.seconds(clip.start.value)),
        gain: clip.gain.value ?? 0,
      };
    });
  },

  /**
   * What a tape stop or start would act on now: LUNA's highlighted range, the range it will
   * write (wider than the selection with Extend: later for a stop, earlier for a start), and,
   * for each selected track, the audio it reads, or why that track is skipped. Empty space in
   * the range plays as silence. `problem` says why nothing can be done yet.
   */
  target(session, options = {}) {
    const o = { ...TapeStop.DEFAULTS, ...options };
    const ctx = session.context;
    const start = ctx.selectionStart.value;
    const stop = ctx.selectionStop.value;
    const ids = ctx.selectionTracks.value ?? [];
    const info = { start, stop, outStart: start, outStop: stop, durationSec: undefined, tracks: [], problem: undefined };
    if (!ids.length) return { ...info, problem: 'Select one or more tracks in LUNA.' };
    if (start == null || stop == null || stop <= start) return { ...info, problem: 'Highlight a range on the timeline in LUNA.' };
    const timeline = session.musical.timeline;
    let selSec;
    try {
      selSec = timeline.seconds(stop) - timeline.seconds(start);
    } catch {
      return { ...info, problem: 'Waiting for the tempo map...' };
    }
    const isStart = o.mode === 'start';
    info.durationSec = o.selection === 'extend' ? selSec * TapeStop.extendFor(o.curve) : selSec;
    if (o.selection === 'extend') {
      if (isStart) info.outStart = Math.round(timeline.tickAtSeconds(timeline.seconds(stop) - info.durationSec));
      else info.outStop = Math.round(timeline.tickAtSeconds(timeline.seconds(start) + info.durationSec));
      if (info.outStart < 0) return { ...info, problem: 'Extend would reach before the start of the session; move the selection later.' };
    }

    const consumedSec = TapeStop.consumedAt(1, TapeStop.exponent(o.curve)) * info.durationSec;
    info.consumedNs = consumedSec * 1e9;
    // The stretch of the timeline the effect plays: from the selection start for a stop, up to
    // the selection end for a start. Read a little either side for the interpolator.
    const edge = isStart ? timeline.seconds(stop) : timeline.seconds(start);
    info.readFrom = isStart ? edge - consumedSec : edge;
    info.readTo = info.readFrom + consumedSec;
    const from = Math.max(0, info.readFrom - TapeStop.READ_MARGIN_SEC);
    const to = info.readTo + TapeStop.READ_MARGIN_SEC;
    for (const id of ids) {
      const track = session.tracks.byId(id);
      if (!track || (track.trackType?.value && track.trackType.value !== 'audio')) continue;
      const row = { track, name: track.name.value ?? id, lane: TapeStop.laneOf(session, track) };
      info.tracks.push(row);
      if (!row.lane) { row.skip = 'no playlist'; continue; }
      const pieces = TapeStop.pieces(row.lane, timeline, from, to);
      if (!pieces.some((p) => p.t1 > info.readFrom && p.t0 < info.readTo)) { row.skip = 'no audio in the range'; continue; }
      if (pieces.some((p) => TapeStop.isStretched(p.clip))) { row.skip = 'clip is time-stretched'; continue; }
      row.pieces = pieces;
      // The piece the audio lines up with: the one at the synced edge, else the nearest. Its
      // file sets the sample grid, so the wave carries on exactly into the original there.
      const dist = (p) => (edge < p.t0 ? p.t0 - edge : edge > p.t1 ? edge - p.t1 : 0);
      row.ref = pieces.reduce((best, p, i) => (dist(p) < dist(pieces[best]) ? i : best), 0);
      row.source = pieces[row.ref].clip;
      // The clips under each edge of the written range, to crossfade with.
      row.beneathStart = TapeStop.clipAt(row.lane, info.outStart);
      row.beneathStop = TapeStop.clipAt(row.lane, info.outStop - 1);
    }
    if (!info.tracks.some((t) => !t.skip)) {
      if (!info.tracks.length) info.problem = 'Select one or more audio tracks in LUNA.';
      else if (info.tracks.every((t) => t.skip === 'no audio in the range')) info.problem = 'No audio in the highlighted range on the selected tracks.';
      else info.problem = `Nothing to do: ${info.tracks.map((t) => `${t.name} (${t.skip})`).join(', ')}.`;
    }
    return info;
  },

  /** Ticks spanned by `ms` milliseconds starting at `tick`, through the tempo map. */
  msToTicks(timeline, tick, ms) {
    return Math.max(1, Math.round(timeline.tickAtSeconds(timeline.seconds(tick) + ms / 1000) - tick));
  },

  /** Post one `set_fade` row (fact 117) on the edit context. */
  async setFade(session, row, shape = 'equal_power') {
    await session.client.raw.post(`/sessions/${session.uid}/contexts/main/commands/set_fade`, {
      session_uid: session.uid,
      fade_shape: shape,
      clips: [{ fade_reference_edge: 'none', ...row }],
    });
  },

  /**
   * A crossfade, posted directly: the SDK's `clip.crossfade` reads the clips' bounds, which a
   * batch transaction holds back for clips it has just made. `left` and `right` meet at an
   * edit; the offsets are relative to that edit (fact 117).
   */
  crossfade(session, lane, left, right, startOffset, stopOffset) {
    return TapeStop.setFade(session, {
      playlist_uid: lane.id, clip_uid: left.id, fade_type: 'cross_fade', contributor_clip_uid: right.id,
      start_offset: startOffset, stop_offset: stopOffset, trim_to_edge: false,
    });
  },

  /** A plain fade-in at a clip's own start. */
  fadeIn(session, lane, clip, startTick, lengthTicks) {
    return TapeStop.setFade(session, { playlist_uid: lane.id, clip_uid: clip.id, fade_type: 'fade_in', start: startTick, stop_offset: lengthTicks });
  },

  /** A plain fade-out at a clip's own stop. */
  fadeOut(session, lane, clip, stopTick, lengthTicks) {
    return TapeStop.setFade(session, { playlist_uid: lane.id, clip_uid: clip.id, fade_type: 'fade_out', stop: stopTick, start_offset: -lengthTicks });
  },

  /**
   * Read, render and encode one track's tape stop or start. The track's audio over the read
   * range is laid out on one buffer, on the sample grid of the clip it lines up with; gaps stay
   * silent and each other clip is scaled to that clip's gain. Resolves to WAV bytes.
   */
  async renderTrack(session, info, row, o, readAudio) {
    const reads = [];
    for (const p of row.pieces) reads.push(await readAudio(p.uid, p.src0, p.src0 + (p.t1 - p.t0)));
    const sr = reads[0].sampleRate;
    if (reads.some((r) => r.sampleRate !== sr)) throw new Error(`the clips on ${row.name} have different sample rates`);
    const ref = row.pieces[row.ref];
    const at = (t) => (t - ref.t0 + ref.src0) * sr; // timeline seconds -> frame on the buffer's grid
    const lo = Math.floor(at(Math.max(0, info.readFrom - TapeStop.READ_MARGIN_SEC)));
    const hi = Math.ceil(at(info.readTo + TapeStop.READ_MARGIN_SEC)) + 1;
    const count = Math.max(...reads.map((r) => r.channels.length));
    const channels = Array.from({ length: count }, () => new Float32Array(hi - lo));
    row.pieces.forEach((p, i) => {
      const r = reads[i];
      const shift = Math.round((p.t0 - p.src0 - ref.t0 + ref.src0) * sr) - lo;
      const g = 10 ** ((p.gain - ref.gain) / 20);
      // Only the frames inside the clip: what lies past its edges in the file is not heard.
      const f0 = Math.max(Math.ceil(p.src0 * sr - 1e-6), r.startFrame);
      const f1 = Math.min(Math.ceil((p.src0 + (p.t1 - p.t0)) * sr - 1e-6), r.startFrame + r.channels[0].length);
      for (let ch = 0; ch < count; ch++) {
        const src = r.channels[Math.min(ch, r.channels.length - 1)];
        const dst = channels[ch];
        for (let f = f0; f < f1; f++) {
          const k = f + shift;
          if (k >= 0 && k < dst.length) dst[k] = src[f - r.startFrame] * g;
        }
      }
    });
    const out = TapeStop.renderVarispeed({
      channels,
      sampleRate: sr,
      startFrame: lo,
      baseFrame: at(info.readFrom),
      durationSec: info.durationSec,
      mode: o.mode,
      curve: o.curve,
      fade: o.fade,
    });
    return { bytes: TapeStop.encodeWav(out, sr), lengthNs: (out[0].length / sr) * 1e9 };
  },

  /**
   * Make the tape stop or start on every selected track that has audio for it. For each track:
   * read its audio, render, and add the result to the session as a new file (none of which is an
   * edit). Then, in one transaction (one undo step), place each as one clip over the written
   * range (empty space in it included), keep the gain of the clip it lines up with, and
   * crossfade the edge where the tape is stopped with the audio beneath.
   *
   * `readAudio(sourceUid, startSec, stopSec)` resolves to `{ sampleRate, startFrame, channels }`
   * ({@link makeReader}). `onStage(text)` reports progress. Resolves to `{ tracks }`.
   */
  async apply(session, info, options = {}, { onStage = () => {}, readAudio } = {}) {
    const o = { ...TapeStop.DEFAULTS, ...options };
    if (!readAudio) throw new Error('reading audio needs LUNA');
    const rows = info.tracks.filter((t) => !t.skip);
    const title = o.mode === 'start' ? 'Vinyl Start' : 'Vinyl Stop';
    const durNs = (info.durationSec ?? 0) * 1e9;
    const clipName = (row) => `${row.source.name.value ?? 'Clip'} ${o.mode === 'start' ? 'vinyl start' : 'vinyl stop'}`;

    const made = [];
    for (const row of rows) {
      onStage(`Rendering ${row.name}...`);
      const { bytes, lengthNs } = await TapeStop.renderTrack(session, info, row, o, readAudio);
      onStage(`Adding ${row.name} to the session...`);
      const source = await session.uploadFile({ bytes, name: `${clipName(row)}.wav` });
      made.push({ row, source, lengthNs });
    }

    onStage('Placing...');
    const timeline = session.musical.timeline;
    const { outStart, outStop } = info;
    await session.transaction(title, async () => {
      for (const { row, source, lengthNs } of made) {
        const clip = await session.insertClip({
          playlistUid: row.lane.id,
          sourceUid: source.id,
          startTick: outStart,
          stopTick: outStop,
          sourceStartNs: 0,
          sourceStopNs: Math.round(Math.min(lengthNs, durNs)),
          name: clipName(row),
          lengthFollows: 'time',
        });
        const gain = row.source.gain.value ?? 0;
        if (gain !== 0) await clip.gain.set(gain);

        // The synced edge (a stop's start, a start's end) joins the original with no crossfade:
        // the render reads the same file from the same point, so the wave carries straight on.
        // The other edge, where the tape has stopped, crossfades with the audio beneath.
        const half = Math.floor((outStop - outStart) / 2);
        if (o.mode === 'start') {
          const lIn = Math.min(TapeStop.msToTicks(timeline, outStart, o.crossfadeMs), half);
          if (row.beneathStart) await TapeStop.crossfade(session, row.lane, row.beneathStart, clip, 0, lIn);
          else await TapeStop.fadeIn(session, row.lane, clip, outStart, lIn);
        } else {
          const lOut = Math.min(TapeStop.msToTicks(timeline, outStop, o.crossfadeMs), half);
          if (row.beneathStop) await TapeStop.crossfade(session, row.lane, clip, row.beneathStop, -lOut, 0);
          else await TapeStop.fadeOut(session, row.lane, clip, outStop, lOut);
        }
      }
    });
    return { tracks: made.length };
  },
};

globalThis.TapeStop = TapeStop;
