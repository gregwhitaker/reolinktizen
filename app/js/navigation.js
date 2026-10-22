export function nextInDirection(current, candidates, direction) {
  const cx = current.x + current.width / 2, cy = current.y + current.height / 2;
  let best = null, score = Infinity;
  for (const candidate of candidates) {
    const r = candidate.rect;
    const dx = r.x + r.width / 2 - cx, dy = r.y + r.height / 2 - cy;
    const forward = direction === 'right' ? dx : direction === 'left' ? -dx : direction === 'down' ? dy : -dy;
    if (forward < 2) continue;
    const sideways = ['left', 'right'].includes(direction) ? Math.abs(dy) : Math.abs(dx);
    const rank = forward + sideways * 3 + (sideways > forward ? 10000 : 0);
    if (rank < score) { best = candidate.element; score = rank; }
  }
  return best;
}

export function moveFocus(scope, direction) {
  const elements = [...scope.querySelectorAll('button, input, select, [tabindex="0"]')]
    .filter(el => !el.disabled && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  const current = document.activeElement;
  if (!elements.includes(current)) { elements[0]?.focus(); return; }
  const next = nextInDirection(current.getBoundingClientRect(), elements.filter(el => el !== current)
    .map(element => ({ element, rect: element.getBoundingClientRect() })), direction);
  next?.focus();
}

export function registerRemote() {
  const keys = ['ChannelUp', 'ChannelDown', 'MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue', 'Info'];
  for (const key of keys) { try { globalThis.tizen?.tvinputdevice?.registerKey(key); } catch (_) { /* Optional remote keys vary by model. */ } }
}
