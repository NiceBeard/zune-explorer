class AudioPlayer {
  constructor() {
    this.audio = new Audio();
    this.queue = [];
    this.currentIndex = -1;
    this.isPlaying = false;
    this.shuffle = false;
    this.repeat = 'none'; // 'none', 'all', 'one'
    this.currentMetadata = null;
    this._listeners = {};

    this.audio.addEventListener('timeupdate', () => {
      this.emit('timeupdate', {
        currentTime: this.audio.currentTime,
        duration: this.audio.duration || 0,
      });
    });

    this.audio.addEventListener('ended', () => {
      if (this.repeat === 'one') {
        this.audio.currentTime = 0;
        this.audio.play();
      } else {
        this.next();
      }
    });

    this.audio.addEventListener('loadedmetadata', () => {
      this.emit('loaded', { duration: this.audio.duration });
    });

    this.audio.addEventListener('error', (e) => {
      console.error('Audio playback error:', e);
      this.emit('error', e);
    });
  }

  on(event, callback) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(callback);
  }

  emit(event, data) {
    if (this._listeners[event]) {
      this._listeners[event].forEach(cb => cb(data));
    }
  }

  async play(file, queue) {
    this.queue = queue || [file];
    this.currentIndex = this.queue.findIndex(f => (f.id && f.id === file.id) || f.path === file.path);
    if (this.currentIndex === -1) this.currentIndex = 0;
    await this.loadAndPlay(this.queue[this.currentIndex]);
  }

  async loadAndPlay(file) {
    try {
      if (file.isPodcast) {
        // Podcast episode — metadata is inline, no IPC needed
        this.currentMetadata = {
          title: file.title,
          artist: file.podcastName,
          album: file.podcastName,
          picture: file.artworkPath ? [{ data: file.artworkPath, format: 'path' }] : null,
          duration: file.duration,
        };
        // Use local file if downloaded, otherwise stream from URL
        if (file.localPath) {
          this.audio.src = 'file://' + file.localPath.split('/').map(encodeURIComponent).join('/');
        } else {
          this.audio.src = file.enclosureUrl;
        }
        // Resume from saved position — must wait for media to load
        if (file.playbackPosition && file.playbackPosition > 0) {
          const resumePos = file.playbackPosition;
          await new Promise((resolve) => {
            const onLoaded = () => {
              this.audio.currentTime = resumePos;
              this.audio.removeEventListener('loadedmetadata', onLoaded);
              resolve();
            };
            this.audio.addEventListener('loadedmetadata', onLoaded);
          });
        }
      } else {
        // Music track — existing behavior
        const metadata = await window.electronAPI.getAudioMetadata(file.path);
        this.currentMetadata = metadata;
        this.audio.src = 'file://' + file.path.split('/').map(encodeURIComponent).join('/');
      }
      await this.audio.play();
      this.isPlaying = true;
      this.emit('trackchange', { file, metadata: this.currentMetadata, index: this.currentIndex, queue: this.queue });
      this.emit('play');
    } catch (error) {
      console.error('Error loading track:', error);
      let message;
      if (file.isPodcast) {
        const type = file.enclosureType || 'audio';
        message = file.localPath
          ? `unable to play downloaded episode`
          : `unable to stream episode (${type})`;
      } else {
        const ext = (file.path || '').split('.').pop().toLowerCase();
        const mediaError = this.audio.error;
        if (mediaError && mediaError.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
          message = `unable to play .${ext} files on this platform`;
        } else if (mediaError && mediaError.code === MediaError.MEDIA_ERR_DECODE) {
          message = `unable to decode .${ext} file`;
        } else {
          message = `unable to play: ${file.name || file.title || ext}`;
        }
      }
      this.isPlaying = false;
      this.emit('playbackerror', { file, message });
    }
  }

  pause() {
    this.audio.pause();
    this.isPlaying = false;
    this.emit('pause');
  }

  resume() {
    this.audio.play();
    this.isPlaying = true;
    this.emit('play');
  }

  togglePlayPause() {
    if (this.isPlaying) {
      this.pause();
    } else {
      this.resume();
    }
  }

  async next() {
    if (this.queue.length === 0) return;

    let nextIndex;
    if (this.shuffle) {
      if (this.queue.length <= 1) {
        nextIndex = 0;
      } else {
        do {
          nextIndex = Math.floor(Math.random() * this.queue.length);
        } while (nextIndex === this.currentIndex);
      }
    } else {
      nextIndex = this.currentIndex + 1;
    }

    if (nextIndex >= this.queue.length) {
      if (this.repeat === 'all') {
        nextIndex = 0;
      } else {
        this.isPlaying = false;
        this.emit('queueend');
        return;
      }
    }

    this.currentIndex = nextIndex;
    await this.loadAndPlay(this.queue[this.currentIndex]);
  }

  async previous() {
    if (this.queue.length === 0) return;

    // If more than 3 seconds in, restart current track
    if (this.audio.currentTime > 3) {
      this.audio.currentTime = 0;
      return;
    }

    let prevIndex = this.currentIndex - 1;
    if (prevIndex < 0) {
      if (this.repeat === 'all') {
        prevIndex = this.queue.length - 1;
      } else {
        prevIndex = 0;
      }
    }

    this.currentIndex = prevIndex;
    await this.loadAndPlay(this.queue[this.currentIndex]);
  }

  seek(percent) {
    if (this.audio.duration) {
      this.audio.currentTime = this.audio.duration * (percent / 100);
    }
  }

  toggleShuffle() {
    this.shuffle = !this.shuffle;
    this.emit('shufflechange', this.shuffle);
  }

  toggleRepeat() {
    const modes = ['none', 'all', 'one'];
    const currentIdx = modes.indexOf(this.repeat);
    this.repeat = modes[(currentIdx + 1) % modes.length];
    this.emit('repeatchange', this.repeat);
  }

  formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  getCurrentFile() {
    return this.queue[this.currentIndex] || null;
  }
}
