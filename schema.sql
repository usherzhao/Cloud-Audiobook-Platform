-- 1. 先彻底清理可能存在的旧表结构，确保环境干净
DROP TABLE IF EXISTS history;
DROP TABLE IF EXISTS chapters;
DROP TABLE IF EXISTS books;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS sessions;

-- 2. 重新创建全新的表结构
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
                                       user_id TEXT,
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

-- 3. 插入一条默认的演示书籍
INSERT INTO books (title, author, cover_url) VALUES ('默认测试书本', '未知作者', 'https://images.unsplash.com/photo-1544816155-12df9643f363?auto=format&fit=crop&w=300&q=80');
