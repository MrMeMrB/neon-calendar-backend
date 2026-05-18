import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import axios from 'axios';
import pkg from 'pg';
const { Pool } = pkg;

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json());

const PORT = process.env.PORT || 5001;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

let ZOE_CACHE = [];
let WORK_CACHE = [];

async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        start_time TIMESTAMP WITH TIME ZONE NOT NULL,
        end_time TIMESTAMP WITH TIME ZONE,
        description TEXT,
        calendar VARCHAR(50) NOT NULL,
        metric_sentiment VARCHAR(50) DEFAULT NULL,
        metric_location VARCHAR(255) DEFAULT NULL,
        metric_severity INT DEFAULT 0
      );
    `);
    console.log("✅ Database table assertion verified.");
  } catch (err) {
    console.error("❌ DB init failure:", err.message);
  }
}
initDb();

async function syncExternalFeeds() {
  try {
    const zoeResponse = await axios.get("https://calendar.google.com/calendar/ical/example-zoe/public/basic.ics", { timeout: 6000 }).catch(() => null);
    if (zoeResponse && zoeResponse.data) {
      ZOE_CACHE = []; 
    }
    
    const workResponse = await axios.get("https://calendar.google.com/calendar/ical/example-work/public/basic.ics", { timeout: 6000 }).catch(() => null);
    if (workResponse && workResponse.data) {
      WORK_CACHE = [];
    }
  } catch (err) {
    console.log("ℹ️ External network link empty or unreachable.");
  }
}
cron.schedule('*/30 * * * *', syncExternalFeeds);
syncExternalFeeds();

// OPEN FEED ROUTING - NO AUTH REQUIREMENT
app.get('/api/events', async (req, res) => {
  const targetView = req.query.calendar || 'combined';
  try {
    const dbResult = await pool.query('SELECT * FROM events ORDER BY start_time ASC');
    const localEvents = dbResult.rows.map(row => ({
      id: String(row.id),
      title: row.title,
      start: new Date(row.start_time).toISOString(),
      end: row.end_time ? new Date(row.end_time).toISOString() : null,
      description: row.description || '',
      calendar: row.calendar,
      metricSentiment: row.metric_sentiment,
      metricLocation: row.metric_location,
      metricSeverity: row.metric_severity,
      isExternal: false
    }));

    if (targetView === 'combined') {
      return res.json([...localEvents, ...ZOE_CACHE, ...WORK_CACHE]);
    }
    if (targetView === 'zoe') {
      return res.json([...localEvents.filter(e => e.calendar === 'zoe'), ...ZOE_CACHE]);
    }
    if (targetView === 'work') {
      return res.json([...localEvents.filter(e => e.calendar === 'work'), ...WORK_CACHE]);
    }
    
    return res.json(localEvents.filter(e => e.calendar === targetView));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/events', async (req, res) => {
  const { title, start, end, description, calendar, metricSentiment, metricLocation, metricSeverity } = req.body;
  try {
    const insertQuery = `
      INSERT INTO events (title, start_time, end_time, description, calendar, metric_sentiment, metric_location, metric_severity)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, title, start_time AS start, end_time AS end, description, calendar, metric_sentiment AS "metricSentiment", metric_location AS "metricLocation", metric_severity AS "metricSeverity";
    `;
    const outcome = await pool.query(insertQuery, [title, start, end || null, description || '', calendar, metricSentiment || null, metricLocation || null, metricSeverity || 0]);
    
    const formatted = {
      ...outcome.rows[0],
      id: String(outcome.rows[0].id),
      start: new Date(outcome.rows[0].start).toISOString(),
      end: outcome.rows[0].end ? new Date(outcome.rows[0].end).toISOString() : null
    };
    return res.status(201).json(formatted);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.delete('/api/events/:id', async (req, res) => {
  try {
    const targetId = parseInt(req.params.id, 10);
    const destructionResult = await pool.query('DELETE FROM events WHERE id = $1', [targetId]);
    if (destructionResult.rowCount === 0) return res.status(404).json({ error: "Not found." });
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Open API Backend active on port ${PORT}`));
