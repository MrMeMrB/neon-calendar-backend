import express from 'express';
import cors from 'cors';
import pkg from 'pg';
import pdfParse from 'pdf-parse';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';

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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      start_time TIMESTAMP NOT NULL,
      end_time TIMESTAMP,
      description TEXT
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

app.get('/api/events', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM events ORDER BY start_time ASC');
    const formatted = result.rows.map(row => ({
      id: row.id,
      title: row.title,
      start: row.start_time,
      end: row.end_time,
      description: row.description
    }));
    res.json(formatted);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/events', async (req, res) => {
  const { title, start, end, description } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO events (title, start_time, end_time, description) VALUES ($1, $2, $3, $4) RETURNING *',
      [title, start, end || null, description || '']
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
