import { describe, expect, it } from 'vitest';
import { bounds, fit, route, zoomAt, ZOOM } from '../../webview/boardGeometry.js';

describe('board geometry', () => {
  it('bounds every box, and nothing without boxes', () => {
    expect(bounds([])).toBeNull();
    expect(
      bounds([
        { x: 0, y: 10, w: 100, h: 50 },
        { x: 200, y: 0, w: 100, h: 40 },
      ]),
    ).toEqual({ x: 0, y: 0, w: 300, h: 60 });
  });

  it('fits the content in the middle, without enlarging past the maximum', () => {
    const content = { x: 0, y: 0, w: 400, h: 200 };
    expect(fit(content, 1000, 600, 50)).toEqual({ k: 1, x: 300, y: 200 });
    const small = fit(content, 300, 300, 50);
    expect(small.k).toBeCloseTo(0.5);
    expect(small.x).toBeCloseTo(50);
    expect(small.y).toBeCloseTo(100);
    expect(fit(content, 100, 100, 50).k).toBe(ZOOM.min);
  });

  it('zooms around the pointer and within the limits', () => {
    const view = zoomAt({ x: 0, y: 0, k: 1 }, 100, 100, 2);
    expect(view).toEqual({ k: 2, x: -100, y: -100 });
    // The world point under the pointer stays there.
    expect((100 - view.x) / view.k).toBe(100);
    expect(zoomAt(view, 0, 0, 10).k).toBe(ZOOM.max);
  });

  it('routes level boxes with a straight line, two lanes apart', () => {
    const a = { x: 0, y: 0, w: 100, h: 100 };
    const b = { x: 200, y: 0, w: 100, h: 100 };
    const there = route(a, b, -10);
    const back = route(b, a, 10);
    expect(there.points).toEqual([
      [100, 40],
      [200, 40],
    ]);
    expect(back.points).toEqual([
      [200, 60],
      [100, 60],
    ]);
    expect(there.label).toEqual([150, 40]);
    // The head points along the line, at its end.
    expect(there.head[0]).toEqual([200, 40]);
    expect(there.head[1]?.[0]).toBeLessThan(200);
  });

  it('routes boxes that are not level with one elbow, and stacked boxes vertically', () => {
    const elbow = route({ x: 0, y: 0, w: 100, h: 50 }, { x: 200, y: 200, w: 100, h: 50 }, 0);
    expect(elbow.points).toEqual([
      [100, 25],
      [150, 25],
      [150, 225],
      [200, 225],
    ]);
    const stacked = route({ x: 0, y: 0, w: 100, h: 50 }, { x: 0, y: 150, w: 100, h: 50 }, 0);
    expect(stacked.points[0]).toEqual([50, 50]);
    expect(stacked.points[stacked.points.length - 1]).toEqual([50, 150]);
  });
});
