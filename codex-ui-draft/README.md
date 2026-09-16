# Eidos Spatial Interface

一个轻量级的 720° 全景内容制作与浏览平台。项目提供全景图片上传、分层场景管理、热点编辑、场景跳转、公开浏览和图片自动优化能力，适合实验室、展厅、校园、厂房、房产空间等虚拟导览场景。

项目采用原生 HTML、CSS 和 JavaScript 编写前端，使用 Node.js、Express 和 MySQL 提供后端服务，无需前端构建工具即可部署。

## 功能概览

### 全景项目创作

- 浏览公开作品和当前设备创建的作品。
- 上传全景项目封面和房间全景图。
- 使用“项目 -> 区域 -> 房间”的三级结构组织场景。
- 编辑项目、区域和房间名称。
- 在编辑器中直接预览全景画面。
- 以全屏模式预览当前作品。
- 删除单个场景、区域或整个项目，并同步清理对应图片和热点数据。
- 创作页面支持中文和英文切换，语言偏好保存在浏览器本地。

### 热点与场景交互

- 信息热点：显示标题和详细说明。
- 跳转热点：点击后进入指定区域或房间。
- 在全景画面中点击放置热点。
- 编辑或删除已有热点。
- 浏览端的信息窗口支持独立滚轮滚动，不会触发全景缩放。
- 跳转热点会同步生成方向指示，帮助用户判断目标场景方向。

### 全景浏览体验

- 支持鼠标拖动、缩放和全屏浏览。
- 支持下载当前场景原图；原图不存在时回退到展示图。
- 提供区域导航和可折叠的房间缩略图导航。
- 缩略图导航支持鼠标滚轮滚动，并阻止滚轮事件穿透到全景画面。
- 切换场景时显示模糊缩略图背景、旋转线框球体、加载文字和动态进度条。
- 实际图片加载完成后，进度条会平滑补充到 100%，再进入全景场景。

### 图片处理与加载优化

每次上传会保存和生成三种图片：

| 类型 | 数据库字段 | 默认目录 | 用途 |
| --- | --- | --- | --- |
| 原图 | `original_url` | `uploads/original/` | 原图留存和下载 |
| 展示图 | `image_url` | `uploads/pano/` | 全景查看器加载 |
| 缩略图 | `thumb_url` | `uploads/thumb/` | 作品列表、导航和加载背景 |

当前图片处理参数：

- 单个上传文件最大 50 MB。
- 展示图最长边限制为 6000 像素，JPEG 质量为 82。
- 缩略图宽度限制为 480 像素，JPEG 质量为 76。
- 使用 MozJPEG 压缩，不放大小于目标尺寸的图片。
- 列表和导航图片启用浏览器懒加载与异步解码。
- `/uploads` 静态资源设置 30 天浏览器缓存。
- Sharp 并发数限制为 1，并限制内存缓存，适合内存较小的云服务器。

## 技术栈

### 前端

