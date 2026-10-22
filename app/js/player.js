import { createStreamLoader } from './stream-loader.js';

// Each instance owns exactly one decoder and its reconnect/watchdog timers.
export class CameraPlayer {
  constructor(video, onState, library = globalThis.mpegts, { videoOnly = false } = {}) {
    this.video = video;
    this.onState = onState;
    this.library = library;
    this.videoOnly = videoOnly;
    this.generation = 0;
    this.player = null;
    this.retryTimer = null;
    this.watchdog = null;
    this.active = false;
    this.audio = false;
    this.lastTime = 0;
    this.lastProgress = 0;
    this.playingSince = 0;
    if (library?.LoggingControl) library.LoggingControl.enableAll = false;
    this.onPlaying = () => {
      if (!this.active || !this.player) return;
      this.lastProgress = Date.now();
      if (!this.playingSince) this.playingSince = Date.now();
      this.onState({ state: 'live', quality: this.quality });
    };
    this.onTimeUpdate = () => {
      if (video.currentTime !== this.lastTime) {
        this.lastTime = video.currentTime;
        this.lastProgress = Date.now();
        if (this.playingSince && Date.now() - this.playingSince >= 30000) this.attempts = 0;
      }
    };
    this.onWaiting = () => {
      if (this.active && this.player) this.onState({ state: 'buffering', quality: this.quality });
    };
    this.onError = () => {
      if (this.active && this.player) this.failure(this.generation, 'Unable to decode this camera. Try a smaller live layout.');
    };
    video.addEventListener('playing', this.onPlaying);
    video.addEventListener('timeupdate', this.onTimeUpdate);
    video.addEventListener('waiting', this.onWaiting);
    video.addEventListener('error', this.onError);
  }

  async play(client, channel, quality, authMode = 'auto') {
    this.stop();
    this.active = true;
    this.client = client;
    this.channel = channel;
    this.quality = quality;
    this.authMode = authMode;
    this.auth = authMode === 'credentials' ? 'credentials' : 'token';
    this.attempts = 0;
    this.fellBack = false;
    await this.start(this.generation);
  }

  async start(generation) {
    if (!this.active || generation !== this.generation) return;
    this.clearMedia();
    this.onState({ state: this.attempts ? 'reconnecting' : 'connecting', quality: this.quality });
    try {
      if (!this.library?.getFeatureList().mseLivePlayback) throw new Error('This device cannot play the HTTP video stream. Use the installed TV app or a Chromium browser.');
      const url = await this.client.streamUrl(this.channel, this.quality, this.auth);
      if (!this.active || generation !== this.generation) return;
      this.video.muted = !this.audio;
      this.player = this.library.createPlayer({ type: 'flv', isLive: true, url, cors: true, ...(this.videoOnly ? { hasAudio: false } : {}) }, {
        customLoader: this.library.BaseLoader ? createStreamLoader(this.library, this.client.fetch) : undefined,
        enableWorker: false,
        enableWorkerForMSE: false,
        enableStashBuffer: false,
        lazyLoad: false,
        liveBufferLatencyChasing: true,
        liveBufferLatencyMaxLatency: 3,
        liveBufferLatencyMinRemain: 0.5,
        autoCleanupSourceBuffer: true,
        autoCleanupMaxBackwardDuration: this.videoOnly ? 5 : 15,
        autoCleanupMinBackwardDuration: this.videoOnly ? 2 : 5,
        fixAudioTimestampGap: false
      });
      const instance = this.player;
      this.player.on(this.library.Events.ERROR, (type, detail) => {
        if (this.player !== instance) return;
        // Never surface library error objects: they can contain authenticated URLs.
        this.failure(generation, type === 'MediaError' ? 'Video format is not supported.' : 'The camera stream was interrupted.');
      });
      this.player.attachMediaElement(this.video);
      this.player.load();
      const playPromise = this.player.play();
      if (playPromise?.catch) playPromise.catch(() => {
        if (generation !== this.generation || !this.active || this.player !== instance) return;
        this.video.muted = true;
        this.audio = false;
        this.video.play().catch(() => {
          if (this.player === instance) this.failure(generation, 'Unable to start video playback.');
        });
      });
      this.lastProgress = Date.now();
      this.lastTime = -1;
      this.playingSince = 0;
      this.watchdog = setInterval(() => {
        if (Date.now() - this.lastProgress > 15000) this.failure(generation, 'No video received. Check that HTTP and RTMP are enabled on your NVR.');
      }, 3000);
    } catch (error) {
      if (generation !== this.generation || !this.active) return;
      this.failure(generation, error.name === 'NvrError' ? error.message :
        (!this.library?.getFeatureList().mseLivePlayback ? error.message : 'Unable to open the camera stream.'));
    }
  }

  failure(generation, message) {
    if (generation !== this.generation || !this.active || this.retryTimer) return;
    this.clearMedia();
    this.attempts++;
    if (this.authMode === 'auto' && this.auth === 'token') {
      this.auth = 'credentials';
    } else if (this.quality !== 'sub' && !this.fellBack) {
      this.quality = 'sub';
      this.fellBack = true;
      this.onState({ state: 'notice', message: 'Switching to Fluent. Clear video needs an H.264 main stream.' });
    }
    if (this.attempts > 4) {
      this.onState({ state: 'error', message: `${message} Try Fluent quality, confirm RTMP is enabled, or change Stream sign-in in settings.` });
      return;
    }
    this.onState({ state: 'reconnecting', quality: this.quality, attempt: this.attempts });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (generation === this.generation) this.start(generation);
    }, Math.min(1000 * 2 ** (this.attempts - 1), 8000));
  }

  setAudio(enabled) { this.audio = !this.videoOnly && enabled; this.video.muted = !this.audio; }

  clearMedia() {
    clearInterval(this.watchdog);
    this.watchdog = null;
    if (this.player) {
      const previous = this.player;
      this.player = null;
      try { previous.pause(); } catch (_) {}
      try { previous.unload(); } catch (_) {}
      try { previous.detachMediaElement(); } catch (_) {}
      try { previous.destroy(); } catch (_) {}
    }
  }

  stop() {
    this.generation++;
    this.active = false;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.clearMedia();
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
  }

  destroy() {
    this.stop();
    this.video.removeEventListener('playing', this.onPlaying);
    this.video.removeEventListener('timeupdate', this.onTimeUpdate);
    this.video.removeEventListener('waiting', this.onWaiting);
    this.video.removeEventListener('error', this.onError);
  }
}
