// src/worker.js
import { AudiobookDB } from './db/do.js';
import { D1Adapter } from './db/d1.js';

// 必须在主入口导出 Durable Object 类，Cloudflare 才能正确绑定
export { AudiobookDB };

// 适配器工厂：根据环境变量动态生成目标数据库代理
function getDbAdapter(env) {
    if (env.DB_TYPE === 'D1') {
        if (!env.DB) throw new Error("请在 wrangler.toml 中配置 D1 绑定");
        return new D1Adapter(env);
    } else {
        if (!env.AUDIOBOOK_DB) throw new Error("请在 wrangler.toml 中配置 Durable Objects 绑定");
        const id = env.AUDIOBOOK_DB.idFromName("global-db");
        return env.AUDIOBOOK_DB.get(id); // DO 自身天然带有一个 fetch(request) 方法
    }
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        // 0. 处理全局 CORS 预检请求
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

            if (!object) return new Response('Audio not found', { status: 404 });

            const headers = new Headers();
            object.writeHttpMetadata(headers);
            headers.set('etag', object.httpEtag);
            headers.set('Accept-Ranges', 'bytes');
            headers.set('Access-Control-Allow-Origin', '*');

            return new Response(object.body, { headers });
        }

        // 获取根据配置初始化的数据库实例 (D1 或 DO)
        const db = getDbAdapter(env);

        // 2. 处理真实的音频文件批量上传到 R2
        if (url.pathname === '/api/admin/upload-file' && request.method === 'POST') {
            try {
                const authHeader = request.headers.get('Authorization');

                // 统一交给下层数据库做权限校验
                const authReq = new Request(new URL('/api/internal/verify-token', request.url), {
                    headers: { 'Authorization': authHeader || '' }
                });
                const authRes = await db.fetch(authReq);
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
                    return new Response(JSON.stringify({ success: false, error: '未检测到文件' }), { status: 400 });
                }

                const safeBookTitle = bookTitle.replace(/[^a-zA-Z0-9\u4e00-\u9fa5-_ ]/g, '').trim() || `book-${bookId}`;
                const safeFileName = file.name.replace(/[^a-zA-Z0-9.\u4e00-\u9fa5-_ ]/g, '').trim();
                const fileKey = `${safeBookTitle}/${Date.now()}-${safeFileName}`;

                await env.AUDIO_BUCKET.put(fileKey, file.stream(), {
                    httpMetadata: { contentType: file.type }
                });

                // 将元数据转发给下层数据库处理
                const dbReq = new Request(new URL('/api/admin/upload', request.url), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': authHeader || '' },
                    body: JSON.stringify({
                        bookId: parseInt(bookId), title: title, fileKey: fileKey,
                        orderNum: parseInt(orderNum), skipIntro: parseInt(skipIntro), skipOutro: parseInt(skipOutro)
                    })
                });

                const dbRes = await db.fetch(dbReq);
                const resData = await dbRes.json();

                return new Response(JSON.stringify(resData), {
                    status: dbRes.status,
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            } catch (err) {
                return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
            }
        }

        // 3. 处理超管删除书籍及 R2 音频文件
        if (url.pathname.match(/^\/api\/admin\/books\/\d+$/) && request.method === 'DELETE') {
            try {
                const authHeader = request.headers.get('Authorization');
                const authReq = new Request(new URL('/api/internal/verify-token', request.url), { headers: { 'Authorization': authHeader || '' }});
                const authRes = await db.fetch(authReq);
                const authData = await authRes.json();

                if (!authData.valid || !authData.isAdmin) return new Response(JSON.stringify({ success: false, error: '无权限' }), { status: 403 });

                const bookId = url.pathname.split('/')[4];
                const keysReq = new Request(new URL(`/api/internal/books/${bookId}/keys`, request.url), { method: 'GET' });
                const keysRes = await db.fetch(keysReq);
                const { keys } = await keysRes.json();

                if (keys && keys.length > 0) await env.AUDIO_BUCKET.delete(keys);

                const dbDeleteReq = new Request(request.url, { method: 'DELETE', headers: { 'Authorization': authHeader || '' } });
                const dbRes = await db.fetch(dbDeleteReq);

                return new Response(dbRes.body, { status: dbRes.status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
            } catch (err) { return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 }); }
        }

        // 3.5. 处理超管删除单集章节及 R2 音频文件
        if (url.pathname.match(/^\/api\/admin\/chapters\/\d+$/) && request.method === 'DELETE') {
            try {
                const authHeader = request.headers.get('Authorization');
                const authReq = new Request(new URL('/api/internal/verify-token', request.url), { headers: { 'Authorization': authHeader || '' }});
                const authRes = await db.fetch(authReq);
                const authData = await authRes.json();

                if (!authData.valid || !authData.isAdmin) return new Response(JSON.stringify({ success: false, error: '无权限' }), { status: 403 });

                const chapterId = url.pathname.split('/')[4];
                const keyReq = new Request(new URL(`/api/internal/chapters/${chapterId}/key`, request.url), { method: 'GET' });
                const keyRes = await db.fetch(keyReq);
                const { key } = await keyRes.json();

                if (key) await env.AUDIO_BUCKET.delete(key);

                const dbDeleteReq = new Request(request.url, { method: 'DELETE', headers: { 'Authorization': authHeader || '' } });
                const dbRes = await db.fetch(dbDeleteReq);

                return new Response(dbRes.body, { status: dbRes.status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
            } catch (err) { return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 }); }
        }

        // 4. 将其余 API 请求统一转发到对应的底层数据库处理器
        if (url.pathname.startsWith('/api/')) {
            return db.fetch(request);
        }

        return new Response('Not Found', { status: 404 });
    }
};
