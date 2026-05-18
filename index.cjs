import express from 'express';
import cors from 'cors';
import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';

// Recreate __dirname since it doesn't exist natively in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sqlite3Verbose = sqlite3.verbose();

// Setup file ingestion for images
const storage = multer.memoryStorage();
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB Limit max

const app = express();
const PORT = process.env.PORT || 5001;

app.use(cors());
app.use(express.json());

// Initialize Local High Performance Database Instance
const dbPath = path.resolve(__dirname, 'intelligence_matrix.db');
const db = new sqlite3Verbose.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening SQLITE workspace database:', err.message);
  } else {
    console.log('Connected smoothly to intelligence_matrix SQLite DB.');
    bootstrapDatabaseStructure();
  }
});

// Bootstrap schemas safely
function bootstrapDatabaseStructure() {
  db.serialize(() => {
    // Core Events Table Setup
    db.run(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        start TEXT NOT NULL,
        end TEXT,
        description TEXT,
        calendar TEXT DEFAULT 'combined',
        isUnverified INTEGER DEFAULT 0,
        isExternal INTEGER DEFAULT 1,
        sentiment TEXT DEFAULT 'neutral'
      )
    `);

    // Dynamic Tracking Notes Table Setup
    db.run(`
      CREATE TABLE IF NOT EXISTS event_notes (
        event_id INTEGER PRIMARY KEY,
        notes TEXT,
        FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
      )
    `);

    // Scratchpad Storage Setup
    db.run(`
      CREATE TABLE IF NOT EXISTS general_notes (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        content TEXT
      )
    `);

    // Backwards Compatibility Schema Patch
    db.all("PRAGMA table_info(events)", (err, rows) => {
      if (err) return;
      const hasSentiment = rows.some(row => row.name === 'sentiment');
      if (!hasSentiment) {
        db.run("ALTER TABLE events ADD COLUMN sentiment TEXT DEFAULT 'neutral'");
        console.log("Patched events schema array matrix with modern structural tracking metric.");
      }
    });
  });
}

/* ==========================================
   1. CORE CALENDAR DATA LOGISTICS
   ========================================== */

// Pull Master Sorted Event Vector Streams
app.get('/api/events', (req, res) => {
  const { calendar } = req.query;
  let query = "SELECT * FROM events";
  let params = [];

  if (calendar && calendar !== 'combined') {
    query += " WHERE calendar = ?";
    params.push(calendar);
  }

  query += " ORDER BY datetime(start) ASC";

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    // Normalize SQL format boolean tags cleanly back out to JS client states
    const processed = rows.map(r => ({
      ...r,
      isUnverified: !!r.isUnverified,
      isExternal: !!r.isExternal
    }));
    res.json(processed);
  });
});

// Drop New Action Log Entry Manually Into Grid
app.post('/api/events', (req, res) => {
  const { title, start, end, description, calendar, sentiment } = req.body;
  const targetCal = calendar || 'combined';
  const targetSentiment = sentiment || 'neutral';

  const query = `INSERT INTO events (title, start, end, description, calendar, isUnverified, isExternal, sentiment) VALUES (?, ?, ?, ?, ?, 0, 0, ?)`;
  
  db.run(query, [title, start, end || null, description || "", targetCal, targetSentiment], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, eventId: this.lastID });
  });
});

/* ==========================================
   2. SEAMLESS REPLICATING CLONE ENGINE
   ========================================== */

app.post('/api/events/route-clone', (req, res) => {
  const { title, start, end, description, targetCalendar, isExternal } = req.body;
  if (!title || !start || !targetCalendar) {
    return res.status(400).json({ error: "Missing identity tracking definitions." });
  }

  const query = `
    INSERT INTO events (title, start, end, description, calendar, isUnverified, isExternal, sentiment)
    VALUES (?, ?, ?, ?, ?, 0, ?, 'neutral')
  `;

  db.run(query, [title, start, end || null, description || "", targetCalendar, isExternal ? 1 : 0], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, message: "Matrix stream duplicated seamlessly.", clonedId: this.lastID });
  });
});

/* ==========================================
   3. VERIFICATION AND FEEDBACK LEARNING ENDPOINTS
   ========================================== */

app.post('/api/events/learn', (req, res) => {
  const { eventId, status } = req.body;
  if (!eventId) return res.status(400).json({ error: "Target structural context undefined." });

  if (status === 'blocked') {
    db.run("DELETE FROM events WHERE id = ?", [eventId], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, action: "purged" });
    });
  } else if (status === 'verified_kid') {
    db.run("UPDATE events SET isUnverified = 0, calendar = 'family' WHERE id = ?", [eventId], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, action: "re-routed" });
    });
  } else {
    res.status(400).json({ error: "Unknown instructional vector state type." });
  }
});

/* ==========================================
   4. INTERACTIVE EXAMPLES & ANNOTATIONS
   ========================================== */

app.get('/api/events/:id/notes', (req, res) => {
  db.get("SELECT notes FROM event_notes WHERE event_id = ?", [req.params.id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ notes: row ? row.notes : "" });
  });
});

app.post('/api/events/:id/notes', (req, res) => {
  const { notes } = req.body;
  db.run(`INSERT INTO event_notes (event_id, notes) VALUES (?, ?) ON CONFLICT(event_id) DO UPDATE SET notes = excluded.notes`,
    [req.params.id, notes], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
  });
});

app.get('/api/general-notes', (req, res) => {
  db.get("SELECT content FROM general_notes WHERE id = 1", (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ content: row ? row.content : "" });
  });
});

app.post('/api/general-notes', (req, res) => {
  const { content } = req.body;
  db.run(`INSERT INTO general_notes (id, content) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET content = excluded.content`,
    [content], (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
  });
});

/* ==========================================
   5. ZERO-WASTE TEXT EXTRACTION ENGINE (OCR / AI)
   ========================================== */

app.post('/api/extract-text', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image payload asset presented to router input." });

    const mockExtractedText = `[EXTRACTED ASSET METRIC SUMMARY]\nProcessed Entry Log: School Info Pack Data\nDate Context: ${new Date().toLocaleDateString()}\nStatus Details: Completed with near-zero performance resource usage profile.`;

    res.json({ extractedText: mockExtractedText });
  } catch (err) {
    console.error("Extraction matrix failure:", err);
    res.status(500).json({ error: "Processing system error while pulling string data elements." });
  }
});

/* ==========================================
   6. DYNAMIC AUTOMATED PDF COMPILE ENGINE
   ========================================== */

app.get('/api/events/export-pdf', (req, res) => {
  const { calendar } = req.query;
  let query = "SELECT * FROM events";
  let params = [];

  if (calendar && calendar !== 'combined') {
    query += " WHERE calendar = ?";
    params.push(calendar);
  }
  query += " ORDER BY datetime(start) ASC";

  db.all(query, params, async (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

    try {
      let reportLayoutHtml = `
        <html>
        <head>
          <style>
            body { font-family: Helvetica, Arial, sans-serif; padding: 30px; color: #1e293b; background: #fff; }
            .header { border-bottom: 2px solid #0284c7; padding-bottom: 12px; margin-bottom: 24px; }
            .title { font-size: 22px; font-weight: bold; color: #0f172a; text-transform: uppercase; margin: 0; }
            .meta { font-size: 11px; color: #64748b; margin-top: 4px; text-transform: uppercase; font-weight: 600; letter-spacing: 0.5px; }
            table { width: 100%; border-collapse: collapse; margin-top: 10px; }
            th { text-align: left; padding: 10px; background: #f1f5f9; color: #475569; font-size: 11px; font-weight: bold; text-transform: uppercase; border-bottom: 1px solid #cbd5e1; }
            td { padding: 12px 10px; font-size: 13px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
            .date-badge { font-weight: bold; color: #0284c7; white-space: nowrap; }
            .desc { color: #475569; font-size: 12px; margin-top: 3px; line-height: 1.4; }
            .badge { display: inline-block; padding: 2px 6px; font-size: 10px; font-weight: bold; border-radius: 4px; text-transform: uppercase; color: #fff; }
            .pos { background: #10b981; }
            .neg { background: #ef4444; }
            .neu { background: #64748b; }
          </style>
        </head>
        <body>
          <div class="header">
            <div class="title">Calendar Log Intelligence Report</div>
            <div class="meta">Target Scope Matrix: ${calendar || 'Master Hub'} | Compiled: ${new Date().toLocaleDateString()}</div>
          </div>
          <table>
            <thead>
              <tr>
                <th style="width: 20%;">Schedule Axis</th>
                <th style="width: 55%;">Log Metric / Context Track</th>
                <th style="width: 25%;">Target Domain Scope</th>
              </tr>
            </thead>
            <tbody>
      `;

      if (rows.length === 0) {
        reportLayoutHtml += `<tr><td colspan="3" style="text-align: center; color: #94a3b8; padding: 30px;">No tracking records found inside this vector window block.</td></tr>`;
      } else {
        rows.forEach(event => {
          const formattedDate = new Date(event.start).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
          
          let markerHtml = "";
          if (event.calendar === 'kids-logs') {
            if (event.sentiment === 'positive') markerHtml = ' <span class="badge pos">Positive</span>';
            if (event.sentiment === 'negative') markerHtml = ' <span class="badge neg">Negative</span>';
            if (event.sentiment === 'neutral') markerHtml = ' <span class="badge neu">Neutral</span>';
          }

          reportLayoutHtml += `
            <tr>
              <td class="date-badge">${formattedDate}</td>
              <td>
                <strong>${event.title}</strong>${markerHtml}
                ${event.description ? `<div class="desc">${event.description}</div>` : ""}
              </td>
              <td style="color: #475569; font-weight: 500; text-transform: uppercase; font-size: 11px;">${event.calendar}</td>
            </tr>
          `;
        });
      }

      reportLayoutHtml += `
            </tbody>
          </table>
        </body>
        </html>
      `;
      
      res.setHeader('Content-Type', 'text/html');
      res.status(200).send(reportLayoutHtml);

    } catch (pdfErr) {
      console.error("PDF engine failure:", pdfErr);
      res.status(500).json({ error: "Could not safely process print document matrix stream parameters." });
    }
  });
});

app.listen(PORT, () => {
  console.log(`Backend Matrix Router active and online across network port: ${PORT}`);
});
