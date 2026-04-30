/**
 * ═══════════════════════════════════════════════════════════════
 *  URBS — MathEngine.js
 *  Module 2 of 6
 *
 *  Responsibilities:
 *    • ALL coordinate mathematics — zero canvas context calls here.
 *    • Manual World→Screen and Screen→World transforms using
 *      explicit algebraic formulas. No ctx.scale/translate/rotate.
 *    • Cubic & Quadratic Bézier evaluation, sampling, arc-length
 *      parameterisation (Look-Up Table approach for uniform speed).
 *    • Linear Interpolation (Lerp) and its variants (SmoothStep,
 *      Hermite, angular).
 *    • 2D vector primitives (add, sub, scale, dot, cross, normalise,
 *      perp, magnitude, distance, angle).
 *    • AABB (Axis-Aligned Bounding Box) construction and overlap test
 *      used by the Renderer for viewport clipping.
 *    • Prim's MST helper: Euclidean distance heuristic.
 *    • A* helper: geometric distance along sampled curve segments.
 *
 *  Contract:
 *    • PURE functions only — no side effects, no global mutation.
 *    • Every function is documented with param/return types.
 *    • No external dependencies, no canvas context.
 * ═══════════════════════════════════════════════════════════════
 */

const MathEngine = (() => {

  // ─────────────────────────────────────────────────────────────
  // 1. CONSTANTS
  // ─────────────────────────────────────────────────────────────

  const TAU      = Math.PI * 2;
  const HALF_PI  = Math.PI / 2;
  const DEG2RAD  = Math.PI / 180;
  const RAD2DEG  = 180 / Math.PI;
  const EPSILON  = 1e-9;

  // Number of samples used to build Bezier arc-length LUT
  const BEZIER_LUT_SAMPLES = 64;

  // ─────────────────────────────────────────────────────────────
  // 2. WORLD <-> SCREEN TRANSFORMS
  //    cameraX/Y = world-space coordinate at viewport TOP-LEFT.
  //    zoomLevel = screen pixels per world unit.
  //
  //    World -> Screen:
  //      sx = (wx - cameraX) * zoomLevel
  //      sy = (wy - cameraY) * zoomLevel
  //
  //    Screen -> World:
  //      wx = sx / zoomLevel + cameraX
  //      wy = sy / zoomLevel + cameraY
  // ─────────────────────────────────────────────────────────────

  /**
   * Convert a single world-space point to screen-space.
   * @param {number} wx   World X
   * @param {number} wy   World Y
   * @param {object} cam  { x, y, zoomLevel }
   * @returns {{ x: number, y: number }}
   */
  function worldToScreen(wx, wy, cam) {
    return {
      x: wx,
      y: wy,
    };
  }

  /**
   * Convert a screen-space point to world-space.
   * @param {number} sx
   * @param {number} sy
   * @param {object} cam  { x, y, zoomLevel }
   * @returns {{ x: number, y: number }}
   */
  function screenToWorld(sx, sy, cam) {
    return {
      x: sx / cam.zoomLevel + cam.x,
      y: sy / cam.zoomLevel + cam.y,
    };
  }

  /**
   * Scale a world-space length (e.g. road width) to screen pixels.
   * @param {number} worldLen
   * @param {number} zoomLevel
   * @returns {number}
   */
  function worldLenToScreen(worldLen, zoomLevel) {
    return worldLen;
  }

  /**
   * Transform an array of world points to screen space in one pass.
   * Returns a new array — does not mutate input.
   * @param {Array<{x,y}>} points
   * @param {object} cam
   * @returns {Array<{x,y}>}
   */
  function worldPointsToScreen(points, cam) {
    const out = new Array(points.length);
    for (let i = 0; i < points.length; i++) {
      out[i] = worldToScreen(points[i].x, points[i].y, cam);
    }
    return out;
  }

  // ─────────────────────────────────────────────────────────────
  // 3. 2D VECTOR PRIMITIVES
  //    All return new objects — pure, no mutation.
  // ─────────────────────────────────────────────────────────────

  const Vec2 = Object.freeze({

    create:   (x, y) => ({ x, y }),
    add:      (a, b) => ({ x: a.x + b.x, y: a.y + b.y }),
    sub:      (a, b) => ({ x: a.x - b.x, y: a.y - b.y }),
    scale:    (v, s) => ({ x: v.x * s,   y: v.y * s   }),
    mul:      (a, b) => ({ x: a.x * b.x, y: a.y * b.y }),
    dot:      (a, b) => a.x * b.x + a.y * b.y,
    cross:    (a, b) => a.x * b.y - a.y * b.x,
    magSq:    (v)    => v.x * v.x + v.y * v.y,
    mag:      (v)    => Math.sqrt(v.x * v.x + v.y * v.y),

    dist: (a, b) => {
      const dx = a.x - b.x, dy = a.y - b.y;
      return Math.sqrt(dx * dx + dy * dy);
    },

    distSq: (a, b) => {
      const dx = a.x - b.x, dy = a.y - b.y;
      return dx * dx + dy * dy;
    },

    normalise: (v) => {
      const m = Math.sqrt(v.x * v.x + v.y * v.y);
      if (m < EPSILON) return { x: 0, y: 0 };
      return { x: v.x / m, y: v.y / m };
    },

    perp:    (v)    => ({ x: -v.y, y:  v.x }),
    perpCW:  (v)    => ({ x:  v.y, y: -v.x }),
    angle:   (v)    => Math.atan2(v.y, v.x),
    angleTo: (a, b) => Math.atan2(b.y - a.y, b.x - a.x),

    lerp: (a, b, t) => ({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
    }),

    reflect: (v, n) => {
      const d = 2 * (v.x * n.x + v.y * n.y);
      return { x: v.x - d * n.x, y: v.y - d * n.y };
    },

    clamp: (v, min, max) => ({
      x: Math.max(min, Math.min(max, v.x)),
      y: Math.max(min, Math.min(max, v.y)),
    }),
  });

  // ─────────────────────────────────────────────────────────────
  // 4. SCALAR INTERPOLATION & EASING
  // ─────────────────────────────────────────────────────────────

  function lerp(a, b, t)          { return a + (b - a) * t; }

  function invLerp(a, b, v) {
    const d = b - a;
    return Math.abs(d) < EPSILON ? 0 : (v - a) / d;
  }

  function remap(v, inA, inB, outA, outB) {
    return lerp(outA, outB, invLerp(inA, inB, v));
  }

  function smoothStep(t) {
    const c = Math.max(0, Math.min(1, t));
    return c * c * (3 - 2 * c);
  }

  function smootherStep(t) {
    const c = Math.max(0, Math.min(1, t));
    return c * c * c * (c * (c * 6 - 15) + 10);
  }

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  function lerpAngle(a, b, t) {
    let diff = ((b - a) % TAU + TAU) % TAU;
    if (diff > Math.PI) diff -= TAU;
    return a + diff * t;
  }

  // ─────────────────────────────────────────────────────────────
  // 5. BEZIER CURVES
  //
  //    BezierDef objects:
  //      Quadratic: { type: 'Q', p0, cp, p1 }
  //      Cubic:     { type: 'C', p0, cp1, cp2, p1 }
  // ─────────────────────────────────────────────────────────────

  // -- 5a. Raw point evaluation --

  function quadBezierPoint(p0, cp, p1, t) {
    const mt = 1 - t, mt2 = mt * mt, t2 = t * t;
    return {
      x: mt2 * p0.x + 2 * mt * t * cp.x + t2 * p1.x,
      y: mt2 * p0.y + 2 * mt * t * cp.y + t2 * p1.y,
    };
  }

  function cubicBezierPoint(p0, cp1, cp2, p1, t) {
    const mt = 1 - t, mt2 = mt * mt, mt3 = mt2 * mt;
    const t2 = t * t, t3 = t2 * t;
    return {
      x: mt3 * p0.x + 3 * mt2 * t * cp1.x + 3 * mt * t2 * cp2.x + t3 * p1.x,
      y: mt3 * p0.y + 3 * mt2 * t * cp1.y + 3 * mt * t2 * cp2.y + t3 * p1.y,
    };
  }

  function bezierPoint(curve, t) {
    return curve.type === 'Q'
      ? quadBezierPoint(curve.p0, curve.cp, curve.p1, t)
      : cubicBezierPoint(curve.p0, curve.cp1, curve.cp2, curve.p1, t);
  }

  // -- 5b. Tangent (first derivative) --

  function quadBezierTangent(p0, cp, p1, t) {
    const mt = 1 - t;
    return {
      x: 2 * mt * (cp.x - p0.x) + 2 * t * (p1.x - cp.x),
      y: 2 * mt * (cp.y - p0.y) + 2 * t * (p1.y - cp.y),
    };
  }

  function cubicBezierTangent(p0, cp1, cp2, p1, t) {
    const mt = 1 - t, mt2 = mt * mt, t2 = t * t;
    return {
      x: 3 * mt2 * (cp1.x - p0.x) + 6 * mt * t * (cp2.x - cp1.x) + 3 * t2 * (p1.x - cp2.x),
      y: 3 * mt2 * (cp1.y - p0.y) + 6 * mt * t * (cp2.y - cp1.y) + 3 * t2 * (p1.y - cp2.y),
    };
  }

  function bezierTangent(curve, t) {
    const raw = curve.type === 'Q'
      ? quadBezierTangent(curve.p0, curve.cp,  curve.p1, t)
      : cubicBezierTangent(curve.p0, curve.cp1, curve.cp2, curve.p1, t);
    return Vec2.normalise(raw);
  }

  // -- 5c. Arc-Length LUT --

  function buildBezierLUT(curve, n) {
    n = n || BEZIER_LUT_SAMPLES;
    const lut  = new Array(n + 1);
    let total  = 0;
    let prev   = bezierPoint(curve, 0);
    lut[0]     = { t: 0, arcLen: 0 };

    for (let i = 1; i <= n; i++) {
      const t    = i / n;
      const curr = bezierPoint(curve, t);
      const dx   = curr.x - prev.x;
      const dy   = curr.y - prev.y;
      total     += Math.sqrt(dx * dx + dy * dy);
      lut[i]     = { t, arcLen: total };
      prev       = curr;
    }
    return lut;
  }

  function lutToT(lut, targetLen) {
    const total = lut[lut.length - 1].arcLen;
    if (targetLen <= 0)     return 0;
    if (targetLen >= total) return 1;

    let lo = 0, hi = lut.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >>> 1;
      if (lut[mid].arcLen < targetLen) lo = mid;
      else                             hi = mid;
    }
    const span = lut[hi].arcLen - lut[lo].arcLen;
    const frac = span < EPSILON ? 0 : (targetLen - lut[lo].arcLen) / span;
    return lut[lo].t + frac * (lut[hi].t - lut[lo].t);
  }

  function lutTotalLength(lut) {
    return lut[lut.length - 1].arcLen;
  }

  function bezierPointAtDist(curve, lut, dist) {
    return bezierPoint(curve, lutToT(lut, dist));
  }

  function bezierTangentAtDist(curve, lut, dist) {
    return bezierTangent(curve, lutToT(lut, dist));
  }

  // -- 5d. Bounding Boxes --

  function quadBezierAABB(p0, cp, p1) {
    let minX = Math.min(p0.x, p1.x), maxX = Math.max(p0.x, p1.x);
    let minY = Math.min(p0.y, p1.y), maxY = Math.max(p0.y, p1.y);

    const dxD = p0.x - 2 * cp.x + p1.x;
    if (Math.abs(dxD) > EPSILON) {
      const tx = (p0.x - cp.x) / dxD;
      if (tx > 0 && tx < 1) {
        const qx = quadBezierPoint(p0, cp, p1, tx).x;
        minX = Math.min(minX, qx); maxX = Math.max(maxX, qx);
      }
    }
    const dyD = p0.y - 2 * cp.y + p1.y;
    if (Math.abs(dyD) > EPSILON) {
      const ty = (p0.y - cp.y) / dyD;
      if (ty > 0 && ty < 1) {
        const qy = quadBezierPoint(p0, cp, p1, ty).y;
        minY = Math.min(minY, qy); maxY = Math.max(maxY, qy);
      }
    }
    return { minX, minY, maxX, maxY };
  }

  function cubicBezierAABB(p0, cp1, cp2, p1) {
    let minX = Math.min(p0.x, p1.x), maxX = Math.max(p0.x, p1.x);
    let minY = Math.min(p0.y, p1.y), maxY = Math.max(p0.y, p1.y);

    function addExtrema(v0, v1, v2, v3, isX) {
      const a = -3*v0 + 9*v1 - 9*v2 + 3*v3;
      const b =  6*v0 - 12*v1 + 6*v2;
      const c = -3*v0 + 3*v1;
      const checkT = (t) => {
        if (t <= 0 || t >= 1) return;
        const pt = cubicBezierPoint(p0, cp1, cp2, p1, t);
        const v  = isX ? pt.x : pt.y;
        if (isX) { minX = Math.min(minX, v); maxX = Math.max(maxX, v); }
        else      { minY = Math.min(minY, v); maxY = Math.max(maxY, v); }
      };
      if (Math.abs(a) < EPSILON) {
        if (Math.abs(b) > EPSILON) checkT(-c / b);
        return;
      }
      const disc = b*b - 4*a*c;
      if (disc < 0) return;
      const sq = Math.sqrt(disc);
      checkT((-b + sq) / (2*a));
      checkT((-b - sq) / (2*a));
    }

    addExtrema(p0.x, cp1.x, cp2.x, p1.x, true);
    addExtrema(p0.y, cp1.y, cp2.y, p1.y, false);
    return { minX, minY, maxX, maxY };
  }

  function bezierAABB(curve) {
    return curve.type === 'Q'
      ? quadBezierAABB(curve.p0, curve.cp, curve.p1)
      : cubicBezierAABB(curve.p0, curve.cp1, curve.cp2, curve.p1);
  }

  // -- 5e. Sampling --

  function sampleBezier(curve, n) {
    n = n || 24;
    const pts = new Array(n + 1);
    for (let i = 0; i <= n; i++) pts[i] = bezierPoint(curve, i / n);
    return pts;
  }

  // ─────────────────────────────────────────────────────────────
  // 6. AABB UTILITIES
  // ─────────────────────────────────────────────────────────────

  function aabbOverlap(a, b) {
    return a.minX <= b.maxX && a.maxX >= b.minX &&
           a.minY <= b.maxY && a.maxY >= b.minY;
  }

  function aabbExpand(aabb, margin) {
    return {
      minX: aabb.minX - margin, minY: aabb.minY - margin,
      maxX: aabb.maxX + margin, maxY: aabb.maxY + margin,
    };
  }

  function pointsToAABB(pts) {
    let minX =  Infinity, minY =  Infinity;
    let maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY };
  }

  function aabbContainsPoint(aabb, pt) {
    return pt.x >= aabb.minX && pt.x <= aabb.maxX &&
           pt.y >= aabb.minY && pt.y <= aabb.maxY;
  }

  // ─────────────────────────────────────────────────────────────
  // 7. GRAPH / PATHFINDING HELPERS
  // ─────────────────────────────────────────────────────────────

  function nodeDistance(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function aStarHeuristic(a, b) { return nodeDistance(a, b); }

  function edgeCost(edge, fromNode, toNode) {
    if (edge.length    !== undefined) return edge.length;
    if (edge.lut       !== undefined) return lutTotalLength(edge.lut);
    return nodeDistance(fromNode, toNode);
  }

  // ─────────────────────────────────────────────────────────────
  // 8. CONTROL POINT GENERATION
  // ─────────────────────────────────────────────────────────────

  /**
   * Midpoint-perpendicular control point — core curve generation tool.
   * @param {{ x,y }} p0
   * @param {{ x,y }} p1
   * @param {number}  offset  Perpendicular displacement (world units)
   * @returns {{ x,y }}
   */
  function midpointCP(p0, p1, offset) {
    const mid  = { x: (p0.x + p1.x) * 0.5, y: (p0.y + p1.y) * 0.5 };
    const dir  = Vec2.normalise(Vec2.sub(p1, p0));
    const perp = Vec2.perp(dir);
    return { x: mid.x + perp.x * offset, y: mid.y + perp.y * offset };
  }

  /**
   * Two cubic control points routed through a via guide point.
   */
  function viaPointCPs(p0, via, p1, tension) {
    tension = tension !== undefined ? tension : 0.5;
    return {
      cp1: { x: p0.x + (via.x - p0.x) * tension, y: p0.y + (via.y - p0.y) * tension },
      cp2: { x: p1.x + (via.x - p1.x) * tension, y: p1.y + (via.y - p1.y) * tension },
    };
  }

  /**
   * Catmull-Rom to cubic Bezier conversion.
   * @param {number} alpha  0=uniform, 0.5=centripetal, 1=chordal
   */
  function catmullRomToBezierCPs(p0, p1, p2, p3, alpha) {
    alpha = alpha !== undefined ? alpha : 0.5;
    return {
      cp1: { x: p1.x + (p2.x - p0.x) * alpha, y: p1.y + (p2.y - p0.y) * alpha },
      cp2: { x: p2.x - (p3.x - p1.x) * alpha, y: p2.y - (p3.y - p1.y) * alpha },
    };
  }

  // ─────────────────────────────────────────────────────────────
  // 9. VEHICLE POSE ON PATH
  // ─────────────────────────────────────────────────────────────

  /**
   * Compute vehicle position + heading at arc-length distance along
   * a sequence of edges (each with a pre-built LUT).
   *
   * @param {Array<{curve, lut}>} pathEdges
   * @param {number}              totalDistance
   * @returns {{ x, y, angle, edgeIdx, localDist } | null}
   */
  function vehiclePoseOnPath(pathEdges, totalDistance) {
    let remaining = totalDistance;
    for (let i = 0; i < pathEdges.length; i++) {
      const edge = pathEdges[i];
      const len  = lutTotalLength(edge.lut);
      if (remaining <= len || i === pathEdges.length - 1) {
        const d   = Math.min(remaining, len);
        const pos = bezierPointAtDist(edge.curve, edge.lut, d);
        const tan = bezierTangentAtDist(edge.curve, edge.lut, d);
        return { x: pos.x, y: pos.y, angle: Math.atan2(tan.y, tan.x), edgeIdx: i, localDist: d };
      }
      remaining -= len;
    }
    return null;
  }

  function pathTotalLength(pathEdges) {
    let total = 0;
    for (const e of pathEdges) total += lutTotalLength(e.lut);
    return total;
  }

  // ─────────────────────────────────────────────────────────────
  // 10. SEEDED PRNG  (Mulberry32)
  // ─────────────────────────────────────────────────────────────

  function seededRandom(seed) {
    let s = seed >>> 0;
    return function () {
      s  += 0x6D2B79F5;
      let t = s;
      t  = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function rngRange(rng, min, max) { return min + rng() * (max - min); }
  function rngInt(rng, min, max)   { return Math.floor(rngRange(rng, min, max + 1)); }

  function rngShuffle(rng, arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }

  // ─────────────────────────────────────────────────────────────
  // 11. RENDERER HELPERS
  // ─────────────────────────────────────────────────────────────

  /**
   * World-space Bezier -> screen-space polyline, with AABB clip.
   * Returns null if curve is outside viewport.
   *
   * @param {object}               curve
   * @param {object}               cam         { x, y, zoomLevel }
   * @param {{ minX,minY,maxX,maxY }} viewAABB  World-space viewport
   * @param {number}               segments
   * @param {number}               roadWidth   World-unit margin for AABB test
   * @returns {Array<{x,y}> | null}
   */
  function curveToScreenPolyline(curve, cam, viewAABB, segments, roadWidth) {
    segments  = segments  || 20;
    roadWidth = roadWidth || 0;
    const aabb     = bezierAABB(curve);
    const expanded = roadWidth > 0 ? aabbExpand(aabb, roadWidth) : aabb;
    if (!aabbOverlap(expanded, viewAABB)) return null;
    return worldPointsToScreen(sampleBezier(curve, segments), cam);
  }

  /**
   * Adaptive segment count — fewer segments when curve is tiny on screen.
   * @param {object} curve
   * @param {number} zoomLevel
   * @returns {number}  [4, 40]
   */
  function adaptiveSegments(curve, zoomLevel) {
    const aabb      = bezierAABB(curve);
    const worldSpan = Math.max(aabb.maxX - aabb.minX, aabb.maxY - aabb.minY);
    const screenPx  = worldSpan * zoomLevel;
    return Math.max(4, Math.min(40, Math.ceil(screenPx / 8)));
  }

  // ─────────────────────────────────────────────────────────────
  // 12. PUBLIC API
  // ─────────────────────────────────────────────────────────────
  return Object.freeze({
    // Constants
    TAU, HALF_PI, DEG2RAD, RAD2DEG, EPSILON,

    // Transforms
    worldToScreen,
    screenToWorld,
    worldLenToScreen,
    worldPointsToScreen,

    // Vectors
    Vec2,

    // Scalar math
    lerp, invLerp, remap,
    smoothStep, smootherStep,
    clamp, lerpAngle,

    // Bezier evaluation
    quadBezierPoint, cubicBezierPoint, bezierPoint,
    bezierTangent, sampleBezier,

    // Arc-length LUT
    buildBezierLUT, lutToT, lutTotalLength,
    bezierPointAtDist, bezierTangentAtDist,

    // Bounding boxes
    bezierAABB, quadBezierAABB, cubicBezierAABB,

    // AABB utils
    aabbOverlap, aabbExpand, pointsToAABB, aabbContainsPoint,

    // Graph
    nodeDistance, aStarHeuristic, edgeCost,

    // Control points
    midpointCP, viaPointCPs, catmullRomToBezierCPs,

    // Vehicle animation
    vehiclePoseOnPath, pathTotalLength,

    // RNG
    seededRandom, rngRange, rngInt, rngShuffle,

    // Renderer helpers
    curveToScreenPolyline, adaptiveSegments,
  });

})();
