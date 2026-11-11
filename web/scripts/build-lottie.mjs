// Generates Payday's Lottie animations into src/lottie/. Run: pnpm lottie
//
// The animations are authored here as code so they stay original, small and editable.
// Layers carry a CSS class (`cl`) and globals.css recolours them from the theme tokens;
// the colours baked in below are only the fallback.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "lottie");
const FPS = 60;
const GREEN = [0.04, 0.41, 0.28, 1];
const INK = [0.06, 0.12, 0.1, 1];
const LINE = [0.6, 0.62, 0.58, 1];

const EASE_OUT = { o: [0.2, 0], i: [0.2, 1] };
const EASE_IN_OUT = { o: [0.45, 0], i: [0.55, 1] };
const LINEAR = { o: [0, 0], i: [1, 1] };

const still = (k) => ({ a: 0, k });

/** frames: [time, value, ease?]; the ease describes the segment that starts at that frame. */
function animated(frames) {
  const k = frames.map(([t, value, ease = EASE_IN_OUT], index) => {
    const s = Array.isArray(value) ? value : [value];
    if (index === frames.length - 1) return { t, s };
    return { t, s, o: { x: [ease.o[0]], y: [ease.o[1]] }, i: { x: [ease.i[0]], y: [ease.i[1]] } };
  });
  return { a: 1, k };
}

const groupTransform = { ty: "tr", p: still([0, 0]), a: still([0, 0]), s: still([100, 100]), r: still(0), o: still(100) };
const group = (...items) => ({ ty: "gr", it: [...items, groupTransform] });

const ellipse = (size, at = [0, 0]) => ({ ty: "el", p: still(at), s: still([size, size]) });
const rect = (w, h, radius) => ({ ty: "rc", p: still([0, 0]), s: still([w, h]), r: still(radius) });
const polyline = (points) => ({
  ty: "sh",
  ks: still({ c: false, v: points, i: points.map(() => [0, 0]), o: points.map(() => [0, 0]) }),
});
const fill = (color) => ({ ty: "fl", c: still(color), o: still(100), r: 1 });
const stroke = (color, width) => ({ ty: "st", c: still(color), o: still(100), w: still(width), lc: 2, lj: 2 });
const trim = (end) => ({ ty: "tm", s: still(0), e: end, o: still(0), m: 1 });

let nextIndex = 1;

function layer({ name, cl, shapes, position = [0, 0], scale, opacity, frames }) {
  return {
    ddd: 0,
    ind: nextIndex++,
    ty: 4,
    nm: name,
    cl,
    sr: 1,
    ks: {
      o: opacity ?? still(100),
      r: still(0),
      p: Array.isArray(position) ? still([...position, 0]) : position,
      a: still([0, 0, 0]),
      s: scale ?? still([100, 100, 100]),
    },
    ao: 0,
    shapes,
    ip: 0,
    op: frames,
    st: 0,
    bm: 0,
  };
}

function composition({ name, width, height, frames, layers }) {
  return { v: "5.9.0", fr: FPS, ip: 0, op: frames, w: width, h: height, nm: name, ddd: 0, assets: [], layers };
}

/**
 * A looping event that starts at `start` may run past the last frame. A twin shifted back
 * one loop length covers the part that wraps around, so the loop has no seam.
 */
function looped(start, duration, loopFrames, make) {
  const layers = [make(start)];
  if (start + duration > loopFrames) layers.push(make(start - loopFrames));
  return layers;
}

// --- flow: salary moving employer -> Payday -> three workers --------------------------

