/**
 * ═══════════════════════════════════════════════════════════════
 *  URBS — Renderer.js  |  Premium Hybrid Edition
 *
 *  VISUAL PHILOSOPHY:
 *    Island & Ocean  → Deep blue ocean, rich green radial-gradient
 *                      island, sandy beach ring, wave halos, vignette.
 *    Buildings       → Vibrant flat cartoon with pitched roofs/flat tops.
 *    Trees           → Round bright-green circles, lighter specular top.
 *    Roads           → Medium-grey tarmac, subtle kerb stripe, white
 *                      STATIC dashed centreline (no movement).
 *    Search Anim     → Blue expanding ripple on explored nodes,
 *                      explored edges glow cyan/teal step-by-step,
 *                      then orange path revealed.
 *    Car             → Red rectangular bus, yellow wheels, white windshield.
 *    Minimap         → Bottom-right canvas inset.
 *
 *  ALL transforms via MathEngine.worldToScreen(). Zero ctx.scale/rotate.
 * ═══════════════════════════════════════════════════════════════
 */

const Renderer = (() => {

  let _ctx  = null;
  let _time = 0;

  let _activePath    = null;
  let _activePathSet = new Set();
  let _startNodeId   = -1;
  let _goalNodeId    = -1;

  // Search animation state
  let _searchAnim = null;
  // _searchAnim = {
  //   visitedSequence: [...],   // all nodes visited by A*
  //   exploredEdges: [...],     // edge IDs explored
  //   pathEdges: [...],         // final path edges
  //   stepIndex: 0,             // how many nodes revealed so far
  //   stepTimer: 0,             // timer for next step
  //   stepDelay: 0.04,          // seconds between steps (faster)
  //   phase: 'explore'|'reveal',// phase
  //   done: false,
  //   onComplete: fn,           // called when all revealed
  // }

  // ── Road dimensions ──────────────────────────────────────────
  const ROAD_W      = 14;
  const ROAD_BORDER = '#7a7e8a';
  const ROAD_FILL   = '#5c606e';
  const ROAD_DASH   = 'rgba(255,255,255,0.85)';

  // ── Ocean / island colours ─────────────────────────────────
  const OCEAN_DEEP    = '#0e2235';
  const OCEAN_MID     = '#152e42';
  const OCEAN_SURF    = '#1a3550';
  const ISLAND_C0     = '#7ec85a';
  const ISLAND_C1     = '#68b048';
  const ISLAND_C2     = '#548c38';
  const ISLAND_C3     = '#3e6c28';
  const BEACH_COLOR   = '#d4c272';

  // ── Building palettes (cartoon vibrant) ──────────────────────
  const WALL_COLORS = [
    '#d43030', '#e07020', '#2070d8',
    '#20a0c0', '#9030c0', '#40b840',
    '#e0a020', '#c030a0',
  ];
  const ROOF_COLORS = {
    '#d43030': '#a02020', '#e07020': '#b05010',
    '#2070d8': '#1050a0', '#20a0c0': '#158090',
    '#9030c0': '#6020a0', '#40b840': '#2a8a2a',
    '#e0a020': '#b07010', '#c030a0': '#900870',
  };

  // ─────────────────────────────────────────────────────────────
  // INIT
  // ─────────────────────────────────────────────────────────────

  function init() {
    const canvas = document.getElementById('cityCanvas');
    _ctx = canvas.getContext('2d');
    StateController.setContext(_ctx);
    StateController.on('viewport:resized', () => StateController.setContext(_ctx));
  }

  function setActivePath(result, fromId, toId) {
    _activePath    = result;
    _startNodeId   = fromId  ?? -1;
    _goalNodeId    = toId    ?? -1;
    _activePathSet = new Set();
    if (result) for (const pe of result.pathEdges) _activePathSet.add(pe.edge.id);
  }

  /**
   * Start the A* search visualization animation.
   * @param {object} result      — full PathResult from Pathfinder
   * @param {Function} onComplete — called when animation finishes
   * @param {number} speedFactor  — 1=normal, 2=fast, 0.5=slow
   */
  function startSearchAnimation(result, onComplete, speedFactor) {
    if (!result) { if (onComplete) onComplete(); return; }
    const factor = (speedFactor != null && speedFactor > 0) ? speedFactor : 1;

    // ── Delay formula rationale ────────────────────────────────────────────
    // Goal: total animation ≈ 5 seconds regardless of how many nodes A* visits.
    // min 0.08s/step  → each step is visible for ≥ 4-5 frames at 60 fps.
    // max 0.22s/step  → sparse graphs don't feel too sluggish.
    // factor > 1 speeds up (useful in tests), factor < 1 slows down.
    const nodeCount = Math.max(1, (result.visitedSequence || []).length);
    const stepDelay = Math.max(0.08, Math.min(0.22, 5.0 / nodeCount)) / factor;

    _searchAnim = {
      visitedSequence:  result.visitedSequence || [],
      exploredEdges:    new Set(result.exploredEdges || []),
      pathEdgeSet:      new Set((result.pathEdges || []).map(pe => pe.edge.id)),
      stepIndex:        0,
      stepTimer:        0,
      stepDelay,
      phase:            'explore',
      // Pause between explore-done and route-reveal: 2 full step-delays
      revealTimer:      stepDelay * 2,
      done:             false,
      onComplete:       onComplete || null,
      litNodes:         new Set(),
      litExploredEdges: new Set(),
    };
  }

  function stopSearchAnimation() {
    _searchAnim = null;
  }

  function isSearchAnimating() {
    return _searchAnim !== null && !_searchAnim.done;
  }

  // ─────────────────────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────────────────────

  function _rotRect(cx, cy, hw, hh, angle) {
    const cos = Math.cos(angle), sin = Math.sin(angle);
    return [
      { x: -hw, y: -hh }, { x: hw, y: -hh },
      { x:  hw, y:  hh }, { x: -hw, y:  hh },
    ].map(c => ({
      x: cx + c.x * cos - c.y * sin,
      y: cy + c.x * sin + c.y * cos,
    }));
  }

  function _rotPt(cx, cy, lx, ly, cos, sin) {
    return { x: cx + lx * cos - ly * sin, y: cy + lx * sin + ly * cos };
  }

  function _fillPoly(pts, style) {
    if (!pts || pts.length < 2) return;
    _ctx.beginPath();
    _ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) _ctx.lineTo(pts[i].x, pts[i].y);
    _ctx.closePath();
    _ctx.fillStyle = style;
    _ctx.fill();
  }

  function _strokePoly(pts, style, lw) {
    if (!pts || pts.length < 2) return;
    _ctx.beginPath();
    _ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) _ctx.lineTo(pts[i].x, pts[i].y);
    _ctx.closePath();
    _ctx.strokeStyle = style;
    _ctx.lineWidth   = lw;
    _ctx.stroke();
  }

  function _strokeLine(pts, style, lw, cap) {
    if (!pts || pts.length < 2) return;
    _ctx.beginPath();
    _ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) _ctx.lineTo(pts[i].x, pts[i].y);
    _ctx.strokeStyle = style;
    _ctx.lineWidth   = lw;
    _ctx.lineCap     = cap  || 'round';
    _ctx.lineJoin    = 'round';
    _ctx.stroke();
  }

  // ─────────────────────────────────────────────────────────────
  // LAYER 1: DEEP OCEAN + ATMOSPHERIC ISLAND
  // ─────────────────────────────────────────────────────────────

  function _drawOceanIsland(vp, cam, world) {
    const cfg = MapGenerator.CFG;

    const oceanGrad = _ctx.createLinearGradient(0, 0, 0, vp.height);
    oceanGrad.addColorStop(0,   OCEAN_DEEP);
    oceanGrad.addColorStop(0.5, OCEAN_MID);
    oceanGrad.addColorStop(1,   OCEAN_DEEP);
    _ctx.fillStyle = oceanGrad;
    _ctx.fillRect(0, 0, vp.width, vp.height);

    if (!world.islandPoly || world.islandPoly.length < 3) return;
    const poly = world.islandPoly.map(p => MathEngine.worldToScreen(p.x, p.y, cam));

    // Concentric ocean wave rings (subtle)
    _ctx.save();
    for (let i = 1; i <= 5; i++) {
      const t    = i * 0.055;
      const wPts = world.islandPoly.map(p => {
        const dx = p.x - cfg.WORLD_W * 0.5, dy = p.y - cfg.WORLD_H * 0.5;
        return MathEngine.worldToScreen(
          cfg.WORLD_W * 0.5 + dx * (1 + t),
          cfg.WORLD_H * 0.5 + dy * (1 + t),
          cam
        );
      });
      _ctx.beginPath();
      _ctx.moveTo(wPts[0].x, wPts[0].y);
      for (let j = 1; j < wPts.length; j++) _ctx.lineTo(wPts[j].x, wPts[j].y);
      _ctx.closePath();
      _ctx.strokeStyle = `rgba(40,100,160,${0.13 - i * 0.02})`;
      _ctx.lineWidth   = 1 + i * 0.3;
      _ctx.stroke();
    }
    _ctx.restore();

    // Island drop shadow
    _ctx.save();
    _ctx.shadowColor   = 'rgba(0,0,0,0.42)';
    _ctx.shadowBlur    = 22;
    _ctx.shadowOffsetX = 6;
    _ctx.shadowOffsetY = 10;
    _fillPoly(poly, 'rgba(0,0,0,0.01)');
    _ctx.restore();

    // Island fill: rich radial green gradient
    const cen = MathEngine.worldToScreen(cfg.WORLD_W * 0.5, cfg.WORLD_H * 0.5, cam);
    const rad = MathEngine.worldLenToScreen(
      Math.max(cfg.ISLAND_W, cfg.ISLAND_H) * 1.25, cam.zoomLevel
    );
    const fillGrad = _ctx.createRadialGradient(cen.x, cen.y, 0, cen.x, cen.y, rad);
    fillGrad.addColorStop(0,    ISLAND_C0);
    fillGrad.addColorStop(0.45, ISLAND_C1);
    fillGrad.addColorStop(0.80, ISLAND_C2);
    fillGrad.addColorStop(1,    ISLAND_C3);
    _fillPoly(poly, fillGrad);

    // Sandy beach ring
    const beachW = Math.max(2, MathEngine.worldLenToScreen(14, cam.zoomLevel));
    _strokePoly(poly, BEACH_COLOR, beachW);

    // Coastal vignette (clipped to island)
    _ctx.save();
    _ctx.beginPath();
    _ctx.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) _ctx.lineTo(poly[i].x, poly[i].y);
    _ctx.closePath();
    _ctx.clip();
    const vig = _ctx.createRadialGradient(cen.x, cen.y, 0, cen.x, cen.y, rad);
    vig.addColorStop(0,   'rgba(0,0,0,0)');
    vig.addColorStop(0.65, 'rgba(0,0,0,0)');
    vig.addColorStop(1,   'rgba(0,0,0,0.18)');
    _ctx.fillStyle = vig;
    _ctx.fillRect(0, 0, vp.width, vp.height);
    _ctx.restore();
  }

  // ─────────────────────────────────────────────────────────────
  // LAYER 2: BUILDINGS
  // ─────────────────────────────────────────────────────────────

  function _drawBuildings(world, cam) {
    if (!world.buildings || !world.buildings.length) return;
    const aabb = StateController.getViewportAABB();
    const zoom = cam.zoomLevel;

    for (const b of world.buildings) {
      if (b.x < aabb.minX - 70 || b.x > aabb.maxX + 70 ||
          b.y < aabb.minY - 70 || b.y > aabb.maxY + 70) continue;

      const s  = MathEngine.worldToScreen(b.x, b.y, cam);
      const sw = MathEngine.worldLenToScreen(b.w, zoom);
      const sh = MathEngine.worldLenToScreen(b.h, zoom);
      if (sw < 2.5) continue;

      // Ellipse ground shadow
      _ctx.save();
      _ctx.globalAlpha = 0.20;
      _ctx.beginPath();
      _ctx.ellipse(s.x, s.y + sh * 0.5, sw * 0.78, sh * 0.20, 0, 0, MathEngine.TAU);
      _ctx.fillStyle = '#1a4010';
      _ctx.fill();
      _ctx.restore();

      const wallCol = WALL_COLORS[b.palette % WALL_COLORS.length];
      const roofCol = ROOF_COLORS[wallCol] || '#444';

      if (b.isHouse) {
        _drawHouse(s.x, s.y, sw, sh, wallCol, roofCol, zoom);
      } else {
        _drawTower(s.x, s.y, sw, sh, wallCol, zoom);
      }
    }
  }

  function _drawHouse(cx, cy, sw, sh, wallCol, roofCol, zoom) {
    const hw = sw * 0.5, hh = sh * 0.5;
    const body = _rotRect(cx, cy, hw, hh, 0);

    _fillPoly(body, wallCol);
    _strokePoly(body, 'rgba(0,0,0,0.22)', 0.8);

    if (sw > 5) {
      const roofH = sh * 0.36;
      const roof  = [
        { x: cx - hw, y: cy - hh },
        { x: cx + hw, y: cy - hh },
        { x: cx,      y: cy - hh - roofH },
      ];
      _fillPoly(roof, roofCol);
      _strokePoly(roof, 'rgba(0,0,0,0.18)', 0.6);
    }

    if (sh > 8) {
      const dw = sw * 0.28, dh = sh * 0.26;
      const door = [
        { x: cx - dw * 0.5, y: cy + hh },
        { x: cx + dw * 0.5, y: cy + hh },
        { x: cx + dw * 0.5, y: cy + hh - dh },
        { x: cx - dw * 0.5, y: cy + hh - dh },
      ];
      _fillPoly(door, 'rgba(10,10,10,0.85)');
    }

    if (sw > 9 && zoom > 0.4) {
      _windowGrid(cx, cy, hw, hh, 1, 0, 2, 1, 'rgba(210,235,255,0.9)');
    }
  }

  function _drawTower(cx, cy, sw, sh, wallCol, zoom) {
    const hw = sw * 0.5, hh = sh * 0.5;
    const body = _rotRect(cx, cy, hw, hh, 0);

    _fillPoly(body, wallCol);
    _strokePoly(body, 'rgba(0,0,0,0.25)', 0.9);

    if (sh > 8) {
      const bh = sh * 0.2;
      _fillPoly([
        { x: cx - hw, y: cy + hh },
        { x: cx + hw, y: cy + hh },
        { x: cx + hw, y: cy + hh - bh },
        { x: cx - hw, y: cy + hh - bh },
      ], 'rgba(10,10,10,0.80)');
    }

    if (sw > 8 && zoom > 0.38) {
      _windowGrid(cx, cy, hw, hh, 0, 0, 3, 4, 'rgba(180,220,255,0.90)');
    }
  }

  function _windowGrid(cx, cy, hw, hh, topBias, botBias, cols, rows, color) {
    const usableH = hh * 2 * (1.0 - topBias - botBias - 0.12);
    const usableW = hw * 2 * 0.78;
    const winH    = Math.max(1, usableH / rows * 0.58);
    const winW    = Math.max(1, usableW / cols * 0.62);
    const stepH   = usableH / rows;
    const stepW   = usableW / cols;
    const startX  = cx - usableW * 0.5 + stepW * 0.5;
    const startY  = cy - hh + hh * 2 * topBias + hh * 2 * 0.07 + stepH * 0.5;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const wx = startX + c * stepW;
        const wy = startY + r * stepH;
        _ctx.fillStyle = color;
        _ctx.fillRect(wx - winW * 0.5, wy - winH * 0.5, winW, winH);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // LAYER 3: TREES
  // ─────────────────────────────────────────────────────────────

  function _drawTrees(world, cam) {
    if (!world.trees || !world.trees.length) return;
    const aabb = StateController.getViewportAABB();
    const zoom = cam.zoomLevel;

    for (const t of world.trees) {
      if (t.x < aabb.minX - 30 || t.x > aabb.maxX + 30 ||
          t.y < aabb.minY - 30 || t.y > aabb.maxY + 30) continue;

      const s  = MathEngine.worldToScreen(t.x, t.y, cam);
      const sr = MathEngine.worldLenToScreen(t.r, zoom);
      if (sr < 1.5) continue;

      _ctx.save();
      _ctx.globalAlpha = 0.20;
      _ctx.beginPath();
      _ctx.ellipse(s.x, s.y + sr * 0.68, sr * 0.82, sr * 0.26, 0, 0, MathEngine.TAU);
      _ctx.fillStyle = '#184010';
      _ctx.fill();
      _ctx.restore();

      _ctx.beginPath();
      _ctx.arc(s.x, s.y + sr * 0.12, sr, 0, MathEngine.TAU);
      _ctx.fillStyle = t.shade < 2 ? '#2ea03a' : '#25943a';
      _ctx.fill();

      _ctx.beginPath();
      _ctx.arc(s.x, s.y, sr, 0, MathEngine.TAU);
      _ctx.fillStyle = t.shade < 2 ? '#3db84a' : '#32a840';
      _ctx.fill();

      if (sr > 4) {
        _ctx.beginPath();
        _ctx.arc(s.x - sr * 0.27, s.y - sr * 0.22, sr * 0.44, 0, MathEngine.TAU);
        _ctx.fillStyle = '#62d870';
        _ctx.fill();
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // LAYER 4: ROADS (3-pass + search overlay + A* path overlay)
  // ─────────────────────────────────────────────────────────────

  function _drawRoads(world, cam, dt) {
    if (!world.edges || !world.edges.length) return;
    const aabb = StateController.getViewportAABB();
    const zoom = cam.zoomLevel;
    const RW   = ROAD_W;

    // Catmull-Rom cubic curves benefit from more segments at close zoom.
    const poly = (edge) => {
      const baseSeg = MathEngine.adaptiveSegments(edge.curve, zoom);
      // Cubic curves (Catmull-Rom) need more precision than quadratic
      const segs = edge.curve.type === 'C' ? Math.min(48, baseSeg + 4) : baseSeg;
      return MathEngine.curveToScreenPolyline(edge.curve, cam, aabb, segs, RW);
    };

    // Determine which edges to dim (if search animation active)
    const sanim = _searchAnim && !_searchAnim.done;

    // Pass 1: Road border
    for (const e of world.edges) {
      if (_activePathSet.has(e.id)) continue;
      const p = poly(e);
      if (!p) continue;
      _strokeLine(p, ROAD_BORDER, MathEngine.worldLenToScreen(RW + 4, zoom));
    }

    // Pass 2: Tarmac fill
    for (const e of world.edges) {
      if (_activePathSet.has(e.id)) continue;
      const p = poly(e);
      if (!p) continue;
      _strokeLine(p, ROAD_FILL, MathEngine.worldLenToScreen(RW, zoom));
    }

    // Pass 3: White STATIC dashed centreline (no movement)
    _ctx.save();
    const dl = Math.max(3, MathEngine.worldLenToScreen(18, zoom));
    const gl = Math.max(3, MathEngine.worldLenToScreen(12, zoom));
    _ctx.setLineDash([dl, gl]);
    _ctx.lineDashOffset = 0;  // STATIC — no animation on centreline
    for (const e of world.edges) {
      if (_activePathSet.has(e.id)) continue;
      const p = poly(e);
      if (!p) continue;
      _strokeLine(p, ROAD_DASH, Math.max(0.8, MathEngine.worldLenToScreen(1.4, zoom)));
    }
    _ctx.setLineDash([]);
    _ctx.restore();

    // Search animation overlay
    if (sanim) {
      _drawSearchOverlay(world, cam, aabb, zoom);
    }

    // A* final path overlay
    if (_activePath && _activePathSet.size > 0 && !sanim) {
      _drawPathOverlay(world, cam, aabb);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // SEARCH ANIMATION OVERLAY
  // ─────────────────────────────────────────────────────────────

  function _tickSearchAnimation(dt) {
    if (!_searchAnim || _searchAnim.done) return;
    const sa = _searchAnim;

    if (sa.phase === 'explore') {
      sa.stepTimer += dt;

      // ── CRITICAL FIX: use `if` not `while` ────────────────────────────
      // `while` would process multiple steps in a single slow frame
      // (e.g. a 100ms frame with 80ms stepDelay would skip 1 step silently).
      // `if` enforces strictly 1 step per frame, so every node is visible
      // for at least one rendered frame regardless of frame timing.
      if (sa.stepTimer >= sa.stepDelay && sa.stepIndex < sa.visitedSequence.length) {
        sa.stepTimer -= sa.stepDelay;
        const node = sa.visitedSequence[sa.stepIndex];
        sa.litNodes.add(node.nodeId);
        sa.stepIndex++;
      }

      // Rebuild explored-edge set from currently lit nodes
      const world = StateController.world;
      if (world && world.edges) {
        sa.litExploredEdges = new Set();
        for (const e of world.edges) {
          if (sa.exploredEdges.has(e.id)) {
            if (sa.litNodes.has(e.from) || sa.litNodes.has(e.to))
              sa.litExploredEdges.add(e.id);
          }
        }
      }

      if (sa.stepIndex >= sa.visitedSequence.length) {
        sa.phase      = 'reveal';
        // revealTimer was already set in startSearchAnimation
      }

    } else if (sa.phase === 'reveal') {
      sa.revealTimer -= dt;
      if (sa.revealTimer <= 0) {
        sa.done = true;
        if (sa.onComplete) sa.onComplete();
      }
    }
  }

  function _drawSearchOverlay(world, cam, aabb, zoom) {
    if (!_searchAnim) return;
    const sa  = _searchAnim;
    const RW  = ROAD_W;

    // ── Pass 1: Ruas jalan yang sudah dieksplorasi — "Blue Wave" ─────────────
    // Ini adalah inti dari ketentuan: jalan yang dievaluasi A* menyala biru
    // dan merambat perlahan dari titik Start.
    if (sa.litExploredEdges && sa.litExploredEdges.size > 0) {
      _ctx.save();

      for (const edgeId of sa.litExploredEdges) {
        const e = world.edges[edgeId];
        if (!e) continue;

        const segs = MathEngine.adaptiveSegments(e.curve, zoom);
        const p    = MathEngine.curveToScreenPolyline(e.curve, cam, aabb, segs, RW);
        if (!p || p.length < 2) continue;

        // Layer 1: Glow lebar biru gelap (halo)
        _strokeLine(p, 'rgba(0, 80, 220, 0.28)',
          MathEngine.worldLenToScreen(RW + 10, zoom));

        // Layer 2: Fill biru cerah (jalan utama diwarnai)
        _strokeLine(p, 'rgba(30, 140, 255, 0.55)',
          MathEngine.worldLenToScreen(RW, zoom));

        // Layer 3: Core highlight biru muda tipis (tepi tengah bersinar)
        _strokeLine(p, 'rgba(140, 210, 255, 0.70)',
          MathEngine.worldLenToScreen(RW * 0.30, zoom));
      }

      _ctx.restore();
    }

    // ── Pass 2: Lingkaran ripple di setiap node yang dikunjungi ──────────────
    // Melengkapi efek: "wave front" tampak sebagai lingkaran di persimpangan.
    _ctx.save();
    for (const nodeId of sa.litNodes) {
      const node = world.nodes[nodeId];
      if (!node) continue;
      const s = MathEngine.worldToScreen(node.x, node.y, cam);
      const r = MathEngine.worldLenToScreen(9, zoom);

      // Outer glow ring
      _ctx.beginPath();
      _ctx.arc(s.x, s.y, r * 2.2, 0, MathEngine.TAU);
      _ctx.fillStyle = 'rgba(0, 100, 255, 0.12)';
      _ctx.fill();

      // Inner filled dot — titik biru solid
      _ctx.beginPath();
      _ctx.arc(s.x, s.y, Math.max(2, r * 0.65), 0, MathEngine.TAU);
      _ctx.fillStyle   = 'rgba(80, 180, 255, 0.85)';
      _ctx.fill();
      _ctx.strokeStyle = 'rgba(200, 235, 255, 0.70)';
      _ctx.lineWidth   = 1;
      _ctx.stroke();
    }
    _ctx.restore();
  }

  // ─────────────────────────────────────────────────────────────
  // A* PATH OVERLAY (shown after search animation completes)
  // ─────────────────────────────────────────────────────────────

  function _drawPathOverlay(world, cam, aabb) {
    const zoom  = cam.zoomLevel;
    const RW    = ROAD_W;

    for (const pe of _activePath.pathEdges) {
      const segs = MathEngine.adaptiveSegments(pe.curve, zoom);
      const p    = MathEngine.curveToScreenPolyline(pe.curve, cam, aabb, segs, RW);
      if (!p || p.length < 2) continue;

      // Border
      _strokeLine(p, '#905800', MathEngine.worldLenToScreen(RW + 4, zoom));
      // Orange fill
      _strokeLine(p, '#e89018', MathEngine.worldLenToScreen(RW, zoom));

      // Animated yellow dash chain on path (bergerak mengikuti waktu)
      _ctx.save();
      const dl = Math.max(3, MathEngine.worldLenToScreen(14, zoom));
      const gl = Math.max(2, MathEngine.worldLenToScreen(6, zoom));
      _ctx.setLineDash([dl, gl]);
      _ctx.lineDashOffset = -_time * 40;  // Memberikan efek animasi mengalir (bergerak)
      _strokeLine(p, '#f5d820', MathEngine.worldLenToScreen(2.5, zoom));
      _ctx.setLineDash([]);
      _ctx.restore();
    }
  }

  // ─────────────────────────────────────────────────────────────
  // LAYER 5: INTERSECTION NODES
  // ─────────────────────────────────────────────────────────────

  function _drawNodes(world, cam) {
    if (!world.nodes || cam.zoomLevel < 0.12) return;
    const aabb  = StateController.getViewportAABB();
    const pulse = 0.5 + 0.5 * Math.sin(_time * 4);

    for (const node of world.nodes) {
      if (node.x < aabb.minX - 20 || node.x > aabb.maxX + 20 ||
          node.y < aabb.minY - 20 || node.y > aabb.maxY + 20) continue;

      const s       = MathEngine.worldToScreen(node.x, node.y, cam);
      const isStart = node.id === _startNodeId;
      const isGoal  = node.id === _goalNodeId;

      if (isStart || isGoal) {
        const col = isStart ? '#20cc60' : '#ee2244';
        const r   = Math.max(8, MathEngine.worldLenToScreen(14, cam.zoomLevel));

        // Pulsing halo
        _ctx.beginPath();
        _ctx.arc(s.x, s.y, r * (1.55 + pulse * 0.6), 0, MathEngine.TAU);
        _ctx.fillStyle = col + '2e';
        _ctx.fill();

        // Filled circle
        _ctx.beginPath();
        _ctx.arc(s.x, s.y, r, 0, MathEngine.TAU);
        _ctx.fillStyle   = col;
        _ctx.fill();
        _ctx.strokeStyle = '#fff';
        _ctx.lineWidth   = 2.5;
        _ctx.stroke();

        // A / B label
        if (cam.zoomLevel > 0.22) {
          _ctx.textAlign    = 'center';
          _ctx.textBaseline = 'middle';
          _ctx.fillStyle    = '#fff';
          _ctx.font         = `bold ${Math.min(13, Math.max(7, r))}px sans-serif`;
          _ctx.fillText(isStart ? 'A' : 'B', s.x, s.y);
          _ctx.textAlign    = 'left';
          _ctx.textBaseline = 'alphabetic';
        }

      } else if (cam.zoomLevel > 0.16) {
        // ── Intersection dot — visible at much lower zoom levels ──────────
        // This fulfils the requirement: "Every vertex must show a clear dot
        // to reveal the underlying graph structure."
        const r = Math.max(2, MathEngine.worldLenToScreen(4.5, cam.zoomLevel));

        // Outer ring (slate-blue, stands out from road tarmac)
        _ctx.beginPath();
        _ctx.arc(s.x, s.y, r + 1.2, 0, MathEngine.TAU);
        _ctx.fillStyle = 'rgba(90, 105, 140, 0.70)';
        _ctx.fill();

        // Inner filled dot
        _ctx.beginPath();
        _ctx.arc(s.x, s.y, r, 0, MathEngine.TAU);
        _ctx.fillStyle   = '#b8c4d8';
        _ctx.fill();
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // LAYER 6: RED BUS
  // ─────────────────────────────────────────────────────────────

  function _drawCar(vehicle, cam) {
    if (!vehicle || !vehicle.pose) return;
    const { x, y, angle } = vehicle.pose;
    const aabb = StateController.getViewportAABB();
    if (x < aabb.minX - 60 || x > aabb.maxX + 60 ||
        y < aabb.minY - 60 || y > aabb.maxY + 60) return;

    const s    = MathEngine.worldToScreen(x, y, cam);
    const zoom = cam.zoomLevel;
    const bL   = MathEngine.worldLenToScreen(18, zoom);
    const bW   = MathEngine.worldLenToScreen(9,  zoom);
    if (bL < 3) return;

    const cos = Math.cos(angle), sin = Math.sin(angle);
    const rp = (lx, ly) => ({
      x: s.x + lx * cos - ly * sin,
      y: s.y + lx * sin + ly * cos,
    });

    // Shadow
    _fillPoly(_rotRect(s.x + 2, s.y + 3, bL*2, bW*2, angle), 'rgba(0,0,0,0.32)');

    // Body
    _fillPoly(_rotRect(s.x, s.y, bL*2, bW*2, angle), '#cc2233');
    _strokePoly(_rotRect(s.x, s.y, bL*2, bW*2, angle), 'rgba(0,0,0,0.45)', 1.2);

    // Cab front darkening
    if (bL > 6) {
      _fillPoly([rp(bL,-bW), rp(bL,bW), rp(bL*0.42,bW), rp(bL*0.42,-bW)],
               'rgba(0,0,0,0.18)');
    }

    // Windshield
    if (bL > 7) {
      _fillPoly([rp(bL*0.90,-bW*0.72), rp(bL*0.90,bW*0.72),
                 rp(bL*0.42, bW*0.72), rp(bL*0.42,-bW*0.72)],
               'rgba(215,238,255,0.90)');
    }

    // Wheels
    const wlx = bL * 0.55, wly = bW * 1.06;
    const wrX = bL * 0.12, wrY = bW * 0.20;
    const wAng = angle + Math.PI * 0.5;
    for (const [lx, ly] of [[-wlx,-wly],[-wlx,wly],[wlx,-wly],[wlx,wly]]) {
      const wc = rp(lx, ly);
      _ctx.beginPath();
      _ctx.ellipse(wc.x, wc.y, wrX, wrY, wAng, 0, MathEngine.TAU);
      _ctx.fillStyle   = '#f5c518';
      _ctx.fill();
      _ctx.strokeStyle = '#888';
      _ctx.lineWidth   = 0.8;
      _ctx.stroke();
    }

    // Headlights
    for (const sy of [-1, 1]) {
      const hp = rp(bL * 0.96, sy * bW * 0.72);
      _ctx.beginPath();
      _ctx.arc(hp.x, hp.y, bL * 0.09, 0, MathEngine.TAU);
      _ctx.fillStyle = 'rgba(255,255,210,0.95)';
      _ctx.fill();
    }
  }

  // ─────────────────────────────────────────────────────────────
  // LAYER 7: MINIMAP
  // ─────────────────────────────────────────────────────────────

  function _drawMinimap(world, cam, vp) {
    if (!world.nodes || !world.islandPoly) return;
    const cfg = MapGenerator.CFG;
    const MW = 140, MH = 100;
    const MX = vp.width  - MW - 12;
    const MY = vp.height - MH - 12;

    _ctx.fillStyle   = 'rgba(10,20,34,0.90)';
    _ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    _ctx.lineWidth   = 1;
    _ctx.fillRect(MX, MY, MW, MH);
    _ctx.strokeRect(MX, MY, MW, MH);

    const sc  = Math.min(MW / cfg.WORLD_W, MH / cfg.WORLD_H);
    const toM = (wx, wy) => ({ x: MX + wx * sc, y: MY + wy * sc });

    // Island
    if (world.islandPoly.length > 2) {
      _ctx.beginPath();
      const p0 = toM(world.islandPoly[0].x, world.islandPoly[0].y);
      _ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < world.islandPoly.length; i++) {
        const p = toM(world.islandPoly[i].x, world.islandPoly[i].y);
        _ctx.lineTo(p.x, p.y);
      }
      _ctx.closePath();
      _ctx.fillStyle = '#4a7830';
      _ctx.fill();
    }

    // Roads
    const sa = _searchAnim && !_searchAnim.done;
    for (const e of (world.edges || [])) {
      const pts = MathEngine.sampleBezier(e.curve, 6);
      if (pts.length < 2) continue;
      const isPath     = _activePathSet.has(e.id);
      const isExplored = sa && _searchAnim.litExploredEdges && _searchAnim.litExploredEdges.has(e.id);
      _ctx.beginPath();
      const p0 = toM(pts[0].x, pts[0].y);
      _ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < pts.length; i++) {
        const p = toM(pts[i].x, pts[i].y);
        _ctx.lineTo(p.x, p.y);
      }
      _ctx.strokeStyle = isPath ? '#e08010' : (isExplored ? '#00ccdd' : ROAD_BORDER);
      _ctx.lineWidth   = isPath ? 1.5 : (isExplored ? 1.2 : 0.8);
      _ctx.stroke();
    }

    // Car dot
    const car = (StateController.vehicles || [])[0];
    if (car && car.pose) {
      const cp = toM(car.pose.x, car.pose.y);
      _ctx.beginPath();
      _ctx.arc(cp.x, cp.y, 2.5, 0, MathEngine.TAU);
      _ctx.fillStyle = '#cc2233';
      _ctx.fill();
    }

    // Viewport rect
    const vpAABB = StateController.getViewportAABB();
    const vTL    = toM(vpAABB.minX, vpAABB.minY);
    const vBR    = toM(vpAABB.maxX, vpAABB.maxY);
    _ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    _ctx.lineWidth   = 1;
    _ctx.strokeRect(vTL.x, vTL.y, vBR.x - vTL.x, vBR.y - vTL.y);

    _ctx.fillStyle = 'rgba(255,255,255,0.28)';
    _ctx.font      = '6px sans-serif';
    _ctx.textAlign = 'right';
    _ctx.fillText('MINIMAP', MX + MW - 3, MY + MH - 3);
    _ctx.textAlign = 'left';
  }

  // ─────────────────────────────────────────────────────────────
  // MAIN DRAW
  // ─────────────────────────────────────────────────────────────

  function drawFrame(dt) {
    if (!_ctx) return;
    _time += dt || 0.016;

    const vp       = StateController.viewport;
    const cam      = StateController.camera;
    const world    = StateController.world;
    const vehicles = StateController.vehicles;
    const car      = vehicles && vehicles.length > 0 ? vehicles[0] : null;

    // Tick search animation
    _tickSearchAnimation(dt);

    _drawOceanIsland(vp, cam, world);
    _drawBuildings(world, cam);
    _drawTrees(world, cam);
    _drawRoads(world, cam, dt);
    _drawNodes(world, cam);

    // Only draw car if NOT in search animation phase
    if (!(_searchAnim && !_searchAnim.done)) {
      _drawCar(car, cam);
    }

    _drawMinimap(world, cam, vp);
  }

  return Object.freeze({
    init, drawFrame, setActivePath,
    startSearchAnimation, stopSearchAnimation, isSearchAnimating,
  });

})();
