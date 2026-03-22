const express = require('express');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const mysql = require('mysql2/promise');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

// 静态文件托管：让前端能访问到上传的图片
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// 确保上传目录存在
if (!fs.existsSync(path.join(__dirname, 'uploads'))) {
    fs.mkdirSync(path.join(__dirname, 'uploads'));
}

// ================== 数据库配置 ==================
// ⚠️ 注意：部署时请务必修改为真实的数据库密码
const dbConfig = { 
    host: '127.0.0.1', 
    user: 'root', 
    password: 'your_password', 
    database: 'vr_pano' 
};

// ================== 上传配置 ==================
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } }); // 限制最大 50MB

// ================== API 接口区 ==================

// 1. 上传全景图（支持主/副场景，记录拥有者 ownerId）
app.post('/api/upload', upload.single('image'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: '请上传文件' });
    
    const imageUrl = `/uploads/${req.file.filename}`;
    const ownerId = req.body.ownerId; 
    const parentId = (req.body.parentId && req.body.parentId !== 'null') ? req.body.parentId : null;
    
    try {
        const connection = await mysql.createConnection(dbConfig);
        const [result] = await connection.execute(
            'INSERT INTO scenes (image_url, title, owner_id, parent_id) VALUES (?, ?, ?, ?)', 
            [imageUrl, parentId ? '副房间' : '未命名全景项目', ownerId, parentId]
        );
        await connection.end();
        res.json({ success: true, sceneId: result.insertId, imageUrl });
    } catch (err) { 
        res.status(500).json({ error: '数据库错误: ' + err.message }); 
    }
});

// 2. 长廊主页 (公海)：只展示所有人的主场景 (parent_id 为空)
app.get('/api/scenes', async (req, res) => {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const [scenes] = await connection.execute('SELECT * FROM scenes WHERE parent_id IS NULL ORDER BY update_time DESC, create_time DESC');
        await connection.end();
        res.json({ success: true, scenes });
    } catch (err) { res.status(500).json({ error: '数据库错误' }); }
});

// 3. 我的作品：只展示当前用户的作品
app.get('/api/my-scenes', async (req, res) => {
    const ownerId = req.query.ownerId;
    if (!ownerId) return res.json({ success: true, scenes: [] });

    try {
        const connection = await mysql.createConnection(dbConfig);
        const [scenes] = await connection.execute('SELECT * FROM scenes WHERE owner_id = ? AND parent_id IS NULL ORDER BY update_time DESC, create_time DESC', [ownerId]);
        await connection.end();
        res.json({ success: true, scenes });
    } catch (err) { res.status(500).json({ error: '数据库错误' }); }
});

// 4. 获取单个场景详情及标记 (带安全拦截机制)
app.get('/api/scenes/:id', async (req, res) => {
    const requestOwnerId = req.query.ownerId; // 编辑器会传这个，如果是单纯观看(view.html)则不传
    try {
        const connection = await mysql.createConnection(dbConfig);
        const [scenes] = await connection.execute('SELECT * FROM scenes WHERE id = ?', [req.params.id]);
        
        if (scenes.length === 0) {
            await connection.end();
            return res.status(404).json({ error: '场景不存在' });
        }
        
        // 权限拦截：如果是编辑器请求，且身份不匹配，拦截！
        if (requestOwnerId && scenes[0].owner_id !== requestOwnerId) {
            await connection.end();
            return res.json({ success: false, error: '无权编辑：您不能修改其他人的作品。' });
        }
        
        const [markers] = await connection.execute('SELECT * FROM markers WHERE scene_id = ?', [req.params.id]);
        await connection.end();
        res.json({ success: true, scene: scenes[0], markers });
    } catch (err) { res.status(500).json({ error: '数据库错误' }); }
});

// 5. 获取某个主场景下的所有副房间 (侧边栏漫游图库用)
app.get('/api/scenes/:id/subs', async (req, res) => {
    const ownerId = req.query.ownerId;
    try {
        const connection = await mysql.createConnection(dbConfig);
        const [subs] = await connection.execute('SELECT * FROM scenes WHERE parent_id = ? AND owner_id = ? ORDER BY id ASC', [req.params.id, ownerId]);
        await connection.end();
        res.json({ success: true, subs });
    } catch (err) { res.status(500).json({ error: '数据库错误' }); }
});

// 6. 更新主场景标题
app.put('/api/scenes/:id', async (req, res) => {
    const { title, ownerId } = req.body;
    try {
        const connection = await mysql.createConnection(dbConfig);
        await connection.execute('UPDATE scenes SET title = ? WHERE id = ? AND owner_id = ?', [title, req.params.id, ownerId]);
        await connection.end();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: '更新失败' }); }
});

// 7. 保存新标记
app.post('/api/scenes/:id/markers', async (req, res) => {
    const { yaw, pitch, title, description, target_scene_id, ownerId } = req.body;
    try {
        const connection = await mysql.createConnection(dbConfig);
        
        // 双重校验：防止恶意调用 API 给别人的图打点
        const [scenes] = await connection.execute('SELECT owner_id FROM scenes WHERE id = ?', [req.params.id]);
        if (scenes.length === 0 || scenes[0].owner_id !== ownerId) {
            await connection.end();
            return res.status(403).json({ error: '权限不足，禁止操作' });
        }

        const [result] = await connection.execute(
            'INSERT INTO markers (scene_id, yaw, pitch, title, description, target_scene_id) VALUES (?, ?, ?, ?, ?, ?)',
            [req.params.id, yaw, pitch, title, description, target_scene_id || null]
        );
        await connection.end();
        res.json({ success: true, markerId: result.insertId });
    } catch (err) { res.status(500).json({ error: '保存失败' }); }
});

// 8. 删除单个标记
app.delete('/api/markers/:id', async (req, res) => {
    try {
        const connection = await mysql.createConnection(dbConfig);
        await connection.execute('DELETE FROM markers WHERE id = ?', [req.params.id]);
        await connection.end();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: '删除标记失败' }); }
});

// 9. 终极粉碎删除（级联清理数据库 + 物理删除硬盘文件 + ID归位）
app.delete('/api/scenes/:id', async (req, res) => {
    const ownerId = req.query.ownerId; 
    try {
        const connection = await mysql.createConnection(dbConfig);
        const mainId = req.params.id;
        
        const fileQuery = 'SELECT id, image_url FROM scenes WHERE (id = ? OR parent_id = ?) AND owner_id = ?';
        const [allScenes] = await connection.execute(fileQuery, [mainId, mainId, ownerId]);
        
        if (allScenes.length === 0) {
            await connection.end();
            return res.json({ success: false, error: '项目不存在或无权删除' });
        }
        
        // 物理删除图片文件
        allScenes.forEach(s => {
            if (s.image_url) {
                const filePath = path.join(__dirname, 'uploads', path.basename(s.image_url)); 
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            }
        });

        // 数据库级联清理
        const deleteIds = allScenes.map(s => s.id);
        if (deleteIds.length > 0) {
            const placeholders = deleteIds.map(() => '?').join(',');
            await connection.execute(`DELETE FROM markers WHERE scene_id IN (${placeholders})`, deleteIds);
            await connection.execute(`DELETE FROM scenes WHERE id IN (${placeholders})`, deleteIds);
        }

        // 强迫症重置 ID
        await connection.execute('ALTER TABLE scenes AUTO_INCREMENT = 1');
        await connection.execute('ALTER TABLE markers AUTO_INCREMENT = 1');
        
        await connection.end();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: '删除失败' }); }
});

app.listen(3000, () => { 
    console.log('API Server running on port 3000'); 
});