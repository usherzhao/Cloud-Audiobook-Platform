// src/db/do.js

export class AudiobookDB {
    constructor(ctx, env) {
        this.ctx = ctx;
        this.env = env;
        this.sql = this.ctx.storage.sql;
        this.initDatabase();
    }

    initDatabase() {
        this.sql.exec(`
            CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT);
            CREATE TABLE IF NOT EXISTS books (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, author TEXT, cover_url TEXT);
            CREATE TABLE IF NOT EXISTS chapters (id INTEGER PRIMARY KEY AUTOINCREMENT, book_id INTEGER, title TEXT, file_key TEXT, order_num INTEGER, skip_intro INTEGER DEFAULT 0, skip_outro INTEGER DEFAULT 0, FOREIGN KEY(book_id) REFERENCES books(id));
            CREATE TABLE IF NOT EXISTS history (user_id TEXT, book_id INTEGER, chapter_id INTEGER, progress REAL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (user_id, book_id));
            CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT, username TEXT, is_admin INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
        `);

        const bookCount = [...this.sql.exec(`SELECT COUNT(*) as count FROM books`)][0].count;
        if (bookCount === 0) {
            this.sql.exec(`INSERT INTO books (title, author, cover_url) VALUES ('默认测试书本', '未知作者', 'https://images.unsplash.com/photo-1544816155-12df9643f363?auto=format&fit=crop&w=300&q=80')`);
        }
    }

