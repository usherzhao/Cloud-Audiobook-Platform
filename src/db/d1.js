// src/db/d1.js

export class D1Adapter {
    constructor(env) {
        this.env = env;
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
                currentUser = await this.env.DB.prepare(`SELECT * FROM sessions WHERE token = ?`).bind(token).first();
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
                    await this.env.DB.prepare(`INSERT INTO sessions (token, user_id, username, is_admin) VALUES (?, ?, ?, 1)`).bind(token, 'admin', adminUser).run();
                    return this.jsonResponse({ success: true, token, user: { id: 'admin', username: adminUser, isAdmin: true } });
                }
                let user = await this.env.DB.prepare(`SELECT * FROM users WHERE username = ? AND password = ?`).bind(username, password).first();
                if (user) {
                    await this.env.DB.prepare(`INSERT INTO sessions (token, user_id, username, is_admin) VALUES (?, ?, ?, 0)`).bind(token, user.id.toString(), user.username).run();
                    return this.jsonResponse({ success: true, token, user: { id: user.id, username: user.username, isAdmin: false } });
                }
                return this.jsonResponse({ success: false, error: '账号或密码错误，请联系管理员分配' }, 401);
            }

            if (path === '/api/admin/users' && method === 'GET') {
                const { results } = await this.env.DB.prepare(`SELECT id, username FROM users ORDER BY id DESC`).all();
                return this.jsonResponse({ users: results });
            }

            if (path === '/api/admin/users' && method === 'POST') {
                const { newUsername, newPassword } = await request.json();
                try {
                    await this.env.DB.prepare(`INSERT INTO users (username, password) VALUES (?, ?)`).bind(newUsername, newPassword).run();
                    return this.jsonResponse({ success: true });
                } catch (err) { return this.jsonResponse({ success: false, error: '账号已存在' }, 400); }
            }

            if (path.match(/^\/api\/admin\/users\/\d+$/) && method === 'DELETE') {
                const userId = path.split('/')[4];
                await this.env.DB.batch([
                    this.env.DB.prepare(`DELETE FROM history WHERE user_id = ?`).bind(userId),
                    this.env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(userId),
                    this.env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(parseInt(userId))
                ]);
                return this.jsonResponse({ success: true });
            }

            if (path.match(/^\/api\/internal\/books\/\d+\/keys$/) && method === 'GET') {
                const bookId = path.split('/')[4];
                const { results } = await this.env.DB.prepare(`SELECT file_key FROM chapters WHERE book_id = ?`).bind(parseInt(bookId)).all();
                return this.jsonResponse({ keys: results.map(c => c.file_key) });
            }

            if (path.match(/^\/api\/internal\/chapters\/\d+\/key$/) && method === 'GET') {
                const chapterId = path.split('/')[4];
                const chapter = await this.env.DB.prepare(`SELECT file_key FROM chapters WHERE id = ?`).bind(parseInt(chapterId)).first();
                return this.jsonResponse({ key: chapter ? chapter.file_key : null });
            }

            if (path.match(/^\/api\/admin\/books\/\d+$/) && method === 'DELETE') {
                const bookId = path.split('/')[4];
                await this.env.DB.batch([
                    this.env.DB.prepare(`DELETE FROM history WHERE book_id = ?`).bind(parseInt(bookId)),
                    this.env.DB.prepare(`DELETE FROM chapters WHERE book_id = ?`).bind(parseInt(bookId)),
                    this.env.DB.prepare(`DELETE FROM books WHERE id = ?`).bind(parseInt(bookId))
                ]);
                return this.jsonResponse({ success: true });
            }

            if (path.match(/^\/api\/admin\/chapters\/\d+$/) && method === 'PUT') {
                const chapterId = path.split('/')[4];
                const { title } = await request.json();
                await this.env.DB.prepare(`UPDATE chapters SET title = ? WHERE id = ?`).bind(title, parseInt(chapterId)).run();
                return this.jsonResponse({ success: true });
            }

            if (path.match(/^\/api\/admin\/chapters\/\d+$/) && method === 'DELETE') {
                const chapterId = path.split('/')[4];
                await this.env.DB.batch([
                    this.env.DB.prepare(`DELETE FROM history WHERE chapter_id = ?`).bind(parseInt(chapterId)),
                    this.env.DB.prepare(`DELETE FROM chapters WHERE id = ?`).bind(parseInt(chapterId))
                ]);
                return this.jsonResponse({ success: true });
            }

            if (path === '/api/books' && method === 'GET') {
                const { results } = await this.env.DB.prepare(`SELECT * FROM books ORDER BY id DESC`).all();
                return this.jsonResponse({ books: results });
            }

            if (path.match(/^\/api\/books\/\d+\/chapters$/) && method === 'GET') {
                const bookId = path.split('/')[3];
                const fetchAll = url.searchParams.get('all') === 'true';
                if (fetchAll) {
                    const { results } = await this.env.DB.prepare(`SELECT * FROM chapters WHERE book_id = ? ORDER BY order_num ASC`).bind(parseInt(bookId)).all();
                    return this.jsonResponse({ chapters: results });
                }
                const page = parseInt(url.searchParams.get('page')) || 1;
                const limit = parseInt(url.searchParams.get('limit')) || 10;
                const sort = url.searchParams.get('sort') || 'default';
                const offset = (page - 1) * limit;

                let orderClause = 'ORDER BY order_num ASC';
                if (sort === 'titleAsc') orderClause = 'ORDER BY title ASC';
                if (sort === 'titleDesc') orderClause = 'ORDER BY title DESC';

                const totalObj = await this.env.DB.prepare(`SELECT COUNT(*) as count FROM chapters WHERE book_id = ?`).bind(parseInt(bookId)).first();
                const total = totalObj ? totalObj.count : 0;
                const { results } = await this.env.DB.prepare(`SELECT * FROM chapters WHERE book_id = ? ${orderClause} LIMIT ? OFFSET ?`).bind(parseInt(bookId), limit, offset).all();

                return this.jsonResponse({ chapters: results, total, page, limit });
            }

            if (path === '/api/history' && method === 'GET') {
                const userId = url.searchParams.get('userId');
                const bookId = url.searchParams.get('bookId');
                const sort = url.searchParams.get('sort') || 'default';

                const history = await this.env.DB.prepare(`SELECT * FROM history WHERE user_id = ? AND book_id = ?`).bind(userId, parseInt(bookId)).first();
                if (history) {
                    let orderClause = 'ORDER BY order_num ASC';
                    if (sort === 'titleAsc') orderClause = 'ORDER BY title ASC';
                    if (sort === 'titleDesc') orderClause = 'ORDER BY title DESC';
                    const rankQuery = `SELECT rn FROM (SELECT id, ROW_NUMBER() OVER (${orderClause}) as rn FROM chapters WHERE book_id = ?) WHERE id = ?`;
                    const rankRes = await this.env.DB.prepare(rankQuery).bind(parseInt(bookId), history.chapter_id).first();
                    if (rankRes) history.chapter_index = rankRes.rn - 1;
                }
                return this.jsonResponse({ history: history || null });
            }

            if (path === '/api/history' && method === 'POST') {
                const { userId, bookId, chapterId, progress } = await request.json();
                await this.env.DB.prepare(`
                    INSERT INTO history (user_id, book_id, chapter_id, progress, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(user_id, book_id) DO UPDATE SET chapter_id = excluded.chapter_id, progress = excluded.progress, updated_at = CURRENT_TIMESTAMP
                `).bind(userId, bookId, chapterId, progress).run();
                return this.jsonResponse({ success: true });
            }

            if (path === '/api/admin/upload' && method === 'POST') {
                const { bookId, title, fileKey, orderNum, skipIntro, skipOutro } = await request.json();
                await this.env.DB.prepare(`INSERT INTO chapters (book_id, title, file_key, order_num, skip_intro, skip_outro) VALUES (?, ?, ?, ?, ?, ?)`).bind(bookId, title, fileKey, orderNum, skipIntro, skipOutro).run();
                return this.jsonResponse({ success: true });
            }

            if (path === '/api/admin/books' && method === 'POST') {
                const { title, author, cover_url } = await request.json();
                await this.env.DB.prepare(`INSERT INTO books (title, author, cover_url) VALUES (?, ?, ?)`).bind(title, author || '未知作者', cover_url || 'https://images.unsplash.com/photo-1544816155-12df9643f363?auto=format&fit=crop&w=300&q=80').run();
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
