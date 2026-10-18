const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sharp = require('sharp');
const { createPreviewStore } = require('../preview');
const { chromium } = require(process.env.PANO_PLAYWRIGHT_MODULE || 'playwright');

test('real viewer: cached navigation and existing hotspots', { timeout: 120000 }, async t => {
    const browser = await chromium.launch({
        headless: true,
        ...(fs.existsSync(chromium.executablePath()) ? {} : { channel: 'msedge' }),
        args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const fixturePage = await context.newPage();
    const imageData = await fixturePage.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 3072;
        canvas.height = 1536;
        const ctx = canvas.getContext('2d');
        const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
        gradient.addColorStop(0, '#157d73');
        gradient.addColorStop(0.5, '#d6e9f3');
        gradient.addColorStop(1, '#e55a6a');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#18252c';
        ctx.font = '96px sans-serif';
        for (let x = 0; x < canvas.width; x += 384) ctx.fillText(String(x), x, 780);
        return canvas.toDataURL('image/png').split(',')[1];
    });
    await fixturePage.close();
    const xmp = '<x:xmpmeta xmlns:x="adobe:ns:meta/">'
        + '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
        + '<rdf:Description xmlns:GPano="http://ns.google.com/photos/1.0/panorama/" '
        + 'GPano:FullPanoWidthPixels="3072" GPano:FullPanoHeightPixels="1536" '
        + 'GPano:CroppedAreaImageWidthPixels="3072" GPano:CroppedAreaImageHeightPixels="1536" '
        + 'GPano:CroppedAreaLeftPixels="0" GPano:CroppedAreaTopPixels="0" '
        + 'GPano:PoseHeadingDegrees="30" GPano:InitialViewHeadingDegrees="60" '
        + 'GPano:InitialViewPitchDegrees="5" GPano:InitialHorizontalFOVDegrees="90"/>'
        + '</rdf:RDF></x:xmpmeta>';
    const image = await sharp(Buffer.from(imageData, 'base64')).withXmp(xmp).png().toBuffer();
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pano-browser-fixture-'));
    const uploadRoot = path.join(fixtureDir, 'uploads');
    fs.mkdirSync(path.join(uploadRoot, 'pano'), { recursive: true });
    for (const id of [1, 2, 3, 4]) fs.writeFileSync(path.join(uploadRoot, 'pano', `${id}.png`), image);
    const previewStore = createPreviewStore(uploadRoot);
    const viewHtml = fs.readFileSync(path.join(__dirname, '..', 'view.html'));
    const scenes = [1, 2, 3, 4].map(id => ({
        id, title: `Room ${id}`, parent_id: id === 1 ? null : 1, is_group: 0,
        image_url: `/pano/${id}.png`, original_url: `/original/${id}.png`,
        thumb_url: `/thumb/${id}.png`
    }));
    const info = { id: 100, yaw: 0, pitch: 0, title: 'Printer <A1>',
        description: Array(60).fill('Existing information, kept in the database.').join('\n'),
        target_scene_id: null };
    const markers = new Map(scenes.map(s => [s.id, [{ ...info, id: s.id * 100 }]]));
    markers.get(1).push(...[2, 3, 4].map(id => ({
        id: id + 10, yaw: id / 3, pitch: 0, title: `Jump ${id}`,
        description: '', target_scene_id: id
    })));
    let hits = [];
    let imageDelay = new Map();
    let metadataDelay = new Map();
    let failOnce = new Set();
    let imageFailures = new Set();
    let previewUnavailable = new Set();
    let imageCompleted = new Set();
    const server = http.createServer((req, res) => {
        hits.push({ url: req.url, method: req.method });
        const json = body => {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'no-store');
            res.end(JSON.stringify(body));
        };
        if (req.url.startsWith('/view.html')) {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(viewHtml);
        } else if (req.url.startsWith('/api/scenes-tree/')) {
            json({ success: true, projectMainId: 1, scenes });
        } else if (/^\/api\/scenes\/\d+\/preview$/.test(req.url)) {
            const id = Number(req.url.split('/')[3]);
            if (previewUnavailable.has(id)) {
                res.statusCode = 404;
                res.end();
            } else previewStore.ensurePreview(`/uploads/pano/${id}.png`)
                .then(filename => {
                    res.setHeader('Content-Type', 'image/jpeg');
                    res.setHeader('Cache-Control', 'no-store');
                    res.end(fs.readFileSync(filename));
                }).catch(error => {
                    res.statusCode = 404;
                    res.end(error.message);
                });
        } else if (req.url.startsWith('/api/scenes/')) {
            const id = Number(req.url.split('/').pop());
            setTimeout(() => {
                if (failOnce.delete(id)) {
                    res.statusCode = 500;
                    json({ error: 'Simulated failure' });
                } else json({ success: true, scene: scenes.find(s => s.id === id), markers: markers.get(id) });
            }, metadataDelay.get(id) || 0);
        } else if (/^\/(pano|thumb|original)\//.test(req.url)) {
            const id = Number(path.basename(req.url, '.png'));
            const completed = imageCompleted;
            const failed = imageFailures;
            setTimeout(() => {
                if (req.url.startsWith('/pano/') && failed.has(id)) {
                    res.statusCode = 404;
                    res.end();
                    return;
                }
                res.setHeader('Content-Type', 'image/png');
                // Disable HTTP caching to verify the viewer's own panorama cache.
                res.setHeader('Cache-Control', 'no-store');
                res.end(image);
                completed.add(req.url);
            }, req.url.startsWith('/pano/') ? imageDelay.get(id) || 0 : 0);
        } else {
            res.statusCode = 404;
            res.end();
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/view.html?id=1`;
    const count = target => hits.filter(hit => hit.url === target).length;
    const pages = [];
    async function openPage(options = {}) {
        const page = await context.newPage();
        pages.push(page);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        if (options.saveData) await page.addInitScript(() => {
            Object.defineProperty(navigator, 'connection', { value: { saveData: true } });
        });
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForFunction(() => document.querySelector('#titleObj').innerText === 'Room 1');
        await page.waitForFunction(() => !document.querySelector('#loadingOverlay').classList.contains('active'));
        return { page, errors };
    }
    async function reset() {
        for (const page of pages.splice(0)) await page.close();
        hits = [];
        imageDelay = new Map();
        metadataDelay = new Map();
        failOnce = new Set();
        imageFailures = new Set();
        previewUnavailable = new Set();
        imageCompleted = new Set();
    }
    async function waitForPanorama(page, target) {
        await page.waitForFunction(url => {
            const viewer = Object.values(document.querySelector('#viewer'))
                .find(value => value && typeof value.setPanorama === 'function');
            return viewer?.state.textureData?.panorama === url && !viewer.state.loadingPromise;
        }, target);
    }
    async function viewerState(page) {
        return page.evaluate(() => {
            const viewer = Object.values(document.querySelector('#viewer'))
                .find(value => value && typeof value.setPanorama === 'function');
            return { panorama: viewer.state.textureData.panorama,
                position: viewer.getPosition(), zoom: viewer.getZoomLevel(),
                panoData: viewer.state.textureData.panoData,
                pose: { x: viewer.renderer.panoramaPose.x, y: viewer.renderer.panoramaPose.y, z: viewer.renderer.panoramaPose.z },
                fov: viewer.renderer.camera.fov };
        });
    }
    const screenshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pano-view-check-'));
    try {
        await t.test('first load, preserved content, preload limit and cached return', async () => {
            const { page, errors } = await openPage();
            let cached = false;
            for (let i = 0; i < 150 && !cached; i++) {
                cached = await page.evaluate(async () => {
                    const { Cache } = await import('@photo-sphere-viewer/core');
                    return Boolean(Cache.get('/pano/2.png', '/pano/2.png') && Cache.get('/pano/3.png', '/pano/3.png'));
                });
                if (!cached) await new Promise(resolve => setTimeout(resolve, 20));
            }
            assert.ok(cached, 'both linked panoramas should finish preloading');
            assert.equal(count('/pano/2.png'), 1);
            assert.equal(count('/pano/3.png'), 1);
            assert.equal(count('/pano/4.png'), 0);
            assert.equal(await page.locator('.marker-info-title').textContent(), info.title);
            assert.equal(await page.locator('.marker-info-desc').textContent(), info.description);
            await page.evaluate(() => window.switchToScene(2));
            await page.evaluate(() => window.switchToScene(1));
            assert.equal(count('/pano/1.png'), 1);
            assert.equal(count('/pano/2.png'), 1);
            assert.equal(count('/api/scenes/1'), 1);
            assert.equal(count('/api/scenes/2'), 1);
            assert.equal(await page.locator('#titleObj').textContent(), 'Room 1');
            assert.ok(hits.every(hit => hit.method === 'GET'));
            await page.locator('#bottomSceneToggle').click();
            await page.screenshot({ path: path.join(screenshotDir, 'desktop.png') });
            await page.setViewportSize({ width: 390, height: 844 });
            await page.screenshot({ path: path.join(screenshotDir, 'mobile.png') });
            assert.ok(await page.locator('#viewer canvas').count() > 0);
            assert.deepEqual(errors, []);
        });
        await reset();
        await t.test('low resolution is usable before HD and the upgrade preserves yaw, pitch, zoom and hotspots', async () => {
            imageDelay.set(1, 1600);
            const { page, errors } = await openPage({ saveData: true });
            assert.equal((await viewerState(page)).panorama, '/api/scenes/1/preview');
            assert.equal(imageCompleted.has('/pano/1.png'), false);
            await page.evaluate(() => {
                const viewer = Object.values(document.querySelector('#viewer'))
                    .find(value => value && typeof value.setPanorama === 'function');
                viewer.rotate({ yaw: 1.1, pitch: 0.15 });
                viewer.zoom(37);
                window.testViewerInstance = viewer;
            });
            await page.waitForFunction(() => getComputedStyle(document.querySelector('#loadingOverlay')).opacity === '0');
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            const before = await viewerState(page);
            const infoBefore = await page.locator('.marker-info-desc').textContent();
            const previewPixels = await sharp(await page.locator('#viewer canvas').screenshot())
                .resize(64, 40).removeAlpha().raw().toBuffer();
            await page.screenshot({ path: path.join(screenshotDir, 'preview.png') });
            await waitForPanorama(page, '/pano/1.png');
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            const after = await viewerState(page);
            assert.ok(Math.abs(after.position.yaw - before.position.yaw) < 0.001);
            assert.ok(Math.abs(after.position.pitch - before.position.pitch) < 0.001);
            assert.ok(Math.abs(after.zoom - before.zoom) < 0.001);
            assert.equal(await page.locator('.marker-info-desc').textContent(), infoBefore);
            assert.ok(await page.evaluate(() => Object.values(document.querySelector('#viewer')).includes(window.testViewerInstance)));
            const hdScreenshot = await page.locator('#viewer canvas').screenshot();
            const pixels = await sharp(hdScreenshot).stats();
            assert.ok(pixels.channels.slice(0, 3).some(channel => channel.stdev > 5));
            const hdPixels = await sharp(hdScreenshot).resize(64, 40).removeAlpha().raw().toBuffer();
            const difference = previewPixels.reduce((sum, value, index) => sum + Math.abs(value - hdPixels[index]), 0) / previewPixels.length;
            await page.screenshot({ path: path.join(screenshotDir, 'hd.png') });
            if (difference >= 12) console.log('Alignment diagnostics:', JSON.stringify({ before, after, difference }));
            assert.ok(difference < 12, `the panorama must remain aligned across the upgrade (pixel difference ${difference})`);
            assert.deepEqual(errors, []);
        });
        await reset();
        await t.test('click during a neighbour download does not download it twice', async () => {
            imageDelay.set(2, 900);
            const { page, errors } = await openPage();
            for (let i = 0; i < 100 && count('/pano/2.png') === 0; i++) {
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            assert.equal(count('/pano/2.png'), 1);
            await page.evaluate(() => window.switchToScene(2));
            assert.equal(await page.locator('#titleObj').textContent(), 'Room 2');
            await waitForPanorama(page, '/pano/2.png');
            assert.equal(count('/pano/2.png'), 1);
            assert.equal(count('/api/scenes/2'), 1);
            assert.deepEqual(errors, []);
        });
        await reset();
        await t.test('latest click wins, a failed request retries, and download uses the active scene', async () => {
            metadataDelay.set(2, 300);
            const { page, errors } = await openPage({ saveData: true });
            await page.evaluate(() => Promise.all([window.switchToScene(2), window.switchToScene(3)]));
            assert.equal(await page.locator('#titleObj').textContent(), 'Room 3');
            failOnce.add(4);
            await page.evaluate(() => window.switchToScene(4));
            assert.equal(await page.locator('#loadingOverlay').evaluate(el => el.classList.contains('active')), false);
            await page.evaluate(() => window.switchToScene(4));
            assert.equal(await page.locator('#titleObj').textContent(), 'Room 4');
            const downloadButton = page.locator('.psv-navbar .psv-custom-button');
            assert.equal(await downloadButton.count(), 1,
                await page.locator('.psv-navbar').evaluate(el => el.outerHTML));
            const [file] = await Promise.all([
                page.waitForEvent('download', { timeout: 5000 }), downloadButton.click()
            ]);
            assert.equal(file.suggestedFilename(), 'Room 4.jpg');
            assert.equal(count('/original/4.png'), 1);
            assert.deepEqual(errors, []);
        });
        await reset();
        await t.test('missing previews fall back to existing images without rebuilding scenes', async () => {
            previewUnavailable.add(1);
            const { page, errors } = await openPage({ saveData: true });
            await waitForPanorama(page, '/pano/1.png');
            assert.equal(await page.locator('.marker-info-title').textContent(), info.title);
            assert.deepEqual(errors, []);
        });
        await reset();
        await t.test('failed HD download keeps the preview interactive', async () => {
            imageFailures.add(1);
            const { page, errors } = await openPage({ saveData: true });
            assert.equal((await viewerState(page)).panorama, '/api/scenes/1/preview');
            assert.equal(await page.locator('.marker-info-desc').textContent(), info.description);
            await page.locator('#bottomSceneToggle').click();
            await page.locator('.scene-thumb-item').first().click();
            await page.waitForFunction(() => document.querySelector('#titleObj').innerText === 'Room 2');
            assert.deepEqual(errors, []);
        });
        await reset();
        await t.test('a late HD download cannot replace a more recent scene', async () => {
            imageDelay.set(1, 1500);
            const { page, errors } = await openPage({ saveData: true });
            await page.evaluate(() => window.switchToScene(2));
            await waitForPanorama(page, '/pano/2.png');
            await new Promise(resolve => setTimeout(resolve, 1600));
            assert.equal((await viewerState(page)).panorama, '/pano/2.png');
            assert.equal(await page.locator('#titleObj').textContent(), 'Room 2');
            assert.deepEqual(errors, []);
        });
        await reset();
        await t.test('data-saving mode skips background downloads', async () => {
            const { page, errors } = await openPage({ saveData: true });
            await new Promise(resolve => setTimeout(resolve, 900));
            assert.equal(count('/pano/2.png'), 0);
            assert.equal(count('/api/scenes/2'), 0);
            assert.deepEqual(errors, []);
        });
        console.log(`Screenshots: ${screenshotDir}`);
    } finally {
        await context.close();
        await browser.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
});
