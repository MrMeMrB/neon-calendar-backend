import express from 'express';
import cors from 'cors';
import pkg from 'pg';
import pdfParse from 'pdf-parse';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import ical from 'node-ical'; // <-- Make sure this import is here

dotenv.config();

const { Pool } = pkg;
const app = express();

app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const initDb = async () => {
  // Added a 'calendar' column to track where AI-uploaded events go
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      start_time TIMESTAMP NOT NULL,
      end_time TIMESTAMP,
      description TEXT,
      calendar VARCHAR(50) DEFAULT 'combined'
    );
  `);
  console.log("Neon PostgreSQL tables initialized successfully.");
};
initDb().catch(console.error);

async function extractEventsWithAI(text) {
  const prompt = `
    Analyze this text and extract all calendar events, tasks, deadlines, or meetings.
    Return the output STRICTLY as a valid JSON array of objects using this exact format:
    [
      {
        "title": "Clear descriptive name for the event",
        "start": "YYYY-MM-DDTHH:MM:SS",
        "end": "YYYY-MM-DDTHH:MM:SS or null",
        "description": "Context clues or details extracted from text"
      }
    ]
    Rules: Current year is 2026. If no specific clock time is found, default to 09:00:00. Do not append markdown backticks.
    Text: ${text}
  `;

  const response = await ai.models.generateContent({
    model: "gemini-1.5-flash",
    contents: prompt,
    config: { responseMimeType: "application/json" }
  });

  return JSON.parse(response.text);
}

// ==========================================
// UPGRADED MULTI-CALENDAR SYNC ROUTE
// ==========================================
app.get('/api/events', async (req, res) => {
  const { calendar } = req.query; // Captures the channel (e.g. ?calendar=zoe)
  let eventsList = [];

  try {
    // 1. Fetch Local Database Events from Neon
    let dbResult;
    if (!calendar || calendar === 'combined') {
      dbResult = await pool.query('SELECT * FROM events ORDER BY start_time ASC');
    } else {
      dbResult = await pool.query('SELECT * FROM events WHERE calendar = $1 ORDER BY start_time ASC', [calendar]);
    }

    const localEvents = dbResult.rows.map(row => ({
      id: row.id,
      title: row.title,
      start: row.start_time,
      end: row.end_time,
      description: row.description,
      // Default color if it doesn't match an external stream
      color: row.calendar === 'zoe' ? '#f43f5e' : row.calendar === 'work' ? '#818cf8' : row.calendar === 'family' ? '#f59e0b' : '#38bdf8'
    }));

    eventsList = [...localEvents];

    // Helper to stream, parse, and clean external iCal URLs
    const fetchExternalCalendar = async (url, defaultColor) => {
      if (!url) return [];
      try {
        const data = await ical.async.fromURL(url);
        return Object.values(data)
          .filter(event => event.type === 'VEVENT')
          .map(event => ({
            id: event.uid,
            title: event.summary,
            start: event.start,
            end: event.end,
            description: event.description || '',
            color: defaultColor // Assign color palette matching your frontend theme
          }));
      } catch (err) {
        console.error(`Error parsing link stream: ${url.substring(0, 30)}...`, err.message);
        return [];
      }
    };

    // 2. Mix in Live Feeds Depending on Active Frontend View Matrix
    if (!calendar || calendar === 'liam' || calendar === 'combined') {
      const gcalLiam = await fetchExternalCalendar(process.env.ICAL_URL_LIAM, '#10b981'); // Emerald Green
      eventsList = [...eventsList, ...gcalLiam];
    }
    
    if (!calendar || calendar === 'zoe' || calendar === 'combined') {
      const gcalZoe = await fetchExternalCalendar(process.env.ICAL_URL_ZOE, '#f43f5e'); // Rose Pink
      eventsList = [...eventsList, ...gcalZoe];
    }
    
    if (!calendar || calendar === 'work' || calendar === 'combined') {
      const outlookWork = await fetchExternalCalendar(process.env.ICAL_URL_WORK, '#818cf8'); // Indigo Blue
      eventsList = [...eventsList, ...outlookWork];
    }
    
    if (!calendar || calendar === 'family' || calendar === 'combined') {
      const appleFamily = await fetchExternalCalendar(process.env.ICAL_URL_FAMILY, '#f59e0b'); // Amber Orange
      eventsList = [...eventsList, ...appleFamily];
    }

    res.json(eventsList);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/events', async (req, res) => {
  const { title, start, end, description, calendar } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO events (title, start_time, end_time, description, calendar) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [title, start, end || null, description || '', calendar || 'combined']
    );
    res.json({ success: true, event: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/upload-document', express.raw({ type: 'application/pdf', limit: '10mb' }), async (req, res) => {
  try {
    const parsedPdf = await pdfParse(req.body);
    const events = await extractEventsWithAI(parsedPdf.text);
    res.json({ success: true, events });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/upload-url', async (req, res) => {
  const { fileUrl } = req.body;
  if (!fileUrl) return res.status(400).json({ error: "No link submitted" });
  try {
    const response = await fetch(fileUrl);
    const arrayBuffer = await response.arrayBuffer();
    const parsedPdf = await pdfParse(Buffer.from(arrayBuffer));
    const events = await extractEventsWithAI(parsedPdf.text);
    res.json({ success: true, events });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => console.log(`Backend server listening on port ${PORT}`));
