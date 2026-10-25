/* global document, window */
// Zune HD-style screensaver: the current track's album, title + time, artist and cover
// scroll across the artist photo in sets. Each set travels once in one of four directions;
// the next set comes in from edges the previous one has vacated, with no fades and no
// crossings (see src/shared/screensaver-motion.js).
class Screensaver {
  constructor(explorer, { onClose } = {}) {
    this.explorer = explorer;
    this.onClose = onClose || (() => {});
    this.isOpen = false;
    this.overlay = null;
    this.bgEl = null;
    this.sets = [];          // live sets: { rotor, rows: [{ plan, anim, track }], duration, angle }
    this.pending = null;     // next set, built and measured but not yet launched
    this._preparing = false;
    this.lastAngle = null;
    this._tickTimer = null;
    this._openedAt = 0;
    this._pointerOrigin = null;
    this._clockText = '0:00';
    this._timeListenerAdded = false;
    this._trackGeneration = 0;

    this._onExitInput = this._onExitInput.bind(this);
    this._onVisibility = this._onVisibility.bind(this);
    this._swallow = (e) => { e.preventDefault(); e.stopPropagation(); };
  }

  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this._openedAt = performance.now();
    this._pointerOrigin = null;
    this.lastAngle = null;

    this.overlay = document.createElement('div');
    this.overlay.className = 'screensaver-overlay';
    this.bgEl = document.createElement('div');
    this.bgEl.className = 'ss-bg';
    this.overlay.appendChild(this.bgEl);
    document.body.appendChild(this.overlay);

    if (!this._timeListenerAdded && this.explorer.audioPlayer) {
      // AudioPlayer has no off(); the handler checks isOpen instead.
      this.explorer.audioPlayer.on('timeupdate', ({ currentTime }) => this._onTime(currentTime));
      // A set built for the previous track is dropped; the next set shows the new one.
      this.explorer.audioPlayer.on('trackchange', () => this._discardPending());
      this._timeListenerAdded = true;
    }
    this._clockText = '';
    this._onTime(this.explorer.audioPlayer?.audio?.currentTime || 0);

    for (const type of ['keydown', 'mousedown', 'wheel', 'touchstart', 'mousemove']) {
      window.addEventListener(type, this._onExitInput, { capture: true, passive: false });
    }
    document.addEventListener('visibilitychange', this._onVisibility);

    this._startTicking();
    this._tick();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this._stopTicking();
    for (const set of this.sets) {
      for (const r of set.rows) r.anim.cancel();
    }
    this.sets = [];
    this.pending = null;
    if (this.overlay) this.overlay.remove();
    this.overlay = null;
    this.bgEl = null;

    for (const type of ['keydown', 'mousedown', 'wheel', 'touchstart', 'mousemove']) {
      window.removeEventListener(type, this._onExitInput, { capture: true });
    }
    document.removeEventListener('visibilitychange', this._onVisibility);

    // The input that closed us must not reach the page underneath (click, key repeat, menu).
    const swallowed = ['click', 'mouseup', 'keyup', 'keypress', 'contextmenu', 'dblclick'];
    for (const type of swallowed) window.addEventListener(type, this._swallow, true);
    setTimeout(() => {
      for (const type of swallowed) window.removeEventListener(type, this._swallow, true);
    }, 400);