    async fetch(request) {
        const url = new URL(request.url);
        const path = url.pathname;
        const method = request.method;

        try {
            if (method === 'OPTIONS') return new Response(null, { headers: this.getCorsHeaders() });

            let currentUser = null;
            const authHeader = request.headers.get('Authorization');
            if (authHeader && authHeader.startsWith('Bearer ')) {
                const token = authHeader.split(' ')[1];
                currentUser = [...this.sql.exec(`SELECT * FROM sessions WHERE token = ?`, token)][0];
            }

            if (path.startsWith('/api/admin/')) {
                if (!currentUser || currentUser.is_admin !== 1) {
                    return this.jsonResponse({ success: false, error: '无权限执行此操作，仅限超级管理员' }, 403);
                }
            }

            if (path === '/api/internal/verify-token' && method === 'GET') {
                return this.jsonResponse({ valid: !!currentUser, isAdmin: currentUser ? currentUser.is_admin === 1 : false });
            }

            if (path === '/api/login' && method === 'POST') {
                const { username, password } = await request.json();
                let adminUser = 'admin', adminPass = 'admin123';
                if (this.env.ADMIN_KV) {
                    adminUser = await this.env.ADMIN_KV.get('admin_username') || 'admin';
                    adminPass = await this.env.ADMIN_KV.get('admin_password') || 'admin123';
                }
                const token = crypto.randomUUID();
                if (username === adminUser && password === adminPass) {
                    this.sql.exec(`INSERT INTO sessions (token, user_id, username, is_admin) VALUES (?, ?, ?, 1)`, token, 'admin', adminUser);
                    return this.jsonResponse({ success: true, token, user: { id: 'admin', username: adminUser, isAdmin: true } });
                }
                let user = [...this.sql.exec(`SELECT * FROM users WHERE username = ? AND password = ?`, username, password)][0];
                if (user) {
                    this.sql.exec(`INSERT INTO sessions (token, user_id, username, is_admin) VALUES (?, ?, ?, 0)`, token, user.id.toString(), user.username);
                    return this.jsonResponse({ success: true, token, user: { id: user.id, username: user.username, isAdmin: false } });
                }
                return this.jsonResponse({ success: false, error: '账号或密码错误，请联系管理员分配' }, 401);
            }

            if (path === '/api/admin/users' && method === 'GET') {
                const users = [...this.sql.exec(`SELECT id, username FROM users ORDER BY id DESC`)];
                return this.jsonResponse({ users });
            }

            if (path === '/api/admin/users' && method === 'POST') {
                const { newUsername, newPassword } = await request.json();
                try {
                    this.sql.exec(`INSERT INTO users (username, password) VALUES (?, ?)`, newUsername, newPassword);
                    return this.jsonResponse({ success: true });
                } catch (err) { return this.jsonResponse({ success: false, error: '账号已存在' }, 400); }
            }

            if (path.match(/^\/api\/admin\/users\/\d+$/) && method === 'DELETE') {
                const userId = path.split('/')[4];
                this.sql.exec(`DELETE FROM history WHERE user_id = ?`, userId);
                this.sql.exec(`DELETE FROM sessions WHERE user_id = ?`, userId);
                this.sql.exec(`DELETE FROM users WHERE id = ?`, parseInt(userId));
                return this.jsonResponse({ success: true });
            }

            if (path.match(/^\/api\/internal\/books\/\d+\/keys$/) && method === 'GET') {
                const bookId = path.split('/')[4];
                const chapters = [...this.sql.exec(`SELECT file_key FROM chapters WHERE book_id = ?`, parseInt(bookId))];
                return this.jsonResponse({ keys: chapters.map(c => c.file_key) });
            }

            if (path.match(/^\/api\/internal\/chapters\/\d+\/key$/) && method === 'GET') {
                const chapterId = path.split('/')[4];
                const chapter = [...this.sql.exec(`SELECT file_key FROM chapters WHERE id = ?`, parseInt(chapterId))][0];
                return this.jsonResponse({ key: chapter ? chapter.file_key : null });
            }

            if (path.match(/^\/api\/admin\/books\/\d+$/) && method === 'DELETE') {
                const bookId = path.split('/')[4];
                this.sql.exec(`DELETE FROM history WHERE book_id = ?`, parseInt(bookId));
                this.sql.exec(`DELETE FROM chapters WHERE book_id = ?`, parseInt(bookId));
                this.sql.exec(`DELETE FROM books WHERE id = ?`, parseInt(bookId));
                return this.jsonResponse({ success: true });
            }

            if (path.match(/^\/api\/admin\/chapters\/\d+$/) && method === 'PUT') {
                const chapterId = path.split('/')[4];
                const { title } = await request.json();
                this.sql.exec(`UPDATE chapters SET title = ? WHERE id = ?`, title, parseInt(chapterId));
                return this.jsonResponse({ success: true });
            }

            if (path.match(/^\/api\/admin\/chapters\/\d+$/) && method === 'DELETE') {
                const chapterId = path.split('/')[4];
                this.sql.exec(`DELETE FROM history WHERE chapter_id = ?`, parseInt(chapterId));
                this.sql.exec(`DELETE FROM chapters WHERE id = ?`, parseInt(chapterId));
                return this.jsonResponse({ success: true });
            }

            if (path === '/api/books' && method === 'GET') {
                const books = [...this.sql.exec(`SELECT * FROM books ORDER BY id DESC`)];
                return this.jsonResponse({ books });
            }

            if (path.match(/^\/api\/books\/\d+\/chapters$/) && method === 'GET') {
                const bookId = path.split('/')[3];
                const fetchAll = url.searchParams.get('all') === 'true';
                if (fetchAll) {
                    const chapters = [...this.sql.exec(`SELECT * FROM chapters WHERE book_id = ? ORDER BY order_num ASC`, parseInt(bookId))];
                    return this.jsonResponse({ chapters });
                }
                const page = parseInt(url.searchParams.get('page')) || 1;
                const limit = parseInt(url.searchParams.get('limit')) || 10;
                const sort = url.searchParams.get('sort') || 'default';
                const offset = (page - 1) * limit;

                let orderClause = 'ORDER BY order_num ASC';
                if (sort === 'titleAsc') orderClause = 'ORDER BY title ASC';
                if (sort === 'titleDesc') orderClause = 'ORDER BY title DESC';

                const totalRes = [...this.sql.exec(`SELECT COUNT(*) as count FROM chapters WHERE book_id = ?`, parseInt(bookId))];
                const total = totalRes[0].count;
                const chapters = [...this.sql.exec(`SELECT * FROM chapters WHERE book_id = ? ${orderClause} LIMIT ? OFFSET ?`, parseInt(bookId), limit, offset)];

                return this.jsonResponse({ chapters, total, page, limit });
            }

            if (path === '/api/history' && method === 'GET') {
                const userId = url.searchParams.get('userId');
                const bookId = url.searchParams.get('bookId');
                const sort = url.searchParams.get('sort') || 'default';

                const history = [...this.sql.exec(`SELECT * FROM history WHERE user_id = ? AND book_id = ?`, userId, parseInt(bookId))][0];
                if (history) {
                    let orderClause = 'ORDER BY order_num ASC';
                    if (sort === 'titleAsc') orderClause = 'ORDER BY title ASC';
                    if (sort === 'titleDesc') orderClause = 'ORDER BY title DESC';
                    const rankQuery = `SELECT rn FROM (SELECT id, ROW_NUMBER() OVER (${orderClause}) as rn FROM chapters WHERE book_id = ?) WHERE id = ?`;
                    const rankRes = [...this.sql.exec(rankQuery, parseInt(bookId), history.chapter_id)][0];
                    if (rankRes) history.chapter_index = rankRes.rn - 1;
                }
                return this.jsonResponse({ history: history || null });
            }

            if (path === '/api/history' && method === 'POST') {
                const { userId, bookId, chapterId, progress } = await request.json();
                this.sql.exec(`
                    INSERT INTO history (user_id, book_id, chapter_id, progress, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(user_id, book_id) DO UPDATE SET chapter_id = excluded.chapter_id, progress = excluded.progress, updated_at = CURRENT_TIMESTAMP
                `, userId, bookId, chapterId, progress);
                return this.jsonResponse({ success: true });
            }

            if (path === '/api/admin/upload' && method === 'POST') {
                const { bookId, title, fileKey, orderNum, skipIntro, skipOutro } = await request.json();
                this.sql.exec(`INSERT INTO chapters (book_id, title, file_key, order_num, skip_intro, skip_outro) VALUES (?, ?, ?, ?, ?, ?)`, bookId, title, fileKey, orderNum, skipIntro, skipOutro);
                return this.jsonResponse({ success: true });
            }

            if (path === '/api/admin/books' && method === 'POST') {
                const { title, author, cover_url } = await request.json();
                this.sql.exec(`INSERT INTO books (title, author, cover_url) VALUES (?, ?, ?)`, title, author || '未知作者', cover_url || 'https://images.unsplash.com/photo-1544816155-12df9643f363?auto=format&fit=crop&w=300&q=80');
                return this.jsonResponse({ success: true });
            }

            return new Response('API Route Not Found', { status: 404, headers: this.getCorsHeaders() });
        } catch (err) { return this.jsonResponse({ success: false, error: err.message }, 500); }
    }

    jsonResponse(data, status = 200) {
        return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...this.getCorsHeaders() } });
    }

    getCorsHeaders() {
        return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
    }
}
