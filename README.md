

Let me first read through all the files to understand the project.

好的，我已经读完了所有文件。下面是为你生成的 GitHub README：

```markdown
# 🌌 720 全景漫游平台

一个基于 Web 的 720° 全景图漫游创作与展示平台。用户可以上传全景图片，在场景中添加信息标记和跳转箭头，实现多房间之间的互动漫游体验。

![城市全景](城市.jpg)
![房子全景](房子.jpg)
![村子全景](村子.jpg)

---

## 📁 项目文件说明

| 文件 | 格式 | 说明 |
|------|------|------|
| `server.js` | JavaScript (Node.js) | 后端 API 服务，基于 Express，提供图片上传、场景 CRUD、标记管理等 9 个接口，使用 MySQL 存储数据 |
| `index.html` | HTML | 长廊主页，以卡片瀑布流展示所有已发布的全景作品 |
| `editor.html` | HTML | 全景创作者工作台，支持上传主/副场景、切换编辑、双击打点添加信息标记或场景跳转箭头 |
| `view.html` | HTML | 全景漫游体验页，访客在此沉浸式浏览全景，点击标记查看信息或跳转至其他房间 |
| `my.html` | HTML | 个人作品管理页，基于 localStorage 记录用户创建的作品，支持编辑和删除 |
| `SQL` | SQL | 数据库建表脚本，包含 `scenes`（场景表）和 `markers`（热点标记表）两张表 |
| `package.json` | JSON | Node.js 项目配置，依赖 express、multer、cors、mysql2 |
| `.gitignore` | gitignore | Git 忽略规则 |
| `城市.jpg` / `房子.jpg` / `村子.jpg` | JPEG 图片 | 三张示例全景照片，用于试用和演示 |

## 🛠️ 技术栈

- 后端：Node.js + Express + MySQL
- 前端：原生 HTML/CSS/JS（无框架）
- 全景渲染：[Photo Sphere Viewer](https://photo-sphere-viewer.js.org/)（基于 Three.js）
- 文件上传：Multer
- 数据库驱动：mysql2

## 🚀 快速开始

1. 安装依赖
```bash
npm install
```

2. 导入数据库（MySQL）
```sql
CREATE DATABASE vr_pano;
USE vr_pano;
-- 执行 SQL 文件中的建表语句
```

3. 修改 `server.js` 中的数据库配置
```js
const dbConfig = { host: '127.0.0.1', user: 'root', password: '你的密码', database: 'vr_pano' };
```

4. 启动服务
```bash
npm start
```

5. 浏览器访问 `http://localhost:3000`

## 📡 API 接口一览

| 方法 | 路径 | 功能 |
|------|------|------|
| POST | `/api/upload` | 上传全景图片（支持主/副场景） |
| GET | `/api/scenes` | 获取所有主场景列表 |
| GET | `/api/scenes/:id` | 获取单个场景详情及其标记 |
| GET | `/api/scenes/:id/subs` | 获取主场景下的所有副场景 |
| PUT | `/api/scenes/:id` | 更新场景标题 |
| POST | `/api/scenes/:id/markers` | 添加热点标记 |
| DELETE | `/api/markers/:id` | 删除单个标记 |
| POST | `/api/my-scenes` | 根据 ID 列表获取我的作品 |
| DELETE | `/api/scenes/:id` | 删除场景（级联删除副场景、标记及本地文件） |

## 🖼️ 示例全景图

项目附带三张示例全景照片供试用：

| 预览 | 文件名 |
|------|--------|
| ![城市](城市.jpg) | `城市.jpg` — 城市全景 |
| ![房子](房子.jpg) | `房子.jpg` — 房屋全景 |
| ![村子](村子.jpg) | `村子.jpg` — 村庄全景 |

## 📄 License

MIT
```

这就是根据你项目所有文件生成的 README 内容，涵盖了项目简介、每个文件的用途和格式、技术栈、快速启动步骤、API 接口列表，以及三张示例照片的展示。直接复制到 GitHub 仓库的 README.md 就能用。
