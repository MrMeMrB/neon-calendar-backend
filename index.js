import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import cron from 'node-cron';
import axios from 'axios';
import { PDFDocument, rgb } from 'pdf-lib';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5001; 
const JWT_SECRET = "matrix_override_secure_token_99812";

// --- DATABASE SIMULATION LAYER ---
let usersDb = [];
let eventsDb = []; 
let cachedExternalEvents = []; 

const PUBLIC_SCHOOL_CALENDAR_URL = "https://calendar.google.com/calendar/ical/example/public/basic.ics";

if (usersDb.length === 0) {
  const salt = bcrypt.genSaltSync(10);
  usersDb.push({
    id: "u1",
    username: "LiamBaker",
    password: bcrypt.hashSync("password123", salt)
  });
}

function normalizeEvent(raw, sourceCategory) {
  const cleanCategory = String(sourceCategory || 'liam-life').toLowerCase().trim();
  let domain = 'internal';
  let color = '#6366f1'; 

  if (cleanCategory.includes('school') || cleanCategory.includes('abington')) {
    domain = 'school';
    color = '#38bdf8'; 
  } else if (cleanCategory === 'work') {
    domain = 'work';
    color = '#10b981'; 
  } else if (cleanCategory === 'zoe') {
    domain = 'zoe';
    color = '#f43f5e'; 
  } else if (cleanCategory === 'kids-logs') {
    domain = 'kids-logs';
    color = '#f97316'; 
  }

  return {
    id: raw.id || raw.uid || Math.random().toString(36).substring(2, 9),
    title: raw.title || raw.summary || 'Untitled Core Event',
    start: raw.start || raw.dtstart || new Date().toISOString(),
    end: raw.end || raw.dtend || new Date().toISOString(),
    description: raw.description || '',
    calendar: cleanCategory,
    domain: domain,
    color: color
  };
}

// --- SYSTEM CRON ENGINE ---
async function syncExternalFeeds() {
  console.log("🔄 Background Sync Init: Scraping external iCal matrix arrays...");
  try {
    const response = await axios.get(PUBLIC_SCHOOL_CALENDAR_URL, { timeout: 6000 });
    const rawFeedItems = Array.isArray(response.data) ? response.data : [];
    cachedExternalEvents = rawFeedItems.map(item => normalizeEvent(item, 'abington-school'));
    console.log(`✅ Cached ${cachedExternalEvents.length} distinct events from Abington School.`);
  } catch (err) {
    console.error("⚠️ External iCal feed sync dropped.", err.message);
  }
}
cron.schedule('*/30 * * * *', syncExternalFeeds);
syncExternalFeeds();

// --- JWT AUTHENTICATION MIDDLEWARE ---
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: "Access token missing." });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Token signature invalid or expired." });
    req.user = user;
    next();
  });
}

// --- API ROUTING PORTS ---
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = usersDb.find(u => u.username === username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(400).json({ error: "Invalid operational access credentials." });
  }
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { name: user.username } });
});

app.get('/api/events', authenticateToken, (req, res) => {
  const combined = [...eventsDb, ...cachedExternalEvents];
  combined.sort((a, b) => new Date(a.start) - new Date(b.start));
  res.json(combined);
});

app.post('/api/events', authenticateToken, (req, res) => {
  const { title, start, description, calendar } = req.body;
  if (!title || !start) return res.status(400).json({ error: "Title and Start dates are required." });
  
  const newEvent = normalizeEvent({ title, start, description }, calendar);
  eventsDb.push(newEvent);
  res.status(201).json(newEvent);
});

app.delete('/api/events/:id', authenticateToken, (req, res) => {
  eventsDb = eventsDb.filter(e => e.id !== req.params.id);
  res.json({ success: true, message: "Entry expunged from system local storage." });
});

// --- PDF INCIDENT/LOG REPORT GENERATOR ---
app.get('/api/reports/pdf', authenticateToken, async (req, res) => {
  try {
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([600, 800]);
    
    page.drawText('GRIDNODE SYSTEM PERFORMANCE LOGS & INCIDENTS REPORT', { x: 50, y: 750, size: 16, color: rgb(0.1, 0.1, 0.2) });
    page.drawText(`Generated on: ${new Date().toLocaleString()}`, { x: 50, y: 725, size: 10, color: rgb(0.4, 0.4, 0.4) });

    let yOffset = 680;
    const criticalLogs = eventsDb.filter(e => e.calendar === 'kids-logs');
    
    if (criticalLogs.length === 0) {
      page.drawText('No active tracking incident anomalies reported inside this sector timeframe.', { x: 50, y: yOffset, size: 11 });
    } else {
      criticalLogs.forEach((log) => {
        if (yOffset > 100) {
          page.drawText(`• [${new Date(log.start).toLocaleDateString()}] ${log.title}`, { x: 50, y: yOffset, size: 11 });
          yOffset -= 20;
          if (log.description) {
            page.drawText(`  Notes: ${log.description.substring(0, 75)}`, { x: 60, y: yOffset, size: 9, color: rgb(0.3, 0.3, 0.3) });
            yOffset -= 20;
          }
        }
      });
    }

    const pdfBytes = await pdfDoc.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=system-incident-report.pdf');
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    res.status(500).json({ error: "Failed to generate system printable file asset." });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Core Secure Matrix Stack listening safely on port ${PORT}`);
});