- HTML5
- CSS3
- 原生 JavaScript ES Modules
- [Photo Sphere Viewer](https://photo-sphere-viewer.js.org/)
- Photo Sphere Viewer Markers Plugin
- Three.js，由 Photo Sphere Viewer 使用

前端依赖通过 jsDelivr CDN 加载，因此浏览器访问页面时需要能够连接对应 CDN。

### 后端

- Node.js
- Express
- MySQL2
- Multer
- Sharp
- CORS

### 数据库与部署

- MySQL
- Nginx，可用于托管前端并反向代理 API
- 宝塔面板，可选

## 项目结构

```text
codex-ui-draft/
├── index.html      # 项目列表、上传和全景创作页面
├── view.html       # 面向访客的全景浏览页面
├── server.js       # Express API、数据库操作和图片处理
├── package.json    # Node.js 依赖与启动命令
├── SQL             # MySQL 基础表结构
└── README.md       # 项目说明
```

服务器首次运行时会自动创建以下目录：

```text
uploads/
├── original/       # 用户上传的原图
├── pano/           # 压缩后的全景展示图
└── thumb/          # 小尺寸缩略图
```

## 数据流程

```text
用户上传全景图
        |
        v
Multer 保存原图到 uploads/original
        |
        v
Sharp 生成展示图和缩略图
        |
        +--> uploads/pano
        +--> uploads/thumb
        |
        v
MySQL 保存场景信息和三种图片地址
        |
        v
index.html 管理项目，view.html 展示全景
```

## 数据库结构

项目包含两张主要数据表。

### `scenes`

保存项目、区域和房间信息。

| 字段 | 说明 |
| --- | --- |
| `id` | 场景主键 |
| `image_url` | 全景展示图地址 |
| `original_url` | 原图地址 |
| `thumb_url` | 缩略图地址 |
| `title` | 项目、区域或房间名称 |
| `owner_id` | 浏览器生成的创作者标识 |
| `parent_id` | 父级场景 ID |
| `is_group` | 是否为区域分组 |
| `status` | 作品状态 |
| `create_time` | 创建时间 |
| `update_time` | 更新时间 |

### `markers`

保存信息热点和跳转热点。

| 字段 | 说明 |
| --- | --- |
| `id` | 热点主键 |
| `scene_id` | 热点所属场景 |
| `yaw` | 水平方向角度 |
| `pitch` | 垂直方向角度 |
| `title` | 热点标题 |
| `description` | 信息热点的详细内容 |
| `target_scene_id` | 跳转热点的目标场景 ID |
| `create_time` | 创建时间 |

`server.js` 启动时会尝试为旧数据库自动补充 `is_group`、`original_url` 和 `thumb_url` 字段。

## 快速开始

### 1. 环境要求

- Node.js 18.17 或更高版本，推荐使用 Node.js 20 LTS。
- MySQL 5.7 或 MySQL 8.0。
- 支持 WebGL 和 ES Modules 的现代浏览器。
- Nginx 或其他静态文件服务器。

### 2. 安装后端依赖

进入项目目录：

```bash
cd /path/to/codex-ui-draft
npm install
```

### 3. 创建数据库

先在 MySQL 中创建数据库，例如：

```sql
CREATE DATABASE vr_pano
CHARACTER SET utf8mb4
COLLATE utf8mb4_unicode_ci;
```

然后导入项目中的 `SQL` 文件：

```bash
mysql -u YOUR_USER -p vr_pano < SQL
```

### 4. 配置数据库连接

打开 `server.js`，修改以下配置：

```javascript
const dbConfig = {
    host: '127.0.0.1',
    user: 'YOUR_DATABASE_USER',
    password: 'YOUR_DATABASE_PASSWORD',
    database: 'vr_pano'
};
```

不要把真实数据库密码提交到公开仓库。生产环境建议将数据库配置迁移到环境变量。

### 5. 启动后端

```bash
npm start
```

后端默认监听：

```text
http://127.0.0.1:3000
```

后端只提供 `/api` 和 `/uploads`，`index.html` 与 `view.html` 需要由 Nginx 或其他静态文件服务器提供。

### 6. 配置 Nginx

下面是前后端同域部署的基础示例：

```nginx
server {
    listen 8090;
    server_name _;

    root /www/wwwroot/pano-frontend;
    index index.html;

    location / {
        try_files $uri $uri/ =404;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /uploads/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
    }
}
```

部署时可以将：

- `index.html`、`view.html` 放入前端网站目录。
- `server.js`、`package.json` 放入后端目录并执行 `npm install`。
- `SQL` 用于初始化 MySQL 数据库。

如果 Node.js 进程不是以 `root` 用户运行，需要保证运行用户能够写入 `uploads` 目录。例如宝塔常见的运行用户为 `www`：

```bash
chown -R www:www uploads
chmod -R 755 uploads
```

请根据实际 Node.js 运行用户调整目录所有者。

## 使用方式

### 创建项目

1. 打开 `index.html`。
2. 进入“开始制作”。
3. 上传项目封面或入口全景图。
4. 创建区域和房间，并分别上传对应全景图。
5. 修改场景名称并保存。
6. 添加信息热点或跳转热点。
7. 使用全屏预览检查最终效果。

### 访问作品

作品浏览地址格式为：

```text
/view.html?id=SCENE_ID
```

例如：

```text
/view.html?id=95
```

浏览页面会自动查找该场景所属项目，并加载项目下的区域、房间和热点数据。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/upload` | 上传原图，生成展示图和缩略图，并创建场景 |
| `GET` | `/api/scenes` | 获取公开项目列表 |
| `GET` | `/api/my-scenes?ownerId=...` | 获取当前创作者的项目列表 |
| `GET` | `/api/scenes/:id` | 获取单个场景及其热点 |
| `GET` | `/api/scenes-tree/:id` | 获取场景所属项目的完整三级结构 |
| `PUT` | `/api/scenes/:id` | 修改场景名称 |
| `DELETE` | `/api/scenes/:id` | 删除场景、子场景、热点和对应图片 |
| `POST` | `/api/scenes/:id/markers` | 新建信息热点或跳转热点 |
| `DELETE` | `/api/markers/:id` | 删除热点 |

## 当前身份机制

项目暂未接入账号登录系统。首次访问时，前端会在浏览器 `localStorage` 中生成 `panoOwnerId`，并使用它区分“我的作品”。

这种方式适合原型演示、内部使用和单用户部署，不等同于安全的用户认证。若用于公开的多用户生产环境，建议增加登录、会话、权限校验、上传类型校验和 API 访问限制。

## 部署建议

- 不要在 GitHub 中提交真实数据库账号、密码或服务器地址。
- 使用 PM2 或宝塔 Node 项目管理器保持后端进程运行。
- 为网站启用 HTTPS。
- 大量图片建议迁移到对象存储和 CDN。
- 定期备份 MySQL 数据库和 `uploads/original` 原图目录。
- 生产环境建议限制 CORS 来源，并对写入和删除接口进行身份认证。
- 上传前应增加 MIME 类型、文件扩展名和图片有效性检查。

## 主要配置

| 配置 | 当前值 | 所在文件 |
| --- | --- | --- |
| Node.js 端口 | `3000` | `server.js` |
| 上传大小上限 | `50 MB` | `server.js` |
| 展示图最大宽度 | `6000 px` | `server.js` |
| 展示图质量 | `82` | `server.js` |
| 缩略图宽度 | `480 px` | `server.js` |
| 缩略图质量 | `76` | `server.js` |
| 图片缓存时间 | `30 天` | `server.js` |

## 后续可扩展方向

- 正式的用户注册、登录和项目权限系统。
- 腾讯云 COS、S3 等对象存储及 CDN 分发。
- 分块全景图或多分辨率瓦片加载。
- 项目分享权限、密码访问和二维码。
- 热点图标、颜色和动画的可视化配置。
- 场景初始视角和自动漫游路线设置。
- 后台数据统计、访问量和热门场景分析。

