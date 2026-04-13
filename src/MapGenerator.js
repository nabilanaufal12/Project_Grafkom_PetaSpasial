/**
 * ═══════════════════════════════════════════════════════════════
 *  URBS — MapGenerator.js  |  Refactored Edition
 *
 *  KEY IMPROVEMENTS OVER PREVIOUS VERSION:
 *    1. Governors Island Teardrop shape — more faithful to real island
 *    2. Poisson Disk Sampling (Bridson's algorithm) — organic, evenly-
 *       spaced node placement with no clustering or large voids.
 *    3. Catmull-Rom splines for road curves — curves are computed using
 *       neighboring node positions so roads FLOW through intersections
 *       naturally (no abrupt direction changes).
 *    4. Iterative dead-end elimination — up to 6 passes until degree ≥ 2
 *       for every node.
 *    5. Seed-based 5-variation system — each seed produces a completely
 *       different road network while keeping the island boundary fixed.
 *
 *  OUTPUT: { nodes, edges, adjacency, buildings, trees, islandPoly }
 * ═══════════════════════════════════════════════════════════════
 */

const MapGenerator = (() => {

  // ── Config ────────────────────────────────────────────────────
  const CFG = Object.freeze({
    WORLD_W: 2000,
    WORLD_H: 1600,

    // Island half-extents (world units from centre)
    ISLAND_W: 830,
    ISLAND_H: 720,

    // ── Poisson Disk Sampling ──
    // minDist controls how many nodes are generated.
    // Smaller = more nodes, denser road network.
    PDS_MIN_DIST:     128,   // minimum separation between nodes (world units)
    PDS_MAX_ATTEMPTS: 30,    // Bridson samples per active point
    PDS_POLY_MARGIN:  32,    // min distance from coastline

    // ── Connectivity ──
    MIN_CONNECTIONS: 2,      // every node must have at least this many edges

    // ── Catmull-Rom → Cubic Bézier conversion ──
    // alpha = 1/6 gives standard tension-0 Catmull-Rom smoothness.
    // Increase toward 1/4 for tighter curves.
    CATMULL_ALPHA: 0.1667,

    // Small perpendicular jitter on CP for organic variety (world units)
    CATMULL_JITTER: 14,

    LUT_SAMPLES: 48,

    // ── Environment ──
    TREE_COUNT:       50,
    BUILDING_COUNT:   110,
    MIN_TREE_DIST:    48,
    MIN_BLDG_DIST:    52,
    ROAD_CLEAR_TREE:  44,
    ROAD_CLEAR_BLDG:  52,
    ROAD_SAMPLE_PTS:  16,
  });

  const CX = CFG.WORLD_W * 0.5;
  const CY = CFG.WORLD_H * 0.5;

  let _rng;
  const _r  = () => _rng();
  const _rr = (a, b) => MathEngine.rngRange(_rng, a, b);
  const _ri = (a, b) => MathEngine.rngInt(_rng, a, b);

  // ─────────────────────────────────────────────────────────────
  // 1. GOVERNORS ISLAND BOUNDARY
  //    Normalized control points (u ∈ [0,1] = west→east,
  //    v ∈ [0,1] = north→south) for the teardrop/keyhole shape.
  //    Wide rounded north half; narrow, pointed southwest tip.
  // ─────────────────────────────────────────────────────────────

  const ISLAND_CTRL = [
    // ─── Northern arc (top, widest part) ───
    [0.47, 0.04],   // top-centre
    [0.59, 0.03],   // top-right
    [0.71, 0.07],   // NE shoulder
    [0.82, 0.13],   // east upper
    [0.91, 0.21],   // far east upper
    [0.95, 0.32],   // far east (widest)
    [0.93, 0.43],   // east middle
    [0.90, 0.53],   // east lower
    // ─── Southeast and dock area ───
    [0.86, 0.62],   // SE
    [0.80, 0.70],   // south-east curve
    [0.72, 0.78],   // south
    // ─── South and SW narrows ───
    [0.61, 0.85],   // south-SW
    [0.49, 0.89],   // SW wide
    [0.37, 0.89],   // SW
    [0.25, 0.84],   // west-south
    [0.16, 0.76],   // west lower
    // ─── West side ───
    [0.10, 0.65],   // west middle
    [0.10, 0.53],   // west upper-middle
    [0.13, 0.41],   // west upper
    // ─── NW indent (characteristic Governors Island feature) ───
    [0.13, 0.30],   // NW lower (slight indent)
    [0.17, 0.19],   // NW upper
    // ─── Back to top ───
    [0.27, 0.10],   // north-left
    [0.37, 0.05],   // top-left
  ];

  /** Catmull-Rom spline evaluator (for island boundary interpolation) */
  function _catmullRom(p0, p1, p2, p3, t) {
    const t2 = t * t, t3 = t2 * t;
    return {
      x: 0.5 * ((2*p1.x) + (-p0.x+p2.x)*t +
         (2*p0.x-5*p1.x+4*p2.x-p3.x)*t2 +
         (-p0.x+3*p1.x-3*p2.x+p3.x)*t3),
      y: 0.5 * ((2*p1.y) + (-p0.y+p2.y)*t +
         (2*p0.y-5*p1.y+4*p2.y-p3.y)*t2 +
         (-p0.y+3*p1.y-3*p2.y+p3.y)*t3),
    };
  }

  function _buildIslandPoly() {
    const pts = ISLAND_CTRL.map(([u, v]) => ({
      x: CX + (u - 0.5) * CFG.ISLAND_W * 2,
      y: CY + (v - 0.5) * CFG.ISLAND_H * 2,
    }));
    const n     = pts.length;
    const STEPS = 9;          // finer interpolation for smoother coastline
    const poly  = [];
    for (let i = 0; i < n; i++) {
      const p0 = pts[(i - 1 + n) % n];
      const p1 = pts[i];
      const p2 = pts[(i + 1) % n];
      const p3 = pts[(i + 2) % n];
      for (let s = 0; s < STEPS; s++) {
        poly.push(_catmullRom(p0, p1, p2, p3, s / STEPS));
      }
    }
    return poly;
  }

  /** Ray-casting point-in-polygon test */
  function _pip(px, py, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y;
      const xj = poly[j].x, yj = poly[j].y;
      if (((yi > py) !== (yj > py)) &&
          px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)
        inside = !inside;
    }
    return inside;
  }

  /**
   * Returns true if (px, py) is inside poly AND farther than `margin`
   * from every polygon edge.
   */
  function _insideWithMargin(px, py, poly, margin) {
    if (!_pip(px, py, poly)) return false;
    const m2 = margin * margin;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const ax = poly[j].x, ay = poly[j].y;
      const bx = poly[i].x, by = poly[i].y;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx*dx + dy*dy;
      if (len2 < 1e-9) continue;
      const t  = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
      const ex = ax + t * dx - px, ey = ay + t * dy - py;
      if (ex*ex + ey*ey < m2) return false;
    }
    return true;
  }

  // ─────────────────────────────────────────────────────────────
  // 2. POISSON DISK SAMPLING  (Bridson's Algorithm, 2007)
  //    Generates a "blue noise" distribution — no clustering,
  //    no large voids — with minimum separation `minDist`.
  //    Each seed produces a completely different set of nodes.
  // ─────────────────────────────────────────────────────────────

  function _poissonDisk(poly, minDist) {
    const k        = CFG.PDS_MAX_ATTEMPTS;
    const margin   = CFG.PDS_POLY_MARGIN;
    const cellSize = minDist / Math.SQRT2;
    const minDist2 = minDist * minDist;

    // Compute polygon bounding box
    let bMinX =  Infinity, bMinY =  Infinity;
    let bMaxX = -Infinity, bMaxY = -Infinity;
    for (const p of poly) {
      if (p.x < bMinX) bMinX = p.x;  if (p.x > bMaxX) bMaxX = p.x;
      if (p.y < bMinY) bMinY = p.y;  if (p.y > bMaxY) bMaxY = p.y;
    }

    const gCols = Math.ceil((bMaxX - bMinX) / cellSize) + 2;
    const gRows = Math.ceil((bMaxY - bMinY) / cellSize) + 2;
    const grid  = new Int32Array(gCols * gRows).fill(-1);

    function _gIdx(x, y) {
      const c = Math.floor((x - bMinX) / cellSize);
      const r = Math.floor((y - bMinY) / cellSize);
      if (c < 0 || c >= gCols || r < 0 || r >= gRows) return -1;
      return r * gCols + c;
    }

    const samples = [];
    const active  = [];

    function _addSample(x, y) {
      const id = samples.length;
      samples.push({ x, y });
      active.push(id);
      const gi = _gIdx(x, y);
      if (gi >= 0) grid[gi] = id;
      return id;
    }

    // Find first valid seed point inside the island
    let seeded = false;
    for (let att = 0; att < 3000 && !seeded; att++) {
      const px = bMinX + _r() * (bMaxX - bMinX);
      const py = bMinY + _r() * (bMaxY - bMinY);
      if (_insideWithMargin(px, py, poly, margin)) {
        _addSample(px, py);
        seeded = true;
      }
    }
    if (!seeded) return [];

    // Main Bridson loop
    while (active.length > 0) {
      const ai  = Math.floor(_r() * active.length);
      const pid = active[ai];
      const par = samples[pid];
      let   placed = false;

      for (let attempt = 0; attempt < k; attempt++) {
        // Random point in annulus [minDist, 2·minDist]
        const angle = _r() * Math.PI * 2;
        const dist  = minDist * (1 + _r());
        const cx = par.x + Math.cos(angle) * dist;
        const cy = par.y + Math.sin(angle) * dist;

        if (!_insideWithMargin(cx, cy, poly, margin)) continue;

        // Check neighbouring grid cells for conflicts
        const gc = Math.floor((cx - bMinX) / cellSize);
        const gr = Math.floor((cy - bMinY) / cellSize);
        let tooClose = false;

        for (let dr = -2; dr <= 2 && !tooClose; dr++) {
          for (let dc = -2; dc <= 2 && !tooClose; dc++) {
            const nr = gr + dr, nc = gc + dc;
            if (nr < 0 || nr >= gRows || nc < 0 || nc >= gCols) continue;
            const ni = grid[nr * gCols + nc];
            if (ni < 0) continue;
            const s  = samples[ni];
            const dx = s.x - cx, dy = s.y - cy;
            if (dx*dx + dy*dy < minDist2) { tooClose = true; }
          }
        }

        if (!tooClose) {
          _addSample(cx, cy);
          placed = true;
          break;
        }
      }

      if (!placed) active.splice(ai, 1);
    }

    return samples;
  }

  // ─────────────────────────────────────────────────────────────
  // 3. PRIM'S MST
  // ─────────────────────────────────────────────────────────────

  function _primMST(nodes) {
    const n = nodes.length;
    if (n < 2) return [];
    const inMST = new Uint8Array(n);
    const key   = new Float64Array(n).fill(Infinity);
    const par   = new Int32Array(n).fill(-1);

    // Seed from node closest to island centre
    let seed = 0, best = Infinity;
    for (let i = 0; i < n; i++) {
      const dx = nodes[i].x - CX, dy = nodes[i].y - CY;
      const d = dx*dx + dy*dy;
      if (d < best) { best = d; seed = i; }
    }
    key[seed] = 0;

    for (let iter = 0; iter < n; iter++) {
      let u = -1, uk = Infinity;
      for (let i = 0; i < n; i++) if (!inMST[i] && key[i] < uk) { uk = key[i]; u = i; }
      if (u < 0) break;
      inMST[u] = 1;
      for (let v = 0; v < n; v++) {
        if (inMST[v]) continue;
        const dx = nodes[u].x - nodes[v].x, dy = nodes[u].y - nodes[v].y;
        const d  = Math.sqrt(dx*dx + dy*dy);
        if (d < key[v]) { key[v] = d; par[v] = u; }
      }
    }

    const edges = [];
    for (let v = 0; v < n; v++) if (par[v] >= 0) edges.push({ from: par[v], to: v });
    return edges;
  }

  // ─────────────────────────────────────────────────────────────
  // 4. ITERATIVE DEAD-END ELIMINATION
  //    Runs up to 6 passes. In each pass, any node with degree < 2
  //    gets connected to its nearest unconnected neighbour.
  //    Updating degree[target] in-pass ensures later iterations
  //    see the corrected connectivity.
  // ─────────────────────────────────────────────────────────────

  function _addExtraEdges(nodes, mstPairs) {
    const ek = (a, b) => a < b ? `${a},${b}` : `${b},${a}`;
    const set = new Set(mstPairs.map(p => ek(p.from, p.to)));

    const degree = new Int32Array(nodes.length);
    for (const { from, to } of mstPairs) { degree[from]++; degree[to]++; }

    const extra   = [];
    const MAX_PASS = 6;

    for (let pass = 0; pass < MAX_PASS; pass++) {
      let added = 0;
      for (let i = 0; i < nodes.length; i++) {
        if (degree[i] >= 2) continue;

        let bestD = Infinity, target = -1;
        for (let j = 0; j < nodes.length; j++) {
          if (i === j || set.has(ek(i, j))) continue;
          const dx = nodes[i].x - nodes[j].x, dy = nodes[i].y - nodes[j].y;
          const d  = dx*dx + dy*dy;
          if (d < bestD) { bestD = d; target = j; }
        }
        if (target >= 0) {
          set.add(ek(i, target));
          extra.push({ from: i, to: target });
          degree[i]++;
          degree[target]++;   // ← update in-pass so next iterations are accurate
          added++;
        }
      }
      if (added === 0) break;
    }

    return extra;
  }

  // ─────────────────────────────────────────────────────────────
  // 5. RAW ADJACENCY  (node-id → array of connected node-ids)
  //    Built BEFORE curve computation so Catmull-Rom can access
  //    neighbouring nodes when computing control points.
  // ─────────────────────────────────────────────────────────────

  function _buildRawAdj(n, pairs) {
    const adj = Array.from({ length: n }, () => []);
    for (const { from, to } of pairs) {
      adj[from].push(to);
      adj[to].push(from);
    }
    return adj;
  }

  // ─────────────────────────────────────────────────────────────
  // 6. CATMULL-ROM EDGE BUILDING
  //    For edge A→B, we find:
  //      pPrev = neighbour of A that "continues from" B — i.e. the
  //              neighbour whose direction from A is most opposite to B.
  //              This acts as the phantom p0 in Catmull-Rom.
  //      pNext = same idea for neighbour of B, acting as phantom p3.
  //    With these four points (pPrev, A, B, pNext), the standard
  //    Catmull-Rom → cubic Bézier conversion produces a curve that
  //    enters A and exits B along the natural road direction —
  //    roads FLOW through intersections without kinks.
  // ─────────────────────────────────────────────────────────────

  /**
   * Find the neighbour of `centreIdx` whose direction from `centreIdx`
   * is most opposite to `oppositeIdx` (i.e. the one that "continues through").
   * Falls back to a phantom mirror point if no valid neighbour exists.
   */
  function _bestNeighbour(centreIdx, oppositeIdx, rawAdj, nodes) {
    const centre   = nodes[centreIdx];
    const opposite = nodes[oppositeIdx];
    // Direction AWAY from opposite (the direction we want to continue)
    const awayDir = MathEngine.Vec2.normalise(
      MathEngine.Vec2.sub(centre, opposite)
    );

    let bestScore = -Infinity, bestPt = null;
    for (const nid of rawAdj[centreIdx]) {
      if (nid === oppositeIdx) continue;
      const nd = MathEngine.Vec2.normalise(
        MathEngine.Vec2.sub(nodes[nid], centre)
      );
      const score = MathEngine.Vec2.dot(awayDir, nd);
      if (score > bestScore) { bestScore = score; bestPt = nodes[nid]; }
    }

    // Phantom fallback: mirror of opposite across centre
    if (!bestPt) {
      bestPt = {
        x: 2 * centre.x - opposite.x,
        y: 2 * centre.y - opposite.y,
      };
    }
    return bestPt;
  }

  function _buildEdge(id, from, to, nodes, rawAdj) {
    const p0 = nodes[from];
    const p1 = nodes[to];

    // Ghost control points for smooth Catmull-Rom flow
    const pPrev = _bestNeighbour(from, to,   rawAdj, nodes);
    const pNext = _bestNeighbour(to,   from, rawAdj, nodes);

    // Convert Catmull-Rom segment (pPrev→p0→p1→pNext) to cubic Bézier CPs
    const { cp1, cp2 } = MathEngine.catmullRomToBezierCPs(
      pPrev, p0, p1, pNext, CFG.CATMULL_ALPHA
    );

    // Add a small seed-deterministic perpendicular jitter for organic variety.
    // This breaks collinear monotony without destroying smoothness.
    const dir    = MathEngine.Vec2.normalise(MathEngine.Vec2.sub(p1, p0));
    const perp   = MathEngine.Vec2.perp(dir);
    const jitter = _rr(-CFG.CATMULL_JITTER, CFG.CATMULL_JITTER);

    const curve = {
      type: 'C',
      p0,
      cp1: { x: cp1.x + perp.x * jitter,         y: cp1.y + perp.y * jitter },
      cp2: { x: cp2.x - perp.x * jitter * 0.65,  y: cp2.y - perp.y * jitter * 0.65 },
      p1,
    };

    const lut = MathEngine.buildBezierLUT(curve, CFG.LUT_SAMPLES);
    return { id, from, to, curve, lut, length: MathEngine.lutTotalLength(lut) };
  }

  // ─────────────────────────────────────────────────────────────
  // 7. FULL ADJACENCY  (with edge references, for A*)
  // ─────────────────────────────────────────────────────────────

  function _buildAdjacency(n, edges) {
    const adj = {};
    for (let i = 0; i < n; i++) adj[i] = [];
    for (const e of edges) {
      adj[e.from].push({ nodeId: e.to,   edgeIdx: e.id, reversed: false });
      adj[e.to  ].push({ nodeId: e.from, edgeIdx: e.id, reversed: true  });
    }
    return adj;
  }

  // ─────────────────────────────────────────────────────────────
  // 8. ENVIRONMENT PLACEMENT
  // ─────────────────────────────────────────────────────────────

  function _buildRoadSamples(edges) {
    const pts = [];
    for (const e of edges) {
      for (const p of MathEngine.sampleBezier(e.curve, CFG.ROAD_SAMPLE_PTS))
        pts.push(p);
    }
    return pts;
  }

  const BLDG_PALETTES = [
    '#d43030', '#e07020', '#2070d8',
    '#20a0c0', '#9030c0', '#40b840',
    '#e0a020', '#c030a0',
  ];

  function _placeTrees(poly, roadSamples) {
    const trees   = [];
    const minD2   = CFG.MIN_TREE_DIST    * CFG.MIN_TREE_DIST;
    const roadCl2 = CFG.ROAD_CLEAR_TREE * CFG.ROAD_CLEAR_TREE;
    let tries = 0;
    while (trees.length < CFG.TREE_COUNT && tries < CFG.TREE_COUNT * 40) {
      tries++;
      const px = CX + _rr(-CFG.ISLAND_W * 0.86, CFG.ISLAND_W * 0.86);
      const py = CY + _rr(-CFG.ISLAND_H * 0.86, CFG.ISLAND_H * 0.86);
      if (!_insideWithMargin(px, py, poly, 28)) continue;

      let clash = false;
      for (const pt of roadSamples) {
        const dx = pt.x - px, dy = pt.y - py;
        if (dx*dx + dy*dy < roadCl2) { clash = true; break; }
      }
      if (clash) continue;

      for (const t of trees) {
        const dx = t.x - px, dy = t.y - py;
        if (dx*dx + dy*dy < minD2) { clash = true; break; }
      }
      if (clash) continue;

      trees.push({ x: px, y: py, r: _rr(10, 20), shade: _ri(0, 3) });
    }
    return trees;
  }

  function _placeBuildings(poly, roadSamples) {
    const buildings = [];
    const minD2     = CFG.MIN_BLDG_DIST    * CFG.MIN_BLDG_DIST;
    const roadCl2   = CFG.ROAD_CLEAR_BLDG * CFG.ROAD_CLEAR_BLDG;
    let tries = 0;
    while (buildings.length < CFG.BUILDING_COUNT && tries < CFG.BUILDING_COUNT * 30) {
      tries++;
      const px = CX + _rr(-CFG.ISLAND_W * 0.86, CFG.ISLAND_W * 0.86);
      const py = CY + _rr(-CFG.ISLAND_H * 0.86, CFG.ISLAND_H * 0.86);
      if (!_insideWithMargin(px, py, poly, 36)) continue;

      let clash = false;
      for (const pt of roadSamples) {
        const dx = pt.x - px, dy = pt.y - py;
        if (dx*dx + dy*dy < roadCl2) { clash = true; break; }
      }
      if (clash) continue;

      for (const b of buildings) {
        const dx = b.x - px, dy = b.y - py;
        if (dx*dx + dy*dy < minD2) { clash = true; break; }
      }
      if (clash) continue;

      const isHouse = _r() < 0.50;
      buildings.push({
        x: px, y: py,
        w: isHouse ? _rr(28, 46)  : _rr(20, 34),
        h: isHouse ? _rr(26, 38)  : _rr(38, 62),
        angle:   0,
        floors:  isHouse ? _ri(1, 2) : _ri(3, 6),
        palette: _ri(0, BLDG_PALETTES.length - 1),
        isHouse,
      });
    }
    return buildings;
  }

  // ─────────────────────────────────────────────────────────────
  // 9. PUBLIC: generate(options)
  //    options.seed → integer — each of the 5 preset seeds produces
  //    a unique road network via Poisson Disk Sampling + MST.
  // ─────────────────────────────────────────────────────────────

  function generate(options) {
    const seed = (options && options.seed != null) ? options.seed : 42;
    _rng = MathEngine.seededRandom(seed);

    // ── Island boundary (fixed across seeds) ──
    const islandPoly = _buildIslandPoly();

    // ── Node placement via Poisson Disk Sampling (seed-dependent) ──
    const rawSamples = _poissonDisk(islandPoly, CFG.PDS_MIN_DIST);
    if (rawSamples.length < 4) {
      console.warn('[MapGenerator] Insufficient PDS samples for seed:', seed);
      return { nodes: [], edges: [], adjacency: {}, buildings: [], trees: [], islandPoly };
    }

    // Assign proper IDs and clamp to world bounds
    const nodes = rawSamples.map((s, i) => ({
      id:   i,
      x:    Math.max(30, Math.min(CFG.WORLD_W - 30, s.x)),
      y:    Math.max(30, Math.min(CFG.WORLD_H - 30, s.y)),
      kind: 'pds',
    }));

    // ── Graph topology ──
    const mstPairs   = _primMST(nodes);
    const extraPairs = _addExtraEdges(nodes, mstPairs);
    const allPairs   = [...mstPairs, ...extraPairs];

    // Raw adjacency needed BEFORE curve computation
    const rawAdj = _buildRawAdj(nodes.length, allPairs);

    // ── Edge curves: Catmull-Rom splines ──
    const edges     = allPairs.map((p, i) => _buildEdge(i, p.from, p.to, nodes, rawAdj));
    const adjacency = _buildAdjacency(nodes.length, edges);

    // ── Environment ──
    const roadSamples = _buildRoadSamples(edges);
    const trees       = _placeTrees(islandPoly, roadSamples);
    const buildings   = _placeBuildings(islandPoly, roadSamples);

    // ── Connectivity report ──
    const degree   = new Int32Array(nodes.length);
    for (const e of edges) { degree[e.from]++; degree[e.to]++; }
    const deadEnds = degree.filter(d => d < 2).length;

    console.log(
      `[MapGenerator] seed:${seed} | PDS nodes:${nodes.length} | ` +
      `edges:${edges.length} (MST:${mstPairs.length}+extra:${extraPairs.length}) | ` +
      `dead-ends:${deadEnds} | trees:${trees.length} bldg:${buildings.length}`
    );

    return { nodes, edges, adjacency, buildings, trees, islandPoly, BLDG_PALETTES };
  }

  return Object.freeze({ generate, CFG });

})();
