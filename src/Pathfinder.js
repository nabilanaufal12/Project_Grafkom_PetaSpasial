/**
 * ═══════════════════════════════════════════════════════════════
 *  URBS — Pathfinder.js
 *  Module 4 of 6
 *
 *  Responsibilities:
 *    • A* algorithm (from scratch) over the road graph.
 *    • Returns step-by-step visited node sequence for animation.
 *    • Edge cost: actual arc-length via pre-built LUT.
 *    • Path reconstruction: ordered list of edge objects.
 *
 *  Contract:
 *    • findPath(fromId, toId, world) → PathResult | null
 *    • randomRoute(world, rng?)     → { fromId, toId, path } | null
 *
 *  PathResult = {
 *    nodeSequence: number[],
 *    pathEdges: Array<{ edge, reversed, curve, lut }>,
 *    totalLength: number,
 *    visited: number,
 *    visitedSequence: Array<{ nodeId, x, y }>,  // for search animation
 *    exploredEdges: number[],                    // edge IDs explored during search
 *  }
 * ═══════════════════════════════════════════════════════════════
 */

const Pathfinder = (() => {

  // ─────────────────────────────────────────────────────────────
  // 1. MIN-HEAP
  // ─────────────────────────────────────────────────────────────

  class MinHeap {
    constructor() { this._data = []; }

    get size() { return this._data.length; }

    push(item) {
      this._data.push(item);
      this._bubbleUp(this._data.length - 1);
    }

    pop() {
      const top  = this._data[0];
      const last = this._data.pop();
      if (this._data.length > 0) {
        this._data[0] = last;
        this._siftDown(0);
      }
      return top;
    }

    _bubbleUp(i) {
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (this._data[parent].f <= this._data[i].f) break;
        [this._data[parent], this._data[i]] = [this._data[i], this._data[parent]];
        i = parent;
      }
    }

    _siftDown(i) {
      const n = this._data.length;
      while (true) {
        let smallest = i;
        const l = 2 * i + 1, r = 2 * i + 2;
        if (l < n && this._data[l].f < this._data[smallest].f) smallest = l;
        if (r < n && this._data[r].f < this._data[smallest].f) smallest = r;
        if (smallest === i) break;
        [this._data[smallest], this._data[i]] = [this._data[i], this._data[smallest]];
        i = smallest;
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 2. REVERSE BEZIER
  // ─────────────────────────────────────────────────────────────

  function _reverseCurve(curve) {
    if (curve.type === 'Q') {
      return { type: 'Q', p0: curve.p1, cp: curve.cp, p1: curve.p0 };
    }
    return { type: 'C', p0: curve.p1, cp1: curve.cp2, cp2: curve.cp1, p1: curve.p0 };
  }

  // ─────────────────────────────────────────────────────────────
  // 3. A* ALGORITHM with step recording
  // ─────────────────────────────────────────────────────────────

  function findPath(fromId, toId, world) {
    const { nodes, edges, adjacency } = world;

    if (!nodes || !adjacency || fromId === toId) return null;
    if (!adjacency[fromId] || !adjacency[toId])  return null;

    const n      = nodes.length;
    const gScore = new Float64Array(n).fill(Infinity);
    const fScore = new Float64Array(n).fill(Infinity);
    const cameFromNode = new Int32Array(n).fill(-1);
    const cameFromEdge = new Int32Array(n).fill(-1);
    const cameFromRev  = new Uint8Array(n);

    const open    = new MinHeap();
    const closed  = new Uint8Array(n);
    let   visited = 0;

    // Record visited node sequence for animation
    const visitedSequence = [];
    const exploredEdgeSet = new Set();

    gScore[fromId] = 0;
    fScore[fromId] = MathEngine.aStarHeuristic(nodes[fromId], nodes[toId]);
    open.push({ f: fScore[fromId], id: fromId });

    while (open.size > 0) {
      const { id: current } = open.pop();

      if (current === toId) {
        const result = _reconstructPath(
          current, fromId, cameFromNode, cameFromEdge, cameFromRev, nodes, edges, visited
        );
        result.visitedSequence = visitedSequence;
        result.exploredEdges   = Array.from(exploredEdgeSet);
        return result;
      }

      if (closed[current]) continue;
      closed[current] = 1;
      visited++;

      // Record this node being visited with A* calculation
      const g = gScore[current];
      const f = fScore[current];
      const h = f - g;
      visitedSequence.push({ nodeId: current, x: nodes[current].x, y: nodes[current].y, g, h, f });

      const neighbours = adjacency[current];
      if (!neighbours) continue;

      for (const { nodeId: neighbour, edgeIdx, reversed } of neighbours) {
        if (closed[neighbour]) continue;

        exploredEdgeSet.add(edgeIdx);

        const edge  = edges[edgeIdx];
        const cost  = edge.length;
        const tentG = gScore[current] + cost;

        if (tentG < gScore[neighbour]) {
          cameFromNode[neighbour] = current;
          cameFromEdge[neighbour] = edgeIdx;
          cameFromRev[neighbour]  = reversed ? 1 : 0;
          gScore[neighbour]       = tentG;
          fScore[neighbour]       = tentG + MathEngine.aStarHeuristic(nodes[neighbour], nodes[toId]);
          open.push({ f: fScore[neighbour], id: neighbour });
        }
      }
    }

    return { pathEdges: [], nodeSequence: [], totalLength: 0, visited, visitedSequence, exploredEdges: Array.from(exploredEdgeSet) };
  }

  // ─────────────────────────────────────────────────────────────
  // 4. PATH RECONSTRUCTION
  // ─────────────────────────────────────────────────────────────

  function _reconstructPath(toId, fromId, cameFromNode, cameFromEdge, cameFromRev, nodes, edges, visited) {
    const nodeSeq  = [];
    const edgeSeq  = [];

    let cur = toId;
    while (cur !== fromId) {
      nodeSeq.unshift(cur);
      const prev     = cameFromNode[cur];
      const edgeIdx  = cameFromEdge[cur];
      const reversed = cameFromRev[cur] === 1;
      edgeSeq.unshift({ edgeIdx, reversed });
      cur = prev;
    }
    nodeSeq.unshift(fromId);

    const pathEdges = edgeSeq.map(({ edgeIdx, reversed }) => {
      const edge  = edges[edgeIdx];
      const curve = reversed ? _reverseCurve(edge.curve) : edge.curve;
      const lut   = reversed ? MathEngine.buildBezierLUT(curve, 48) : edge.lut;
      return { edge, reversed, curve, lut };
    });

    const totalLength = MathEngine.pathTotalLength(pathEdges);
    return { nodeSequence: nodeSeq, pathEdges, totalLength, visited: visited ?? '—' };
  }

  // ─────────────────────────────────────────────────────────────
  // 5. RANDOM ROUTE
  // ─────────────────────────────────────────────────────────────

  function randomRoute(world, rngFn, maxTries) {
    const rng   = rngFn    || Math.random.bind(Math);
    const tries = maxTries || 30;
    const n     = world.nodes.length;
    if (n < 2) return null;

    for (let i = 0; i < tries; i++) {
      const fromId = Math.floor(rng() * n);
      let   toId   = Math.floor(rng() * n);
      if (toId === fromId) toId = (fromId + 1) % n;

      const path = findPath(fromId, toId, world);
      if (path && path.pathEdges.length > 0) {
        return { fromId, toId, path };
      }
    }
    return null;
  }

  // ─────────────────────────────────────────────────────────────
  // PUBLIC API
  // ─────────────────────────────────────────────────────────────
  return Object.freeze({ findPath, randomRoute });

})();
