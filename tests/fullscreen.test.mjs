import test from 'node:test';
import assert from 'node:assert/strict';
import { GridFullscreen } from '../app/js/fullscreen.js';

function browser() {
  const document = new EventTarget();
  document.documentElement = {};
  document.fullscreenElement = null;
  document.exitCalls = 0;
  document.change = element => {
    document.fullscreenElement = element;
    document.dispatchEvent(new Event('fullscreenchange'));
  };
  document.documentElement.requestFullscreen = async () => document.change(document.documentElement);
  document.exitFullscreen = async () => { document.exitCalls++; document.change(null); };
  const changes = [];
  return { document, changes, view: new GridFullscreen(document, active => changes.push(active)) };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('the grid fills the app when fullscreen is unavailable or refused, and Back still exits', async () => {
  for (const request of [undefined, () => { throw new Error('unsupported'); }, () => Promise.reject(new Error('denied'))]) {
    const { document, view, changes } = browser();
    document.documentElement.requestFullscreen = request;
    view.enter();
    await settle();
    assert.equal(view.active, true);
    view.exit();
    assert.equal(view.active, false);
    assert.equal(document.exitCalls, 0);
    assert.deepEqual(changes, [true, false]);
  }
});

test('both the in-app exit and the browser fullscreen exit restore the overview once', async () => {
  for (const nativeExit of [false, true]) {
    const { document, view, changes } = browser();
    view.enter();
    await settle();
    assert.equal(document.fullscreenElement, document.documentElement);
    if (nativeExit) document.change(null); else view.exit();
    assert.equal(view.active, false);
    assert.equal(document.fullscreenElement, null);
    assert.deepEqual(changes, [true, false]);
  }
});

test('Back during a pending browser request releases fullscreen when that request completes', async () => {
  const { document, view, changes } = browser();
  let finish;
  document.documentElement.requestFullscreen = () => new Promise(resolve => { finish = resolve; });
  view.enter();
  view.exit();
  document.change(document.documentElement);
  finish();
  await settle();
  assert.equal(view.active, false);
  assert.equal(document.fullscreenElement, null);
  assert.equal(document.exitCalls, 1);
  assert.deepEqual(changes, [true, false]);
});

test('re-entering while a browser request is pending uses that request without losing the view', async () => {
  const { document, view } = browser();
  let finish, requests = 0;
  document.documentElement.requestFullscreen = () => {
    requests++;
    return new Promise(resolve => { finish = resolve; });
  };
  view.enter(); view.exit(); view.enter();
  document.change(document.documentElement);
  finish();
  await settle();
  assert.equal(view.active, true);
  assert.equal(requests, 1);
  view.exit();
  assert.equal(document.exitCalls, 1);
});

test('leaving the grid does not exit a fullscreen session it did not create', () => {
  const { document, view } = browser();
  const otherElement = {};
  document.change(otherElement);
  view.enter(); view.exit();
  assert.equal(document.fullscreenElement, otherElement);
  assert.equal(document.exitCalls, 0);
});

test('prefixed browser fullscreen events also keep the grid and browser in sync', async () => {
  const { document, view } = browser();
  delete document.documentElement.requestFullscreen;
  delete document.exitFullscreen;
  const change = element => {
    document.webkitFullscreenElement = element;
    document.dispatchEvent(new Event('webkitfullscreenchange'));
  };
  document.documentElement.webkitRequestFullscreen = () => change(document.documentElement);
  document.webkitExitFullscreen = () => change(null);
  view.enter();
  await settle();
  assert.equal(view.active, true);
  view.exit();
  assert.equal(document.webkitFullscreenElement, null);
});
