import { describe, expect, it } from 'vitest';
import { brokenLines, latticeLines } from '../../webview/latticeGeometry.js';

describe('latticeLines', () => {
  it('draws a shared edge once and merges collinear segments', () => {
    // Two cells side by side over one wide cell: 200 × 100.
    const lines = latticeLines(
      [
        { x0: 0, y0: 0, x1: 100, y1: 50 },
        { x0: 100, y0: 0, x1: 200, y1: 50 },
        { x0: 0, y0: 50, x1: 200, y1: 100 },
      ],
      200,
      100,
    );
    expect(lines.horizontal).toEqual([
      { at: 0, from: 0, to: 200 },
      { at: 50, from: 0, to: 200 },
      { at: 100, from: 0, to: 200 },
    ]);
    expect(lines.vertical).toEqual([
      { at: 0, from: 0, to: 100 },
      { at: 100, from: 0, to: 50 },
      { at: 200, from: 0, to: 100 },
    ]);
  });

  it('treats edges a pixel apart as one line', () => {
    const lines = latticeLines(
      [
        { x0: 0, y0: 0, x1: 100, y1: 40 },
        { x0: 101, y0: 0, x1: 200, y1: 40 },
      ],
      200,
      40,
    );
    expect(lines.vertical.map((l) => l.at)).toEqual([0, 100, 200]);
  });

  it('puts nodes where lines meet the boundary, not inside', () => {
    const lines = latticeLines(
      [
        { x0: 0, y0: 0, x1: 100, y1: 50 },
        { x0: 100, y0: 0, x1: 200, y1: 50 },
        { x0: 0, y0: 50, x1: 200, y1: 100 },
      ],
      200,
      100,
    );
    const nodes = lines.nodes.map((n) => `${String(n.x)},${String(n.y)}`).sort();
    // Four corners, the inner vertical meeting the top, the middle line meeting both sides.
    expect(nodes).toEqual(['0,0', '0,100', '0,50', '100,0', '200,0', '200,100', '200,50'].sort());
  });

  it('skips cells with no area', () => {
    const lines = latticeLines([{ x0: 10, y0: 10, x1: 10, y1: 30 }], 100, 100);
    expect(lines.horizontal).toEqual([]);
    expect(lines.vertical).toEqual([]);
    expect(lines.nodes).toEqual([]);
  });
});

describe('brokenLines', () => {
  // Four cells of 100 × 100 in a 200 × 200 lattice: one junction in the middle.
  const four = [
    { x0: 0, y0: 0, x1: 100, y1: 100 },
    { x0: 100, y0: 0, x1: 200, y1: 100 },
    { x0: 0, y0: 100, x1: 100, y1: 200 },
    { x0: 100, y0: 100, x1: 200, y1: 200 },
  ];

  it('leaves the perimeter open and cuts the lines as far on both sides of a junction', () => {
    const broken = brokenLines(four, 200, 200);
    expect(broken.pluses).toEqual([{ x: 100, y: 100 }]);
    // Pixels 94 to 106 stay free: six on each side of pixel 100.
    expect(broken.segments).toEqual([
      { horizontal: true, at: 100, from: 0, to: 94 },
      { horizontal: true, at: 100, from: 107, to: 200 },
      { horizontal: false, at: 100, from: 0, to: 94 },
      { horizontal: false, at: 100, from: 107, to: 200 },
    ]);
  });

  it('cuts a corner the same on both axes, on the last pixel at the far edge', () => {
    const one = [{ x0: 0, y0: 0, x1: 200, y1: 100 }];
    const broken = brokenLines(one, 200, 100, {
      edges: { top: true, bottom: true, left: true, right: true },
    });
    expect(broken.pluses).toEqual([
      { x: 0, y: 0 },
      { x: 199, y: 0 },
      { x: 0, y: 99 },
      { x: 199, y: 99 },
    ]);
    expect(broken.segments).toEqual([
      { horizontal: true, at: 0, from: 7, to: 193 },
      { horizontal: true, at: 99, from: 7, to: 193 },
      { horizontal: false, at: 0, from: 7, to: 93 },
      { horizontal: false, at: 199, from: 7, to: 93 },
    ]);
  });

  it('keeps crowded junctions and the edges of an inverted cell plain', () => {
    const rows = [
      { x0: 0, y0: 0, x1: 100, y1: 20 },
      { x0: 100, y0: 0, x1: 200, y1: 20 },
      { x0: 0, y0: 20, x1: 100, y1: 40 },
      { x0: 100, y0: 20, x1: 200, y1: 40 },
    ];
    expect(brokenLines(rows, 200, 40, { edges: { top: true, bottom: true } }).pluses).toEqual([]);
    const whole = brokenLines(four, 200, 200, { whole: [{ x0: 0, y0: 0, x1: 100, y1: 100 }] });
    expect(whole.pluses).toEqual([]);
  });
});
