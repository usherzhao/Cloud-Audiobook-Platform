export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        // 处理全局 CORS 预检请求 (针对本地跨域调试)
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                }
            });
        }

        // 1. 处理获取音频文件的请求 (直接从 R2 流式返回)
        if (url.pathname.startsWith('/audio/')) {
            const fileKey = decodeURIComponent(url.pathname.replace('/audio/', ''));
            const object = await env.AUDIO_BUCKET.get(fileKey);

            if (!object) {
                return new Response('Audio not found', { status: 404 });
            }

            const headers = new Headers();
            object.writeHttpMetadata(headers);
            headers.set('etag', object.httpEtag);
            headers.set('Accept-Ranges', 'bytes');
            // 允许跨域请求音频资源
            headers.set('Access-Control-Allow-Origin', '*');

            return new Response(object.body, { headers });
        }

        // 2. 处理真实的音频文件批量上传到 R2
        if (url.pathname === '/api/admin/upload-file' && request.method === 'POST') {
            try {
                const authHeader = request.headers.get('Authorization');
                const id = env.AUDIOBOOK_DB.idFromName("global-db");
                const dbObject = env.AUDIOBOOK_DB.get(id);

                // 验证超管权限 (拦截非法上传)
                const authReq = new Request(new URL('/api/internal/verify-token', request.url), {
                    headers: { 'Authorization': authHeader || '' }
                });
                const authRes = await dbObject.fetch(authReq);
                const authData = await authRes.json();

                if (!authData.valid || !authData.isAdmin) {
                    return new Response(JSON.stringify({ success: false, error: '无权限调用此接口' }), {
                        status: 403, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                    });
                }

                const formData = await request.formData();
                const file = formData.get('file');
                const bookId = formData.get('bookId');
                const bookTitle = formData.get('bookTitle') || `book_${bookId}`;
                const title = formData.get('title');
                const skipIntro = formData.get('skipIntro') || 0;
                const skipOutro = formData.get('skipOutro') || 0;
                const orderNum = formData.get('orderNum') || 1;

                if (!file || !file.name) {
                    return new Response(JSON.stringify({ success: false, error: '未检测到文件' }), {
                        status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                    });
                }

                // 将文件流直接写入 R2 存储桶，并以"书籍名称"作为目录路径前缀
                const safeBookTitle = bookTitle.replace(/[^a-zA-Z0-9\u4e00-\u9fa5-_ ]/g, '').trim() || `book-${bookId}`;
                const safeFileName = file.name.replace(/[^a-zA-Z0-9.\u4e00-\u9fa5-_ ]/g, '').trim();
                const fileKey = `${safeBookTitle}/${Date.now()}-${safeFileName}`;

                await env.AUDIO_BUCKET.put(fileKey, file.stream(), {
                    httpMetadata: { contentType: file.type }
                });

                // 将元数据转发给 Durable Object 进行 SQLite 数据库存储
                const dbReq = new Request(new URL('/api/admin/upload', request.url), {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': authHeader || ''
                    },
                    body: JSON.stringify({
                        bookId: parseInt(bookId),
                        title: title,
                        fileKey: fileKey,
                        orderNum: parseInt(orderNum),
                        skipIntro: parseInt(skipIntro),
                        skipOutro: parseInt(skipOutro)
                    })
                });

                // 将 DO 的处理结果（包含跨域头）返回给前端
                const dbRes = await dbObject.fetch(dbReq);
                const resData = await dbRes.json();

                return new Response(JSON.stringify(resData), {
                    status: dbRes.status,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            } catch (err) {
                return new Response(JSON.stringify({ success: false, error: err.message }), {
                    status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            }
        }

        // 3. 处理超管删除书籍及 R2 音频文件
        if (url.pathname.match(/^\/api\/admin\/books\/\d+$/) && request.method === 'DELETE') {
            try {
                const authHeader = request.headers.get('Authorization');
                const id = env.AUDIOBOOK_DB.idFromName("global-db");
                const dbObject = env.AUDIOBOOK_DB.get(id);

                // 验证超管权限
                const authReq = new Request(new URL('/api/internal/verify-token', request.url), {
                    headers: { 'Authorization': authHeader || '' }
                });
                const authRes = await dbObject.fetch(authReq);
                const authData = await authRes.json();

                if (!authData.valid || !authData.isAdmin) {
                    return new Response(JSON.stringify({ success: false, error: '无权限执行此操作，仅限超级管理员' }), {
                        status: 403, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                    });
                }

                const bookId = url.pathname.split('/')[4];

                // 先从 SQLite 获取所有需要删除的 R2 file_key
                const keysReq = new Request(new URL(`/api/internal/books/${bookId}/keys`, request.url), { method: 'GET' });
                const keysRes = await dbObject.fetch(keysReq);
                const { keys } = await keysRes.json();

                // 批量删除 R2 中的音频文件
                if (keys && keys.length > 0) {
                    await env.AUDIO_BUCKET.delete(keys);
                }

                // 将带有 Authorization Token 的 Header 转发给 DO 数据库
                const dbDeleteReq = new Request(request.url, {
                    method: 'DELETE',
                    headers: { 'Authorization': authHeader || '' }
                });
                const dbRes = await dbObject.fetch(dbDeleteReq);

                return new Response(dbRes.body, {
                    status: dbRes.status,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            } catch (err) {
                return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
            }
        }

        // 3.5. 处理超管删除单集章节及 R2 音频文件
        if (url.pathname.match(/^\/api\/admin\/chapters\/\d+$/) && request.method === 'DELETE') {
            try {
                const authHeader = request.headers.get('Authorization');
                const id = env.AUDIOBOOK_DB.idFromName("global-db");
                const dbObject = env.AUDIOBOOK_DB.get(id);

                // 验证超管权限
                const authReq = new Request(new URL('/api/internal/verify-token', request.url), {
                    headers: { 'Authorization': authHeader || '' }
                });
                const authRes = await dbObject.fetch(authReq);
                const authData = await authRes.json();

                if (!authData.valid || !authData.isAdmin) {
                    return new Response(JSON.stringify({ success: false, error: '无权限执行此操作，仅限超级管理员' }), {
                        status: 403, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                    });
                }

                const chapterId = url.pathname.split('/')[4];

                // 获取需要删除的 R2 file_key
                const keyReq = new Request(new URL(`/api/internal/chapters/${chapterId}/key`, request.url), { method: 'GET' });
                const keyRes = await dbObject.fetch(keyReq);
                const { key } = await keyRes.json();

                // 从 R2 中删除单个音频文件
                if (key) {
                    await env.AUDIO_BUCKET.delete(key);
                }

                // 删除 SQLite 数据库中的记录
                const dbDeleteReq = new Request(request.url, {
                    method: 'DELETE',
                    headers: { 'Authorization': authHeader || '' }
                });
                const dbRes = await dbObject.fetch(dbDeleteReq);

                return new Response(dbRes.body, {
                    status: dbRes.status,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            } catch (err) {
                return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
            }
        }

        // 4. 将其余 API 请求转发到 Durable Object 进行处理 (数据库操作)
        if (url.pathname.startsWith('/api/')) {
            const id = env.AUDIOBOOK_DB.idFromName("global-db");
            const dbObject = env.AUDIOBOOK_DB.get(id);
            return dbObject.fetch(request);
        }

        return new Response('Not Found', { status: 404 });
    }
};

// ============================================================================
// Durable Object 类 - 使用 SQLite 作为后端数据库
// ============================================================================
export class AudiobookDB {
    constructor(ctx, env) {
        this.ctx = ctx;
        this.env = env;
        this.sql = this.ctx.storage.sql;
        this.initDatabase();
    }

    // 初始化 SQLite 数据库表
    initDatabase() {
        this.sql.exec(`
            CREATE TABLE IF NOT EXISTS users (
                                                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                                                 username TEXT UNIQUE,
                                                 password TEXT
            );
            CREATE TABLE IF NOT EXISTS books (
                                                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                                                 title TEXT,
                                                 author TEXT,
                                                 cover_url TEXT
            );
            CREATE TABLE IF NOT EXISTS chapters (
                                                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                                                    book_id INTEGER,
                                                    title TEXT,
                                                    file_key TEXT,
                                                    order_num INTEGER,
                                                    skip_intro INTEGER DEFAULT 0,
                                                    skip_outro INTEGER DEFAULT 0,
                                                    FOREIGN KEY(book_id) REFERENCES books(id)
                );
            CREATE TABLE IF NOT EXISTS history (
                                                   user_id INTEGER,
                                                   book_id INTEGER,
                                                   chapter_id INTEGER,
                                                   progress REAL,
                                                   updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                                                   PRIMARY KEY (user_id, book_id)
                );
            CREATE TABLE IF NOT EXISTS sessions (
                                                    token TEXT PRIMARY KEY,
                                                    user_id TEXT,
                                                    username TEXT,
                                                    is_admin INTEGER,
                                                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // 插入测试书本数据 (如果为空)
        const bookCount = [...this.sql.exec(`SELECT COUNT(*) as count FROM books`)][0].count;
        if (bookCount === 0) {
            this.sql.exec(`INSERT INTO books (title, author, cover_url) VALUES ('默认测试书本', '未知作者', 'https://images.unsplash.com/photo-1544816155-12df9643f363?auto=format&fit=crop&w=300&q=80')`);
        }
    }

    // DO 的 HTTP 路由处理
    async fetch(request) {
        const url = new URL(request.url);
        const path = url.pathname;
        const method = request.method;

        try {
            // 解决 CORS 问题
            if (method === 'OPTIONS') {
                return new Response(null, { headers: this.getCorsHeaders() });
            }

            // 解析 Token
            let currentUser = null;
            const authHeader = request.headers.get('Authorization');
            if (authHeader && authHeader.startsWith('Bearer ')) {
                const token = authHeader.split(' ')[1];
                currentUser = [...this.sql.exec(`SELECT * FROM sessions WHERE token = ?`, token)][0];
            }

            // 管理员权限校验拦截器
            if (path.startsWith('/api/admin/')) {
                if (!currentUser || currentUser.is_admin !== 1) {
                    return this.jsonResponse({ success: false, error: '无权限执行此操作，仅限超级管理员' }, 403);
                }
            }

            // --- 内部 API：验证 Token ---
            if (path === '/api/internal/verify-token' && method === 'GET') {
                return this.jsonResponse({
                    valid: !!currentUser,
                    isAdmin: currentUser ? currentUser.is_admin === 1 : false
                });
            }

            // --- 用户认证 API ---
            if (path === '/api/login' && method === 'POST') {
                const { username, password } = await request.json();

                // 1. 检查 KV 中的超管账号 (安全兼容：未配置KV时采用默认凭证)
                let adminUser = 'admin';
                let adminPass = 'admin123';
                if (this.env.ADMIN_KV) {
                    adminUser = await this.env.ADMIN_KV.get('admin_username') || 'admin';
                    adminPass = await this.env.ADMIN_KV.get('admin_password') || 'admin123';
                }

                const token = crypto.randomUUID(); // 生成会话 Token

                if (username === adminUser && password === adminPass) {
                    this.sql.exec(`INSERT INTO sessions (token, user_id, username, is_admin) VALUES (?, ?, ?, 1)`, token, 'admin', adminUser);
                    return this.jsonResponse({ success: true, token, user: { id: 'admin', username: adminUser, isAdmin: true } });
                }

                // 2. 检查 SQLite 中的普通用户
                let user = [...this.sql.exec(`SELECT * FROM users WHERE username = ? AND password = ?`, username, password)][0];

                if (user) {
                    this.sql.exec(`INSERT INTO sessions (token, user_id, username, is_admin) VALUES (?, ?, ?, 0)`, token, user.id, user.username);
                    return this.jsonResponse({ success: true, token, user: { id: user.id, username: user.username, isAdmin: false } });
                } else {
                    // 不再自动注册，直接返回错误
                    return this.jsonResponse({ success: false, error: '账号或密码错误，请联系管理员分配' }, 401);
                }
            }

            // --- 超管获取账号列表 API ---
            if (path === '/api/admin/users' && method === 'GET') {
                const users = [...this.sql.exec(`SELECT id, username FROM users ORDER BY id DESC`)];
                return this.jsonResponse({ users });
            }

            // --- 超管新增账号 API ---
            if (path === '/api/admin/users' && method === 'POST') {
                const { newUsername, newPassword } = await request.json();
                try {
                    this.sql.exec(`INSERT INTO users (username, password) VALUES (?, ?)`, newUsername, newPassword);
                    return this.jsonResponse({ success: true });
                } catch (err) {
                    return this.jsonResponse({ success: false, error: '账号已存在或创建失败' }, 400);
                }
            }

            // --- 超管删除账号 API ---
            if (path.match(/^\/api\/admin\/users\/\d+$/) && method === 'DELETE') {
                const userId = path.split('/')[4];
                // 彻底删除该用户的播放记录、在线会话，及账号实体
                this.sql.exec(`DELETE FROM history WHERE user_id = ?`, parseInt(userId));
                this.sql.exec(`DELETE FROM sessions WHERE user_id = ?`, userId);
                this.sql.exec(`DELETE FROM users WHERE id = ?`, parseInt(userId));
                return this.jsonResponse({ success: true });
            }

            // --- 内部 API：获取书籍对应的所有文件 Key (用于 R2 删除) ---
            if (path.match(/^\/api\/internal\/books\/\d+\/keys$/) && method === 'GET') {
                const bookId = path.split('/')[4];
                const chapters = [...this.sql.exec(`SELECT file_key FROM chapters WHERE book_id = ?`, parseInt(bookId))];
                return this.jsonResponse({ keys: chapters.map(c => c.file_key) });
            }

            // --- 内部 API：获取单集章节对应的文件 Key (用于 R2 删除) ---
            if (path.match(/^\/api\/internal\/chapters\/\d+\/key$/) && method === 'GET') {
                const chapterId = path.split('/')[4];
                const chapter = [...this.sql.exec(`SELECT file_key FROM chapters WHERE id = ?`, parseInt(chapterId))][0];
                return this.jsonResponse({ key: chapter ? chapter.file_key : null });
            }

            // --- 超管删除书籍 API (清理数据库) ---
            if (path.match(/^\/api\/admin\/books\/\d+$/) && method === 'DELETE') {
                const bookId = path.split('/')[4];
                // 依次清理历史记录、章节和书本自身
                this.sql.exec(`DELETE FROM history WHERE book_id = ?`, parseInt(bookId));
                this.sql.exec(`DELETE FROM chapters WHERE book_id = ?`, parseInt(bookId));
                this.sql.exec(`DELETE FROM books WHERE id = ?`, parseInt(bookId));
                return this.jsonResponse({ success: true });
            }

// --- 超管更新单集章节 API ---
            if (path.match(/^\/api\/admin\/chapters\/\d+$/) && method === 'PUT') {
                const chapterId = path.split('/')[4];
                const { title } = await request.json(); // 移除了 orderNum 的接收

                // 数据库仅更新 title，保留原有的 order_num (时间戳)
                this.sql.exec(`
                    UPDATE chapters
                    SET title = ?
                    WHERE id = ?
                `, title, parseInt(chapterId));
                return this.jsonResponse({ success: true });
            }

           // 这样修改后，前端“批量上传”页面不再显示令人困惑的起始序号输入框，章节管理面板中也清爽了许多，仅保留了核心的章节标题修改功能，而上传逻辑依然能依靠隐藏的时间戳保持精准的顺位。

            // --- 超管删除单集章节 API (清理数据库) ---
            if (path.match(/^\/api\/admin\/chapters\/\d+$/) && method === 'DELETE') {
                const chapterId = path.split('/')[4];
                // 清理历史记录和章节记录
                this.sql.exec(`DELETE FROM history WHERE chapter_id = ?`, parseInt(chapterId));
                this.sql.exec(`DELETE FROM chapters WHERE id = ?`, parseInt(chapterId));
                return this.jsonResponse({ success: true });
            }

            // --- 书籍列表 API ---
            if (path === '/api/books' && method === 'GET') {
                const books = [...this.sql.exec(`SELECT * FROM books ORDER BY id DESC`)];
                return this.jsonResponse({ books });
            }

            // --- 章节列表 API (新增支持后端异步分页与排序) ---
            if (path.match(/^\/api\/books\/\d+\/chapters$/) && method === 'GET') {
                const bookId = path.split('/')[3];
                const fetchAll = url.searchParams.get('all') === 'true'; // 后台管理界面保留全部加载

                if (fetchAll) {
                    const chapters = [...this.sql.exec(`SELECT * FROM chapters WHERE book_id = ? ORDER BY order_num ASC`, parseInt(bookId))];
                    return this.jsonResponse({ chapters });
                }

                // 前台异步加载逻辑
                const page = parseInt(url.searchParams.get('page')) || 1;
                const limit = parseInt(url.searchParams.get('limit')) || 10;
                const sort = url.searchParams.get('sort') || 'default';
                const offset = (page - 1) * limit;

                let orderClause = 'ORDER BY order_num ASC';
                if (sort === 'titleAsc') orderClause = 'ORDER BY title ASC';
                if (sort === 'titleDesc') orderClause = 'ORDER BY title DESC';

                // 获取总集数
                const totalRes = [...this.sql.exec(`SELECT COUNT(*) as count FROM chapters WHERE book_id = ?`, parseInt(bookId))];
                const total = totalRes[0].count;

                // 分页获取本页章节
                const chapters = [...this.sql.exec(`SELECT * FROM chapters WHERE book_id = ? ${orderClause} LIMIT ? OFFSET ?`, parseInt(bookId), limit, offset)];

                return this.jsonResponse({ chapters, total, page, limit });
            }

            // --- 播放历史 API (新增计算当前集绝对序号的功能) ---
            if (path === '/api/history' && method === 'GET') {
                const userId = url.searchParams.get('userId');
                const bookId = url.searchParams.get('bookId');
                const sort = url.searchParams.get('sort') || 'default';

                // 修复：兼容超管的文本 userId 和普通用户的数字 userId
                const history = [...this.sql.exec(`SELECT * FROM history WHERE user_id = ? AND book_id = ?`, userId, parseInt(bookId))][0];

                if (history) {
                    // 利用窗口函数 ROW_NUMBER() 算出这集在当前排序规则下的绝对序号(从1开始)，以便前端计算页码
                    let orderClause = 'ORDER BY order_num ASC';
                    if (sort === 'titleAsc') orderClause = 'ORDER BY title ASC';
                    if (sort === 'titleDesc') orderClause = 'ORDER BY title DESC';

                    const rankQuery = `
                SELECT rn FROM (
                    SELECT id, ROW_NUMBER() OVER (${orderClause}) as rn 
                    FROM chapters 
                    WHERE book_id = ?
                ) WHERE id = ?
            `;
                    const rankRes = [...this.sql.exec(rankQuery, parseInt(bookId), history.chapter_id)][0];
                    if (rankRes) {
                        history.chapter_index = rankRes.rn - 1; // 转换为 0-based 索引
                    }
                }
                return this.jsonResponse({ history: history || null });
            }

            if (path === '/api/history' && method === 'POST') {
                const { userId, bookId, chapterId, progress } = await request.json();
                this.sql.exec(`
                    INSERT INTO history (user_id, book_id, chapter_id, progress, updated_at)
                    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                        ON CONFLICT(user_id, book_id) DO UPDATE SET
                        chapter_id = excluded.chapter_id, progress = excluded.progress, updated_at = CURRENT_TIMESTAMP
                `, userId, bookId, chapterId, progress);
                return this.jsonResponse({ success: true });
            }

            // --- 保存上传元数据 API (供 Worker 内部调用) ---
            if (path === '/api/admin/upload' && method === 'POST') {
                const { bookId, title, fileKey, orderNum, skipIntro, skipOutro } = await request.json();
                this.sql.exec(`
                    INSERT INTO chapters (book_id, title, file_key, order_num, skip_intro, skip_outro)
                    VALUES (?, ?, ?, ?, ?, ?)
                `, bookId, title, fileKey, orderNum, skipIntro, skipOutro);
                return this.jsonResponse({ success: true });
            }

            // --- 创建新书籍 API ---
            if (path === '/api/admin/books' && method === 'POST') {
                const { title, author, cover_url } = await request.json();
                this.sql.exec(`
                    INSERT INTO books (title, author, cover_url)
                    VALUES (?, ?, ?)
                `, title, author || '未知作者', cover_url || 'https://images.unsplash.com/photo-1544816155-12df9643f363?auto=format&fit=crop&w=300&q=80');
                return this.jsonResponse({ success: true });
            }

            return new Response('API Route Not Found', { status: 404, headers: this.getCorsHeaders() });

        } catch (err) {
            return this.jsonResponse({ success: false, error: err.message }, 500);
        }
    }

    jsonResponse(data, status = 200) {
        return new Response(JSON.stringify(data), {
            status,
            headers: {
                'Content-Type': 'application/json',
                ...this.getCorsHeaders()
            }
        });
    }

    getCorsHeaders() {
        return {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        };
    }
}
