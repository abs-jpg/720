const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'view.html'), 'utf8');
const source = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
    .replace(/^\s*import .*;\s*$/gm, '');

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function makeHarness() {
    let now = 0;
    let timerId = 0;
    const timers = new Map();
    const elements = new Map();
    const imageCache = new Map();
    const requests = [];
    const loads = [];
    const preloads = [];
    const imageGates = new Map();
    const metadataGates = new Map();
    const failures = new Set();
    const imageFailures = new Set();
    const scenes = [1, 2, 3, 4].map(id => ({
        id, title: `Room ${id}`, parent_id: id === 1 ? null : 1,
        is_group: 0, image_url: `/pano/${id}.jpg`, thumb_url: `/thumb/${id}.jpg`,
        preview_url: `/preview/${id}.jpg`
    }));
    const info = { id: 10, yaw: 0, pitch: 0, title: 'Printer <A1>',
        description: 'Original description', target_scene_id: null };
    const markers = new Map(scenes.map(scene => [scene.id, [{ ...info, id: scene.id * 10 }]]));
    const rawMarkers = JSON.stringify([...markers]);
    const setTimer = (fn, delay, repeat = false) => {
        const id = ++timerId;
        timers.set(id, { fn, at: now + delay, delay, repeat });
        return id;
    };
    const element = () => {
        const classes = new Set();
        return {
            style: {}, innerText: '', innerHTML: '', children: [],
            classList: {
                add: name => classes.add(name), remove: name => classes.delete(name),
                contains: name => classes.has(name),
                toggle: (name, on) => on ? classes.add(name) : classes.delete(name)
            },
            setAttribute() {}, appendChild(child) { this.children.push(child); },
            querySelector() { return element(); }
        };
    };
    const byId = id => {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
    };
    const plugin = {
        markers: [], updates: 0, addEventListener() {},
        setMarkers(items) { this.markers = items; this.updates++; },
        clearMarkers() { this.markers = []; }
    };
    class Viewer {
        constructor() {
            this.loadId = 0;
            this.position = { yaw: 0, pitch: 0 };
            this.zoom = 0;
            this.state = { textureData: { panoData: {
                fullWidth: 1536, fullHeight: 768,
                croppedWidth: 1536, croppedHeight: 768,
                croppedX: 0, croppedY: 0, poseHeading: 30
            } } };
        }
        async setPanorama(url, options) {
            const id = ++this.loadId;
            loads.push({ url, options });
            if (imageGates.has(url)) await imageGates.get(url).promise;
            if (imageFailures.has(url)) throw new Error('Image unavailable');
            if (id !== this.loadId) return false;
            imageCache.set(url, true);
            return true;
        }
        getPlugin() { return plugin; }
        getPosition() { return { ...this.position }; }
        getZoomLevel() { return this.zoom; }
        hideError() {}
        addEventListener() {}
        removeEventListener() {}
    }
    const window = { location: { search: '' }, addEventListener() {} };
    const context = vm.createContext({
        window, Viewer, MarkersPlugin: {}, fixtures: scenes,
        Cache: { get: url => imageCache.get(url),
            add: (url, key, data) => imageCache.set(url, data),
            remove: url => imageCache.delete(url) }, navigator: {},
        URLSearchParams, AbortController, performance: { now: () => now },
        Date: class extends Date { static now() { return now; } },
        console: { error() {}, warn() {} },
        document: { getElementById: byId, querySelector: byId, createElement: element },
        setTimeout: (fn, delay) => setTimer(fn, delay),
        clearTimeout: id => timers.delete(id),
        setInterval: (fn, delay) => setTimer(fn, delay, true),
        clearInterval: id => timers.delete(id),
        requestAnimationFrame: fn => setTimer(() => fn(now), 16),
        cancelAnimationFrame: id => timers.delete(id),
        fetch: async (url, options) => {
            requests.push({ url, options });
            if (!url.startsWith('/api/scenes/')) {
                preloads.push(url);
                const gate = imageGates.get(url);
                if (gate) {
                    await Promise.race([gate.promise, new Promise((resolve, reject) => {
                        options.signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
                    })]);
                }
                return { ok: !imageFailures.has(url), status: imageFailures.has(url) ? 404 : 200,
                    blob: async () => ({ url }) };
            }
            const id = Number(url.split('/').pop());
            if (metadataGates.has(id)) await metadataGates.get(id).promise;
            const ok = !failures.has(id);
            return { ok, status: ok ? 200 : 500,
                json: async () => ({ success: true, scene: scenes.find(s => s.id === id),
                    markers: markers.get(id) || [] }) };
        }
    });
    vm.runInContext(source, context, { filename: 'view.html' });
    vm.runInContext('projectScenes = fixtures; projectMainId = 1;', context);
    const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
    async function advance(ms) {
        const end = now + ms;
        await flush();
        while (true) {
            const next = [...timers].filter(([, timer]) => timer.at <= end)
                .sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            const [id, timer] = next;
            now = timer.at;
            if (timer.repeat) timer.at += timer.delay;
            else timers.delete(id);
            timer.fn();
            await flush();
        }
        now = end;
        await flush();
    }
    async function settle(promise) {
        let done = false;
        promise.finally(() => { done = true; });
        for (let i = 0; i < 40 && !done; i++) await advance(16);
        assert.ok(done, 'operation should complete');
        return promise;
    }
    return { context, window, byId, plugin, scenes, markers, rawMarkers,
        requests, loads, preloads, imageGates, metadataGates, failures, imageFailures,
        advance, settle, flush, run: code => vm.runInContext(code, context) };
}

