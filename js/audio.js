/*
 * audio.js — AudioEngine for "My SFX Panel"
 *
 * Decodes audio files into peaks (for waveform drawing), renders
 * pitch/reverse-processed buffers, and encodes WAV. Uses the Web Audio
 * API; falls back to ffmpeg for peaks when a format won't decode
 * (e.g. some .m4a). Node (fs/child_process) is enabled via --enable-nodejs.
 */
window.AudioEngine = (function () {
    "use strict";

    var fs = require("fs");
    var cp = require("child_process");

    var Ctx = window.AudioContext || window.webkitAudioContext;
    var actx = new Ctx();

    var bufCache = {};   // path -> AudioBuffer
    var peakCache = {};  // path -> { peaks:Float32Array(N*2), duration }
    var PEAK_N = 320;    // peak resolution used for thumbnails

    // Locate ffmpeg (GUI apps don't inherit the shell PATH).
    var FFMPEG = (function () {
        var cands = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"];
        for (var i = 0; i < cands.length; i++) {
            try { if (fs.existsSync(cands[i])) return cands[i]; } catch (e) {}
        }
        return null;
    })();

    function readArrayBuffer(p) {
        var b = fs.readFileSync(p); // Node Buffer
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    }

    function decode(p) {
        if (bufCache[p]) return Promise.resolve(bufCache[p]);
        return new Promise(function (res, rej) {
            var ab;
            try { ab = readArrayBuffer(p); } catch (e) { return rej(e); }
            actx.decodeAudioData(ab, function (buf) { bufCache[p] = buf; res(buf); },
                function (e) { rej(e || new Error("decodeAudioData failed")); });
        });
    }

    // Downsample a mono mix of an AudioBuffer to PEAK_N min/max pairs.
    function peaksFromBuffer(buf, n) {
        var ch = buf.numberOfChannels, len = buf.length;
        var datas = [];
        for (var c = 0; c < ch; c++) datas.push(buf.getChannelData(c));
        var step = Math.max(1, Math.floor(len / n));
        var peaks = new Float32Array(n * 2);
        for (var i = 0; i < n; i++) {
            var start = i * step, end = Math.min(len, start + step), mn = 0, mx = 0;
            for (var j = start; j < end; j++) {
                var v = 0;
                for (var c2 = 0; c2 < ch; c2++) v += datas[c2][j];
                v /= ch;
                if (v > mx) mx = v;
                if (v < mn) mn = v;
            }
            peaks[i * 2] = mn; peaks[i * 2 + 1] = mx;
        }
        return peaks;
    }

    // Per-channel peaks at a given width (used for the big stereo preview).
    function channelPeaks(buf, width) {
        var ch = buf.numberOfChannels, len = buf.length, out = [];
        var step = Math.max(1, Math.floor(len / width));
        for (var c = 0; c < ch; c++) {
            var d = buf.getChannelData(c), peaks = new Float32Array(width * 2);
            for (var i = 0; i < width; i++) {
                var start = i * step, end = Math.min(len, start + step), mn = 0, mx = 0;
                for (var j = start; j < end; j++) {
                    var v = d[j];
                    if (v > mx) mx = v;
                    if (v < mn) mn = v;
                }
                peaks[i * 2] = mn; peaks[i * 2 + 1] = mx;
            }
            out.push(peaks);
        }
        return out;
    }

    function ffmpegPeaks(p, n) {
        return new Promise(function (res, rej) {
            if (!FFMPEG) return rej(new Error("ffmpeg not found"));
            cp.execFile(FFMPEG, ["-v", "error", "-i", p, "-ac", "1", "-ar", "8000", "-f", "s16le", "-"],
                { maxBuffer: 1024 * 1024 * 64, encoding: "buffer" }, function (err, stdout) {
                    if (err) return rej(err);
                    var samples = new Int16Array(stdout.buffer, stdout.byteOffset,
                        Math.floor(stdout.byteLength / 2));
                    var len = samples.length, step = Math.max(1, Math.floor(len / n));
                    var peaks = new Float32Array(n * 2);
                    for (var i = 0; i < n; i++) {
                        var start = i * step, end = Math.min(len, start + step), mn = 0, mx = 0;
                        for (var j = start; j < end; j++) {
                            var v = samples[j] / 32768;
                            if (v > mx) mx = v;
                            if (v < mn) mn = v;
                        }
                        peaks[i * 2] = mn; peaks[i * 2 + 1] = mx;
                    }
                    res({ peaks: peaks, duration: len / 8000 });
                });
        });
    }

    // Thumbnail peaks: try Web Audio (also warms the decode cache), then
    // ffmpeg, then give up. Cached per path.
    function peaks(p) {
        if (peakCache[p]) return Promise.resolve(peakCache[p]);
        return decode(p).then(function (buf) {
            var r = { peaks: peaksFromBuffer(buf, PEAK_N), duration: buf.duration };
            peakCache[p] = r; return r;
        }).catch(function () {
            return ffmpegPeaks(p, PEAK_N).then(function (r) { peakCache[p] = r; return r; });
        });
    }

    function reversed(buf) {
        var out = actx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
        for (var c = 0; c < buf.numberOfChannels; c++) {
            var src = buf.getChannelData(c), dst = out.getChannelData(c), n = buf.length;
            for (var i = 0; i < n; i++) dst[i] = src[n - 1 - i];
        }
        return out;
    }

    // Synthetic reverb impulse response: decaying noise. `decay` in seconds,
    // `falloff` shapes the tail (higher = faster decay).
    function makeImpulse(ctx, decay, falloff) {
        var rate = ctx.sampleRate;
        var len = Math.max(1, Math.floor(decay * rate));
        var imp = ctx.createBuffer(2, len, rate);
        for (var c = 0; c < 2; c++) {
            var ch = imp.getChannelData(c);
            for (var i = 0; i < len; i++) {
                ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, falloff);
            }
        }
        return imp;
    }

    // Offline-render a buffer with pitch (resample), reverse, and reverb baked
    // in. Crucially, when reverb is on we ADD a tail to the render length, so
    // the exported file is longer and the reverb tail survives import (a
    // Premiere effect alone can't lengthen a clip).
    function renderProcessed(buf, semitones, reverse, reverbWet, reverbDecay, trebleDb) {
        var rate = Math.pow(2, semitones / 12);
        var srcBuf = reverse ? reversed(buf) : buf;
        var sr = srcBuf.sampleRate;
        var baseLen = Math.max(1, Math.ceil(srcBuf.length / rate));
        var decay = reverbDecay || 2.2;
        var tail = (reverbWet > 0) ? Math.ceil((decay + 0.3) * sr) : 0;

        var oc = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(
            srcBuf.numberOfChannels, baseLen + tail, sr);
        var src = oc.createBufferSource();
        src.buffer = srcBuf;
        src.playbackRate.value = rate;

        // Treble = high-shelf EQ. Sits right after the source, before reverb.
        var node = src;
        if (trebleDb && trebleDb !== 0) {
            var hs = oc.createBiquadFilter();
            hs.type = "highshelf"; hs.frequency.value = 3500; hs.gain.value = trebleDb;
            src.connect(hs); node = hs;
        }

        if (reverbWet > 0) {
            var conv = oc.createConvolver();
            conv.buffer = makeImpulse(oc, decay, 2.5);
            var wet = oc.createGain(); wet.gain.value = reverbWet;
            node.connect(oc.destination);                 // dry (full)
            node.connect(conv); conv.connect(wet); wet.connect(oc.destination); // wet
        } else {
            node.connect(oc.destination);
        }
        src.start();
        return oc.startRendering();
    }

    function encodeWav(buf) {
        var numCh = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate;
        var blockAlign = numCh * 2, dataSize = len * blockAlign;
        var ab = new ArrayBuffer(44 + dataSize), dv = new DataView(ab);
        function ws(off, s) { for (var i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); }
        ws(0, "RIFF"); dv.setUint32(4, 36 + dataSize, true); ws(8, "WAVE");
        ws(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
        dv.setUint16(22, numCh, true); dv.setUint32(24, sr, true);
        dv.setUint32(28, sr * blockAlign, true); dv.setUint16(32, blockAlign, true); dv.setUint16(34, 16, true);
        ws(36, "data"); dv.setUint32(40, dataSize, true);
        var offset = 44, chans = [];
        for (var c = 0; c < numCh; c++) chans.push(buf.getChannelData(c));
        for (var i = 0; i < len; i++) {
            for (var c2 = 0; c2 < numCh; c2++) {
                var s = Math.max(-1, Math.min(1, chans[c2][i]));
                dv.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
                offset += 2;
            }
        }
        return Buffer.from(ab);
    }

    return {
        context: actx,
        decode: decode,
        peaks: peaks,
        channelPeaks: channelPeaks,
        reversed: reversed,
        makeImpulse: makeImpulse,
        renderProcessed: renderProcessed,
        encodeWav: encodeWav,
        ffmpegAvailable: !!FFMPEG
    };
})();