    this.onClose();
  }

  _onExitInput(e) {
    if (e.type === 'mousemove') {
      // Chromium sends synthetic moves when the overlay appears; require real movement.
      if (!this._pointerOrigin) this._pointerOrigin = { x: e.clientX, y: e.clientY };
      if (performance.now() - this._openedAt < 500) {
        this._pointerOrigin = { x: e.clientX, y: e.clientY };
        return;
      }
      if (Math.hypot(e.clientX - this._pointerOrigin.x, e.clientY - this._pointerOrigin.y) <= 4) return;
    }
    e.preventDefault();
    e.stopPropagation();
    this.close();
  }

  _onVisibility() {
    if (!this.isOpen) return;
    const hidden = document.visibilityState === 'hidden';
    for (const set of this.sets) {
      for (const r of set.rows) {
        if (r.anim.playState === 'finished') continue;
        if (hidden) r.anim.pause(); else r.anim.play();
      }
    }
    if (hidden) this._stopTicking(); else this._startTicking();
  }

  _startTicking() {
    this._stopTicking();
    this._tickTimer = setInterval(() => this._tick(), 500);
  }

  _stopTicking() {
    if (this._tickTimer) clearInterval(this._tickTimer);
    this._tickTimer = null;
  }

  _onTime(currentTime) {
    if (!this.isOpen) return;
    const text = this.explorer.audioPlayer.formatTime(currentTime);
    if (text === this._clockText) return;
    this._clockText = text;
    for (const el of this.overlay.querySelectorAll('.ss-time')) el.textContent = text;
  }

  _discardPending() {
    this._trackGeneration = (this._trackGeneration || 0) + 1;
    if (this.pending) this.pending.rotor.remove();
    this.pending = null;
  }

  _viewport() {
    return { w: this.overlay.clientWidth, h: this.overlay.clientHeight };
  }

  async _tick() {
    if (!this.isOpen || document.visibilityState === 'hidden') return;
    const motion = window.screensaverMotion;
    for (const set of this.sets) {
      if (set.rows.every((r) => r.anim.playState === 'finished')) set.rotor.remove();
    }
    this.sets = this.sets.filter((set) => set.rotor.isConnected);

    const newest = this.sets[this.sets.length - 1];
    if (newest) {
      const elapsed = (newest.rows[0].anim.currentTime || 0) / 1000;
      if (elapsed < newest.duration * 0.5) return;
    }

    if (!this.pending) {
      if (this._preparing) return;
      this._preparing = true;
      const generation = this._trackGeneration;
      let prepared;
      try {
        prepared = await this._prepareSet();
      } finally {
        this._preparing = false;
      }
      if (!prepared) return;
      if (!this.isOpen || generation !== this._trackGeneration) {
        prepared.rotor.remove(); // built for a track that is no longer playing
        return;
      }
      this.pending = prepared;
    }

    // The window may have been hidden while the set was being prepared; launching now
    // would run it while the older sets are paused. Keep it for when we're visible again.
    if (document.visibilityState === 'hidden') return;

    const viewport = this._viewport();
    const outgoing = [];
    for (const set of this.sets) {
      for (const r of set.rows) {
        if (r.anim.playState !== 'finished') outgoing.push({ row: r.plan, elapsed: (r.anim.currentTime || 0) / 1000 });
      }
    }
    const pending = this.pending;
    const angle = motion.chooseNextAngle({
      previous: this.lastAngle,
      buildIncoming: (a) => motion.planRows({ rows: pending.rows, angle: a, viewport, setDuration: pending.setDuration }),
      outgoing,
      viewport,
      rand: Math.random,
    });
    if (angle === null) return; // nothing clear yet; try again next tick
    this._launch(pending, angle, viewport);
  }

  _currentInfo() {
    const player = this.explorer.audioPlayer;
    const metadata = player?.currentMetadata;
    const file = player?.getCurrentFile();
    if (!metadata || !file) return null;
    const isPodcast = !!file.isPodcast;
    const title = metadata.title || file.title || file.name || '';
    const album = (isPodcast ? file.podcastName : metadata.album) || metadata.album || title;
    const artist = isPodcast ? album : (metadata.artist || 'unknown artist');
    let cover = metadata.albumArt || null;
    if (!cover && isPodcast && file.artworkPath) {
      cover = 'file://' + file.artworkPath.split('/').map(encodeURIComponent).join('/');
    }
    if (!cover && !isPodcast) {
      try { cover = this.explorer.findAlbumArtForTrack(file) || null; } catch { cover = null; }
    }
    const libTrack = !isPodcast && file.path ? this.explorer.musicLibrary?.tracks.get(file.path) : null;
    // Compilations: "Various Artists" is not a person; use the track's own artist instead.
    const { isPlaceholderArtist } = window.artistName;
    let photoArtist = null;
    if (!isPodcast) {
      const albumArtist = libTrack && libTrack.albumArtist;
      photoArtist = albumArtist && !isPlaceholderArtist(albumArtist) ? albumArtist : (metadata.artist || null);
    }
    return { title, album, artist, cover, isPodcast, photoArtist };
  }

  async _resolveBackground(info) {
    if (info.photoArtist && this.explorer.preferences?.artistImages?.enabled) {
      // Use the cache only, so a new artist never leaves the screen empty while a photo
      // downloads; the lookup runs in the background and a later set picks it up.
      try {
        const photo = await window.electronAPI.artistImageGet(info.photoArtist);
        if (photo) return { url: photo.url, kind: 'photo' };
        window.electronAPI.artistImageFind(info.photoArtist).catch(() => {});
      } catch { /* fall back to the cover */ }
    }
    if (info.cover) return { url: info.cover, kind: 'cover' };
    return { url: null, kind: 'none' };
  }

  // Build the next set off-screen (hidden), measure it, and plan its lanes.
  // Measurements don't depend on direction, so the same set can be tried at any angle.
  async _prepareSet() {
    const info = this._currentInfo();
    if (!info) return null;
    const background = await this._resolveBackground(info);
    if (!this.isOpen) return null;

    const motion = window.screensaverMotion;
    const rand = (a, b) => a + Math.random() * (b - a);
    const { w, h } = this._viewport();
    const diagonal = Math.hypot(w, h);

    const defs = [
      { cls: 'ss-giant', text: info.album, size: 0.55 },
      { cls: 'ss-small', clock: true, size: 0.06, eligible: true },
      { cls: 'ss-bold', text: info.album, size: 0.13, eligible: true },
      { cls: 'ss-mid', text: info.artist, size: 0.10, eligible: true },
      { cls: 'ss-giant', text: info.artist, size: 0.60 },
    ];
    const coverIndex = Math.floor(rand(1, defs.length + 1));
    defs.splice(coverIndex, 0, { cls: 'ss-cover-row', cover: true, size: 0.38 });

    const rotor = document.createElement('div');
    rotor.className = 'ss-rotor';
    rotor.style.width = diagonal + 'px';
    rotor.style.height = diagonal + 'px';
    rotor.style.visibility = 'hidden';
    this.overlay.appendChild(rotor);

    const tracks = defs.map((def) => {
      const row = document.createElement('div');
      row.className = 'ss-row ' + def.cls;
      row.style.fontSize = def.size * h * rand(0.85, 1.2) + 'px';
      const track = document.createElement('div');
      track.className = 'ss-track';
      if (def.cover) {
        const box = document.createElement('div');
        box.className = 'ss-cover';
        if (info.cover) {
          const img = document.createElement('img');
          img.src = info.cover;
          img.alt = '';
          box.appendChild(img);
        } else {
          const label = document.createElement('div');
          label.className = 'ss-cover-text';
          label.textContent = info.album;
          box.appendChild(label);
        }
        track.appendChild(box);
      } else if (def.clock) {
        for (let i = 0; i < 3; i++) {
          const t = document.createElement('span');
          t.textContent = info.title;
          const timeWrap = document.createElement('span');
          const b = document.createElement('b');
          b.className = 'ss-time';
          b.textContent = this._clockText;
          timeWrap.appendChild(b);
          track.appendChild(t);
          track.appendChild(timeWrap);
        }
      } else {
        const span = document.createElement('span');
        span.textContent = def.text;
        track.appendChild(span);
      }
      row.appendChild(track);
      rotor.appendChild(row);
      return { row, track };
    });

    const heights = tracks.map(({ row }) => row.offsetHeight);
    const widths = tracks.map(({ track }) => track.offsetWidth);
    const lanes = motion.stackLanes(heights, h, Math.random, { solid: [coverIndex] });
    const eligible = defs.map((d, i) => (d.eligible ? i : -1)).filter((i) => i >= 0);
    const reversals = motion.pickReversals(defs.length, eligible, Math.random);

    const rows = defs.map((_, i) => ({
      width: widths[i],
      height: heights[i],
      laneOffset: lanes[i],
      reverse: reversals[i],
      speedFactor: rand(0.75, 1.1),
      delay: rand(0, 2.5),
    }));
    tracks.forEach(({ row }, i) => {
      row.style.top = diagonal / 2 + lanes[i] - heights[i] / 2 + 'px';
    });

    return { rotor, tracks, rows, setDuration: rand(35, 50), background, diagonal };
  }

  _launch(pending, angle, viewport) {
    this.pending = null;
    this.lastAngle = angle;
    this._applyBackground(pending.background);

    const plans = window.screensaverMotion.planRows({ rows: pending.rows, angle, viewport, setDuration: pending.setDuration });
    const { rotor, tracks, diagonal } = pending;
    rotor.style.transform = `translate(-50%, -50%) rotate(${angle}deg)`;
    rotor.style.visibility = 'visible';

    const rows = plans.map((plan, i) => {
      const anim = tracks[i].track.animate(
        [
          { transform: `translateX(${diagonal / 2 + plan.from}px)` },
          { transform: `translateX(${diagonal / 2 + plan.to}px)` },
        ],
        { duration: plan.duration * 1000, delay: plan.delay * 1000, easing: 'linear', fill: 'both' }
      );
      return { plan, anim, track: tracks[i].track };
    });
    const longest = Math.max(...plans.map((p) => p.delay + p.duration));
    this.sets.push({ rotor, rows, duration: longest, angle });
  }

  _applyBackground(background) {
    if (!this.bgEl) return;
    this.bgEl.className = 'ss-bg ss-bg-' + background.kind;
    this.bgEl.style.backgroundImage = background.url ? `url("${background.url}")` : 'none';
  }
}

window.Screensaver = Screensaver;
