/**
 * ═══════════════════════════════════════════════════════════════
 *  URBS — StateController.js
 *  Module 1 of 6
 *
 *  Responsibilities:
 *    • Owns ALL mutable global state (camera, zoom, world graph,
 *      vehicles, frame timing, debug flags).
 *    • Exposes a typed, documented public API — no other module
 *      is permitted to mutate state directly.
 *    • Manages raw input events (mouse, wheel, keyboard) and
 *      translates them into camera delta operations.
 *    • Provides a lightweight EventBus so modules communicate
 *      without coupling to each other.
 *    • Feeds the UI overlay with live readouts via DOM writes
 *      (intentionally kept here — UI sync is a state concern).
 *
 *  Contract for other modules:
 *    READ  → State.camera, State.world, State.config, State.debug
 *    WRITE → State.setCameraPos(), State.setCameraZoom(),
 *             State.panCamera(), State.resetCamera(),
 *             State.setWorldData(), State.registerVehicle(), etc.
 *    LISTEN → State.on(event, handler)
 *    EMIT  → State.emit(event, payload)
 * ═══════════════════════════════════════════════════════════════
 */

const StateController = (() => {

  // ─────────────────────────────────────────────────────────────
  // 1. CONFIGURATION  (read-only after init)
  // ─────────────────────────────────────────────────────────────
  const CONFIG = Object.freeze({
    // World coordinate space (logical pixels)
    WORLD_WIDTH:      2000,
    WORLD_HEIGHT:     1600,

    // Zoom limits
    ZOOM_MIN:         0.15,
    ZOOM_MAX:         6.0,
    ZOOM_STEP_WHEEL:  0.001,   // multiplied by deltaY magnitude
    ZOOM_STEP_KEY:    0.12,    // per keypress

    // Pan inertia
    PAN_FRICTION:     0.88,    // velocity decay per frame (0–1)
    PAN_MIN_VELOCITY: 0.3,     // px/frame below which inertia stops

    // Initial camera (centred on world)
    INITIAL_ZOOM:     0.9,

    // UI refresh rate (every N frames to avoid thrashing the DOM)
    UI_REFRESH_EVERY: 4,
  });

  // ─────────────────────────────────────────────────────────────
  // 2. CAMERA STATE
  //    cameraX / cameraY = world-space coordinate visible at the
  //    TOP-LEFT corner of the canvas viewport.
  //    All world→screen math uses these three values exclusively.
  // ─────────────────────────────────────────────────────────────
  const _camera = {
    x:         0,          // world-space X of viewport top-left
    y:         0,          // world-space Y of viewport top-left
    zoomLevel: CONFIG.INITIAL_ZOOM,

    // Inertia / pan velocity (world-space units per frame)
    vx: 0,
    vy: 0,

    // Panning interaction state
    isPanning:    false,
    panStartX:    0,       // screen px where drag started
    panStartY:    0,
    panOriginX:   0,       // camera.x when drag started
    panOriginY:   0,
  };

  // ─────────────────────────────────────────────────────────────
  // 3. WORLD / GRAPH STATE  (populated by MapGenerator)
  // ─────────────────────────────────────────────────────────────
  const _world = {
    nodes:     [],    // Array<{ id, x, y, kind }>
    edges:     [],    // Array<{ from, to, curve: BezierDef, length }>
    adjacency: {},    // Map<nodeId, Array<{ nodeId, edgeIdx }>>
    buildings: [],    // Array<{ x, y, w, h, angle, floors }>
    trees:     [],    // Array<{ x, y, r, shade }>
    islandPoly:[],    // Array<{ x, y }> — coastline polygon
    generated: false,
  };

  // ─────────────────────────────────────────────────────────────
  // 4. VEHICLE STATE  (populated by animation system)
  // ─────────────────────────────────────────────────────────────
  const _vehicles = [];   // Array<VehicleObject>

  // ─────────────────────────────────────────────────────────────
  // 5. FRAME / TIMING STATE
  // ─────────────────────────────────────────────────────────────
  const _timing = {
    frameCount:  0,
    lastTime:    0,       // DOMHighResTimeStamp of previous rAF
    fps:         0,
    deltaTime:   0,       // seconds since last frame (capped)
    rafHandle:   null,
  };

  // ─────────────────────────────────────────────────────────────
  // 6. CANVAS / VIEWPORT  (set on init and resize)
  // ─────────────────────────────────────────────────────────────
  const _viewport = {
    canvas:  null,   // HTMLCanvasElement
    ctx:     null,   // CanvasRenderingContext2D (Renderer sets this)
    width:   0,      // canvas CSS / logical pixel width
    height:  0,
  };

  // ─────────────────────────────────────────────────────────────
  // 7. DEBUG FLAGS
  // ─────────────────────────────────────────────────────────────
  const _debug = {
    enabled:        false,
    showNodes:      true,
    showEdgeIds:    false,
    showGrid:       false,
    showAABBClip:   false,
    log:            [],
    MAX_LOG:        80,
  };

  // ─────────────────────────────────────────────────────────────
  // 8. EVENT BUS  (publish / subscribe, no external lib)
  // ─────────────────────────────────────────────────────────────
  const _listeners = {};

  function on(event, handler) {
    if (!_listeners[event]) _listeners[event] = [];
    _listeners[event].push(handler);
  }

  function off(event, handler) {
    if (!_listeners[event]) return;
    _listeners[event] = _listeners[event].filter(h => h !== handler);
  }

  function emit(event, payload) {
    if (!_listeners[event]) return;
    for (const h of _listeners[event]) {
      try { h(payload); }
      catch (e) { console.error(`[EventBus] handler error on "${event}":`, e); }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 9. CAMERA  PUBLIC API
  // ─────────────────────────────────────────────────────────────

  /**
   * Set camera position directly (world-space).
   * Clamps so the viewport never goes beyond the world bounds.
   */
  function setCameraPos(x, y) {
    const maxX = CONFIG.WORLD_WIDTH  - (_viewport.width  / _camera.zoomLevel);
    const maxY = CONFIG.WORLD_HEIGHT - (_viewport.height / _camera.zoomLevel);
    _camera.x = Math.max(0, Math.min(x, Math.max(0, maxX)));
    _camera.y = Math.max(0, Math.min(y, Math.max(0, maxY)));
    emit('camera:moved', getCameraSnapshot());
  }

  /**
   * Apply a delta in world-space units.
   * Used by pan handlers and inertia.
   */
  function panCamera(dx, dy) {
    setCameraPos(_camera.x + dx, _camera.y + dy);
  }

  /**
   * Set zoom level, optionally anchoring around a screen-space
   * pivot point (e.g. the mouse cursor position).
   * Anchor defaults to canvas centre.
   *
   * @param {number} newZoom
   * @param {number} [pivotScreenX]
   * @param {number} [pivotScreenY]
   */
  function setCameraZoom(newZoom, pivotScreenX, pivotScreenY) {
    const clamped = Math.max(CONFIG.ZOOM_MIN, Math.min(CONFIG.ZOOM_MAX, newZoom));
    if (clamped === _camera.zoomLevel) return;

    const px = pivotScreenX !== undefined ? pivotScreenX : _viewport.width  / 2;
    const py = pivotScreenY !== undefined ? pivotScreenY : _viewport.height / 2;

    // World coordinate under pivot BEFORE zoom change
    const worldPivotX = _camera.x + px / _camera.zoomLevel;
    const worldPivotY = _camera.y + py / _camera.zoomLevel;

    _camera.zoomLevel = clamped;

    // Reposition camera so the same world point stays under pivot
    const newCamX = worldPivotX - px / _camera.zoomLevel;
    const newCamY = worldPivotY - py / _camera.zoomLevel;
    setCameraPos(newCamX, newCamY);

    emit('camera:zoomed', getCameraSnapshot());
  }

  /**
   * Reset camera to show the entire world centred in viewport.
   */
  function resetCamera() {
    const fitZoomX = _viewport.width  / CONFIG.WORLD_WIDTH;
    const fitZoomY = _viewport.height / CONFIG.WORLD_HEIGHT;
    const fitZoom  = Math.min(fitZoomX, fitZoomY) * 0.92; // 8% padding

    _camera.vx = 0;
    _camera.vy = 0;
    _camera.zoomLevel = Math.max(CONFIG.ZOOM_MIN, Math.min(CONFIG.ZOOM_MAX, fitZoom));

    // Centre the world
    const worldVisW = _viewport.width  / _camera.zoomLevel;
    const worldVisH = _viewport.height / _camera.zoomLevel;
    _camera.x = (CONFIG.WORLD_WIDTH  - worldVisW) / 2;
    _camera.y = (CONFIG.WORLD_HEIGHT - worldVisH) / 2;

    emit('camera:reset', getCameraSnapshot());
  }

  /** Snapshot of camera for read-only consumption by other modules */
  function getCameraSnapshot() {
    return {
      x:         _camera.x,
      y:         _camera.y,
      zoomLevel: _camera.zoomLevel,
    };
  }

  /** World-space AABB of the current viewport (for clipping) */
  function getViewportAABB() {
    const visW = _viewport.width  / _camera.zoomLevel;
    const visH = _viewport.height / _camera.zoomLevel;
    return {
      minX: _camera.x,
      minY: _camera.y,
      maxX: _camera.x + visW,
      maxY: _camera.y + visH,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // 10. WORLD DATA  PUBLIC API
  // ─────────────────────────────────────────────────────────────

  function setWorldData({ nodes, edges, adjacency, buildings, trees, islandPoly }) {
    _world.nodes      = nodes      || [];
    _world.edges      = edges      || [];
    _world.adjacency  = adjacency  || {};
    _world.buildings  = buildings  || [];
    _world.trees      = trees      || [];
    _world.islandPoly = islandPoly || [];
    _world.generated  = true;
    emit('world:ready', { nodeCount: _world.nodes.length, edgeCount: _world.edges.length });
  }

  // ─────────────────────────────────────────────────────────────
  // 11. VEHICLE  PUBLIC API
  // ─────────────────────────────────────────────────────────────

  function registerVehicle(vehicle) {
    _vehicles.push(vehicle);
    emit('vehicles:updated', { count: _vehicles.length });
  }

  function removeVehicle(id) {
    const idx = _vehicles.findIndex(v => v.id === id);
    if (idx !== -1) {
      _vehicles.splice(idx, 1);
      emit('vehicles:updated', { count: _vehicles.length });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 12. TIMING  PUBLIC API
  // ─────────────────────────────────────────────────────────────

  /**
   * Called once per rAF tick by main.js.
   * Returns computed deltaTime in seconds.
   */
  function tickTiming(timestamp) {
    const MAX_DELTA = 1 / 15; // cap at ~67 ms to avoid spiral of death
    _timing.deltaTime = _timing.lastTime
      ? Math.min((timestamp - _timing.lastTime) / 1000, MAX_DELTA)
      : 0;
    _timing.lastTime  = timestamp;
    _timing.frameCount++;

    // Rolling FPS over 30 frames
    if (_timing.deltaTime > 0) {
      const raw = 1 / _timing.deltaTime;
      _timing.fps = _timing.fps === 0
        ? raw
        : _timing.fps * 0.9 + raw * 0.1;
    }

    return _timing.deltaTime;
  }

  // ─────────────────────────────────────────────────────────────
  // 13. INERTIA TICK  (called per frame from main loop)
  // ─────────────────────────────────────────────────────────────

  function tickInertia() {
    if (_camera.isPanning) return; // don't apply inertia while dragging

    const speed = Math.sqrt(_camera.vx * _camera.vx + _camera.vy * _camera.vy);
    if (speed < CONFIG.PAN_MIN_VELOCITY) {
      _camera.vx = 0;
      _camera.vy = 0;
      return;
    }

    panCamera(_camera.vx, _camera.vy);
    _camera.vx *= CONFIG.PAN_FRICTION;
    _camera.vy *= CONFIG.PAN_FRICTION;
  }

  // ─────────────────────────────────────────────────────────────
  // 14. INPUT HANDLERS
  // ─────────────────────────────────────────────────────────────

  function _onMouseDown(e) {
    if (e.button !== 0) return;
    _camera.isPanning  = true;
    _camera.panStartX  = e.clientX;
    _camera.panStartY  = e.clientY;
    _camera.panOriginX = _camera.x;
    _camera.panOriginY = _camera.y;
    _camera.vx = 0;
    _camera.vy = 0;
  }

  function _onMouseMove(e) {
    if (!_camera.isPanning) return;

    const dxScreen = e.clientX - _camera.panStartX;
    const dyScreen = e.clientY - _camera.panStartY;

    // Screen delta → world delta (divide by zoom)
    const dxWorld = -dxScreen / _camera.zoomLevel;
    const dyWorld = -dyScreen / _camera.zoomLevel;

    const newX = _camera.panOriginX + dxWorld;
    const newY = _camera.panOriginY + dyWorld;
    setCameraPos(newX, newY);

    // Capture velocity for inertia on release
    _camera.vx = -e.movementX / _camera.zoomLevel;
    _camera.vy = -e.movementY / _camera.zoomLevel;
  }

  function _onMouseUp() {
    _camera.isPanning = false;
    // inertia carries on from _camera.vx/vy
  }

  function _onMouseLeave() {
    _camera.isPanning = false;
  }

  function _onWheel(e) {
    e.preventDefault();
    const delta    = e.deltaY;
    const factor   = 1 - delta * CONFIG.ZOOM_STEP_WHEEL;
    const newZoom  = _camera.zoomLevel * factor;
    setCameraZoom(newZoom, e.clientX, e.clientY);
  }

  function _onKeyDown(e) {
    switch (e.key.toUpperCase()) {
      case 'R':
        resetCamera();
        _debugLog('Camera reset');
        break;
      case 'D':
        _debug.enabled = !_debug.enabled;
        document.getElementById('debug-panel')?.classList.toggle('hidden', !_debug.enabled);
        _debugLog(`Debug ${_debug.enabled ? 'ON' : 'OFF'}`);
        break;
      case '+':
      case '=':
        setCameraZoom(_camera.zoomLevel * (1 + CONFIG.ZOOM_STEP_KEY));
        break;
      case '-':
        setCameraZoom(_camera.zoomLevel * (1 - CONFIG.ZOOM_STEP_KEY));
        break;
    }
    emit('key:down', { key: e.key });
  }

  // ─────────────────────────────────────────────────────────────
  // 15. DEBUG LOGGING
  // ─────────────────────────────────────────────────────────────

  function _debugLog(msg) {
    const ts = _timing.frameCount;
    const entry = `[${String(ts).padStart(6, '0')}] ${msg}`;
    _debug.log.unshift(entry);
    if (_debug.log.length > _debug.MAX_LOG) _debug.log.pop();

    if (_debug.enabled) {
      const el = document.getElementById('debug-log');
      if (el) el.textContent = _debug.log.slice(0, 25).join('\n');
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 16. UI SYNC  (writes to DOM overlay)
  // ─────────────────────────────────────────────────────────────

  function _syncUI() {
    if (_timing.frameCount % CONFIG.UI_REFRESH_EVERY !== 0) return;

    const set = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };

    set('stat-camX',    _camera.x.toFixed(2));
    set('stat-camY',    _camera.y.toFixed(2));
    set('stat-zoom',    _camera.zoomLevel.toFixed(3));
    set('stat-viewport',`${_viewport.width}×${_viewport.height}`);
    set('stat-nodes',   _world.nodes.length);
    set('stat-edges',   _world.edges.length);
    set('stat-vehicles',_vehicles.length);
    set('stat-fps',     _timing.fps > 0 ? _timing.fps.toFixed(1) : '—');
  }

  // ─────────────────────────────────────────────────────────────
  // 17. RESIZE HANDLER
  // ─────────────────────────────────────────────────────────────

  function _onResize() {
    if (!_viewport.canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w   = window.innerWidth;
    const h   = window.innerHeight;

    _viewport.canvas.width  = w * dpr;
    _viewport.canvas.height = h * dpr;
    _viewport.canvas.style.width  = `${w}px`;
    _viewport.canvas.style.height = `${h}px`;
    _viewport.width  = w;
    _viewport.height = h;

    // Scale ctx for retina (this is the ONE place we touch ctx transform —
    // it's a display scaling concern, not a world-space transform)
    if (_viewport.ctx) {
      _viewport.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    emit('viewport:resized', { width: w, height: h, dpr });
    _debugLog(`Resize → ${w}×${h} @${dpr}x`);
  }

  // ─────────────────────────────────────────────────────────────
  // 18. INITIALISE
  // ─────────────────────────────────────────────────────────────

  function init() {
    const canvas = document.getElementById('cityCanvas');
    if (!canvas) throw new Error('[StateController] #cityCanvas not found');

    _viewport.canvas = canvas;

    // Wire input events on canvas
    canvas.addEventListener('mousedown',  _onMouseDown);
    canvas.addEventListener('mousemove',  _onMouseMove);
    canvas.addEventListener('mouseup',    _onMouseUp);
    canvas.addEventListener('mouseleave', _onMouseLeave);
    canvas.addEventListener('wheel',      _onWheel, { passive: false });

    // Keyboard on window
    window.addEventListener('keydown', _onKeyDown);
    window.addEventListener('resize',  _onResize);

    // Zoom Buttons
    const btnZoomIn  = document.getElementById('btn-zoom-in');
    const btnZoomOut = document.getElementById('btn-zoom-out');
    if (btnZoomIn) {
      btnZoomIn.addEventListener('click', () => {
        setCameraZoom(_camera.zoomLevel * (1 + CONFIG.ZOOM_STEP_KEY));
      });
    }
    if (btnZoomOut) {
      btnZoomOut.addEventListener('click', () => {
        setCameraZoom(_camera.zoomLevel * (1 - CONFIG.ZOOM_STEP_KEY));
      });
    }

    // Initial size pass
    _onResize();

    // Place camera centred on world
    resetCamera();

    _debugLog('StateController init OK');
    emit('state:ready');

    return true;
  }

  // ─────────────────────────────────────────────────────────────
  // 19. PER-FRAME TICK  (called by main.js RAF loop)
  // ─────────────────────────────────────────────────────────────

  function tick(timestamp) {
    tickTiming(timestamp);
    tickInertia();
    _syncUI();
  }

  // ─────────────────────────────────────────────────────────────
  // 20. PUBLIC API  (frozen export object)
  // ─────────────────────────────────────────────────────────────
  return Object.freeze({
    // Lifecycle
    init,
    tick,

    // Camera
    setCameraPos,
    setCameraZoom,
    panCamera,
    resetCamera,
    getCameraSnapshot,
    getViewportAABB,

    // World data
    setWorldData,

    // Vehicles
    registerVehicle,
    removeVehicle,

    // Event bus
    on,
    off,
    emit,

    // Debug
    debugLog: _debugLog,

    // Read-only accessors (avoid direct property mutation)
    get camera()   { return Object.freeze({ ..._camera }); },
    get world()    { return _world;    },   // array refs are intentionally live
    get vehicles() { return _vehicles; },
    get timing()   { return Object.freeze({ ..._timing }); },
    get viewport() { return Object.freeze({ ..._viewport, canvas: _viewport.canvas }); },
    get config()   { return CONFIG; },
    get debug()    { return _debug; },

    // Allow Renderer to register the context after it sets up
    setContext(ctx) {
      _viewport.ctx = ctx;
      // Re-apply DPR scaling to the new context
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    },
  });

})(); // IIFE — StateController is a singleton
