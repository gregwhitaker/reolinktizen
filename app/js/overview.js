function tile(column, row, columnSpan = 1, rowSpan = 1) {
  return { column, row, columnSpan, rowSpan };
}

// Featured cameras come first, followed by the remaining cells in reading order.
// The same placement data draws the picker thumbnail and the actual camera grid.
function layout(value, columns, rows, featured = [], detail = `${columns} × ${rows} grid`) {
  const occupied = new Set();
  for (const item of featured) {
    for (let row = item.row; row < item.row + item.rowSpan; row++) {
      for (let column = item.column; column < item.column + item.columnSpan; column++) occupied.add(`${column},${row}`);
    }
  }
  const tiles = [...featured];
  for (let row = 1; row <= rows; row++) {
    for (let column = 1; column <= columns; column++) {
      if (!occupied.has(`${column},${row}`)) tiles.push(tile(column, row));
    }
  }
  return { value, count: tiles.length, columns, rows, tiles, detail };
}

export const OVERVIEW_LAYOUTS = [
  { value: 'auto', label: 'Auto', detail: 'Fit camera count' },
  layout(25, 5, 5),
  layout(16, 4, 4),
  layout(14, 5, 5, [tile(1, 1, 3, 3), tile(4, 1, 2, 2)], '2 large + 12 small'),
  layout(13, 4, 4, [tile(1, 1, 2, 2)], '1 large + 12 small'),
  layout(10, 4, 4, [tile(1, 1, 2, 2), tile(3, 1, 2, 2)], '2 large + 8 small'),
  layout(9, 3, 3),
  layout(8, 4, 4, [tile(1, 1, 3, 3)], '1 large + 7 small'),
  layout(6, 3, 3, [tile(1, 1, 2, 2)], '1 large + 5 small'),
  layout(4, 2, 2),
  layout(2, 2, 1, [], 'Side by side'),
  layout('2-vertical', 1, 2, [], 'Stacked'),
  layout(1, 1, 1, [], 'Single camera')
];

const AUTO_LAYOUTS = OVERVIEW_LAYOUTS.filter(item => typeof item.value === 'number').sort((a, b) => a.count - b.count);

export function normalizeOverviewLayout(value) {
  if (value === '2-vertical') return value;
  const number = Number(value);
  return OVERVIEW_LAYOUTS.some(layout => layout.value === number) ? number : 'auto';
}

export function resolveOverviewLayout(value, cameraCount) {
  const preference = normalizeOverviewLayout(value);
  return preference === 'auto'
    ? AUTO_LAYOUTS.find(item => item.count >= cameraCount) || AUTO_LAYOUTS[AUTO_LAYOUTS.length - 1]
    : OVERVIEW_LAYOUTS.find(item => item.value === preference);
}

export function overviewPage(cameras, preference, requestedPage = 0) {
  const layout = resolveOverviewLayout(preference, cameras.length);
  const pages = Math.max(1, Math.ceil(cameras.length / layout.count));
  const page = Math.max(0, Math.min(Math.trunc(requestedPage) || 0, pages - 1));
  const start = page * layout.count;
  return { layout, page, pages, start, cameras: cameras.slice(start, start + layout.count) };
}
