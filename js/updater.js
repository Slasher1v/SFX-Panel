/*
 * updater.js — self-updater for "My SFX Panel".
 *
 * On launch the panel fetches a small JSON manifest you host (a raw GitHub
 * URL is perfect). If its version is newer than the locally installed one,
 * the panel downloads the listed files and overwrites itself in place — then
 * asks the user to reopen the panel.
 *
 * User data is preserved: only files listed in the manifest are replaced, so
 * library/config.json (tags, favourites, added folders) is never touched.
 *
 * To cut a release you only edit the hosted manifest + push the new files.
 * A working copy that contains a ".dev" marker file never auto-updates, so
 * your own symlinked dev folder is safe.
 */
window.Updater = (function () {
    "use strict";

    var https = require("https");
    var http = require("http");
    var fs = require("fs");
    var path = require("path");

    // ============================================================
    //  CONFIGURE: point this at your hosted manifest (see update.json).
    //  Example: https://raw.githubusercontent.com/yourname/my-sfx-panel/main/update.json
    var UPDATE_MANIFEST_URL = "https://raw.githubusercontent.com/Slasher1v/SFX-Panel/main/update.json";
    // ============================================================

    function client(url) { return url.indexOf("https:") === 0 ? https : http; }
    function bust(url) { return url + (url.indexOf("?") === -1 ? "?" : "&") + "t=" + Date.now(); }

    function get(url, onRes, onErr) {
        client(url).get(url, { headers: { "User-Agent": "MySFXPanel" } }, function (res) {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                return get(res.headers.location, onRes, onErr);
            }
            if (res.statusCode !== 200) { res.resume(); return onErr(new Error("HTTP " + res.statusCode + " — " + url)); }
            onRes(res);
        }).on("error", onErr);
    }

    function fetchText(url) {
        return new Promise(function (resolve, reject) {
            get(bust(url), function (res) {
                var data = ""; res.setEncoding("utf8");
                res.on("data", function (c) { data += c; });
                res.on("end", function () { resolve(data); });
            }, reject);
        });
    }

    function fetchToFile(url, dest) {
        return new Promise(function (resolve, reject) {
            try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch (e) {}
            get(bust(url), function (res) {
                var out = fs.createWriteStream(dest);
                res.pipe(out);
                out.on("finish", function () { out.close(function () { resolve(); }); });
                out.on("error", reject);
            }, reject);
        });
    }

    function parseVer(v) { return String(v || "0").split(".").map(function (n) { return parseInt(n, 10) || 0; }); }
    function isNewer(remote, local) {
        var a = parseVer(remote), b = parseVer(local);
        for (var i = 0; i < Math.max(a.length, b.length); i++) {
            if ((a[i] || 0) > (b[i] || 0)) return true;
            if ((a[i] || 0) < (b[i] || 0)) return false;
        }
        return false;
    }

    function localVersion(extRoot) {
        try { return JSON.parse(fs.readFileSync(path.join(extRoot, "package.json"), "utf8")).version || "0.0.0"; }
        catch (e) { return "0.0.0"; }
    }
    function isDev(extRoot) {
        try { return fs.existsSync(path.join(extRoot, ".dev")); } catch (e) { return false; }
    }
    function rmrf(p) {
        try {
            var st = fs.statSync(p);
            if (st.isDirectory()) {
                fs.readdirSync(p).forEach(function (c) { rmrf(path.join(p, c)); });
                fs.rmdirSync(p);
            } else { fs.unlinkSync(p); }
        } catch (e) {}
    }

    // Resolve: { available, version, local, notes, manifest } — or {available:false,...}
    function check(extRoot) {
        if (isDev(extRoot)) return Promise.resolve({ available: false, dev: true });
        if (UPDATE_MANIFEST_URL.indexOf("YOUR_GITHUB_USERNAME") !== -1) {
            return Promise.resolve({ available: false, unconfigured: true });
        }
        return fetchText(UPDATE_MANIFEST_URL).then(function (txt) {
            var m = JSON.parse(txt), local = localVersion(extRoot);
            return {
                available: isNewer(m.version, local),
                version: m.version, local: local, notes: m.notes || "", manifest: m
            };
        });
    }

    // Download every listed file to a temp dir, then copy into place once all
    // succeed (so a half-finished download can't leave the panel broken).
    function apply(extRoot, manifest, onProgress) {
        var base = manifest.baseUrl || "";
        if (base && base.charAt(base.length - 1) !== "/") base += "/";
        var files = manifest.files || [];
        var tmp = path.join(extRoot, "_update_tmp");
        rmrf(tmp);

        var i = 0;
        function next() {
            if (i >= files.length) return Promise.resolve();
            var rel = files[i++];
            if (onProgress) onProgress(i, files.length, rel);
            return fetchToFile(base + rel, path.join(tmp, rel)).then(next);
        }

        return next().then(function () {
            files.forEach(function (rel) {
                var to = path.join(extRoot, rel);
                try { fs.mkdirSync(path.dirname(to), { recursive: true }); } catch (e) {}
                fs.copyFileSync(path.join(tmp, rel), to);
            });
            rmrf(tmp);
            // stamp the new version locally
            try {
                var pkgPath = path.join(extRoot, "package.json"), pkg = {};
                try { pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")); } catch (e) {}
                pkg.version = manifest.version;
                fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
            } catch (e) {}
        });
    }

    return { check: check, apply: apply, localVersion: localVersion, manifestUrl: UPDATE_MANIFEST_URL };
})();
