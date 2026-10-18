const fs = require('fs/promises');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const sharp = require('sharp');

function scalePanoramaXmp(xmp, scaleX, scaleY) {
    const geometry = {
        FullPanoWidthPixels: scaleX, CroppedAreaImageWidthPixels: scaleX, CroppedAreaLeftPixels: scaleX,
        FullPanoHeightPixels: scaleY, CroppedAreaImageHeightPixels: scaleY, CroppedAreaTopPixels: scaleY
    };
    const namespaces = [...xmp.matchAll(/xmlns:([\w.-]+)\s*=\s*["']http:\/\/ns\.google\.com\/photos\/1\.0\/panorama\/["']/g)];
    // Scale only GPano geometry; keep pose and other camera metadata unchanged.
    for (const [, prefix] of namespaces) {
        const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        for (const [field, scale] of Object.entries(geometry)) {
            const name = `${escapedPrefix}:${field}`;
            xmp = xmp.replace(new RegExp(`(${name}\\s*=\\s*["'])(\\d+)(["'])`, 'g'),
                (_, before, value, after) => before + Math.round(Number(value) * scale) + after);
            xmp = xmp.replace(new RegExp(`(<${name}\\b[^>]*>\\s*)(\\d+)(\\s*</${name}\\s*>)`, 'g'),
                (_, before, value, after) => before + Math.round(Number(value) * scale) + after);
        }
    }
    return xmp;
}

function createPreviewStore(uploadRoot) {
    const root = path.resolve(uploadRoot);
    const previewDir = path.join(root, 'preview');
    const pending = new Map();
    let queue = Promise.resolve();

    async function locate(imageUrl) {
        const url = new URL(imageUrl, 'http://pano.local');
        if (url.origin !== 'http://pano.local' || !url.pathname.startsWith('/uploads/')) {
            throw new Error('Preview source must be a local upload');
        }
        const candidate = path.resolve(root, decodeURIComponent(url.pathname.slice('/uploads/'.length)));
        const realRoot = await fs.realpath(root);
        const source = await fs.realpath(candidate);
        const relative = path.relative(realRoot, source);
        if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)
            || relative.startsWith('preview' + path.sep)) {
            throw new Error('Invalid preview source');
        }
        const stat = await fs.stat(source);
        if (!stat.isFile()) throw new Error('Preview source is not a file');
        const key = createHash('sha256')
            .update(`1536:60:${relative}:${stat.size}:${stat.mtimeMs}`)
            .digest('hex').slice(0, 32);
        return { source, destination: path.join(previewDir, `${key}.jpg`) };
    }

    async function ensurePreview(imageUrl) {
        const { source, destination } = await locate(imageUrl);
        try {
            await fs.access(destination);
            return destination;
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        if (pending.has(destination)) return pending.get(destination);

        // Serialize generation on small servers and publish only complete JPEGs.
        const task = queue.then(async () => {
            await fs.mkdir(previewDir, { recursive: true });
            const temporary = path.join(previewDir, `.${randomUUID()}.tmp`);
            try {
                const metadata = await sharp(source).metadata();
                const pipeline = sharp(source)
                    .rotate()
                    .resize({ width: 1536, withoutEnlargement: true })
                    .jpeg({ quality: 60, mozjpeg: true });
                if (metadata.xmp) {
                    const rotated = metadata.orientation >= 5;
                    const width = rotated ? metadata.height : metadata.width;
                    const height = rotated ? metadata.width : metadata.height;
                    const previewWidth = Math.min(1536, width);
                    const previewHeight = Math.round(height * previewWidth / width);
                    pipeline.withXmp(scalePanoramaXmp(metadata.xmp.toString('utf8'),
                        previewWidth / width, previewHeight / height));
                }
                await pipeline.toFile(temporary);
                await fs.rename(temporary, destination);
                return destination;
            } finally {
                await fs.rm(temporary, { force: true });
            }
        }).finally(() => pending.delete(destination));
        pending.set(destination, task);
        queue = task.catch(() => {});
        return task;
    }

    async function removePreview(imageUrl) {
        if (!imageUrl) return;
        try {
            const { destination } = await locate(imageUrl);
            if (pending.has(destination)) await pending.get(destination).catch(() => {});
            await fs.rm(destination, { force: true });
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
    }

    return { ensurePreview, removePreview };
}

module.exports = { createPreviewStore };
