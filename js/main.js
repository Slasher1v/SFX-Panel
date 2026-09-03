/*
 * main.js — UI logic for "My SFX Panel" (Premiere Composer-style)
 *
 * - Library is one or more local folders, scanned recursively into a tree.
 * - Grid shows waveform thumbnails (AudioEngine).
 * - Bottom preview player: stereo waveform, transport, pitch, reverse, Add.
 * - Add bakes pitch/reverse into a temp WAV, then imports at the playhead.
 */
(function () {
    "use strict";

    var fs = require("fs");
    var path = require("path");

    var cs = new CSInterface();
    var EXT_ROOT = cs.getSystemPath(SystemPath.EXTENSION);
    var LIB_DIR = path.join(EXT_ROOT, "library");
    var STARTER_DIR = path.join(LIB_DIR, "sounds");
    var PROCESSED_DIR = path.join(LIB_DIR, "_processed");
    var CONFIG = path.join(LIB_DIR, "config.json");

    var AUDIO_EXT = [".wav", ".mp3", ".m4a", ".aac", ".aif", ".aiff", ".flac", ".ogg", ".wma"];

    var config = { version: 2, roots: [], favorites: [], tags: [], fileTags: {}, settings: { trackIndex: 0 } };
    var tree = [];                 // array of root folder nodes
    var selectedFolder = null;     // node currently shown in grid
    var selectedSound = null;      // sound shown in preview
    var favFilter = false;
    var listView = false;
    var selectedTags = [];         // tag ids currently filtering the grid

    // macOS-style preset colors (plus custom via the editor).
    var TAG_PALETTE = ["#ff5f57", "#ff9f0a", "#ffd60a", "#32d74b", "#0a84ff", "#bf5af0", "#ff66c4", "#98989d"];

    // ---- DOM ----
    var $ = function (id) { return document.getElementById(id); };
    var $tree = $("tree"), $grid = $("grid"), $search = $("search"), $status = $("status");

    // Cross-platform file:// URL. Mac: /a/b -> file:///a/b. Windows: C:\a\b -> file:///C:/a/b
    function fileUrl(p) {
        var u = p.replace(/\\/g, "/");
        if (u.charAt(0) !== "/") u = "/" + u;
        return "file://" + encodeURI(u);
    }

    // ============ Config ============
    function loadConfig() {
        try {
            config = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
            config.roots = config.roots || [];
            config.favorites = config.favorites || [];
            config.tags = config.tags || [];
            config.fileTags = config.fileTags || {};
            config.settings = config.settings || { trackIndex: 0 };
        } catch (e) { /* first run — keep defaults */ }
    }
    function saveConfig() {
        try { fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2), "utf8"); }
        catch (e) { setStatus("Couldn't save config: " + e.message, "err"); }
    }
    function isFav(p) { return config.favorites.indexOf(p) !== -1; }
    function toggleFav(p) {
        var i = config.favorites.indexOf(p);
        if (i === -1) config.favorites.push(p); else config.favorites.splice(i, 1);
        saveConfig();
    }

    // ---- Tag helpers ----
    function tagById(id) {
        for (var i = 0; i < config.tags.length; i++) if (config.tags[i].id === id) return config.tags[i];
        return null;
    }
    function tagsForFile(p) { return config.fileTags[p] || []; }
    function fileHasTag(p, id) { return tagsForFile(p).indexOf(id) !== -1; }
    function toggleFileTag(p, id) {
        var arr = config.fileTags[p] || [];
        var i = arr.indexOf(id);
        if (i === -1) arr.push(id); else arr.splice(i, 1);
        if (arr.length) config.fileTags[p] = arr; else delete config.fileTags[p];
        saveConfig();
    }
    function countFilesWithTag(id) {
        var n = 0;
        for (var p in config.fileTags) if (config.fileTags[p].indexOf(id) !== -1) n++;
        return n;
    }

    // ============ Folder scanning ============
    function scanFolder(dirPath, name) {
        var node = { name: name || path.basename(dirPath), path: dirPath, folders: [], files: [], type: "folder", open: false };
        var entries;
        try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); }
        catch (e) { return node; }
        entries.forEach(function (ent) {
            if (ent.name.charAt(0) === ".") return;
            var full = path.join(dirPath, ent.name);
            if (ent.isDirectory()) {
                var child = scanFolder(full);
                if (child.files.length || child.folders.length) node.folders.push(child);
            } else if (AUDIO_EXT.indexOf(path.extname(ent.name).toLowerCase()) !== -1) {
                node.files.push({
                    name: path.parse(ent.name).name,
                    file: ent.name,
                    path: full,
                    ext: path.extname(ent.name).slice(1).toLowerCase()
                });
            }
        });
        node.folders.sort(function (a, b) { return a.name.localeCompare(b.name); });
        node.files.sort(function (a, b) { return a.name.localeCompare(b.name); });
        // Precompute total descendant count once, so the tree doesn't re-walk
        // the whole subtree to show a count on every render.
        node.count = node.files.length;
        node.folders.forEach(function (f) { node.count += f.count; });
        return node;
    }

    function buildTree() {
        tree = [];
        allFilesCache = null;       // invalidate the whole-library cache
        // Starter Pack = the bundled samples
        if (fs.existsSync(STARTER_DIR)) {
            var sp = scanFolder(STARTER_DIR, "Starter Pack");
            sp.open = true;
            tree.push(sp);
        }
        // User library = each added root folder. A root whose folder has gone
        // missing still gets a (dimmed) row, so it can be removed instead of
        // sitting in config.json forever.
        config.roots.forEach(function (r) {
            var n;
            if (fs.existsSync(r.path)) {
                n = scanFolder(r.path, r.name);
            } else {
                n = { name: r.name, path: r.path, folders: [], files: [], type: "folder", open: false, count: 0, missing: true };
            }
            n.open = !n.missing;
            n.rootPath = r.path;      // identifies the config.roots entry to remove
            tree.push(n);
        });
    }

    // All audio files at or below a node (recursive).
    function collectFiles(node) {
        var out = node.files.slice();
        node.folders.forEach(function (f) { out = out.concat(collectFiles(f)); });
        return out;
    }

    // ============ Tree rendering ============
    function renderTree() {
        $tree.innerHTML = "";
        if (!tree.length) {
            var hint = document.createElement("div");
            hint.className = "trow"; hint.style.color = "var(--text-dim)";
            hint.textContent = "No folders yet";
            $tree.appendChild(hint);
            return;
        }
        tree.forEach(function (root) { $tree.appendChild(treeNodeEl(root, 0)); });
        refreshTreeCounts();
    }

    function treeNodeEl(node, depth) {
        var wrap = document.createElement("div");
        wrap.className = "tnode";

        var row = document.createElement("div");
        row.className = "trow" + (selectedFolder === node ? " sel" : "");
        row.style.paddingLeft = (6 + depth * 14) + "px";

        var caret = document.createElement("span");
        var hasKids = node.folders.length > 0;
        caret.className = "caret" + (hasKids ? (node.open ? " open" : "") : " leaf");
        caret.innerHTML = Icons.chevronRight;

        var ico = document.createElement("span");
        ico.className = "ico"; ico.innerHTML = Icons.folder;

        var name = document.createElement("span");
        name.className = "tname"; name.textContent = node.name;

        var count = document.createElement("span");
        count.className = "count";
        node.countEl = count;    // refreshTreeCounts() updates these in place
        node.rowEl = row;

        row.appendChild(caret); row.appendChild(ico); row.appendChild(name); row.appendChild(count);

        if (node.missing) {
            row.classList.add("missing");
            row.title = "Folder not found — it may have been moved, renamed, or on a drive that isn't connected.";
        }
        // Added roots (not the bundled Starter Pack) can be taken back out.
        if (node.rootPath) {
            var rm = document.createElement("span");
            rm.className = "rmroot"; rm.innerHTML = Icons.close;
            rm.title = "Remove this folder from the panel (the files are not deleted)";
            rm.addEventListener("click", function (e) { e.stopPropagation(); removeRoot(node); });
            row.appendChild(rm);
        }
        wrap.appendChild(row);

        var kids = document.createElement("div");
        kids.className = "tchildren" + (node.open ? " open" : "");
        node.folders.forEach(function (c) { kids.appendChild(treeNodeEl(c, depth + 1)); });
        wrap.appendChild(kids);

        caret.addEventListener("click", function (e) {
            e.stopPropagation();
            if (!hasKids) return;
            node.open = !node.open;
            caret.classList.toggle("open", node.open);
            kids.classList.toggle("open", node.open);
        });
        row.addEventListener("click", function () { selectFolder(node); });
        return wrap;
    }

    // Take an added folder back out of the library. Only config.roots changes —
    // the sounds stay on disk, and their tags/favourites stay in config keyed by
    // path, so re-adding the folder brings everything back.
    function removeRoot(node) {
        var i = -1;
        for (var k = 0; k < config.roots.length; k++) {
            if (config.roots[k].path === node.rootPath) { i = k; break; }
        }
        if (i === -1) return;
        var name = config.roots[i].name;
        config.roots.splice(i, 1);
        saveConfig();

        var keepPath = selectedFolder ? selectedFolder.path : null;
        buildTree();
        var again = keepPath ? findNodeByPath(keepPath) : null;
        selectFolder(again || tree[0] || null);   // re-renders the tree
        setStatus("Removed \u201C" + name + "\u201D — the files were not deleted.", "ok");
    }

    function findNodeByPath(p) {
        var found = null;
        (function walk(nodes) {
            nodes.forEach(function (n) {
                if (found) return;
                if (n.path === p) { found = n; return; }
                walk(n.folders);
            });
        })(tree);
        return found;
    }

    var folderFilesCache = [];      // collectFiles(selectedFolder), computed once on select
    var allFilesCache = null;       // allLibraryFiles(), built lazily, cleared on buildTree

    function selectFolder(node) {
        selectedFolder = node;
        selectedTags = [];          // browsing a folder clears the tag filter
        folderFilesCache = node ? collectFiles(node) : [];
        renderTags();
        renderTree();
        renderGrid();
    }

    // Every audio file across all roots, de-duped by path (cached).
    function allLibraryFiles() {
        if (allFilesCache) return allFilesCache;
        var seen = {}, out = [];
        tree.forEach(function (root) {
            collectFiles(root).forEach(function (f) {
                if (!seen[f.path]) { seen[f.path] = 1; out.push(f); }
            });
        });
        allFilesCache = out;
        return out;
    }

    // ============ Filtering ============
    // One definition of "does this file match right now", shared by the grid
    // and by the folder counts in the tree.
    function searchQuery() { return $search.value.trim().toLowerCase(); }
    function filterActive() { return !!searchQuery() || favFilter; }
    function fileMatches(f, q) {
        if (favFilter && !isFav(f.path)) return false;
        if (q && f.name.toLowerCase().indexOf(q) === -1) return false;
        return true;
    }

    // How many sounds at/below this folder match the current search.
    function computeMatches(node, q) {
        var n = 0, i;
        for (i = 0; i < node.files.length; i++) if (fileMatches(node.files[i], q)) n++;
        for (i = 0; i < node.folders.length; i++) n += computeMatches(node.folders[i], q);
        node.match = n;
        return n;
    }

    // While searching, the number on the right of each folder becomes the
    // match count (highlighted, and the row dims when nothing matches); with
    // no search it goes back to the plain total. Updated in place so typing
    // never rebuilds the sidebar.
    function refreshTreeCounts() {
        var active = filterActive(), q = searchQuery();
        if (active) tree.forEach(function (root) { computeMatches(root, q); });
        (function walk(nodes) {
            nodes.forEach(function (node) {
                var n = active ? node.match : node.count;
                if (node.countEl) {
                    node.countEl.textContent = (active || n) ? String(n) : "";
                    node.countEl.className = "count" + (active && n ? " match" : "");
                }
                if (node.rowEl) node.rowEl.classList.toggle("nomatch", active && !n);
                walk(node.folders);
            });
        })(tree);
    }

    // ============ Grid rendering ============
    function currentFiles() {
        // Tag filter acts like a Smart Folder: searches the whole library,
        // ignoring which folder is selected. A file matches if it has ANY
        // of the selected tags. Both sources come from caches so typing in
        // search doesn't re-walk the folder tree on every keystroke.
        var files = selectedTags.length
            ? allLibraryFiles().filter(function (f) {
                return selectedTags.some(function (id) { return fileHasTag(f.path, id); });
            })
            : folderFilesCache;

        var q = searchQuery();
        if (!q && !favFilter) return files;
        return files.filter(function (f) { return fileMatches(f, q); });
    }

    // ---- Virtualized grid ----
    // Only the tiles inside the scroll viewport (plus a small buffer) are
    // built as DOM, and only those decode their waveform. This keeps a
    // 2,000+ file folder fast instead of building thousands of canvases.
    var gridFiles = [];
    var tileZoom = 190;            // px min tile width — tuned for ~4 across on a wide panel
    var gridMetrics = null;
    var gridSpacer = null;         // sized to the full content; tiles absolutely placed inside
    var renderedRange = null;
    var scrollScheduled = false;
    var decodeQueue = [], decoding = 0;
    var DECODE_MAX = 4;
    var WAVE_COLOR = "#8a8a8a";

    function renderGrid() {
        gridFiles = currentFiles();
        $grid.innerHTML = "";
        decodeQueue.length = 0;
        renderedRange = null;
        gridSpacer = null;
        $grid.style.display = "block";
        $grid.style.position = "relative";

        if (!gridFiles.length) {
            var empty = document.createElement("div");
            empty.className = "empty";
            empty.textContent = selectedTags.length
                ? "No sounds with " + (selectedTags.length > 1 ? "these tags." : "this tag.")
                : selectedFolder
                    ? (favFilter ? "No favorites here yet." : "No sounds match.")
                    : "Select a folder on the left, or click “＋ Add folder”.";
            $grid.appendChild(empty);
            return;
        }

        gridSpacer = document.createElement("div");
        gridSpacer.style.position = "relative";
        gridSpacer.style.width = "100%";
        $grid.appendChild(gridSpacer);
        $grid.scrollTop = 0;
        layoutGrid();
    }

    function computeMetrics() {
        var availW = Math.max(40, $grid.clientWidth - (listView ? 16 : 20));
        if (listView) {
            return { list: true, pad: 8, gap: 6, cols: 1, tileW: availW,
                     thumbW: 120, thumbH: 32, tileH: 44, rowH: 50 };
        }
        var pad = 10, gap = 10, minW = tileZoom;
        var cols = Math.max(1, Math.floor((availW + gap) / (minW + gap)));
        var tileW = Math.floor((availW - gap * (cols - 1)) / cols);
        var thumbH = Math.round(tileW * 0.52), capH = 34;
        return { list: false, pad: pad, gap: gap, cols: cols, tileW: tileW,
                 thumbH: thumbH, tileH: thumbH + capH, rowH: thumbH + capH + gap };
    }

    // Recompute sizing and the spacer height, then paint the visible window.
    function layoutGrid() {
        if (!gridSpacer || !gridFiles.length) return;
        gridMetrics = computeMetrics();
        var m = gridMetrics, rows = Math.ceil(gridFiles.length / m.cols);
        gridSpacer.style.height = (m.pad * 2 + rows * m.rowH - (m.list ? 0 : m.gap)) + "px";
        renderedRange = null;
        renderVisible(true);
    }

    function renderVisible(force) {
        if (!gridSpacer || !gridMetrics) return;
        var m = gridMetrics, n = gridFiles.length, buffer = 2;
        var scrollTop = $grid.scrollTop, viewH = $grid.clientHeight || 400;
        var firstRow = Math.max(0, Math.floor((scrollTop - m.pad) / m.rowH) - buffer);
        var lastRow = Math.ceil((scrollTop + viewH - m.pad) / m.rowH) + buffer;
        var firstIdx = firstRow * m.cols, lastIdx = Math.min(n, (lastRow + 1) * m.cols);
        if (!force && renderedRange && renderedRange[0] === firstIdx && renderedRange[1] === lastIdx) return;
        renderedRange = [firstIdx, lastIdx];

        gridSpacer.innerHTML = "";
        decodeQueue.length = 0;
        for (var i = firstIdx; i < lastIdx; i++) gridSpacer.appendChild(tileEl(gridFiles[i], i, m));
        pumpDecode();
    }

    function tileEl(f, index, m) {
        var row = Math.floor(index / m.cols), col = index % m.cols;
        var tile = document.createElement("div");
        tile.className = "tile" + (m.list ? " listrow" : "") + (selectedSound && selectedSound.path === f.path ? " sel" : "");
        tile.setAttribute("draggable", "true");
        tile.style.position = "absolute";
        tile.style.width = m.tileW + "px";
        if (m.list) {
            tile.style.left = m.pad + "px";
            tile.style.top = (m.pad + index * m.rowH) + "px";
            tile.style.height = m.tileH + "px";
        } else {
            tile.style.left = (m.pad + col * (m.tileW + m.gap)) + "px";
            tile.style.top = (m.pad + row * m.rowH) + "px";
        }

        var canvas = document.createElement("canvas");
        canvas.className = "thumb";
        if (m.list) {
            canvas.style.width = m.thumbW + "px"; canvas.style.height = m.thumbH + "px";
            canvas.style.flex = "0 0 " + m.thumbW + "px";
        } else { canvas.style.height = m.thumbH + "px"; }

        var cap = document.createElement("div");
        cap.className = "caption";
        var badge = document.createElement("span");
        badge.className = "badge"; badge.textContent = f.ext;
        var cname = document.createElement("span");
        cname.className = "cname"; cname.textContent = f.name; cname.title = f.name;
        var dots = document.createElement("span");
        dots.className = "dots";
        tagsForFile(f.path).forEach(function (id) {
            var t = tagById(id);
            if (!t) return;
            var d = document.createElement("span");
            d.className = "dot"; d.style.background = t.color; d.title = t.name;
            dots.appendChild(d);
        });
        var star = document.createElement("span");
        star.className = "cstar" + (isFav(f.path) ? " on" : ""); star.innerHTML = Icons.star;
        star.addEventListener("click", function (e) {
            e.stopPropagation();
            toggleFav(f.path);
            star.classList.toggle("on", isFav(f.path));
            if (favFilter) renderGrid();
        });

        cap.appendChild(badge); cap.appendChild(cname); cap.appendChild(dots); cap.appendChild(star);
        tile.appendChild(canvas); tile.appendChild(cap);

        // Single click = select/preview. Double click = add at the playhead.
        tile.addEventListener("click", function () { selectSound(f); });
        tile.addEventListener("dblclick", function () { selectSound(f); addToTimeline("overwrite"); });
        tile.addEventListener("contextmenu", function (e) { e.preventDefault(); openTagMenu(f, e.clientX, e.clientY); });

        // Drag onto the Premiere timeline / project via Adobe's CEP drag format.
        // If this tile is the selected sound with effects applied, drag the
        // baked file; otherwise drag the original.
        tile.addEventListener("dragstart", function (e) {
            var dragPath = dragFileFor(f);
            try {
                e.dataTransfer.setData("com.adobe.cep.dnd.file.0", dragPath);
                e.dataTransfer.effectAllowed = "copy";
            } catch (err) {}
        });

        decodeQueue.push({ file: f, canvas: canvas });
        return tile;
    }

    // Waveform decode scheduler — capped concurrency, skips tiles that have
    // scrolled out of view (their canvas is no longer in the DOM). Peaks are
    // cached by AudioEngine, so re-scrolling redraws instantly.
    function pumpDecode() {
        while (decoding < DECODE_MAX && decodeQueue.length) {
            var job = decodeQueue.shift();
            if (!job.canvas.isConnected) continue;
            decoding++;
            (function (j) {
                AudioEngine.peaks(j.file.path).then(function (r) {
                    if (j.canvas.isConnected) drawWave(j.canvas, r.peaks, WAVE_COLOR);
                }).catch(function () {
                    if (j.canvas.isConnected) drawFlat(j.canvas);
                }).then(function () { decoding--; pumpDecode(); });
            })(job);
        }
    }

    function onGridScroll() {
        if (scrollScheduled) return;
        scrollScheduled = true;
        requestAnimationFrame(function () { scrollScheduled = false; renderVisible(false); });
    }

    function setupCanvas(canvas) {
        var dpr = window.devicePixelRatio || 1;
        var w = canvas.clientWidth || 138, h = canvas.clientHeight || 70;
        canvas.width = w * dpr; canvas.height = h * dpr;
        var ctx = canvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        return { ctx: ctx, w: w, h: h };
    }

    function drawWave(canvas, peaks, color) {
        var c = setupCanvas(canvas), ctx = c.ctx, w = c.w, h = c.h, mid = h / 2, n = peaks.length / 2;
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = color || "#8a8a8a";
        for (var x = 0; x < w; x++) {
            var idx = Math.floor(x / w * n);
            var mn = peaks[idx * 2], mx = peaks[idx * 2 + 1];
            var y1 = mid - mx * mid * 0.92, y2 = mid - mn * mid * 0.92;
            ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
        }
    }

    function drawFlat(canvas) {
        var c = setupCanvas(canvas), ctx = c.ctx;
        ctx.clearRect(0, 0, c.w, c.h);
        ctx.fillStyle = "#262626";
        ctx.fillRect(0, c.h / 2 - 1, c.w, 2);
    }

    // ============ Preview player ============
    var REVERB_DECAY = 2.2;        // seconds of reverb tail baked on Add
    var player = {
        sound: null, buffer: null, reversedBuf: null,
        source: null, gain: AudioEngine.context.createGain(),
        startedAt: 0, startOffset: 0, playing: false, duration: 0,
        pitch: 0, reverse: false, reverb: 0, treble: 0, volume: 1, muted: false,
        raf: 0, audioEl: null, mode: "wa", reverbImpulse: null
    };
    player.gain.connect(AudioEngine.context.destination);

    var $player = $("player"), $pPlay = $("pPlay"), $pSeek = $("pSeek"),
        $pTime = $("pTime"), $pWave = $("pWave"), $pPitch = $("pPitch"),
        $pPitchVal = $("pPitchVal"), $pReverse = $("pReverse");

    function selectSound(f) {
        selectedSound = f;
        // repaint the visible tiles to move the selection highlight, keeping scroll
        renderVisible(true);
        loadIntoPlayer(f);
    }

    // Composer-style: clicking a sound previews it straight away. Settings ▸
    // Playback turns it off; missing/older configs default to on.
    function autoPlayEnabled() { return config.settings.autoPlay !== false; }

    function loadIntoPlayer(f) {
        stopPlayback();
        player.sound = f; player.buffer = null; player.reversedBuf = null;
        player.pitch = 0; player.reverse = false; player.reverb = 0; player.treble = 0; player.startOffset = 0;
        $pPitch.value = "0"; $pPitchVal.textContent = "0"; $pReverse.checked = false;
        $("pReverb").value = "0"; $("pReverbVal").textContent = "0";
        $("pTreble").value = "0"; $("pTrebleVal").textContent = "0";
        var head = $("pHeadName"); if (head) head.textContent = f.name;
        $player.hidden = false;
        $player.classList.toggle("collapsed", !previewExpanded);

        AudioEngine.decode(f.path).then(function (buf) {
            if (player.sound !== f) return;
            player.mode = "wa"; player.buffer = buf; player.duration = buf.duration;
            $pPitch.disabled = false; $pReverse.disabled = false;
            drawPreviewWave();
            updateTime(0);
            if (autoPlayEnabled()) playFrom(0);
        }).catch(function () {
            if (player.sound !== f) return;
            // Fallback: play through an <audio> element (no pitch/reverse).
            player.mode = "el";
            player.buffer = null;
            $pPitch.disabled = true; $pReverse.disabled = true;
            var el = new Audio();
            el.src = fileUrl(f.path);
            el.addEventListener("loadedmetadata", function () {
                player.duration = el.duration || 0; updateTime(0);
                if (autoPlayEnabled() && player.sound === f) playFrom(0);
            });
            el.addEventListener("timeupdate", function () { updateTime(el.currentTime); });
            el.addEventListener("ended", function () { player.playing = false; $pPlay.innerHTML = Icons.play; });
            player.audioEl = el;
            AudioEngine.peaks(f.path).then(function (r) {
                drawPreviewFromPeaks(r.peaks);
            }).catch(function () { drawPreviewFromPeaks(null); });
        });
    }

    var previewExpanded = false;    // collapsed by default; slides open on click
    function setPreviewExpanded(expanded) {
        previewExpanded = expanded;
        $player.classList.toggle("collapsed", !expanded);
        if (expanded) {
            // canvas was clipped while collapsed — redraw to current size
            if (player.buffer) drawPreviewWave(); else renderPreviewCanvas();
        }
    }
    function togglePreview() { setPreviewExpanded($player.classList.contains("collapsed")); }

    function activeBuffer() {
        if (!player.buffer) return null;
        if (player.reverse) {
            if (!player.reversedBuf) player.reversedBuf = AudioEngine.reversed(player.buffer);
            return player.reversedBuf;
        }
        return player.buffer;
    }

    function playFrom(sec) {
        if (player.mode === "el") {
            if (!player.audioEl) return;
            player.audioEl.currentTime = Math.min(sec, player.duration || 0);
            player.audioEl.play();
            player.playing = true; $pPlay.innerHTML = Icons.pause;
            return;
        }
        var buf = activeBuffer();
        if (!buf) return;
        stopSource();
        var ctx = AudioEngine.context;
        var src = ctx.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = Math.pow(2, player.pitch / 12);

        // Treble (high-shelf) sits right after the source.
        var node = src;
        if (player.treble !== 0) {
            var hs = ctx.createBiquadFilter();
            hs.type = "highshelf"; hs.frequency.value = 3500; hs.gain.value = player.treble;
            src.connect(hs); node = hs;
        }

        if (player.reverb > 0) {
            // Live reverb preview (the baked tail is applied on Add).
            if (!player.reverbImpulse) player.reverbImpulse = AudioEngine.makeImpulse(ctx, REVERB_DECAY, 2.5);
            var conv = ctx.createConvolver();
            conv.buffer = player.reverbImpulse;
            var wet = ctx.createGain(); wet.gain.value = player.reverb;
            node.connect(player.gain);                       // dry
            node.connect(conv); conv.connect(wet); wet.connect(player.gain); // wet
        } else {
            node.connect(player.gain);
        }
        src.onended = function () {
            if (player.source === src) { player.playing = false; $pPlay.innerHTML = Icons.play; cancelAnimationFrame(player.raf); updateTime(player.duration); }
        };
        src.start(0, Math.max(0, Math.min(sec, player.duration - 0.001)));
        player.source = src; player.startedAt = AudioEngine.context.currentTime;
        player.startOffset = sec; player.playing = true; $pPlay.innerHTML = Icons.pause;
        tick();
    }

    function stopSource() {
        if (player.source) { try { player.source.onended = null; player.source.stop(); } catch (e) {} player.source = null; }
    }
    function stopPlayback() {
        stopSource();
        if (player.audioEl) { try { player.audioEl.pause(); } catch (e) {} }
        player.playing = false; $pPlay.innerHTML = Icons.play; cancelAnimationFrame(player.raf);
    }

    function currentPos() {
        if (player.mode === "el") return player.audioEl ? player.audioEl.currentTime : 0;
        if (!player.playing) return player.startOffset;
        var rate = Math.pow(2, player.pitch / 12);
        return player.startOffset + (AudioEngine.context.currentTime - player.startedAt) * rate;
    }

    function tick() {
        player.raf = requestAnimationFrame(function () {
            var pos = currentPos();
            if (pos >= player.duration) { updateTime(player.duration); return; }
            updateTime(pos);
            if (player.playing) tick();
        });
    }

    function updateTime(pos) {
        pos = Math.max(0, Math.min(pos, player.duration || 0));
        $pTime.textContent = fmtTime(pos);
        if (player.duration) $pSeek.value = String(Math.round(pos / player.duration * 1000));
        drawPlayhead(pos);
    }

    function fmtTime(s) {
        var hh = Math.floor(s / 3600), mm = Math.floor(s % 3600 / 60),
            ss = Math.floor(s % 60), cc = Math.floor(s * 100 % 100);
        function p(n) { return (n < 10 ? "0" : "") + n; }
        return p(hh) + ":" + p(mm) + ":" + p(ss) + "." + p(cc);
    }

    // Preview waveform (stereo if available)
    var previewPeaks = null; // {channels:[Float32Array...]} or {mono:Float32Array}
    function drawPreviewWave() {
        var w = $pWave.clientWidth || 400;
        var ch = AudioEngine.channelPeaks(activeBuffer() || player.buffer, w);
        previewPeaks = { channels: ch };
        renderPreviewCanvas();
    }
    function drawPreviewFromPeaks(peaks) {
        previewPeaks = peaks ? { mono: peaks } : { mono: null };
        renderPreviewCanvas();
    }

    function renderPreviewCanvas(playheadPos) {
        var c = setupCanvas($pWave), ctx = c.ctx, w = c.w, h = c.h;
        ctx.clearRect(0, 0, w, h);
        var played = playheadPos !== undefined && player.duration ? playheadPos / player.duration * w : -1;

        function band(peaks, top, height, n) {
            var mid = top + height / 2;
            for (var x = 0; x < w; x++) {
                var idx = Math.floor(x / w * n);
                var mn = peaks[idx * 2], mx = peaks[idx * 2 + 1];
                var y1 = mid - mx * (height / 2) * 0.9, y2 = mid - mn * (height / 2) * 0.9;
                ctx.fillStyle = x <= played ? PLAYED : WAVE;
                ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
            }
        }
        if (previewPeaks && previewPeaks.channels) {
            var chs = previewPeaks.channels, gap = 6;
            var bandH = (h - gap * (chs.length - 1)) / chs.length;
            chs.forEach(function (pk, i) { band(pk, i * (bandH + gap), bandH, pk.length / 2); });
        } else if (previewPeaks && previewPeaks.mono) {
            band(previewPeaks.mono, 0, h, previewPeaks.mono.length / 2);
        } else {
            ctx.fillStyle = "#262626"; ctx.fillRect(0, h / 2 - 1, w, 2);
        }
        if (played >= 0) { ctx.fillStyle = "#fff"; ctx.fillRect(played, 0, 1, h); }
    }
    var WAVE = "#8a8a8a", PLAYED = "#2f8fe6";
    function drawPlayhead(pos) { renderPreviewCanvas(pos); }

    // ============ Effects baking (shared by Add + drag) ============
    function hasEffects() {
        return player.mode === "wa" && player.buffer &&
            (player.pitch !== 0 || player.reverse || player.reverb > 0 || player.treble !== 0);
    }
    function effectTag() {
        return (player.pitch >= 0 ? "p" : "m") + Math.abs(player.pitch) +
            (player.reverse ? "_rev" : "") +
            (player.reverb > 0 ? "_rv" + Math.round(player.reverb * 100) : "") +
            (player.treble !== 0 ? "_tb" + player.treble : "");
    }
    function processedPathFor(snd) {
        return path.join(PROCESSED_DIR, sanitize(snd.name) + "_" + effectTag() + ".wav");
    }
    // Render the current effects to a WAV (cached by filename). Returns a Promise<path>.
    function renderToFile(snd) {
        var dest = processedPathFor(snd);
        try { if (fs.existsSync(dest)) return Promise.resolve(dest); } catch (e) {}
        return AudioEngine.renderProcessed(player.buffer, player.pitch, player.reverse, player.reverb, REVERB_DECAY, player.treble)
            .then(function (rendered) {
                try { if (!fs.existsSync(PROCESSED_DIR)) fs.mkdirSync(PROCESSED_DIR, { recursive: true }); } catch (e) {}
                fs.writeFileSync(dest, AudioEngine.encodeWav(rendered));
                return dest;
            });
    }

    // ---- Drag-to-timeline (Adobe CEP drag format) ----
    // dragstart is synchronous, so we can't render then; instead we pre-bake the
    // effected file shortly after the user stops adjusting, and the drag picks it up.
    var dragRenderTimer = null;
    function ensureProcessedForDrag() {
        if (!selectedSound || !hasEffects()) return;
        clearTimeout(dragRenderTimer);
        var snd = selectedSound;
        dragRenderTimer = setTimeout(function () { renderToFile(snd).catch(function () {}); }, 350);
    }
    // Which file a tile should drop: the baked effects file if it's the selected
    // sound with effects already rendered, otherwise the original.
    function dragFileFor(f) {
        if (selectedSound && f.path === selectedSound.path && hasEffects()) {
            var p = processedPathFor(f);
            try { if (fs.existsSync(p)) return p; } catch (e) {}
        }
        return f.path;
    }

    // ============ Add to timeline ============
    function addToTimeline(mode) {
        var snd = selectedSound;
        if (!snd) return;
        if (!hasEffects()) return doDrop(snd.path, mode);
        setStatus("Rendering…");
        renderToFile(snd).then(function (tmp) { doDrop(tmp, mode); })
            .catch(function (e) { setStatus("Render failed: " + e.message, "err"); });
    }

    function doDrop(filePath, mode) {
        var script = "dropSFXAtPlayhead(" + JSON.stringify(filePath) + ", " + JSON.stringify(mode || "overwrite") + ")";
        cs.evalScript(script, function (res) {
            var r = parseResult(res);
            if (r.ok) setStatus(r.msg || "Added.", "ok"); else setStatus(r.err || "Add failed.", "err");
        });
    }

    function sanitize(s) { return s.replace(/[^a-z0-9_-]+/gi, "_").slice(0, 40); }

    // ============ Add folder ============
    // The cep.fs directory dialog is unreliable; a hidden <input webkitdirectory>
    // is the robust way to pick a folder in CEP. We only need the root path —
    // CEF exposes the absolute path on each File, then we scan it ourselves.
    function addFolder() { $("folderInput").click(); }

    function onFolderPicked(fileList) {
        if (!fileList || !fileList.length) return;
        var f0 = fileList[0];
        var rel = f0.webkitRelativePath || f0.name;     // e.g. "SFX/whoosh.wav"
        var abs = f0.path || "";                          // e.g. "/Users/.../SFX/whoosh.wav"
        if (!abs) { setStatus("Could not read folder path.", "err"); return; }
        var rootName = rel.split("/")[0];
        var base = abs.slice(0, abs.length - rel.length); // path up to the chosen folder
        var dir = path.join(base, rootName);

        if (config.roots.some(function (r) { return r.path === dir; })) {
            setStatus("Folder already added.", "ok");
            var existing = tree.filter(function (n) { return n.path === dir; })[0];
            if (existing) selectFolder(existing);
            return;
        }
        config.roots.push({ name: rootName || dir, path: dir });
        saveConfig();
        buildTree();
        renderTree();
        var added = tree[tree.length - 1];
        if (added) selectFolder(added);
        setStatus("Added folder: " + rootName, "ok");
    }

    // ============ Tags UI ============
    function renderTags() {
        var list = $("tagsList");
        list.innerHTML = "";
        if (!config.tags.length) {
            var hint = document.createElement("div");
            hint.className = "tags-empty";
            hint.textContent = "No tags yet — click ＋";
            list.appendChild(hint);
            return;
        }
        config.tags.forEach(function (tag) {
            var row = document.createElement("div");
            row.className = "tagrow" + (selectedTags.indexOf(tag.id) !== -1 ? " sel" : "");

            var dot = document.createElement("span");
            dot.className = "dot"; dot.style.background = tag.color;

            var name = document.createElement("span");
            name.className = "tgname"; name.textContent = tag.name;

            var count = document.createElement("span");
            count.className = "tgcount";
            var n = countFilesWithTag(tag.id);
            count.textContent = n ? n : "";

            var edit = document.createElement("span");
            edit.className = "tgedit"; edit.innerHTML = Icons.pencil; edit.title = "Edit tag";
            edit.addEventListener("click", function (e) { e.stopPropagation(); openTagModal(tag); });

            row.appendChild(dot); row.appendChild(name); row.appendChild(count); row.appendChild(edit);
            row.addEventListener("click", function () {
                var i = selectedTags.indexOf(tag.id);
                if (i === -1) selectedTags.push(tag.id); else selectedTags.splice(i, 1);
                if (selectedTags.length) { selectedFolder = null; renderTree(); }
                renderTags();
                renderGrid();
            });
            list.appendChild(row);
        });
    }

    // ---- Assignment popover (right-click a tile) ----
    function openTagMenu(file, x, y) {
        var menu = $("tagMenu");
        menu.innerHTML = "";

        config.tags.forEach(function (tag) {
            var row = document.createElement("div");
            row.className = "tm-row" + (fileHasTag(file.path, tag.id) ? " on" : "");
            var dot = document.createElement("span");
            dot.className = "dot"; dot.style.background = tag.color;
            var name = document.createElement("span");
            name.textContent = tag.name; name.style.flex = "1";
            var chk = document.createElement("span");
            chk.className = "chk"; chk.innerHTML = Icons.check;
            row.appendChild(dot); row.appendChild(name); row.appendChild(chk);
            row.addEventListener("click", function (e) {
                e.stopPropagation();   // keep menu open for multiple assignments
                toggleFileTag(file.path, tag.id);
                row.classList.toggle("on", fileHasTag(file.path, tag.id));
                renderTags();
                renderGrid();
            });
            menu.appendChild(row);
        });

        if (config.tags.length) {
            var sep = document.createElement("div"); sep.className = "tm-sep"; menu.appendChild(sep);
        }
        var add = document.createElement("div");
        add.className = "tm-row tm-new";
        add.innerHTML = '<span class="tm-ico">' + Icons.plus + '</span><span>New tag…</span>';
        add.addEventListener("click", function () { closeTagMenu(); openTagModal(null, file); });
        menu.appendChild(add);

        menu.hidden = false;
        // keep on-screen
        var mw = menu.offsetWidth, mh = menu.offsetHeight;
        menu.style.left = Math.min(x, window.innerWidth - mw - 8) + "px";
        menu.style.top = Math.min(y, window.innerHeight - mh - 8) + "px";
    }
    function closeTagMenu() { $("tagMenu").hidden = true; }

    // ---- Create / edit modal ----
    var editingTag = null;      // tag being edited, or null when creating
    var pendingFile = null;     // file to auto-assign a newly created tag to
    var chosenColor = TAG_PALETTE[0];

    function openTagModal(tag, fileToAssign) {
        editingTag = tag || null;
        pendingFile = fileToAssign || null;
        chosenColor = tag ? tag.color : TAG_PALETTE[0];

        $("tagModalTitle").textContent = tag ? "Edit Tag" : "New Tag";
        $("tagName").value = tag ? tag.name : "";
        $("tagDelete").hidden = !tag;

        var sw = $("swatches");
        sw.innerHTML = "";
        TAG_PALETTE.forEach(function (col) {
            var s = document.createElement("span");
            s.className = "sw" + (col === chosenColor ? " sel" : "");
            s.style.background = col;
            s.addEventListener("click", function () {
                chosenColor = col;
                Array.prototype.forEach.call(sw.children, function (c) { c.classList.remove("sel"); });
                s.classList.add("sel");
            });
            sw.appendChild(s);
        });

        $("tagModal").hidden = false;
        setTimeout(function () { $("tagName").focus(); }, 0);
    }
    function closeTagModal() { $("tagModal").hidden = true; editingTag = null; pendingFile = null; }

    function saveTag() {
        var name = $("tagName").value.trim();
        if (!name) { $("tagName").focus(); return; }
        if (editingTag) {
            editingTag.name = name; editingTag.color = chosenColor;
        } else {
            var tag = { id: "t" + Date.now() + Math.floor(Math.random() * 1000), name: name, color: chosenColor };
            config.tags.push(tag);
            if (pendingFile) toggleFileTag(pendingFile.path, tag.id);
        }
        saveConfig();
        closeTagModal();
        renderTags();
        renderGrid();
    }

    function deleteTag() {
        if (!editingTag) return;
        var id = editingTag.id;
        config.tags = config.tags.filter(function (t) { return t.id !== id; });
        for (var p in config.fileTags) {
            config.fileTags[p] = config.fileTags[p].filter(function (t) { return t !== id; });
            if (!config.fileTags[p].length) delete config.fileTags[p];
        }
        var si = selectedTags.indexOf(id);
        if (si !== -1) selectedTags.splice(si, 1);
        saveConfig();
        closeTagModal();
        renderTags();
        renderGrid();
    }

    // ============ Theme (Settings) ============
    // A theme is a background gradient + an accent colour. It lives in
    // config.settings.theme, so — like tags and favourites — it survives
    // updates. Surfaces in the CSS are translucent, so the gradient shows
    // through the sidebar, tiles and player without any extra work.
    var THEME_PRESETS = [
        { id: "oled",     name: "OLED Black", from: "#000000", to: "#000000", angle: 160, accent: "#2f8fe6" },
        { id: "graphite", name: "Graphite",   from: "#26292e", to: "#000000", angle: 160, accent: "#8a95a3" },
        { id: "midnight", name: "Midnight",   from: "#101f47", to: "#000000", angle: 160, accent: "#4c8dff" },
        { id: "ocean",    name: "Ocean",      from: "#06303a", to: "#00080b", angle: 160, accent: "#25c2d8" },
        { id: "forest",   name: "Forest",     from: "#0d2e1e", to: "#000000", angle: 160, accent: "#3fc57e" },
        { id: "ember",    name: "Ember",      from: "#3a140b", to: "#000000", angle: 160, accent: "#ff7a45" },
        { id: "violet",   name: "Violet",     from: "#281148", to: "#000000", angle: 160, accent: "#a86bff" },
        { id: "rose",     name: "Rose",       from: "#3d1024", to: "#000000", angle: 160, accent: "#ff6b9d" }
    ];

    function presetById(id) {
        for (var i = 0; i < THEME_PRESETS.length; i++) if (THEME_PRESETS[i].id === id) return THEME_PRESETS[i];
        return null;
    }
    // Fill in anything missing from the stored theme (or from a preset id).
    function normTheme(t) {
        t = t || {};
        var base = presetById(t.preset) || THEME_PRESETS[0];
        return {
            preset: t.preset || base.id,
            from: t.from || base.from,
            to: t.to || base.to,
            angle: typeof t.angle === "number" ? t.angle : base.angle,
            accent: t.accent || base.accent
        };
    }
    function currentTheme() { return normTheme(config.settings && config.settings.theme); }

    function gradientCss(t) {
        // Two identical stops = a flat colour; skip the gradient layer entirely.
        if (t.from.toLowerCase() === t.to.toLowerCase()) return "none";
        return "linear-gradient(" + t.angle + "deg, " + t.from + " 0%, " + t.to + " 100%)";
    }
    function swatchCss(t) { return t.from.toLowerCase() === t.to.toLowerCase() ? t.from : gradientCss(t); }

    // "#aabbcc" / "#abc" / "aabbcc" -> "#aabbcc"; anything else -> null.
    function normHex(v) {
        v = String(v || "").trim().replace(/^#/, "");
        if (/^[0-9a-f]{3}$/i.test(v)) v = v.charAt(0) + v.charAt(0) + v.charAt(1) + v.charAt(1) + v.charAt(2) + v.charAt(2);
        return /^[0-9a-f]{6}$/i.test(v) ? "#" + v.toLowerCase() : null;
    }
    // Darkened accent, used for selected rows.
    function darken(hex, amt) {
        var h = normHex(hex) || "#2f8fe6", out = "#";
        for (var i = 0; i < 3; i++) {
            var v = Math.round(parseInt(h.substr(1 + i * 2, 2), 16) * (1 - amt));
            out += (v < 16 ? "0" : "") + v.toString(16);
        }
        return out;
    }

    function applyTheme(t) {
        var st = document.documentElement.style;
        st.setProperty("--bg", t.to);          // base colour behind the gradient
        st.setProperty("--bg-grad", gradientCss(t));
        st.setProperty("--accent", t.accent);
        st.setProperty("--accent-dim", darken(t.accent, .55));
        st.setProperty("--wave-played", t.accent);
        PLAYED = t.accent;                     // canvas playhead colour (drawn in JS)
        if (!$player.hidden && previewPeaks) renderPreviewCanvas();
    }

    // ---- Settings modal ----
    var themeDraft = null;      // live-previewed theme while the modal is open
    var autoPlayDraft = true;   // pending value of the "play on click" toggle

    function openSettings() {
        $("aboutVersion").textContent = "v" + appVersion();
        autoPlayDraft = autoPlayEnabled();
        $("optAutoPlay").checked = autoPlayDraft;
        themeDraft = currentTheme();
        renderThemePresets();
        syncThemeInputs();
        $("settingsModal").hidden = false;
    }
    // Cancel/Escape puts the saved theme back; Save keeps the draft.
    function closeSettings(revert) {
        if (revert) applyTheme(currentTheme());
        $("settingsModal").hidden = true;
        themeDraft = null;
    }
    function saveSettings() {
        if (themeDraft) config.settings.theme = themeDraft;
        config.settings.autoPlay = autoPlayDraft;
        saveConfig();
        closeSettings(false);
        setStatus("Settings saved.", "ok");
    }

    function renderThemePresets() {
        var box = $("themePresets");
        box.innerHTML = "";
        THEME_PRESETS.forEach(function (p) {
            var sw = document.createElement("span");
            sw.className = "tp";
            sw.setAttribute("data-id", p.id);
            sw.title = p.name;
            sw.style.background = swatchCss(p);
            sw.addEventListener("click", function () {
                themeDraft = normTheme({ preset: p.id });
                markPreset();
                syncThemeInputs();
                applyTheme(themeDraft);
            });
            box.appendChild(sw);
        });
        markPreset();
    }
    function markPreset() {
        var kids = $("themePresets").children;
        for (var i = 0; i < kids.length; i++) {
            kids[i].classList.toggle("sel", themeDraft && kids[i].getAttribute("data-id") === themeDraft.preset);
        }
    }

    function syncThemeInputs() {
        if (!themeDraft) return;
        $("gradFrom").value = themeDraft.from;
        $("gradFromHex").value = themeDraft.from;
        $("gradTo").value = themeDraft.to;
        $("gradToHex").value = themeDraft.to;
        $("gradAccent").value = themeDraft.accent;
        $("gradAccentHex").value = themeDraft.accent;
        $("gradAngle").value = String(themeDraft.angle);
        $("gradAngleVal").textContent = themeDraft.angle + "°";
        updateThemePreview();
    }
    function updateThemePreview() {
        if (themeDraft) $("themePreview").style.background = swatchCss(themeDraft);
    }

    // Any manual tweak makes the draft a custom theme and previews it live.
    function setThemeField(key, value) {
        if (!themeDraft) return;
        themeDraft[key] = value;
        themeDraft.preset = "custom";
        markPreset();
        updateThemePreview();
        applyTheme(themeDraft);
    }

    // Colour picker and hex field stay in sync; typing an invalid hex is ignored
    // until it's complete (the picker is unreliable on some CEP builds, so the
    // hex field is a full alternative rather than a nicety).
    function bindColorPair(colorId, hexId, key) {
        var c = $(colorId), h = $(hexId);
        c.addEventListener("input", function () {
            h.value = c.value;
            setThemeField(key, c.value);
        });
        h.addEventListener("input", function () {
            var v = normHex(h.value);
            if (!v) return;
            c.value = v;
            setThemeField(key, v);
        });
    }

    function bindThemeInputs() {
        bindColorPair("gradFrom", "gradFromHex", "from");
        bindColorPair("gradTo", "gradToHex", "to");
        bindColorPair("gradAccent", "gradAccentHex", "accent");
        $("gradAngle").addEventListener("input", function () {
            var a = parseInt(this.value, 10) || 0;
            $("gradAngleVal").textContent = a + "°";
            setThemeField("angle", a);
        });
        $("themeReset").addEventListener("click", function () {
            themeDraft = normTheme({ preset: THEME_PRESETS[0].id });
            markPreset();
            syncThemeInputs();
            applyTheme(themeDraft);
        });
    }

    // ============ What's new ============
    // Ships inside the build it describes, so a panel that has just updated
    // itself can tell the user what changed the first time it reopens. Seen
    // versions are recorded in config.json, which updates never overwrite.
    var CHANGELOG = [
        {
            version: "1.2.0",
            items: [
                "Clicking a sound now previews it straight away, like Premiere Composer. You can turn this off in Settings \u25B8 Playback.",
                "Added folders can be removed again — hover the folder in the sidebar and click the \u00D7. Your sounds stay on disk, and the folder's tags and favourites come back if you re-add it.",
                "A folder that has been moved, renamed, or left on a disconnected drive now shows greyed out instead of quietly disappearing."
            ]
        },
        {
            version: "1.1.0",
            items: [
                "Sound tiles now stand out from the background, so the grid is much easier to scan.",
                "Themes — pick a gradient preset or mix your own, in the new Settings button (gear, bottom-left).",
                "Searching now shows how many matching sounds sit in each folder, and dims the folders with none."
            ]
        }
    ];

    function appVersion() {
        try { return JSON.parse(fs.readFileSync(path.join(EXT_ROOT, "package.json"), "utf8")).version || "0.0.0"; }
        catch (e) { return "0.0.0"; }
    }
    function changelogFor(v) {
        for (var i = 0; i < CHANGELOG.length; i++) if (CHANGELOG[i].version === v) return CHANGELOG[i];
        return null;
    }

    function showWhatsNew(entry) {
        if (!entry) return;
        $("wnVersion").textContent = "v" + entry.version;
        var list = $("wnList");
        list.innerHTML = "";
        entry.items.forEach(function (text) {
            var li = document.createElement("li");
            li.textContent = text;
            list.appendChild(li);
        });
        $("whatsNewModal").hidden = false;
    }
    function closeWhatsNew() { $("whatsNewModal").hidden = true; }

    // Called on launch: show the notes once per version, then remember it.
    function maybeShowWhatsNew() {
        var v = appVersion();
        if (config.settings.seenVersion === v) return;
        config.settings.seenVersion = v;
        saveConfig();
        showWhatsNew(changelogFor(v));
    }

    // ============ Premiere helpers ============
    function parseResult(res) {
        if (res === "EvalScript error.") return { ok: false, err: "ExtendScript error (check host.jsx)" };
        try { return JSON.parse(res); } catch (e) { return { ok: false, err: "Bad response: " + res }; }
    }

    var statusTimer = null;
    function setStatus(msg, kind) {
        $status.textContent = msg;
        $status.className = "status show" + (kind ? " " + kind : "");
        clearTimeout(statusTimer);
        statusTimer = setTimeout(function () { $status.className = "status"; }, 3500);
    }

    // Fill every static [data-icon] element with its SVG.
    function applyIcons() {
        var els = document.querySelectorAll("[data-icon]");
        for (var i = 0; i < els.length; i++) {
            els[i].innerHTML = Icons[els[i].getAttribute("data-icon")] || "";
        }
    }

    // ============ Self-update ============
    function checkForUpdate() {
        if (typeof Updater === "undefined") return;
        try {
            Updater.check(EXT_ROOT).then(function (r) {
                if (r && r.available) showUpdateBar(r);
            }).catch(function () { /* offline / unconfigured — stay quiet */ });
        } catch (e) {}
    }

    function showUpdateBar(r) {
        var bar = $("updateBar");
        $("updateMsg").textContent = "New version v" + r.version + " available" + (r.notes ? " — " + r.notes : "");
        bar.hidden = false;
        $("updateClose").onclick = function () { bar.hidden = true; };
        $("updateBtn").onclick = function () { runUpdate(r); };
    }

    function runUpdate(r) {
        var btn = $("updateBtn");
        btn.disabled = true;
        Updater.apply(EXT_ROOT, r.manifest, function (i, total) {
            $("updateMsg").textContent = "Downloading update… " + i + "/" + total;
        }).then(function () {
            $("updateMsg").textContent = "Updated to v" + r.version + " — close and reopen the panel to finish.";
            btn.textContent = "Done"; btn.disabled = true;
            $("updateClose").hidden = true;
        }).catch(function (e) {
            $("updateMsg").textContent = "Update failed: " + e.message;
            btn.disabled = false;
        });
    }

    // ============ Resizable sidebar ============
    function initSplitter() {
        var sp = $("splitter");
        if (!sp) return;
        var appEl = document.querySelector(".app");
        var dragging = false;

        // Restore saved width
        var saved = config.settings && config.settings.sidebarWidth;
        if (saved) document.documentElement.style.setProperty("--sidebar-w", saved + "px");

        function onMove(e) {
            if (!dragging) return;
            var w = e.clientX - appEl.getBoundingClientRect().left;
            w = Math.max(140, Math.min(w, window.innerWidth - 200));
            document.documentElement.style.setProperty("--sidebar-w", w + "px");
            // grid columns recompute automatically via the grid's ResizeObserver
        }
        function onUp() {
            if (!dragging) return;
            dragging = false;
            sp.classList.remove("dragging");
            document.body.style.cursor = "";
            var w = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--sidebar-w"), 10);
            config.settings.sidebarWidth = w || 240;
            saveConfig();
            if (!$player.hidden && previewPeaks) {
                if (player.buffer) drawPreviewWave(); else renderPreviewCanvas();
            }
        }
        sp.addEventListener("mousedown", function (e) {
            dragging = true;
            sp.classList.add("dragging");
            document.body.style.cursor = "col-resize";
            e.preventDefault();
        });
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    }

    // ============ Wire up ============
    function init() {
        applyIcons();
        loadConfig();
        applyTheme(currentTheme());
        initSplitter();
        buildTree();
        renderTree();
        renderTags();
        if (tree.length) selectFolder(tree[0]); else renderGrid();

        $search.addEventListener("input", function () { renderGrid(); refreshTreeCounts(); });
        $("favToggle").addEventListener("click", function () {
            favFilter = !favFilter;
            this.classList.toggle("on", favFilter);
            renderGrid();
            refreshTreeCounts();
        });
        $("addFolder").addEventListener("click", addFolder);
        $("folderInput").addEventListener("change", function (e) {
            onFolderPicked(e.target.files);
            e.target.value = "";   // allow re-picking the same folder later
        });

        // Tags
        $("addTag").addEventListener("click", function () { openTagModal(null, null); });
        $("tagSave").addEventListener("click", saveTag);
        $("tagCancel").addEventListener("click", closeTagModal);
        $("tagDelete").addEventListener("click", deleteTag);
        $("tagName").addEventListener("keydown", function (e) {
            if (e.key === "Enter") saveTag();
            else if (e.key === "Escape") closeTagModal();
        });
        $("tagModal").addEventListener("click", function (e) { if (e.target === this) closeTagModal(); });

        // Settings (theme)
        $("openSettings").addEventListener("click", openSettings);
        $("settingsSave").addEventListener("click", saveSettings);
        $("settingsCancel").addEventListener("click", function () { closeSettings(true); });
        $("settingsModal").addEventListener("click", function (e) { if (e.target === this) closeSettings(true); });
        bindThemeInputs();
        $("optAutoPlay").addEventListener("change", function () { autoPlayDraft = this.checked; });

        // What's new
        $("showWhatsNew").addEventListener("click", function () {
            showWhatsNew(changelogFor(appVersion()) || CHANGELOG[0]);
        });
        $("wnClose").addEventListener("click", closeWhatsNew);
        $("whatsNewModal").addEventListener("click", function (e) { if (e.target === this) closeWhatsNew(); });
        // Escape closes the top-most dialog.
        document.addEventListener("keydown", function (e) {
            if (e.key !== "Escape") return;
            if (!$("whatsNewModal").hidden) closeWhatsNew();
            else if (!$("settingsModal").hidden) closeSettings(true);
        });
        // dismiss the right-click menu on any outside interaction
        document.addEventListener("click", function () { closeTagMenu(); });
        document.addEventListener("contextmenu", function (e) {
            if (!e.target.closest || !e.target.closest(".tile")) closeTagMenu();
        }, true);

        // Player transport
        $pPlay.addEventListener("click", function () {
            if (player.playing) { stopPlayback(); }
            else { playFrom(player.mode === "el" ? (player.audioEl ? player.audioEl.currentTime : 0) : currentPos()); }
        });
        $("pRestart").addEventListener("click", function () { player.startOffset = 0; playFrom(0); });
        $("pVol").addEventListener("click", function () {
            player.muted = !player.muted;
            player.gain.gain.value = player.muted ? 0 : player.volume;
            if (player.audioEl) player.audioEl.muted = player.muted;
            this.innerHTML = player.muted ? Icons.mute : Icons.volume;
        });
        $pSeek.addEventListener("input", function () {
            var sec = (this.value / 1000) * (player.duration || 0);
            player.startOffset = sec;
            if (player.playing) playFrom(sec); else updateTime(sec);
        });
        $pWave.addEventListener("click", function (e) {
            var rect = $pWave.getBoundingClientRect();
            var sec = (e.clientX - rect.left) / rect.width * (player.duration || 0);
            player.startOffset = sec;
            if (player.playing) playFrom(sec); else updateTime(sec);
        });
        $pPitch.addEventListener("input", function () {
            player.pitch = parseInt(this.value, 10) || 0;
            $pPitchVal.textContent = (player.pitch > 0 ? "+" : "") + player.pitch;
            if (player.playing) playFrom(currentPos());
            ensureProcessedForDrag();
        });
        // Reset clears ALL effects back to the original sound.
        $("pPitchReset").addEventListener("click", function () {
            player.pitch = 0; player.reverse = false; player.reverb = 0; player.treble = 0;
            player.reversedBuf = null;
            $pPitch.value = "0"; $pPitchVal.textContent = "0";
            $pReverse.checked = false;
            $("pReverb").value = "0"; $("pReverbVal").textContent = "0";
            $("pTreble").value = "0"; $("pTrebleVal").textContent = "0";
            if (player.buffer) drawPreviewWave();
            if (player.playing) playFrom(currentPos());
        });
        $pReverse.addEventListener("change", function () {
            player.reverse = this.checked; player.reversedBuf = null;
            if (player.buffer) drawPreviewWave();
            if (player.playing) playFrom(currentPos());
            ensureProcessedForDrag();
        });
        $("pReverb").addEventListener("input", function () {
            player.reverb = (parseInt(this.value, 10) || 0) / 100;
            $("pReverbVal").textContent = String(parseInt(this.value, 10) || 0);
            if (player.playing) playFrom(currentPos());
            ensureProcessedForDrag();
        });
        $("pTreble").addEventListener("input", function () {
            player.treble = parseInt(this.value, 10) || 0;
            $("pTrebleVal").textContent = (player.treble > 0 ? "+" : "") + player.treble;
            if (player.playing) playFrom(currentPos());
            ensureProcessedForDrag();
        });
        $("pAdd").addEventListener("click", function () { addToTimeline("overwrite"); });

        // Collapsible preview: clicking the header (or chevron) slides it
        $("playerHead").addEventListener("click", togglePreview);

        // Virtualized grid: repaint the visible window on scroll
        $grid.addEventListener("scroll", onGridScroll);

        // Recompute columns when the panel is resized/docked/maximized. CEP
        // doesn't reliably fire window 'resize' for panel changes, so observe
        // the grid element directly (debounced to one layout per frame).
        if (window.ResizeObserver) {
            var roScheduled = false;
            new ResizeObserver(function () {
                if (roScheduled) return;
                roScheduled = true;
                requestAnimationFrame(function () {
                    roScheduled = false;
                    layoutGrid();
                    if (!$player.hidden && previewPeaks) {
                        if (player.buffer) drawPreviewWave(); else renderPreviewCanvas();
                    }
                });
            }).observe($grid);
        }

        // Footer: preview volume + tile size + view toggle
        $("volume").addEventListener("input", function () {
            player.volume = (parseInt(this.value, 10) || 0) / 100;
            if (!player.muted) player.gain.gain.value = player.volume;
            if (player.audioEl) player.audioEl.volume = player.volume;
        });
        $("tileSize").addEventListener("input", function () {
            tileZoom = parseInt(this.value, 10) || 190;
            layoutGrid();
        });
        $("viewToggle").addEventListener("click", function () {
            listView = !listView;
            this.innerHTML = listView ? Icons.grid : Icons.list;
            renderGrid();
        });

        window.addEventListener("resize", function () {
            layoutGrid();
            if (!$player.hidden && previewPeaks) {
                if (player.buffer) drawPreviewWave(); else renderPreviewCanvas();
            }
        });

        checkForUpdate();
        maybeShowWhatsNew();
    }

    init();
})();
