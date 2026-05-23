const express = require('express');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const mysql = require('mysql2/promise');
const fs = require('fs');
const sharp = require('sharp');

const app = express();
app.use(cors());
app.use(express.json());
// 开启静态资源 30 天强缓存
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
    maxAge: '30d',
    immutable: true,
    etag: true,
    lastModified: true
}));

sharp.concurrency(1);
sharp.cache({ memory: 64, files: 0, items: 32 });

const uploadRoot = path.join(__dirname, 'uploads');
const originalDir = path.join(uploadRoot, 'original');
const panoDir = path.join(uploadRoot, 'pano');
const thumbDir = path.join(uploadRoot, 'thumb');

[uploadRoot, originalDir, panoDir, thumbDir].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// 数据库配置
const dbConfig = { host: 'xxxxx', user: 'zxczcx', password: 'qweqwe', database: 'asda' };

// 自动升级数据库架构支持 3 级树状目录
(async function autoUpgradeDB() {
    try {
        const connection = await mysql.createConnection(dbConfig);
        for (const sql of [
            'ALTER TABLE scenes ADD COLUMN is_group TINYINT(1) DEFAULT 0',
            'ALTER TABLE scenes ADD COLUMN original_url VARCHAR(255) DEFAULT NULL',
            'ALTER TABLE scenes ADD COLUMN thumb_url VARCHAR(255) DEFAULT NULL'
        ]) {
            try { await connection.execute(sql); } catch (e) {}
        }
        await connection.end();
    } catch (e) {}
})();

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, originalDir),
    filename: (req, file, cb) => {
        const ext = (path.extname(file.originalname) || '.jpg').toLowerCase();
        cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
    }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

