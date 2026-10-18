const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const vm = require('node:vm');
const sharp = require('sharp');
const { createPreviewStore } = require('../preview');

async function fixture(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pano-preview-test-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const uploads = path.join(directory, 'uploads');
    await fs.mkdir(path.join(uploads, 'pano'), { recursive: true });
    return { directory, uploads, store: createPreviewStore(uploads) };
}

async function makeImage(filename, width, height, xmp) {
    const pipeline = sharp({ create: { width, height, channels: 3, background: '#3b8792' } }).jpeg();
    if (xmp) pipeline.withXmp(xmp);
    await pipeline.toFile(filename);
}

test('legacy images receive previews without changing their source files', async t => {
    const { uploads, store } = await fixture(t);
    const source = path.join(uploads, 'old-photo.jpg');
    await makeImage(source, 3200, 1600);
    const before = await fs.readFile(source);
    const destination = await store.ensurePreview('/uploads/old-photo.jpg');
    const metadata = await sharp(destination).metadata();
    assert.equal(metadata.width, 1536);
    assert.equal(metadata.height, 768);
    assert.deepEqual(await fs.readFile(source), before);
    assert.equal(path.dirname(destination), path.join(uploads, 'preview'));
});

test('small and non-standard images keep their proportions and are never enlarged', async t => {
    const { uploads, store } = await fixture(t);
    for (const [width, height] of [[800, 400], [2400, 1600]]) {
        const name = `${width}.jpg`;
        await makeImage(path.join(uploads, name), width, height);
        const preview = await store.ensurePreview(`/uploads/${name}`);
        const metadata = await sharp(preview).metadata();
        assert.equal(metadata.width, Math.min(width, 1536));
        assert.equal(metadata.height, Math.round(height * Math.min(width, 1536) / width));
    }
});

test('concurrent requests share one complete JPEG and unchanged files reuse the preview', async t => {
    const { uploads, store } = await fixture(t);
    await makeImage(path.join(uploads, 'pano', 'one.jpg'), 3000, 1500);
    const results = await Promise.all(Array.from({ length: 8 }, () => store.ensurePreview('/uploads/pano/one.jpg')));
    assert.equal(new Set(results).size, 1);
    assert.equal((await fs.readdir(path.join(uploads, 'preview'))).length, 1);
    const before = await fs.stat(results[0]);
    assert.equal(await store.ensurePreview('/uploads/pano/one.jpg'), results[0]);
    assert.equal((await fs.stat(results[0])).mtimeMs, before.mtimeMs);
    await store.removePreview('/uploads/pano/one.jpg');
    await assert.rejects(fs.access(results[0]));
    await fs.access(path.join(uploads, 'pano', 'one.jpg'));
});

test('GPano dimensions scale while orientation and initial view metadata survive', async t => {
    const { uploads, store } = await fixture(t);
    const xmp = '<x:xmpmeta xmlns:x="adobe:ns:meta/">'
        + '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
        + '<rdf:Description xmlns:GPano="http://ns.google.com/photos/1.0/panorama/" '
        + 'GPano:FullPanoWidthPixels="6000" GPano:CroppedAreaImageWidthPixels="3000" '
        + 'GPano:CroppedAreaLeftPixels="1500" GPano:PoseHeadingDegrees="90" '
        + 'GPano:InitialViewHeadingDegrees="45">'
        + '<GPano:FullPanoHeightPixels>3000</GPano:FullPanoHeightPixels>'
        + '<GPano:CroppedAreaImageHeightPixels>1500</GPano:CroppedAreaImageHeightPixels>'
        + '</rdf:Description></rdf:RDF></x:xmpmeta>';
    await makeImage(path.join(uploads, 'pano', 'crop.jpg'), 3000, 1500, xmp);
    const preview = await store.ensurePreview('/uploads/pano/crop.jpg');
    const metadata = await sharp(preview).metadata();
    const updated = metadata.xmp.toString('utf8');
    assert.match(updated, /GPano:FullPanoWidthPixels="3072"/);
    assert.match(updated, /GPano:CroppedAreaImageWidthPixels="1536"/);
    assert.match(updated, /GPano:CroppedAreaLeftPixels="768"/);
    assert.match(updated, /<GPano:FullPanoHeightPixels>1536</);
    assert.match(updated, /GPano:PoseHeadingDegrees="90"/);
    assert.match(updated, /GPano:InitialViewHeadingDegrees="45"/);
});

test('invalid or missing sources cannot escape uploads or block later generation', async t => {
    const { directory, uploads, store } = await fixture(t);
    await makeImage(path.join(directory, 'outside.jpg'), 300, 150);
    await assert.rejects(store.ensurePreview('/uploads/%2e%2e%2foutside.jpg'));
    await assert.rejects(store.ensurePreview('https://example.com/pano.jpg'));
    await assert.rejects(store.ensurePreview('/uploads/missing.jpg'));
    await fs.writeFile(path.join(uploads, 'bad.jpg'), 'Not an image');
    await assert.rejects(store.ensurePreview('/uploads/bad.jpg'));
    await makeImage(path.join(uploads, 'good.jpg'), 600, 300);
    const good = await store.ensurePreview('/uploads/good.jpg');
    assert.equal((await sharp(good).metadata()).width, 600);
    assert.ok((await fs.readdir(path.join(uploads, 'preview'))).every(name => name.endsWith('.jpg')));
});

test('preview API only reads an existing scene and closes its database connection', async t => {
    const { directory, uploads } = await fixture(t);
    await makeImage(path.join(uploads, 'legacy.jpg'), 2000, 1000);
    const routes = new Map();
    const queries = [];
    let connections = 0;
    let ended = 0;
    const app = { use() {}, get: (route, handler) => routes.set(route, handler),
        post() {}, put() {}, delete() {}, listen() {} };
    const express = () => app;
    express.json = () => () => {};
    express.static = () => () => {};
    const multer = () => ({ single: () => () => {} });
    multer.diskStorage = () => ({});
    const mysql = { createConnection: async () => {
        // Skip the existing startup migration; this test exercises only the new read route.
        if (++connections === 1) throw new Error('Startup connection disabled in test');
        return {
            execute: async (sql, values) => {
                queries.push({ sql, values });
                return [[{ image_url: '/uploads/legacy.jpg' }]];
            },
            end: async () => { ended++; }
        };
    } };
    const source = await fs.readFile(path.join(__dirname, '..', 'server.js'), 'utf8');
    const stubs = { express, multer, cors: () => () => {}, 'mysql2/promise': mysql,
        './preview': { createPreviewStore } };
    vm.runInNewContext(source, { __dirname: directory, console: { log() {}, warn() {} },
        require: name => Object.hasOwn(stubs, name) ? stubs[name] : require(name) });
    let sent;
    await routes.get('/api/scenes/:id/preview')({ params: { id: '95' } }, {
        sendFile: (filename, options) => { sent = { filename, options }; }
    });
    assert.equal(queries.length, 1);
    assert.equal(queries[0].sql, 'SELECT image_url FROM scenes WHERE id = ?');
    assert.equal(queries[0].values[0], '95');
    assert.equal(ended, 1);
    assert.equal((await sharp(sent.filename).metadata()).width, 1536);
    assert.equal(sent.options.maxAge, '1d');
});
