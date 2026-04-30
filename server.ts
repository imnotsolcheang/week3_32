import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import multer from 'multer';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database('vents.db');

// Ensure uploads directory exists
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

// Configure multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// Initialize database
db.exec(`
  CREATE TABLE IF NOT EXISTS vents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    category TEXT NOT NULL,
    image_url TEXT,
    likes INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vent_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (vent_id) REFERENCES vents (id) ON DELETE CASCADE
  );
`);

// Migration: Add image_url if it doesn't exist
try {
  db.prepare('SELECT image_url FROM vents LIMIT 1').get();
} catch (e) {
  db.exec('ALTER TABLE vents ADD COLUMN image_url TEXT');
}

// Migration: Add status to vents if it doesn't exist
try {
  db.prepare('SELECT status FROM vents LIMIT 1').get();
} catch (e) {
  db.exec("ALTER TABLE vents ADD COLUMN status TEXT DEFAULT 'active'");
}

// Migration: Add status to comments if it doesn't exist
try {
  db.prepare('SELECT status FROM comments LIMIT 1').get();
} catch (e) {
  db.exec("ALTER TABLE comments ADD COLUMN status TEXT DEFAULT 'active'");
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());
  app.use('/uploads', express.static(uploadDir));

  // API Routes
  app.get('/api/vents', (req, res) => {
    const { category } = req.query;
    let query = 'SELECT * FROM vents';
    const params = [];

    if (category && category !== '全部') {
      query += ' WHERE category = ?';
      params.push(category);
    }

    query += ' ORDER BY status ASC, created_at DESC';
    
    const vents = db.prepare(query).all(...params) as any[];
    
    // Attach comments to each vent
    const ventsWithComments = vents.map(vent => {
      // Order: active first, then done. In alphabetical order 'active' < 'done'.
      const comments = db.prepare('SELECT * FROM comments WHERE vent_id = ? ORDER BY status ASC, created_at ASC').all(vent.id);
      return { ...vent, comments };
    });
    
    res.json(ventsWithComments);
  });

  app.post('/api/vents', upload.single('image'), (req, res) => {
    const { content, category, imageUrl } = req.body;
    if (!content || !category) {
      return res.status(400).json({ error: 'Content and category are required' });
    }
    
    let finalImageUrl = imageUrl || null;
    if (req.file) {
      finalImageUrl = `/uploads/${req.file.filename}`;
    }

    const info = db.prepare('INSERT INTO vents (content, category, image_url) VALUES (?, ?, ?)').run(content, category, finalImageUrl);
    const newVent = db.prepare('SELECT * FROM vents WHERE id = ?').get(info.lastInsertRowid);
    res.json(newVent);
  });

  app.post('/api/vents/:id/like', (req, res) => {
    const { id } = req.params;
    db.prepare('UPDATE vents SET likes = likes + 1 WHERE id = ?').run(id);
    const updatedVent = db.prepare('SELECT * FROM vents WHERE id = ?').get(id);
    res.json(updatedVent);
  });

  app.post('/api/vents/:id/toggle-status', (req, res) => {
    const { id } = req.params;
    const vent = db.prepare('SELECT * FROM vents WHERE id = ?').get(id) as any;
    if (!vent) {
      return res.status(404).json({ error: 'Vent not found' });
    }
    const newStatus = vent.status === 'active' ? 'done' : 'active';
    db.prepare('UPDATE vents SET status = ? WHERE id = ?').run(newStatus, id);
    const updatedVent = db.prepare('SELECT * FROM vents WHERE id = ?').get(id);
    res.json(updatedVent);
  });

  app.post('/api/vents/:id/comments', (req, res) => {
    const { id } = req.params;
    const { content } = req.body;
    if (!content) {
      return res.status(400).json({ error: 'Comment content is required' });
    }
    db.prepare('INSERT INTO comments (vent_id, content) VALUES (?, ?)').run(id, content);
    const comments = db.prepare('SELECT * FROM comments WHERE vent_id = ? ORDER BY status ASC, created_at ASC').all(id);
    res.json(comments);
  });

  app.post('/api/comments/:id/toggle-status', (req, res) => {
    const { id } = req.params;
    const comment = db.prepare('SELECT * FROM comments WHERE id = ?').get(id) as any;
    if (!comment) {
      return res.status(404).json({ error: 'Comment not found' });
    }
    const newStatus = comment.status === 'active' ? 'done' : 'active';
    db.prepare('UPDATE comments SET status = ? WHERE id = ?').run(newStatus, id);
    const updatedComment = db.prepare('SELECT * FROM comments WHERE id = ?').get(id);
    res.json(updatedComment);
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