function getUploadPath(fileUrl) {
    if (!fileUrl || !fileUrl.startsWith('/uploads/')) return null;

    const relativePath = path.normalize(decodeURIComponent(fileUrl.replace(/^\/uploads\//, '')));
    const fullPath = path.join(uploadRoot, relativePath);
    return (fullPath === uploadRoot || fullPath.startsWith(uploadRoot + path.sep)) ? fullPath : null;
}

function deleteUploadFile(fileUrl) {
    const filePath = getUploadPath(fileUrl);
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

app.post('/api/upload', upload.single('image'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No File' });
    const baseName = path.parse(req.file.filename).name;
    const originalPath = req.file.path;
    const displayName = `${baseName}.jpg`;
    const thumbName = `${baseName}.jpg`;
    const displayPath = path.join(panoDir, displayName);
    const thumbPath = path.join(thumbDir, thumbName);
    const originalUrl = `/uploads/original/${req.file.filename}`;
    const imageUrl = `/uploads/pano/${displayName}`;
    const thumbUrl = `/uploads/thumb/${thumbName}`;
    const ownerId = req.body.ownerId;
    const parentId = (req.body.parentId && req.body.parentId !== 'null') ? req.body.parentId : null;
    const isGroup = req.body.isGroup === 'true' ? 1 : 0;
    try {
        await sharp(originalPath)
            .rotate()
            .resize({ width: 6000, withoutEnlargement: true })
            .jpeg({ quality: 82, mozjpeg: true })
            .toFile(displayPath);

        await sharp(originalPath)
            .rotate()
            .resize({ width: 480, withoutEnlargement: true })
            .jpeg({ quality: 76, mozjpeg: true })
            .toFile(thumbPath);

        const connection = await mysql.createConnection(dbConfig);
        let title = parentId ? (isGroup ? '新区域(如二楼)' : '新房间') : '我的全景项目';
        const [result] = await connection.execute('INSERT INTO scenes (image_url, original_url, thumb_url, title, owner_id, parent_id, is_group) VALUES (?, ?, ?, ?, ?, ?, ?)', [imageUrl, originalUrl, thumbUrl, title, ownerId, parentId, isGroup]);
        await connection.end();
        res.json({ success: true, sceneId: result.insertId, imageUrl, originalUrl, thumbUrl });
    } catch (err) {
        [originalUrl, imageUrl, thumbUrl].forEach(deleteUploadFile);
        res.status(500).json({ error: 'Upload Error' });
    }
});

app.get('/api/scenes', async (req, res) => {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const [scenes] = await connection.execute('SELECT * FROM scenes WHERE parent_id IS NULL ORDER BY update_time DESC, create_time DESC');
        await connection.end(); res.json({ success: true, scenes });
    } catch (err) { res.status(500).json({ error: 'DB Error' }); }
});

app.get('/api/my-scenes', async (req, res) => {
    const ownerId = req.query.ownerId; if (!ownerId) return res.json({ success: true, scenes: [] });
    try {
        const connection = await mysql.createConnection(dbConfig);
        const [scenes] = await connection.execute('SELECT * FROM scenes WHERE owner_id = ? AND parent_id IS NULL ORDER BY update_time DESC, create_time DESC', [ownerId]);
        await connection.end(); res.json({ success: true, scenes });
    } catch (err) { res.status(500).json({ error: 'DB Error' }); }
});

app.get('/api/scenes/:id', async (req, res) => {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const [scenes] = await connection.execute('SELECT * FROM scenes WHERE id = ?', [req.params.id]);
        if (scenes.length === 0) { await connection.end(); return res.status(404).json({ error: 'Not Found' }); }
        const [markers] = await connection.execute('SELECT * FROM markers WHERE scene_id = ?', [req.params.id]);
        await connection.end(); res.json({ success: true, scene: scenes[0], markers });
    } catch (err) { res.status(500).json({ error: 'DB Error' }); }
});

// 智能寻树接口（一键打包全家桶数据，杜绝寻址崩溃）
app.get('/api/scenes-tree/:id', async (req, res) => {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const targetId = req.params.id;
        const [rows] = await connection.execute('SELECT * FROM scenes WHERE id = ?', [targetId]);
        if (rows.length === 0) { await connection.end(); return res.status(404).json({ success: false, error: '场景不存在' }); }
        let scene = rows[0]; let projectId = scene.id;
        if (scene.parent_id) {
            const [parentRows] = await connection.execute('SELECT * FROM scenes WHERE id = ?', [scene.parent_id]);
            if (parentRows.length > 0) { let parent = parentRows[0]; projectId = parent.parent_id ? parent.parent_id : parent.id; }
        }
        const [level12] = await connection.execute('SELECT * FROM scenes WHERE id = ? OR parent_id = ? ORDER BY id ASC', [projectId, projectId]);
        const areaIds = level12.filter(s => s.parent_id == projectId && s.is_group == 1).map(s => s.id);
        let allScenes = [...level12];
        if (areaIds.length > 0) {
            const placeholders = areaIds.map(()=>'?').join(',');
            const [level3] = await connection.execute(`SELECT * FROM scenes WHERE parent_id IN (${placeholders}) ORDER BY id ASC`, areaIds);
            allScenes = allScenes.concat(level3);
        }
        await connection.end(); res.json({ success: true, projectMainId: projectId, scenes: allScenes });
    } catch (err) { res.status(500).json({ success: false, error: 'DB Error' }); }
});

app.put('/api/scenes/:id', async (req, res) => {
    const { title, ownerId } = req.body;
    try {
        const connection = await mysql.createConnection(dbConfig);
        await connection.execute('UPDATE scenes SET title = ? WHERE id = ? AND owner_id = ?', [title, req.params.id, ownerId]);
        await connection.end(); res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/scenes/:id/markers', async (req, res) => {
    const { yaw, pitch, title, description, target_scene_id, ownerId } = req.body;
    try {
        const connection = await mysql.createConnection(dbConfig);
        const [result] = await connection.execute('INSERT INTO markers (scene_id, yaw, pitch, title, description, target_scene_id) VALUES (?, ?, ?, ?, ?, ?)', [req.params.id, yaw, pitch, title, description, target_scene_id || null]);
        await connection.end(); res.json({ success: true, markerId: result.insertId });
    } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.delete('/api/markers/:id', async (req, res) => {
    try {
        const connection = await mysql.createConnection(dbConfig);
        await connection.execute('DELETE FROM markers WHERE id = ?', [req.params.id]);
        await connection.end(); res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.delete('/api/scenes/:id', async (req, res) => {
    const ownerId = req.query.ownerId;
    try {
        const connection = await mysql.createConnection(dbConfig);
        const pId = req.params.id;
        const [allScenes] = await connection.execute(`SELECT id, image_url, original_url, thumb_url FROM scenes WHERE (id = ? OR parent_id = ? OR parent_id IN (SELECT id FROM (SELECT id FROM scenes WHERE parent_id = ? AND is_group = 1) AS t)) AND owner_id = ?`, [pId, pId, pId, ownerId]);
        if (allScenes.length === 0) { await connection.end(); return res.json({ success: false }); }
        allScenes.forEach(s => {
            [s.image_url, s.original_url, s.thumb_url].forEach(deleteUploadFile);
        });
        const deleteIds = allScenes.map(s => s.id);
        if (deleteIds.length > 0) {
            const placeholders = deleteIds.map(() => '?').join(',');
            await connection.execute(`DELETE FROM markers WHERE scene_id IN (${placeholders})`, deleteIds);
            await connection.execute(`DELETE FROM scenes WHERE id IN (${placeholders})`, deleteIds);
        }
        await connection.end(); res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Error' }); }
});

app.listen(3000, () => { console.log('API Server running on 3000'); });
