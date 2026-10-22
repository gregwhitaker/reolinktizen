// The TV already fills its display. Desktop browsers may also allow the app
// to hide their chrome; a refused/unsupported request still leaves the grid
// filling the app viewport.
export class GridFullscreen {
  constructor(document, onChange) {
    this.document = document;
    this.onChange = onChange;
    this.active = false;
    this.pending = false;
    this.requested = false;
    this.ownsNative = false;
    for (const event of ['fullscreenchange', 'webkitfullscreenchange']) {
      document.addEventListener(event, () => this.nativeChanged());
    }
  }

  get nativeElement() {
    return this.document.fullscreenElement || this.document.webkitFullscreenElement;
  }

  setActive(active) {
    if (this.active === active) return;
    this.active = active;
    this.onChange(active);
  }

  enter() {
    this.setActive(true);
    const root = this.document.documentElement;
    const request = root.requestFullscreen || root.webkitRequestFullscreen;
    if (!request || this.nativeElement || this.pending) return;
    this.pending = true;
    this.requested = true;
    try {
      Promise.resolve(request.call(root)).then(() => this.nativeChanged(), () => {})
        .finally(() => { this.pending = false; this.requested = false; });
    } catch (_) {
      this.pending = false;
      this.requested = false;
    }
  }

  exit() {
    this.setActive(false);
    this.releaseNative();
  }

  nativeChanged() {
    if (this.nativeElement === this.document.documentElement && this.requested) {
      this.ownsNative = true;
      // Back may have been pressed before the browser completed the request.
      if (!this.active) this.releaseNative();
    } else if (!this.nativeElement && this.ownsNative) {
      this.ownsNative = false;
      this.setActive(false);
    }
  }

  releaseNative() {
    if (!this.ownsNative || this.nativeElement !== this.document.documentElement) return;
    this.ownsNative = false;
    const exit = this.document.exitFullscreen || this.document.webkitExitFullscreen;
    try { Promise.resolve(exit?.call(this.document)).catch(() => {}); }
    catch (_) { /* The in-app exit must work even if the browser refuses. */ }
  }
}
