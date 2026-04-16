/**
 * ═══════════════════════════════════════════════════════════════
 *  URBS — main.js  |  Dashboard / Map Pathfinding Edition
 *
 *  Controls:
 *    Map 1-5       → 5 preset maps with fixed seeds
 *    Acak          → random seed map
 *    Set Start     → click canvas → pick nearest node → A
 *    Set End       → click canvas → pick nearest node → B
 *    Start Track   → run/pause single car on A* route
 *    Reset         → restart car from A
 *
 *  Route flow:
 *    1. User picks Start & End
 *    2. A* runs immediately (instant)
 *    3. Search animation plays (visiting nodes shown step by step)
 *    4. When animation complete → path revealed → car starts moving
 * ═══════════════════════════════════════════════════════════════
 */

(function bootstrap() {

  // ─────────────────────────────────────────────────────────────
  // CONSTANTS & STATE
  // ─────────────────────────────────────────────────────────────

  const CAR_SPEED = 110;  // world units / second

  const PICK = Object.freeze({ NONE: 0, START: 1, END: 2 });

  // 5 preset map seeds
  const PRESET_MAPS = [
    { seed: 1234,  label: 'Peta 1' },
    { seed: 5678,  label: 'Peta 2' },
    { seed: 9999,  label: 'Peta 3' },
    { seed: 31415, label: 'Peta 4' },
    { seed: 88888, label: 'Peta 5' },
  ];

  let _seed         = PRESET_MAPS[0].seed;
  let _paused       = true;
  let _pickMode     = PICK.NONE;
  let _startId      = -1;
  let _goalId       = -1;
  let _car          = null;
  let _pathReady    = false;
  let _searchResult = null;   // stored A* result for animation then driving
  let _activeMapIdx = 0;

  // ─────────────────────────────────────────────────────────────
  // DOM SHORTCUTS
  // ─────────────────────────────────────────────────────────────

  const $  = id => document.getElementById(id);
  const T  = (id, v) => { const e = $(id); if (e) e.textContent = v; };

  function _status(msg, type) {
    const el = $('status-msg');
    if (!el) return;
    el.textContent = msg;
    el.className   = type || '';
  }

  function _toast(msg, ms) {
    const el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), ms || 2200);
  }

  // ─────────────────────────────────────────────────────────────
  // SINGLE CAR
  // ─────────────────────────────────────────────────────────────

  class VehicleAgent {
    constructor(pathResult) {
      this.id          = 0;
      this.color       = '#cc2233';
      this.radius      = 12;
      this.pathEdges   = pathResult.pathEdges;
      this.totalLength = pathResult.totalLength;
      this.travelled   = 0;
      this.done        = false;
      this.pose        = MathEngine.vehiclePoseOnPath(pathResult.pathEdges, 0) || null;
    }

    tick(dt) {
      if (_paused || this.done) return;
      this.travelled = Math.min(this.totalLength, this.travelled + CAR_SPEED * dt);
      const pose     = MathEngine.vehiclePoseOnPath(this.pathEdges,
        Math.min(this.travelled, this.totalLength - 0.01));
      if (pose) this.pose = pose;
      if (this.travelled >= this.totalLength) {
        this.done = true;
        _onGoalReached();
      }
    }

    reset() {
      this.travelled = 0;
      this.done      = false;
      this.pose      = MathEngine.vehiclePoseOnPath(this.pathEdges, 0) || null;
    }

    get progress() { return this.totalLength > 0 ? this.travelled / this.totalLength : 0; }
  }

  // ─────────────────────────────────────────────────────────────
  // WORLD BUILD
  // ─────────────────────────────────────────────────────────────

  function _buildWorld(seed) {
    _seed = seed;
    T('status-seed', `Seed: ${seed}`);

    const world = MapGenerator.generate({ seed });
    StateController.setWorldData(world);

    _status(`Peta siap — ${world.nodes.length} node, ${world.edges.length} edge`, '');
    StateController.debugLog(`Map seed:${seed} nodes:${world.nodes.length} edges:${world.edges.length}`);
  }

  // ─────────────────────────────────────────────────────────────
  // A* PATHFINDING + SEARCH ANIMATION
  // ─────────────────────────────────────────────────────────────

  function _runRoute() {
    if (_startId < 0 || _goalId < 0) return;
    if (_startId === _goalId) { _status('⚠ Start dan End harus berbeda!', 'warn'); return; }

    const world = StateController.world;

    // Run A* immediately (instant computation)
    const t0     = performance.now();
    const result = Pathfinder.findPath(_startId, _goalId, world);
    const ms     = (performance.now() - t0).toFixed(1);

    if (!result || result.pathEdges.length === 0) {
      _status('⚠ Tidak ada jalur — coba posisi lain', 'warn');
      Renderer.setActivePath(null, _startId, _goalId);
      $('btn-track').disabled = true;
      _pathReady = false;

      T('st-node-jalur', '—');
      T('st-edge-jalur', '—');
      T('st-jarak',      '—');
      T('st-waktu',      ms + ' ms');
      T('st-visited',    result ? result.visited : '—');
      return;
    }

    // Store result — but DON'T show path yet; play search animation first
    _searchResult = result;

    // Update stats immediately (computation time)
    const distKm  = (result.totalLength / 100).toFixed(2);
    T('st-node-jalur', result.nodeSequence.length);
    T('st-edge-jalur', result.pathEdges.length);
    T('st-jarak',      distKm + ' km');
    T('st-waktu',      ms + ' ms');
    T('st-visited',    result.visited ?? '—');

    // Disable track button temporarily...? No, enable it to "Start Track"!
    const btn = $('btn-track');
    btn.disabled     = false;
    btn.textContent  = '▶ Start Track';
    btn.classList.remove('is-paused');

    _status(`A* selesai (${ms}ms) — Pra-kalkulasi siap. Klik Start Track.`, 'active');
    _toast('✓ A* selesai! Klik Start Track untuk animasi jalur.');

    // Show start+end markers immediately
    Renderer.setActivePath(null, _startId, _goalId);

    StateController.debugLog(`A* ${_startId}→${_goalId} ok ${result.nodeSequence.length} nodes ${ms}ms`);
  }

  // ─────────────────────────────────────────────────────────────
  // CAR EVENTS
  // ─────────────────────────────────────────────────────────────

  function _onGoalReached() {
    _paused = true;
    const btn = $('btn-track');
    if (btn) {
      btn.textContent = '▶ Ulangi';
      btn.classList.remove('is-paused');
      btn.disabled = false;
    }
    _status('Kendaraan tiba di tujuan! 🏁', 'ok');
    _toast('🏁 Tujuan tercapai!');
  }

  // ─────────────────────────────────────────────────────────────
  // PICK MODE
  // ─────────────────────────────────────────────────────────────

  function _nearestNode(sx, sy) {
    const cam   = StateController.camera;
    const wp    = MathEngine.screenToWorld(sx, sy, cam);
    const nodes = StateController.world.nodes;
    if (!nodes || !nodes.length) return null;
    let best = null, bestD2 = Infinity;
    for (const n of nodes) {
      const dx = n.x - wp.x, dy = n.y - wp.y;
      const d2 = dx*dx + dy*dy;
      if (d2 < bestD2) { bestD2 = d2; best = n; }
    }
    return bestD2 < 150*150 ? best : null;
  }

  function _enterPickMode(mode) {
    _pickMode = mode;
    const canvas = $('cityCanvas');
    canvas.classList.add('pick-mode');
    $('btn-set-start').classList.toggle('active', mode === PICK.START);
    $('btn-set-end').classList.toggle('active',   mode === PICK.END);
    _status(
      mode === PICK.START ? 'Klik map untuk pilih titik Start (A)…'
                          : 'Klik map untuk pilih titik End (B)…',
      'active'
    );
  }

  function _exitPickMode() {
    _pickMode = PICK.NONE;
    $('cityCanvas').classList.remove('pick-mode');
    $('btn-set-start').classList.remove('active');
    $('btn-set-end').classList.remove('active');
  }

  // ─────────────────────────────────────────────────────────────
  // CANVAS EVENTS
  // ─────────────────────────────────────────────────────────────

  const canvas = $('cityCanvas');

  canvas.addEventListener('click', (e) => {
    if (_pickMode === PICK.NONE) return;
    const node = _nearestNode(e.clientX, e.clientY);
    if (!node) { _status('Terlalu jauh dari node — klik lebih dekat', 'warn'); return; }

    if (_pickMode === PICK.START) {
      _startId = node.id;
      Renderer.setActivePath(null, _startId, _goalId);
      Renderer.stopSearchAnimation();
      _toast(`▲ Start ditetapkan: Node #${node.id}`);
      _exitPickMode();
      _status(`Start = Node #${_startId}${_goalId >= 0 ? ' — menghitung rute…' : ' — sekarang pilih End'}`, 'active');
      if (_goalId >= 0) { _car = null; $('btn-track').disabled = true; setTimeout(_runRoute, 20); }
    } else if (_pickMode === PICK.END) {
      _goalId = node.id;
      Renderer.setActivePath(null, _startId, _goalId);
      Renderer.stopSearchAnimation();
      _toast(`▼ End ditetapkan: Node #${node.id}`);
      _exitPickMode();
      _status(`End = Node #${_goalId}${_startId >= 0 ? ' — menghitung rute…' : ' — sekarang pilih Start'}`, 'active');
      if (_startId >= 0) { _car = null; $('btn-track').disabled = true; setTimeout(_runRoute, 20); }
    }
  });

  canvas.addEventListener('mousedown', () => {
    if (_pickMode === PICK.NONE) canvas.classList.add('panning');
  });
  canvas.addEventListener('mouseup',    () => canvas.classList.remove('panning'));
  canvas.addEventListener('mouseleave', () => canvas.classList.remove('panning'));

  // ─────────────────────────────────────────────────────────────
  // BUTTON WIRING
  // ─────────────────────────────────────────────────────────────

  // Preset map buttons (1–5)
  document.querySelectorAll('.map-preset-btn').forEach((btn, idx) => {
    btn.addEventListener('click', () => {
      _reset();
      const preset = PRESET_MAPS[idx];
      _activeMapIdx = idx;
      _buildWorld(preset.seed);
      StateController.resetCamera();
      _toast(`⊞ ${preset.label} (seed: ${preset.seed})`);
      // Update active state
      document.querySelectorAll('.map-preset-btn').forEach((b, i) => {
        b.classList.toggle('active-map', i === idx);
      });
    });
  });

  // Acak (random seed)
  $('btn-acak')?.addEventListener('click', () => {
    _reset();
    const ns = Math.floor(Math.random() * 99999);
    _buildWorld(ns);
    StateController.resetCamera();
    _toast(`⟳ Seed acak: ${ns}`);
    // Deselect all preset buttons
    document.querySelectorAll('.map-preset-btn').forEach(b => b.classList.remove('active-map'));
  });

  // Set Start
  $('btn-set-start')?.addEventListener('click', () => {
    if (Renderer.isSearchAnimating()) { _toast('⏳ Tunggu animasi selesai…'); return; }
    if (_pickMode === PICK.START) { _exitPickMode(); _status('Pemilihan dibatalkan', ''); return; }
    _enterPickMode(PICK.START);
  });

  // Set End
  $('btn-set-end')?.addEventListener('click', () => {
    if (Renderer.isSearchAnimating()) { _toast('⏳ Tunggu animasi selesai…'); return; }
    if (_pickMode === PICK.END) { _exitPickMode(); _status('Pemilihan dibatalkan', ''); return; }
    _enterPickMode(PICK.END);
  });

  // Start / Pause / Resume / Replay
  $('btn-track')?.addEventListener('click', () => {
    const btn = $('btn-track');

    // ── PHASE 1: Trigger search animation (only runs once per A* result) ──────
    // Guard: searchResult exists, path NOT ready yet, and no animation running.
    if (_searchResult && !_pathReady && !Renderer.isSearchAnimating()) {
      btn.disabled    = true;
      btn.textContent = '⏳ Mencari rute…';
      _status('Menampilkan proses pencarian algoritma A*…', 'active');

      Renderer.startSearchAnimation(_searchResult, () => {
        // onComplete fires synchronously inside drawFrame → no race condition.
        Renderer.setActivePath(_searchResult, _startId, _goalId);
        Renderer.stopSearchAnimation();

        // Instantiate vehicle
        if (_car) StateController.removeVehicle(0);
        _car = new VehicleAgent(_searchResult);
        StateController.registerVehicle(_car);
        _pathReady = true;

        // ── DIRECT START — no setTimeout, no btn.click() ──────────────────
        // Setting _paused = false here is synchronous and atomic: the RAF
        // loop reads _paused AFTER this callback returns, so there is never
        // a frame where the car ticks unexpectedly.
        _paused = false;

        btn.disabled    = false;
        btn.textContent = '⏸ Pause Track';
        btn.classList.remove('is-paused');

        const distKm = (_searchResult.totalLength / 100).toFixed(2);
        _status(
          `Jalur ${_searchResult.nodeSequence.length} node, ${distKm} km — kendaraan berjalan!`,
          'ok'
        );
        _toast('🚌 Kendaraan mulai bergerak!');
      }); // ← no speedFactor: Renderer formula now ensures ~5s animation
      return;
    }

    // ── PHASE 2: Car movement control (pause / resume / replay) ──────────────
    if (!_car || !_pathReady) return;

    // If car finished its route, reset it to the start before toggling
    if (_car.done) _car.reset();

    _paused = !_paused;
    btn.textContent = _paused ? '▶ Lanjut Track' : '⏸ Pause Track';
    btn.classList.toggle('is-paused', _paused);
    _status(
      _paused ? 'Dijeda — klik lagi untuk lanjut' : 'Kendaraan bergerak…',
      _paused ? '' : 'active'
    );
  });

  // ↺ Reset car to start (keeps route, path NOT cleared)
  $('btn-reset')?.addEventListener('click', () => {
    if (_car) {
      _car.reset();
      _paused    = true;
      _pathReady = false;  // force user to click Start Track again — no auto-start
    }
    Renderer.stopSearchAnimation();
    const btn = $('btn-track');
    if (btn) {
      btn.disabled    = false;
      btn.textContent = '▶ Start Track';
      btn.classList.remove('is-paused');
    }
    _status('Reset — klik Start Track untuk animasi ulang', '');
    _toast('↺ Reset');
  });

  /**
   * Full reset — called when switching maps or Acak.
   * Clears ALL state: car, animation, route, pick mode, stats.
   */
  function _reset() {
    // Stop any in-progress animation first
    Renderer.stopSearchAnimation();

    // Remove vehicle
    if (_car) { StateController.removeVehicle(0); _car = null; }

    // Clear route state
    _startId      = -1;
    _goalId       = -1;
    _pathReady    = false;
    _paused       = true;
    _pickMode     = PICK.NONE;
    _searchResult = null;

    // Reset canvas cursor state
    canvas.classList.remove('pick-mode', 'panning');

    // Reset DOM
    const safeGet = (id) => document.getElementById(id);
    safeGet('btn-set-start')?.classList.remove('active');
    safeGet('btn-set-end')?.classList.remove('active');
    const trackBtn = safeGet('btn-track');
    if (trackBtn) {
      trackBtn.disabled   = true;
      trackBtn.textContent = '▶ Start Track';
      trackBtn.classList.remove('is-paused');
    }

    Renderer.setActivePath(null, -1, -1);
    ['st-node-jalur', 'st-edge-jalur', 'st-jarak', 'st-waktu', 'st-visited']
      .forEach(id => T(id, '—'));
  }

  // ─────────────────────────────────────────────────────────────
  // KEYBOARD
  // ─────────────────────────────────────────────────────────────

  window.addEventListener('keydown', e => {
    switch (e.key.toUpperCase()) {
      case 'F':
        StateController.resetCamera(); break;
      case ' ':
        e.preventDefault();
        $('btn-track')?.click(); break;
      case 'D':
        StateController.debug.enabled = !StateController.debug.enabled;
        $('debug-panel')?.classList.toggle('hidden', !StateController.debug.enabled); break;
      case 'ESCAPE':
        _exitPickMode();
        _status('Esc — pemilihan dibatalkan', ''); break;
      // Quick map switch: keys 1-5
      case '1': case '2': case '3': case '4': case '5': {
        const idx = parseInt(e.key) - 1;
        document.querySelectorAll('.map-preset-btn')[idx]?.click();
        break;
      }
    }
  });

  // ─────────────────────────────────────────────────────────────
  // INIT
  // ─────────────────────────────────────────────────────────────

  StateController.init();
  Renderer.init();

  // Load first preset map
  _buildWorld(_seed);
  StateController.resetCamera();
  // Mark first map button as active
  document.querySelectorAll('.map-preset-btn')[0]?.classList.add('active-map');

  _status('Siap — pilih peta, lalu Set Start & End', '');

  // ─────────────────────────────────────────────────────────────
  // RAF LOOP
  // ─────────────────────────────────────────────────────────────

  function loop(ts) {
    StateController.tick(ts);
    const dt = Math.min(StateController.timing.deltaTime, 0.05);

    // Only tick car if NOT animating search
    if (_car && !Renderer.isSearchAnimating()) _car.tick(dt);
    Renderer.drawFrame(dt);

    // HUD (every 3 frames)
    if (StateController.timing.frameCount % 3 === 0) {
      const fps = StateController.timing.fps;
      T('st-fps', fps > 0 ? fps.toFixed(1) : '—');

      if (StateController.debug.enabled) {
        const el = $('debug-log');
        if (el) el.textContent = (StateController.debug.log || []).slice(0, 20).join('\n');
      }
    }

    requestAnimationFrame(loop);
  }

  requestAnimationFrame(loop);

})();
