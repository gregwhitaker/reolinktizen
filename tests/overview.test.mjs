import test from 'node:test';
import assert from 'node:assert/strict';
import { OVERVIEW_LAYOUTS, overviewPage, resolveOverviewLayout } from '../app/js/overview.js';
import { readSettings, saveSettings } from '../app/js/storage.js';
import { nextInDirection } from '../app/js/navigation.js';

const cameras = Array.from({ length: 64 }, (_, id) => ({ id, name: `Camera ${id + 1}` }));

test('Auto fits the camera count and caps each page at twenty-five cameras', () => {
  for (const [count, expected] of [[0, 1], [1, 1], [2, 2], [3, 4], [5, 6], [7, 8], [8, 8], [9, 9], [10, 10], [12, 13], [13, 13], [14, 14], [15, 16], [16, 16], [17, 25], [25, 25], [64, 25]]) {
    assert.equal(resolveOverviewLayout('auto', count).count, expected);
  }
  assert.equal(overviewPage(cameras, 'auto').pages, 3);
  assert.equal(overviewPage(cameras.slice(0, 8), 'auto').pages, 1);
});

test('every selectable layout pages through all channels without omissions or duplicates', () => {
  for (const preference of OVERVIEW_LAYOUTS.map(layout => layout.value)) {
    const first = overviewPage(cameras, preference);
    const seen = [];
    for (let page = 0; page < first.pages; page++) {
      const result = overviewPage(cameras, preference, page);
      assert.equal(result.page, page);
      assert.ok(result.cameras.length <= result.layout.count);
      seen.push(...result.cameras.map(camera => camera.id));
    }
    assert.deepEqual(seen, cameras.map(camera => camera.id));
  }
});

test('filter changes and empty lists clamp the page without losing the remaining cameras', () => {
  const favorites = [cameras[0], cameras[63]];
  const result = overviewPage(favorites, 'auto', 10);
  assert.equal(result.page, 0);
  assert.equal(result.pages, 1);
  assert.equal(result.layout.value, 2);
  assert.deepEqual(result.cameras, favorites);
  const last = overviewPage(cameras.slice(0, 17), 16, 50);
  assert.equal(last.page, 1);
  assert.deepEqual(last.cameras, [cameras[16]]);
  const empty = overviewPage([], 16, 5);
  assert.equal(empty.page, 0);
  assert.equal(empty.pages, 1);
  assert.deepEqual(empty.cameras, []);
});

test('layout preferences survive reloads, with safe defaults for old or invalid settings', () => {
  let raw = '{}';
  const storage = { getItem: () => raw, setItem: (_, value) => { raw = value; } };
  assert.equal(readSettings(storage).overviewLayout, 'auto');
  for (const choice of OVERVIEW_LAYOUTS.map(layout => layout.value)) {
    saveSettings({ ...readSettings(storage), overviewLayout: choice, password: 'not-remembered' }, storage);
    assert.equal(readSettings(storage).overviewLayout, choice);
    assert.equal(readSettings(storage).password, '');
  }
  for (const choice of [0, -1, 3, 65, null, 'bad']) {
    raw = JSON.stringify({ overviewLayout: choice });
    assert.equal(readSettings(storage).overviewLayout, 'auto');
  }
  raw = JSON.stringify({ overviewLayout: '4' });
  assert.equal(readSettings(storage).overviewLayout, 4);
});

test('every layout fills its frame with the advertised number of non-overlapping camera tiles', () => {
  for (const layout of OVERVIEW_LAYOUTS.filter(layout => layout.value !== 'auto')) {
    const cells = new Set();
    assert.equal(layout.count, typeof layout.value === 'number' ? layout.value : 2);
    assert.equal(layout.tiles.length, layout.count);
    for (const tile of layout.tiles) {
      for (let row = tile.row; row < tile.row + tile.rowSpan; row++) {
        for (let column = tile.column; column < tile.column + tile.columnSpan; column++) {
          assert.ok(row >= 1 && row <= layout.rows && column >= 1 && column <= layout.columns, `out of bounds: ${layout.value}`);
          const cell = `${column},${row}`;
          assert.ok(!cells.has(cell), `overlapping cameras in layout ${layout.value}`);
          cells.add(cell);
        }
      }
    }
    assert.equal(cells.size, layout.columns * layout.rows, `empty cells in layout ${layout.value}`);
  }
});

test('mixed layouts match the reference and two-camera orientations remain distinct', () => {
  const featured = value => resolveOverviewLayout(value, 64).tiles.filter(tile => tile.columnSpan > 1 || tile.rowSpan > 1)
    .map(tile => [tile.column, tile.row, tile.columnSpan, tile.rowSpan]);
  assert.deepEqual(featured(6), [[1, 1, 2, 2]]);
  assert.deepEqual(featured(8), [[1, 1, 3, 3]]);
  assert.deepEqual(featured(10), [[1, 1, 2, 2], [3, 1, 2, 2]]);
  assert.deepEqual(featured(13), [[1, 1, 2, 2]]);
  assert.deepEqual(featured(14), [[1, 1, 3, 3], [4, 1, 2, 2]]);
  assert.equal(resolveOverviewLayout(2, 2).columns, 2);
  assert.equal(resolveOverviewLayout('2-vertical', 2).rows, 2);
  const verticalPage = overviewPage(cameras.slice(0, 3), '2-vertical', 1);
  assert.equal(verticalPage.pages, 2);
  assert.deepEqual(verticalPage.cameras, [cameras[2]]);
});

test('D-pad navigation can reach every camera in overview and full-screen layouts', () => {
  for (const layout of OVERVIEW_LAYOUTS.filter(layout => layout.value !== 'auto')) {
    for (const fullscreen of [false, true]) {
      const gap = fullscreen ? 4 : layout.rows >= 5 ? 14 : layout.rows >= 4 ? 18 : layout.rows >= 3 || layout.columns >= 4 ? 20 : 24;
      const width = ((fullscreen ? 1920 : 1776) - gap * (layout.columns - 1)) / layout.columns;
      const height = ((fullscreen ? 1080 : 588) - gap * (layout.rows - 1)) / layout.rows;
      const tiles = layout.tiles.map((tile, index) => ({ element: `camera-${index}`, rect: {
        x: (tile.column - 1) * (width + gap), y: (tile.row - 1) * (height + gap),
        width: tile.columnSpan * width + (tile.columnSpan - 1) * gap,
        height: tile.rowSpan * height + (tile.rowSpan - 1) * gap
      } }));
      const seen = new Set(['camera-0']), queue = [tiles[0]];
      while (queue.length) {
        const current = queue.shift();
        for (const direction of ['left', 'right', 'up', 'down']) {
          const next = nextInDirection(current.rect, tiles.filter(tile => tile !== current), direction);
          if (next && !seen.has(next)) { seen.add(next); queue.push(tiles.find(tile => tile.element === next)); }
        }
      }
      assert.equal(seen.size, layout.count, `unreachable cameras in ${layout.value}, fullscreen=${fullscreen}`);
    }
  }
});
