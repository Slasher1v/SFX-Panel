/*
 * host.jsx — ExtendScript host for "My SFX Panel"
 * Runs inside Premiere Pro. Imports SFX and drops them on the timeline
 * at the playhead. The panel UI (main.js) calls these functions via
 * CSInterface.evalScript().
 *
 * ExtendScript has no JSON object, so every function returns a JSON
 * STRING built by hand. The panel parses it with JSON.parse().
 */

var TICKS_PER_SECOND = 254016000000; // Premiere's fixed tick rate

function _esc(s) {
    if (s === undefined || s === null) return "";
    s = String(s);
    s = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "");
    return s;
}

function _ok(msg)  { return '{"ok":true,"msg":"'  + _esc(msg) + '"}'; }
function _err(msg) { return '{"ok":false,"err":"' + _esc(msg) + '"}'; }

// Recursively search the project tree for an already-imported clip
// whose media path matches the file we're about to drop.
function _findItemByPath(item, mediaPath) {
    if (!item) return null;
    try {
        if (item.getMediaPath && item.getMediaPath() === mediaPath) return item;
    } catch (e) {}
    if (item.children && item.children.numItems > 0) {
        for (var i = 0; i < item.children.numItems; i++) {
            var found = _findItemByPath(item.children[i], mediaPath);
            if (found) return found;
        }
    }
    return null;
}

// Return info about the active sequence so the panel can populate
// its audio-track dropdown.
function getSequenceInfo() {
    try {
        if (!app.project) return _err("No project open");
        var seq = app.project.activeSequence;
        if (!seq) return _err("No active sequence");
        var parts = [];
        for (var i = 0; i < seq.audioTracks.numTracks; i++) {
            var t = seq.audioTracks[i];
            var nm = (t.name && t.name.length) ? t.name : ("A" + (i + 1));
            parts.push('{"index":' + i + ',"name":"' + _esc(nm) + '"}');
        }
        return '{"ok":true,"sequence":"' + _esc(seq.name) + '","audioTracks":[' + parts.join(",") + ']}';
    } catch (e) {
        return _err(e.toString());
    }
}

// Import (if needed) and overwrite the SFX onto the TARGETED audio track at
// the current playhead (the track whose target button is lit blue). Falls
// back to A1 if nothing is targeted.
function dropSFXAtPlayhead(filePath, mode) {
    try {
        if (!app.project) return _err("No project open");
        var seq = app.project.activeSequence;
        if (!seq) return _err("No active sequence — open a sequence first");
        if (seq.audioTracks.numTracks === 0) return _err("Sequence has no audio tracks");

        // Reuse the clip if it's already in the project, otherwise import it.
        var item = _findItemByPath(app.project.rootItem, filePath);
        if (!item) {
            app.project.importFiles([filePath], true, app.project.rootItem, false);
            item = _findItemByPath(app.project.rootItem, filePath);
        }
        if (!item) return _err("Could not import file: " + filePath);

        // Find the targeted audio track; fall back to A1.
        var track = null, trackIndex = 0;
        for (var i = 0; i < seq.audioTracks.numTracks; i++) {
            var t = seq.audioTracks[i];
            var targeted = false;
            try { targeted = t.isTargeted(); } catch (e) {}
            if (targeted) { track = t; trackIndex = i; break; }
        }
        if (!track) { track = seq.audioTracks[0]; trackIndex = 0; }

        // Playhead position in seconds (with a ticks fallback for safety).
        var pos = seq.getPlayerPosition();
        var seconds = pos.seconds;
        if (seconds === undefined || seconds === null) {
            seconds = parseFloat(pos.ticks) / TICKS_PER_SECOND;
        }

        if (mode === "insert") track.insertClip(item, seconds);
        else track.overwriteClip(item, seconds);

        return _ok("Added \"" + item.name + "\" on A" + (trackIndex + 1));
    } catch (e) {
        return _err("Script error: " + e.toString());
    }
}
