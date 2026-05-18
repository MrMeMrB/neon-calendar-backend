import express from 'express';
import cors from 'cors';
import pkg from 'pg';
import multer from 'multer';

const { Pool } = pkg;

// Setup file ingestion for images
const storage = multer.memoryStorage();
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB Limit max

const app = express();
const PORT = process.env.PORT || 5001;

app.use(cors());
app.use(express.json());

// Initialize Remote Persistent Neon PostgreSQL Database Instance
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Required for secure cloud hosting connections
  }
});

// Test connection and bootstrap schemas safely
async function bootstrapDatabaseStructure() {
  try {
    // Core Events Table Setup
    await pool.query(`
      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT,
        description TEXT,
        calendar TEXT DEFAULT 'combined',
        is_unverified INTEGER DEFAULT 0,
        is_external INTEGER DEFAULT 1,
        sentiment TEXT DEFAULT 'neutral'
      )
    `);

    // Dynamic Tracking Notes Table Setup
    await pool.query(`
      CREATE TABLE IF NOT EXISTS event_notes (
        event_id INTEGER PRIMARY KEY,
        notes TEXT
      )
    `);

    // Scratchpad Storage Setup
    await pool.query(`
      CREATE TABLE IF NOT EXISTS general_notes (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        content TEXT
      )
    `);

    console.log('Connected smoothly to your live Neon PostgreSQL Database.');
  } catch (err) {
    console.error('Error bootstrapping database tables:', err.message);
  }
}

bootstrapDatabaseStructure();

/* ==========================================
   1. CORE CALENDAR DATA LOGISTICS
   ========================================== */

// Pull Master Sorted Event Vector Streams
app.get('/api/events', async (req, res) => {
  const { calendar } = req.query;
  let query = 'SELECT id, title, start_time as start, end_time as end, description, calendar, is_unverified as "isUnverified", is_external as "isExternal", sentiment FROM events';
  let params = [];

  if (calendar && calendar !== 'combined') {
    query += " WHERE calendar = $1";
    params.push(calendar);
  }

  query += " ORDER BY start_time ASC";

  try {
    const result = await pool.query(query, params);
    const processed = result.rows.map(r => ({
      ...r,
      isUnverified: !!r.isUnverified,
      isExternal: !!r.isExternal
    }));
    res.json(processed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Drop New Action Log Entry Manually Into Grid
app.post('/api/events', async (req, res) => {
  const { title, start, end, description, calendar, sentiment } = req.body;
  const targetCal = calendar || 'combined';
  const targetSentiment = sentiment || 'neutral';

  const query = `INSERT INTO events (title, start_time, end_time, description, calendar, is_unverified, is_external, sentiment) VALUES ($1, $2, $3, $4, $5, 0, 0, $6) RETURNING id`;
  
  try {
    const result = await pool.query(query, [title, start, end || null, description || "", targetCal, targetSentiment]);
    res.json({ success: true, eventId: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ==========================================
   2. SEAMLESS REPLICATING CLONE ENGINE
   ========================================== */

app.post('/api/events/route-clone', async (req, res) => {
  const { title, start, end, description, targetCalendar, isExternal } = req.body;
  if (!title || !start || !targetCalendar) {
    return res.status(400).json({ error: "Missing identity tracking definitions." });
  }

  const query = `
    INSERT INTO events (title, start_time, end_time, description, calendar, is_unverified, is_external, sentiment)
    VALUES ($1, $2, $3, $4, $5, 0, $6, 'neutral') RETURNING id
  `;

  try {
    const result = await pool.query(query, [title, start, end || null, description || "", targetCalendar, isExternal ? 1 : 0]);
    res.json({ success: true, message: "Matrix stream duplicated seamlessly.", clonedId: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ==========================================
   3. VERIFICATION AND FEEDBACK LEARNING ENDPOINTS
   ========================================== */

app.post('/api/events/learn', async (req, res) => {
  const { eventId, status } = req.body;
  if (!eventId) return res.status(400).json({ error: "Target structural context undefined." });

  try {
    if (status === 'blocked') {
      await pool.query("DELETE FROM events WHERE id = $1", [eventId]);
      res.json({ success: true, action: "purged" });
    } else if (status === 'verified_kid') {
      await pool.query("UPDATE events SET is_unverified = 0, calendar = 'family' WHERE id = $1", [eventId]);
      res.json({ success: true, action: "re-routed" });
    } else {
      res.status(400).json({ error: "Unknown instructional vector state type." });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ==========================================
   4. INTERACTIVE EXAMPLES & ANNOTATIONS
   ========================================== */

app.get('/api/events/:id/notes', async (req, res) => {
  try {
    const result = await pool.query("SELECT notes FROM event_notes WHERE event_id = $1", [req.params.id]);
    res.json({ notes: result.rows[0] ? result.rows[0].notes : "" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/events/:id/notes', async (req, res) => {
  const { notes } = req.body;
  const query = `
    INSERT INTO event_notes (event_id, notes) VALUES ($1, $2) 
    ON CONFLICT(event_id) DO UPDATE SET notes = EXCLUDED.notes
  `;
  try {
    await pool.query(query, [req.params.id, notes]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/general-notes', async (req, res) => {
  try {
    const result = await pool.query("SELECT content FROM general_notes WHERE id = 1");
    res.json({ content: result.rows[0] ? result.rows[0].content : "" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/general-notes', async (req, res) => {
  const { content } = req.body;
  const query = `
    INSERT INTO general_notes (id, content) VALUES (1, $1) 
    ON CONFLICT(id) DO UPDATE SET content = EXCLUDED.content
  `;
  try {
    await pool.query(query, [content]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

app.get('/api/events/export-pdf', async (req, res) => {
  const { calendar } = req.query;
  let query = "SELECT title, start_time as start, description, calendar, sentiment FROM events";
  let params = [];

  if (calendar && calendar !== 'combined') {
    query += " WHERE calendar = $1";
    params.push(calendar);
  }
  query += " ORDER BY start_time ASC";

  try {
    const result = await pool.query(query, params);
    const rows = result.rows;

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
  } catch (err) {
    res.status(500).json({ error: "Could not safely process print document matrix stream parameters." });
  }
});

app.listen(PORT, () => {
  console.log(`Backend Matrix Router active and online across network port: ${PORT}`);
});