function flow() {
  nextIndex = 1;
  const frames = 180;
  const employer = [70, 100];
  const hub = [300, 100];
  const workers = [
    [530, 36],
    [530, 100],
    [530, 164],
  ];
  const JOURNEY = 96;
  const DOT_EVERY = 30;

  const dots = [];
  for (let n = 0; n < frames / DOT_EVERY; n++) {
    const worker = workers[n % workers.length];
    dots.push(
      ...looped(n * DOT_EVERY, JOURNEY, frames, (t0) =>
        layer({
          name: `dot ${n}`,
          cl: "lt-fill-accent",
          frames,
          shapes: [group(ellipse(12), fill(GREEN))],
          position: animated([
            [t0, [employer[0] + 34, employer[1], 0], EASE_IN_OUT],
            [t0 + 44, [hub[0], hub[1], 0], EASE_IN_OUT],
            [t0 + JOURNEY, [worker[0] - 22, worker[1], 0]],
          ]),
          opacity: animated([
            [t0, 0, LINEAR],
            [t0 + 6, 100, LINEAR],
            [t0 + JOURNEY - 8, 100, LINEAR],
            [t0 + JOURNEY, 0],
          ]),
        }),
      ),
    );
  }

  const hubPulse = animated([
    [0, [100, 100, 100]],
    [45, [108, 108, 100]],
    [90, [100, 100, 100]],
    [135, [108, 108, 100]],
    [180, [100, 100, 100]],
  ]);

  const workerNodes = workers.map((at, n) =>
    layer({
      name: `worker ${n}`,
      cl: "lt-stroke-ink",
      frames,
      position: at,
      shapes: [group(ellipse(34), stroke(INK, 2.5))],
    }),
  );

  const wires = layer({
    name: "wires",
    cl: "lt-stroke-line",
    frames,
    shapes: [
      group(polyline([[employer[0] + 30, employer[1]], [hub[0] - 34, hub[1]]]), stroke(LINE, 2)),
      ...workers.map((at) => group(polyline([[hub[0] + 34, hub[1]], [at[0] - 20, at[1]]]), stroke(LINE, 2))),
    ],
  });

  return composition({
    name: "flow",
    width: 600,
    height: 200,
    frames,
    layers: [
      layer({ name: "hub core", cl: "lt-fill-bg", frames, position: hub, scale: hubPulse, shapes: [group(ellipse(20), fill([0.96, 0.95, 0.91, 1]))] }),
      layer({ name: "hub", cl: "lt-fill-accent", frames, position: hub, scale: hubPulse, shapes: [group(ellipse(60), fill(GREEN))] }),
      ...dots,
      layer({ name: "employer", cl: "lt-stroke-ink", frames, position: employer, shapes: [group(rect(52, 52, 14), stroke(INK, 2.5))] }),
      ...workerNodes,
      wires,
    ],
  });
}

// --- success: a ring and a tick drawing themselves, with a short burst ----------------

function success() {
  nextIndex = 1;
  const frames = 54;
  const center = [60, 60];
  const rays = Array.from({ length: 8 }, (_, n) => {
    const angle = (n * Math.PI) / 4;
    const from = [Math.cos(angle) * 40, Math.sin(angle) * 40];
    const to = [Math.cos(angle) * 52, Math.sin(angle) * 52];
    return group(polyline([from, to]), stroke(GREEN, 3));
  });

  return composition({
    name: "success",
    width: 120,
    height: 120,
    frames,
    layers: [
      layer({
        name: "tick",
        cl: "lt-stroke-accent",
        frames,
        position: center,
        shapes: [group(polyline([[-14, 1], [-4, 11], [15, -10]]), trim(animated([[16, 0, EASE_OUT], [34, 100]])), stroke(GREEN, 5))],
      }),
      layer({
        name: "ring",
        cl: "lt-stroke-accent",
        frames,
        position: center,
        shapes: [group(ellipse(64), trim(animated([[0, 0, EASE_OUT], [24, 100]])), stroke(GREEN, 4))],
      }),
      layer({
        name: "burst",
        cl: "lt-stroke-accent",
        frames,
        position: center,
        shapes: rays,
        scale: animated([[20, [70, 70, 100], EASE_OUT], [44, [112, 112, 100]]]),
        opacity: animated([[20, 0, LINEAR], [26, 100, LINEAR], [36, 100, LINEAR], [46, 0]]),
      }),
    ],
  });
}

// --- waiting: ripples around a still point, for empty states --------------------------

function waiting() {
  nextIndex = 1;
  const frames = 150;
  const center = [80, 60];
  const RIPPLE = 110;

  const ripples = [0, 50, 100].flatMap((start, n) =>
    looped(start, RIPPLE, frames, (t0) =>
      layer({
        name: `ripple ${n}`,
        cl: "lt-stroke-accent",
        frames,
        position: center,
        shapes: [group(ellipse(40), stroke(GREEN, 2))],
        scale: animated([[t0, [40, 40, 100], EASE_OUT], [t0 + RIPPLE, [240, 240, 100]]]),
        opacity: animated([[t0, 0, LINEAR], [t0 + 12, 55, EASE_OUT], [t0 + RIPPLE, 0]]),
      }),
    ),
  );

  return composition({
    name: "waiting",
    width: 160,
    height: 120,
    frames,
    layers: [
      layer({
        name: "point",
        cl: "lt-fill-accent",
        frames,
        position: center,
        shapes: [group(ellipse(14), fill(GREEN))],
        scale: animated([[0, [100, 100, 100]], [75, [118, 118, 100]], [150, [100, 100, 100]]]),
      }),
      ...ripples,
    ],
  });
}

mkdirSync(OUT_DIR, { recursive: true });
for (const [name, build] of Object.entries({ flow, success, waiting })) {
  const file = join(OUT_DIR, `${name}.json`);
  writeFileSync(file, `${JSON.stringify(build())}\n`);
  console.log(`wrote ${file}`);
}