test('preview is interactive before HD finishes and upgrading preserves view and hotspots', async () => {
    const h = makeHarness();
    const gate = deferred();
    h.imageGates.set('/pano/1.jpg', gate);
    await h.settle(h.window.switchToScene(1, true));
    await h.advance(200);
    assert.equal(h.run('currentPanoramaUrl'), '/preview/1.jpg');
    assert.equal(h.byId('loadingOverlay').classList.contains('active'), false);
    assert.equal(h.byId('titleObj').innerText, 'Room 1');
    assert.equal(h.plugin.markers[0].data.title, 'Printer <A1>');
    assert.equal(h.plugin.markers[0].data.desc, 'Original description');
    assert.equal(JSON.stringify([...h.markers]), h.rawMarkers);
    assert.equal(h.loads[0].options.transition, false);
    h.run('viewer.position = { yaw: 1.2, pitch: 0.3 }; viewer.zoom = 42;');
    const upgrade = h.run('qualityUpgrade.promise');
    gate.resolve();
    await h.settle(upgrade);
    assert.equal(h.run('currentPanoramaUrl'), '/pano/1.jpg');
    assert.equal(h.run('viewer.getPosition().yaw'), 1.2);
    assert.equal(h.run('viewer.getZoomLevel()'), 42);
    assert.equal(h.loads[1].options.position, undefined);
    assert.equal(h.loads[1].options.zoom, undefined);
    const data = h.loads[1].options.panoData({ width: 3072, height: 1536 });
    assert.equal(data.poseHeading, 30);
    assert.equal(data.fullWidth, 3072);
    assert.equal(data.initialHeading, null);
    assert.equal(h.plugin.updates, 1);
    assert.ok(h.requests.every(r => !r.options?.method || r.options.method === 'GET'));
});

test('returning to a visited scene uses cached metadata and the short transition', async () => {
    const h = makeHarness();
    await h.settle(h.window.switchToScene(1, true));
    await h.advance(200);
    await h.settle(h.window.switchToScene(2));
    await h.settle(h.window.switchToScene(1));
    assert.equal(h.requests.filter(r => r.url === '/api/scenes/1').length, 1);
    assert.equal(h.loads.find(load => load.url === '/preview/2.jpg').options.transition.speed, 250);
    assert.equal(h.loads.at(-1).url, '/pano/1.jpg');
    assert.equal(h.byId('loadingOverlay').classList.contains('active'), false);
    const count = h.loads.length;
    await h.window.switchToScene(1);
    assert.equal(h.loads.length, count);
});

test('metadata requests are deduplicated, expire and retry after errors', async () => {
    const h = makeHarness();
    const gate = deferred();
    h.metadataGates.set(2, gate);
    const first = h.run('getSceneData(2)');
    const second = h.run('getSceneData(2)');
    assert.equal(h.requests.length, 1);
    gate.resolve();
    await Promise.all([first, second]);
    await h.run('getSceneData(2)');
    assert.equal(h.requests.length, 1);
    await h.advance(5 * 60 * 1000 + 1);
    await h.run('getSceneData(2)');
    assert.equal(h.requests.length, 2);
    h.failures.add(3);
    await assert.rejects(h.run('getSceneData(3)'));
    h.failures.delete(3);
    await h.run('getSceneData(3)');
    assert.equal(h.requests.filter(r => r.url.endsWith('/3')).length, 2);
});

test('late results from an older click cannot replace the most recent scene', async () => {
    const h = makeHarness();
    await h.settle(h.window.switchToScene(1, true));
    const gate = deferred();
    h.metadataGates.set(2, gate);
    const old = h.window.switchToScene(2);
    const latest = h.window.switchToScene(3);
    await h.settle(latest);
    gate.resolve();
    await h.settle(old);
    assert.equal(h.byId('titleObj').innerText, 'Room 3');
    assert.equal(h.plugin.markers[0].id, 'm-30');
});

