/**
 * ═══════════════════════════════════════════════════════════════
 *  URBS — MapGenerator.js  |  Governors Island Topology
 *
 *  ARCHITECTURE:
 *    Road network uses a HYBRID approach:
 *      - Perimeter ring road (outer loop — covers the full island)
 *      - Inner grid-like district roads (spread across island)
 *      - Hub nodes at strategic junctions
 *      - All nodes guaranteed ≥ 2 connections (no dead-ends)
 *      - Controlled extra edges for organic feel
 *
 *  OUTPUT: { nodes, edges, adjacency, buildings, trees, islandPoly }
 * ═══════════════════════════════════════════════════════════════
 */

const MapGenerator = (() => {

  // ── Config ────────────────────────────────────────────────────
  const CFG = Object.freeze({
    WORLD_W:  2000,
    WORLD_H:  1600,

    // Island extent (world units from island centre)
    ISLAND_W: 800,   // half-width
    ISLAND_H: 700,   // half-height

    // Road nodes — well-spread layout
    PERIMETER_NODES: 8,   // fewer perimeter, better spaced
    GRID_COLS:        5,  // wider inner grid
    GRID_ROWS:        4,  // taller inner grid
    HUB_NODES:        4,

    MIN_NODE_DIST:   115,  // allow closer nodes for wider spread

    // Extra edges: controlled — just enough for redundancy, no dead-ends
    MIN_CONNECTIONS:  2,   // guarantee each node has at least this many edges
    EXTRA_EDGE_MAX:  380,  // slightly longer to allow more cross-island connections

    // Bezier: moderate curve for roads to look natural
    CURVE_CHANCE:    0.75,
    CURVE_BEND_MIN:  25,
    CURVE_BEND_MAX:  100,

    LUT_SAMPLES: 48,

    // Environment
    TREE_COUNT:      45,
    BUILDING_COUNT:  110,
    MIN_TREE_DIST:   50,
    MIN_BLDG_DIST:   55,

    ROAD_CLEAR_TREE: 42,
    ROAD_CLEAR_BLDG: 50,
    ROAD_SAMPLE_PTS: 16,
  });

  // Island centre (world space)
  const CX = CFG.WORLD_W * 0.5;
  const CY = CFG.WORLD_H * 0.5;

  let _rng;
  const _r  = () => _rng();
  const _rr = (a, b) => MathEngine.rngRange(_rng, a, b);
  const _ri = (a, b) => MathEngine.rngInt(_rng, a, b);
  const _c  = (p)    => _r() < p;

  // ─────────────────────────────────────────────────────────────
  // 1. GOVERNORS ISLAND BOUNDARY
  // ─────────────────────────────────────────────────────────────

  const ISLAND_CTRL = [
    [0.50, 0.04],
    [0.64, 0.07],
    [0.76, 0.13],
    [0.85, 0.22],
    [0.90, 0.33],
    [0.88, 0.44],
    [0.90, 0.55],
    [0.87, 0.66],
    [0.82, 0.75],
    [0.74, 0.84],
    [0.63, 0.92],
    [0.52, 0.97],
    [0.40, 0.96],
    [0.29, 0.91],
    [0.20, 0.83],
    [0.15, 0.72],
    [0.12, 0.59],
    [0.14, 0.46],
    [0.12, 0.34],
    [0.18, 0.23],
    [0.28, 0.13],
    [0.38, 0.07],
  ];

  function _catmullRom(p0, p1, p2, p3, t) {
    const t2 = t * t, t3 = t2 * t;
    return {
      x: 0.5 * ((2*p1.x) + (-p0.x + p2.x)*t +
         (2*p0.x - 5*p1.x + 4*p2.x - p3.x)*t2 +
         (-p0.x + 3*p1.x - 3*p2.x + p3.x)*t3),
      y: 0.5 * ((2*p1.y) + (-p0.y + p2.y)*t +
         (2*p0.y - 5*p1.y + 4*p2.y - p3.y)*t2 +
         (-p0.y + 3*p1.y - 3*p2.y + p3.y)*t3),
    };
  }

  function _buildIslandPoly() {
    const pts  = ISLAND_CTRL.map(([u, v]) => ({
      x: CX + (u - 0.5) * CFG.ISLAND_W * 2,
      y: CY + (v - 0.5) * CFG.ISLAND_H * 2,
    }));
    const n       = pts.length;
    const STEPS   = 6;
    const poly    = [];

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

  function _pip(px, py, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y;
      const xj = poly[j].x, yj = poly[j].y;
      if (((yi > py) !== (yj > py)) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)
        inside = !inside;
    }
    return inside;
  }

  function _insideWithMargin(px, py, poly, margin) {
    if (!_pip(px, py, poly)) return false;
    const m2 = margin * margin;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const ax = poly[j].x, ay = poly[j].y;
      const bx = poly[i].x, by = poly[i].y;
      const dx = bx - ax, dy = by - ay;
      const t  = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx*dx + dy*dy)));
      const cx = ax + t * dx - px, cy = ay + t * dy - py;
      if (cx*cx + cy*cy < m2) return false;
    }
    return true;
  }

  // ─────────────────────────────────────────────────────────────
  // 2. NODE PLACEMENT — Structured city-like layout
  // ─────────────────────────────────────────────────────────────

  /** Perimeter ring road — spaced around the whole island coastline */
  function _perimeterNodes(poly) {
    const nodes = [];
    const n     = CFG.PERIMETER_NODES;
    const total = poly.length;
    for (let i = 0; i < n; i++) {
      const idx   = Math.floor((i / n) * total);
      const pt    = poly[idx];
      // Inset 18-28% toward centre — close enough to coastline
      const inset = _rr(0.18, 0.28);
      nodes.push({
        x:    pt.x * (1 - inset) + CX * inset,
        y:    pt.y * (1 - inset) + CY * inset,
        kind: 'perimeter',
      });
    }
    return nodes;
  }

  /** Inner grid-like district nodes — spread across the FULL island */
  function _gridNodes(poly) {
    const nodes = [];
    const cols  = CFG.GRID_COLS;
    const rows  = CFG.GRID_ROWS;
    const MARGIN = 70;  // tighter margin so grid covers more of island

    // Grid spans across island — use 90% of island extent
    const gW = CFG.ISLAND_W * 1.55;  // covers nearly full island width
    const gH = CFG.ISLAND_H * 1.40;  // covers nearly full island height

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const u  = (c + 0.5) / cols;
        const v  = (r + 0.5) / rows;
        // Small organic jitter (seed-based)
        const jx = _rr(-gW * 0.06, gW * 0.06);
        const jy = _rr(-gH * 0.06, gH * 0.06);
        const px = CX + (u - 0.5) * gW + jx;
        const py = CY + (v - 0.5) * gH + jy;
        if (_insideWithMargin(px, py, poly, MARGIN)) {
          nodes.push({ x: px, y: py, kind: 'grid' });
        }
      }
    }
    return nodes;
  }

  /** Hub nodes — at strategic mid-ring positions for connectivity */
  function _hubNodes(poly) {
    const nodes = [];
    // Place hub nodes at mid-radius compass + diagonal positions
    const positions = [
      { fr: 0.45, theta: -Math.PI * 0.4 },   // north-east
      { fr: 0.45, theta:  Math.PI * 0.4 },   // south-east
      { fr: 0.45, theta: -Math.PI * 0.75 },  // north-west
      { fr: 0.45, theta:  Math.PI * 0.85 },  // south-west
    ];
    for (const { fr, theta } of positions) {
      const jitter = _rr(-0.06, 0.06);
      const px = CX + Math.cos(theta + jitter) * CFG.ISLAND_W * fr;
      const py = CY + Math.sin(theta + jitter) * CFG.ISLAND_H * fr;
      if (_insideWithMargin(px, py, poly, 75)) {
        nodes.push({ x: px, y: py, kind: 'hub' });
      }
    }
    return nodes;
  }

  /** Deduplicate + enforce min-distance separation */
  function _buildNodeList(rawPts) {
    const out = [];
    const D2  = CFG.MIN_NODE_DIST * CFG.MIN_NODE_DIST;
    for (const pt of rawPts) {
      const x = Math.max(40, Math.min(CFG.WORLD_W - 40, pt.x));
      const y = Math.max(40, Math.min(CFG.WORLD_H - 40, pt.y));
      let clash = false;
      for (const n of out) {
        const dx = n.x - x, dy = n.y - y;
        if (dx*dx + dy*dy < D2) { clash = true; break; }
      }
      if (!clash) out.push({ id: out.length, x, y, kind: pt.kind });
    }
    return out;
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
  // 4. SMART EXTRA EDGES — ensure ≥2 connections + organic loops
  // ─────────────────────────────────────────────────────────────

  function _addExtraEdges(nodes, mstPairs) {
    const set = new Set();
    const ek = (a, b) => a < b ? `${a},${b}` : `${b},${a}`;
    for (const { from, to } of mstPairs) set.add(ek(from, to));

    // Count connections per node
    const degree = new Int32Array(nodes.length);
    for (const { from, to } of mstPairs) {
      degree[from]++;
      degree[to]++;
    }

    const extra = [];
    const maxD2 = CFG.EXTRA_EDGE_MAX * CFG.EXTRA_EDGE_MAX;

    // Build candidate list sorted by distance
    const cands = [];
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        if (set.has(ek(i, j))) continue;
        const dx = nodes[i].x - nodes[j].x, dy = nodes[i].y - nodes[j].y;
        const d2 = dx*dx + dy*dy;
        if (d2 <= maxD2) cands.push({ from: i, to: j, d2 });
      }
    }
    cands.sort((a, b) => a.d2 - b.d2);

    // First pass: fix dead-ends (degree < 2)
    for (const c of cands) {
      if (degree[c.from] < CFG.MIN_CONNECTIONS || degree[c.to] < CFG.MIN_CONNECTIONS) {
        const k = ek(c.from, c.to);
        if (set.has(k)) continue;
        set.add(k);
        extra.push(c);
        degree[c.from]++;
        degree[c.to]++;
      }
    }

    // Second pass: add a few organic loop edges (not too many)
    const loopTarget = Math.floor(nodes.length * 0.40);
    let loopCount = 0;
    for (const c of cands) {
      if (loopCount >= loopTarget) break;
      const k = ek(c.from, c.to);
      if (set.has(k)) continue;
      // Prefer edges between nodes of different kinds for organic loops
      const a = nodes[c.from], b = nodes[c.to];
      if (a.kind !== b.kind || _c(0.35)) {
        set.add(k);
        extra.push(c);
        degree[c.from]++;
        degree[c.to]++;
        loopCount++;
      }
    }

    return extra;
  }

  // ─────────────────────────────────────────────────────────────
  // 5. BEZIER CURVE ASSIGNMENT
  // ─────────────────────────────────────────────────────────────

  function _makeCurve(p0, p1) {
    const curved = _c(CFG.CURVE_CHANCE);
    const bend   = curved ? _rr(CFG.CURVE_BEND_MIN, CFG.CURVE_BEND_MAX) : _rr(5, 20);
    const side   = _c(0.5) ? 1 : -1;
    const cp     = MathEngine.midpointCP(p0, p1, bend * side);

    // ~30% of curved roads get cubic
    if (curved && _c(0.30)) {
      const dir  = MathEngine.Vec2.normalise(MathEngine.Vec2.sub(p1, p0));
      const perp = MathEngine.Vec2.perp(dir);
      const m1   = _rr(20, bend * 0.6) * side;
      const m2   = _rr(20, bend * 0.6) * -side;
      const f    = _rr(0.35, 0.65);
      const via  = { x: p0.x + (p1.x - p0.x) * f, y: p0.y + (p1.y - p0.y) * f };
      const { cp1, cp2 } = MathEngine.viaPointCPs(p0, via, p1, _rr(0.35, 0.65));
      return {
        type: 'C', p0,
        cp1: { x: cp1.x + perp.x * m1, y: cp1.y + perp.y * m1 },
        cp2: { x: cp2.x + perp.x * m2, y: cp2.y + perp.y * m2 },
        p1,
      };
    }
    return { type: 'Q', p0, cp, p1 };
  }

  // ─────────────────────────────────────────────────────────────
  // 6. EDGE ASSEMBLY
  // ─────────────────────────────────────────────────────────────

  function _buildEdge(id, from, to, nodes) {
    const p0    = { x: nodes[from].x, y: nodes[from].y };
    const p1    = { x: nodes[to].x,   y: nodes[to].y   };
    const curve = _makeCurve(p0, p1);
    const lut   = MathEngine.buildBezierLUT(curve, CFG.LUT_SAMPLES);
    return { id, from, to, curve, lut, length: MathEngine.lutTotalLength(lut) };
  }

  // ─────────────────────────────────────────────────────────────
  // 7. ADJACENCY
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
  // 8. TREE PLACEMENT
  // ─────────────────────────────────────────────────────────────

  function _buildRoadSamples(edges) {
    const pts = [];
    for (const edge of edges) {
      const samples = MathEngine.sampleBezier(edge.curve, CFG.ROAD_SAMPLE_PTS);
      for (const p of samples) pts.push(p);
    }
    return pts;
  }

  function _placeTrees(poly, nodes, roadSamples) {
    const trees   = [];
    const minD2   = CFG.MIN_TREE_DIST    * CFG.MIN_TREE_DIST;
    const roadCl2 = CFG.ROAD_CLEAR_TREE * CFG.ROAD_CLEAR_TREE;
    let tries = 0;
    while (trees.length < CFG.TREE_COUNT && tries < CFG.TREE_COUNT * 35) {
      tries++;
      const px = CX + _rr(-CFG.ISLAND_W * 0.88, CFG.ISLAND_W * 0.88);
      const py = CY + _rr(-CFG.ISLAND_H * 0.88, CFG.ISLAND_H * 0.88);
      if (!_insideWithMargin(px, py, poly, 30)) continue;

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

  // ─────────────────────────────────────────────────────────────
  // 9. BUILDING PLACEMENT
  // ─────────────────────────────────────────────────────────────

  const BLDG_PALETTES = [
    '#d43030',
    '#e07020',
    '#2070d8',
    '#20a0c0',
    '#9030c0',
    '#40b840',
    '#e0a020',
    '#c030a0',
  ];

  function _placeBuildings(poly, nodes, roadSamples) {
    const buildings = [];
    const minD2     = CFG.MIN_BLDG_DIST    * CFG.MIN_BLDG_DIST;
    const roadCl2   = CFG.ROAD_CLEAR_BLDG * CFG.ROAD_CLEAR_BLDG;
    let tries = 0;
    while (buildings.length < CFG.BUILDING_COUNT && tries < CFG.BUILDING_COUNT * 30) {
      tries++;
      const px = CX + _rr(-CFG.ISLAND_W * 0.88, CFG.ISLAND_W * 0.88);
      const py = CY + _rr(-CFG.ISLAND_H * 0.88, CFG.ISLAND_H * 0.88);
      if (!_insideWithMargin(px, py, poly, 38)) continue;

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

      const isHouse = _c(0.50);
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
  // 10. PUBLIC: generate()
  // ─────────────────────────────────────────────────────────────

  function generate(options) {
    const seed = (options && options.seed != null) ? options.seed : 42;
    _rng = MathEngine.seededRandom(seed);

    const islandPoly = _buildIslandPoly();

    // Node placement: perimeter ring + inner grid + hub connectors
    const rawPts = [
      ..._perimeterNodes(islandPoly),
      ..._gridNodes(islandPoly),
      ..._hubNodes(islandPoly),
    ];
    const nodes = _buildNodeList(rawPts);

    if (nodes.length < 2) {
      console.warn('[MapGenerator] Too few nodes.');
      return { nodes: [], edges: [], adjacency: {}, buildings: [], trees: [], islandPoly };
    }

    // Graph — MST guarantees full connectivity, then fix dead-ends + loops
    const mstPairs   = _primMST(nodes);
    const extraPairs = _addExtraEdges(nodes, mstPairs);
    const allPairs   = [...mstPairs, ...extraPairs];
    const edges      = allPairs.map((p, i) => _buildEdge(i, p.from, p.to, nodes));
    const adjacency  = _buildAdjacency(nodes.length, edges);

    // Environment
    const roadSamples = _buildRoadSamples(edges);
    const trees       = _placeTrees(islandPoly, nodes, roadSamples);
    const buildings   = _placeBuildings(islandPoly, nodes, roadSamples);

    // Verify connectivity & degree
    const degree = new Int32Array(nodes.length);
    for (const e of edges) { degree[e.from]++; degree[e.to]++; }
    const deadEnds = degree.filter(d => d < 2).length;

    console.log(
      `[MapGenerator] seed:${seed} | nodes:${nodes.length} | ` +
      `edges:${edges.length} (MST:${mstPairs.length}+extra:${extraPairs.length}) | ` +
      `dead-ends:${deadEnds} | trees:${trees.length} bldg:${buildings.length}`
    );

    return { nodes, edges, adjacency, buildings, trees, islandPoly, BLDG_PALETTES };
  }

  return Object.freeze({ generate, CFG });

})();
