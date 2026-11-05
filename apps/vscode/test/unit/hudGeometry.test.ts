import { describe, expect, it } from 'vitest';
import { arc, dial, gauge, HUD, label, limit, point, R, steps } from '../../webview/hudGeometry.js';

const majors = (path: string) => path.split('M').filter(Boolean).length;

describe('hud geometry', () => {
  it('places the arcs toward the composer on both sides', () => {
    // Left: the circle's centre is to the right, its arc near the right edge of the view.
    const [lx, ly] = point('left', R.dial, 0);
    expect(lx).toBeCloseTo(186);
    expect(ly).toBe(HUD.cy);
    // Right: mirrored, near the left edge.
    const [rx] = point('right', R.dial, 0);
    expect(rx).toBeCloseTo(30);
  });

  it('keeps every arc inside the view height', () => {
    const span = limit(R.bezel);
    const [, top] = point('left', R.bezel, -span);
    const [, bottom] = point('left', R.bezel, span);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(bottom).toBeLessThanOrEqual(HUD.height);
  });

  it('draws one major tick per item on the dial, the selected one in the middle', () => {
    expect(majors(dial('left', 0, 2).major)).toBe(2);
    const at = label('left', 1, 1);
    expect(at.y).toBeCloseTo(HUD.cy);
    expect(at.visible).toBe(true);
    expect(label('left', 9, 0).visible).toBe(false);
  });

  it('fills a gauge and its steps from the bottom up', () => {
    expect(gauge('right', R.outer, 0)).toBe('');
    expect(gauge('right', R.outer, 1)).toBe(arc('right', R.outer, -30, 30));
    const three = steps('left', R.outer, 3, 1.5);
    expect(three.off.split('M').filter(Boolean)).toHaveLength(3);
    expect(three.on.split('M').filter(Boolean)).toHaveLength(2);
  });
});
