const express = require('express');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const mysql = require('mysql2/promise');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

if (!fs.existsSync(path.join(__dirname, 'uploads'))) fs.mkdirSync(path.join(__dirname, 'uploads'));

// ================== 数据库配置 ==================
const dbConfig = { host: '127.0.0.1', user: 'root', password: 'your_password', database: 'vr_pano' };

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// 1. 上传图片（支持主/副场景）
app.post('/api/upload', upload.single('image'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: '请上传文件' });
    const imageUrl = `/uploads/${req.file.filename}`;
    const parentId = (req.body.parentId && req.body.parentId !== 'null') ? req.body.parentId : null;
    try {
        const connection = await mysql.createConnection(dbConfig);
        const [result] = await connection.execute('INSERT INTO scenes (image_url, title, parent_id) VALUES (?, ?, ?)', [imageUrl, parentId ? '副场景' : '未命名全景作品', parentId]);
        await connection.end();
        res.json({ success: true, sceneId: result.insertId, imageUrl });
    } catch (err) { res.status(500).json({ error: '数据库错误' }); }
});

// 2. 长廊主页：只展示主场景
app.get('/api/scenes', async (req, res) => {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const [scenes] = await connection.execute('SELECT * FROM scenes WHERE parent_id IS NULL ORDER BY create_time DESC');
        await connection.end();
        res.json({ success: true, scenes });
    } catch (err) { res.status(500).json({ error: '数据库错误' }); }
});

// 3. 获取单个场景详情及标记
app.get('/api/scenes/:id', async (req, res) => {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const [scenes] = await connection.execute('SELECT * FROM scenes WHERE id = ?', [req.params.id]);
        if (scenes.length === 0) return res.status(404).json({ error: '场景不存在' });
        const [markers] = await connection.execute('SELECT * FROM markers WHERE scene_id = ?', [req.params.id]);
        await connection.end();
        res.json({ success: true, scene: scenes[0], markers });
    } catch (err) { res.status(500).json({ error: '数据库错误' }); }
});

// 4. 获取主场景下的所有副场景
app.get('/api/scenes/:id/subs', async (req, res) => {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const [subs] = await connection.execute('SELECT * FROM scenes WHERE parent_id = ? ORDER BY id ASC', [req.params.id]);
        await connection.end();
        res.json({ success: true, subs });
    } catch (err) { res.status(500).json({ error: '数据库错误' }); }
});

// 5. 更新主场景标题
app.put('/api/scenes/:id', async (req, res) => {
    try {
        const connection = await mysql.createConnection(dbConfig);
        await connection.execute('UPDATE scenes SET title = ? WHERE id = ?', [req.body.title, req.params.id]);
        await connection.end();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: '更新失败' }); }
});

// 6. 保存新标记
app.post('/api/scenes/:id/markers', async (req, res) => {
    const { yaw, pitch, title, description, target_scene_id } = req.body;
    try {
        const connection = await mysql.createConnection(dbConfig);
        const [result] = await connection.execute(
            'INSERT INTO markers (scene_id, yaw, pitch, title, description, target_scene_id) VALUES (?, ?, ?, ?, ?, ?)',
            [req.params.id, yaw, pitch, title, description, target_scene_id || null]
        );
        await connection.end();
        res.json({ success: true, markerId: result.insertId });
    } catch (err) { res.status(500).json({ error: '保存失败' }); }
});

// 7. 删除单个标记（新增）
app.delete('/api/markers/:id', async (req, res) => {
    try {
        const connection = await mysql.createConnection(dbConfig);
        await connection.execute('DELETE FROM markers WHERE id = ?', [req.params.id]);
        await connection.end();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: '删除标记失败' }); }
});

// 8. 我的作品：只展示主场景
app.post('/api/my-scenes', async (req, res) => {
    const { ids } = req.body;
    if (!ids || ids.length === 0) return res.json({ success: true, scenes: [] });
    try {
        const connection = await mysql.createConnection(dbConfig);
        const placeholders = ids.map(() => '?').join(',');
        const [scenes] = await connection.execute(`SELECT * FROM scenes WHERE id IN (${placeholders}) AND parent_id IS NULL ORDER BY create_time DESC`, ids);
        await connection.end();
        res.json({ success: true, scenes });
    } catch (err) { res.status(500).json({ error: '失败' }); }
});

// 9. 终极删除：删除场景（带级联删除和硬盘粉碎）
app.delete('/api/scenes/:id', async (req, res) => {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const mainId = req.params.id;

        const [allScenes] = await connection.execute('SELECT id, image_url FROM scenes WHERE id = ? OR parent_id = ?', [mainId, mainId]);
        const allIds = allScenes.map(s => s.id);

        allScenes.forEach(s => {
            if (s.image_url) {
                const filePath = path.join(__dirname, 'uploads', path.basename(s.image_url));
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            }
        });

        if (allIds.length > 0) {
            const placeholders = allIds.map(() => '?').join(',');
            await connection.execute(`DELETE FROM markers WHERE scene_id IN (${placeholders})`, allIds);
            await connection.execute(`DELETE FROM scenes WHERE id IN (${placeholders})`, allIds);
        }

        await connection.execute('ALTER TABLE scenes AUTO_INCREMENT = 1');
        await connection.execute('ALTER TABLE markers AUTO_INCREMENT = 1');
        await connection.end();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: '删除失败' }); }
});

app.listen(3000, () => { console.log('API Server running'); });