test('preloading is limited to two unique linked scenes and runs sequentially', async () => {
    const h = makeHarness();
    h.markers.set(1, [2, 2, 3, 4].map((id, index) => ({
        id: 100 + index, title: 'Jump', description: '', yaw: 0, pitch: 0,
        target_scene_id: id
    })));
    const gate = deferred();
    h.imageGates.set('/preview/2.jpg', gate);
    await h.settle(h.window.switchToScene(1, true));
    await h.advance(650);
    assert.deepEqual(h.preloads, ['/pano/1.jpg', '/preview/2.jpg']);
    gate.resolve();
    await h.advance(1);
    assert.deepEqual(h.preloads, ['/pano/1.jpg', '/preview/2.jpg', '/preview/3.jpg', '/pano/2.jpg', '/pano/3.jpg']);
    assert.equal(h.requests.filter(r => r.url.endsWith('/4')).length, 0);
});

test('clicking a scene being preloaded reuses the download and cancels the old queue', async () => {
    const h = makeHarness();
    h.markers.set(1, [2, 3].map(id => ({
        id, title: 'Jump', description: '', yaw: 0, pitch: 0, target_scene_id: id
    })));
    const gate = deferred();
    h.imageGates.set('/pano/2.jpg', gate);
    await h.settle(h.window.switchToScene(1, true));
    await h.advance(650);
    await h.settle(h.window.switchToScene(2));
    assert.equal(h.run('currentPanoramaUrl'), '/preview/2.jpg');
    const upgrade = h.run('qualityUpgrade.promise');
    gate.resolve();
    await h.settle(upgrade);
    assert.equal(h.byId('titleObj').innerText, 'Room 2');
    assert.equal(h.requests.filter(r => r.url.endsWith('/2')).length, 1);
    assert.equal(h.preloads.filter(url => url === '/pano/2.jpg').length, 1);
    assert.equal(h.preloads.includes('/pano/3.jpg'), false);
});

test('data-saving mode avoids speculative image requests', async () => {
    const h = makeHarness();
    h.context.navigator.connection = { saveData: true };
    h.markers.set(1, [{ id: 2, title: 'Jump', yaw: 0, pitch: 0, target_scene_id: 2 }]);
    await h.settle(h.window.switchToScene(1, true));
    await h.advance(1000);
    assert.deepEqual(h.preloads, ['/pano/1.jpg']);
    assert.equal(h.requests.filter(request => request.url.startsWith('/api/')).length, 1);
});

test('failed metadata leaves the loader dismissible and allows a normal retry', async () => {
    const h = makeHarness();
    await h.settle(h.window.switchToScene(1, true));
    h.failures.add(2);
    await h.settle(h.window.switchToScene(2));
    assert.equal(h.byId('loadingOverlay').classList.contains('active'), false);
    assert.equal(h.run('requestedSceneId'), null);
    h.failures.delete(2);
    await h.settle(h.window.switchToScene(2));
    assert.equal(h.byId('titleObj').innerText, 'Room 2');
    assert.equal(h.plugin.markers[0].id, 'm-20');
});

test('an unavailable target cannot leave an older loading overlay stuck', async () => {
    const h = makeHarness();
    const gate = deferred();
    h.imageGates.set('/preview/1.jpg', gate);
    const old = h.window.switchToScene(1, true);
    await h.advance(350);
    await h.window.switchToScene(999);
    assert.equal(h.byId('loadingOverlay').classList.contains('active'), false);
    gate.resolve();
    await h.settle(old);
    assert.equal(h.run('requestedSceneId'), null);
    assert.equal(h.run('currentSceneId'), null);
});

test('unavailable preview falls back to the existing full image', async () => {
    const h = makeHarness();
    h.imageFailures.add('/preview/1.jpg');
    await h.settle(h.window.switchToScene(1, true));
    assert.equal(h.run('currentPanoramaUrl'), '/pano/1.jpg');
    assert.equal(h.byId('titleObj').innerText, 'Room 1');
    assert.equal(h.plugin.markers[0].data.title, 'Printer <A1>');
});

test('failed HD download keeps the usable preview and retries on a later visit', async () => {
    const h = makeHarness();
    h.imageFailures.add('/pano/1.jpg');
    await h.settle(h.window.switchToScene(1, true));
    await h.advance(200);
    assert.equal(h.run('currentPanoramaUrl'), '/preview/1.jpg');
    assert.equal(h.byId('titleObj').innerText, 'Room 1');
    assert.equal(h.plugin.markers[0].id, 'm-10');
    h.imageFailures.delete('/pano/1.jpg');
    await h.settle(h.window.switchToScene(2));
    await h.settle(h.window.switchToScene(1));
    await h.flush();
    assert.equal(h.run('currentPanoramaUrl'), '/pano/1.jpg');
});

test('a late HD response cannot upgrade a different scene', async () => {
    const h = makeHarness();
    const gate = deferred();
    h.imageGates.set('/pano/1.jpg', gate);
    await h.settle(h.window.switchToScene(1, true));
    await h.settle(h.window.switchToScene(2));
    gate.resolve();
    await h.flush();
    assert.equal(h.byId('titleObj').innerText, 'Room 2');
    assert.equal(h.run('currentPanoramaUrl'), '/pano/2.jpg');
    assert.equal(h.loads.filter(load => load.url === '/pano/1.jpg').length, 0);
});
