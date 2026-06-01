const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const dns = require('dns').promises;
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const crypto = require('crypto');

// Enable CORS and JSON parsing
app.use(cors());
app.use(express.json());

// In-memory set of active session tokens
const activeSessions = new Set();

// Helper to parse cookies from headers
function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach(cookie => {
    const parts = cookie.split('=');
    list[parts.shift().trim()] = decodeURI(parts.join('='));
  });
  return list;
}

// Generate cryptographically secure random token
function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Authentication middleware for API requests
function requireAuth(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.session_token;
  if (token && activeSessions.has(token)) {
    return next();
  }
  res.status(401).json({ success: false, error: 'Unauthorized. Please login.' });
}

// Intercept main page requests for authentication check
app.get('/', (req, res, next) => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.session_token;
  if (token && activeSessions.has(token)) {
    return next();
  }
  res.redirect('/login.html');
});

app.get('/index.html', (req, res, next) => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.session_token;
  if (token && activeSessions.has(token)) {
    return next();
  }
  res.redirect('/login.html');
});

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

/**
 * Endpoint to authenticate the single user
 */
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, error: 'Email and password are required.' });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const targetEmail = 'b_sreekrishna@av.amrita.edu';
  const targetPassword = 'krishna@123';

  if (normalizedEmail === targetEmail && password === targetPassword) {
    const token = generateSessionToken();
    activeSessions.add(token);

    // Set HttpOnly, SameSite=Strict cookie for secure session tracking
    // 24 hour expiry
    res.setHeader('Set-Cookie', `session_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
    return res.json({ success: true, message: 'Login successful' });
  }

  return res.status(401).json({ success: false, error: 'Invalid email or password.' });
});

/**
 * Endpoint to destroy session on logout
 */
app.post('/api/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.session_token;
  if (token) {
    activeSessions.delete(token);
  }
  // Clear cookie by setting past Max-Age
  res.setHeader('Set-Cookie', 'session_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
  res.json({ success: true, message: 'Logged out successfully' });
});

// Ensure uploads directory exists
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fsSync.existsSync(UPLOADS_DIR)) {
  fsSync.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// In-memory mapping of unique filenames to original filenames
const fileRegistry = new Map();

// Configure multer disk storage for attachments
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const filename = uniqueSuffix + path.extname(file.originalname);
    fileRegistry.set(filename, file.originalname);
    cb(null, filename);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 25 * 1024 * 1024 // 25MB limit
  }
});

/**
 * Endpoint to check server environment configuration status
 */
app.get('/api/config-status', requireAuth, (req, res) => {
  const powerAutomateUrl = process.env.POWER_AUTOMATE_URL;
  const isConfigured = !!(powerAutomateUrl && powerAutomateUrl.trim() !== "");
  res.json({
    success: true,
    configured: isConfigured,
    message: isConfigured
      ? 'Power Automate URL is configured.'
      : 'Power Automate URL is missing in .env'
  });
});

/**
 * Endpoint to upload a single attachment file
 */
app.post('/api/upload', requireAuth, upload.single('attachment'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    res.json({
      success: true,
      filename: req.file.filename,
      originalName: req.file.originalname,
      size: req.file.size
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ success: false, error: 'File upload failed: ' + error.message });
  }
});

/**
 * Endpoint to forward an email to Microsoft Power Automate HTTP trigger
 */
app.post('/api/send-email', requireAuth, async (req, res) => {
  const {
    recipientEmail,
    recipientName,
    recipientCompany,
    subject,
    body,
    attachmentFilename
  } = req.body;

  // Validate required inputs
  if (!recipientEmail || !recipientName || !subject || !body) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: recipientEmail, recipientName, subject, or body'
    });
  }

  // Strict regex syntax validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(recipientEmail.trim())) {
    return res.status(400).json({
      success: false,
      error: `Invalid email format: '${recipientEmail}'`
    });
  }

  // Get Power Automate Webhook URL from environment variables
  const powerAutomateUrl = process.env.POWER_AUTOMATE_URL;
  if (!powerAutomateUrl || powerAutomateUrl.trim() === "") {
    return res.status(500).json({
      success: false,
      error: 'Power Automate URL is not configured. Please add your HTTP POST URL in the .env file.'
    });
  }

  // DNS MX validation — attempt lookup but fail-safe if local DNS / network issues block MX queries
  const emailDomain = recipientEmail.trim().split('@')[1];
  try {
    await dns.resolveMx(emailDomain);
  } catch (dnsError) {
    console.warn(`[WARNING] DNS MX check failed for domain '${emailDomain}' (${dnsError.message}). Proceeding anyway...`);
  }

  try {
    let attachmentPayload = null;

    // Process attachment if provided
    if (attachmentFilename) {
      const filePath = path.join(UPLOADS_DIR, attachmentFilename);

      try {
        const fileBuffer = await fs.readFile(filePath);
        const originalName = fileRegistry.get(attachmentFilename) || 'attachment' + path.extname(attachmentFilename);

        attachmentPayload = {
          name: originalName,
          contentBytes: fileBuffer.toString('base64')
        };
      } catch (fileErr) {
        console.error('File read error:', fileErr);
        return res.status(400).json({
          success: false,
          error: `Failed to process attachment: ${fileErr.message}`
        });
      }
    }

    // Construct the payload for Power Automate HTTP Trigger
    const payload = {
      email: recipientEmail.trim(),
      name: recipientName.trim(),
      companyName: (recipientCompany || '').trim(),
      subject: subject,
      body: body
    };

    if (attachmentPayload) {
      payload.attachment = attachmentPayload;
    }

    console.log(`Forwarding email to ${payload.email} via Power Automate...`);

    // Call Power Automate HTTP endpoint
    const response = await fetch(powerAutomateUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const responseText = await response.text();

    if (response.ok) {
      // Try to parse Power Automate response body for delivery status
      let paResult = {};
      try { paResult = JSON.parse(responseText); } catch { }

      if (paResult.status === 'failed') {
        console.error(`Delivery failure for ${payload.email}: ${paResult.reason}`);
        return res.status(200).json({
          success: false,
          error: `Delivery failed: ${paResult.reason || 'Office 365 rejected the recipient'}`
        });
      }

      console.log(`Successfully sent email to ${payload.email}`);
      return res.json({ success: true });
    } else {
      console.error(`Power Automate returned error for ${payload.email}: Status ${response.status} - ${responseText}`);
      return res.status(response.status).json({
        success: false,
        error: `Power Automate error (${response.status}): ${responseText || response.statusText}`
      });
    }

  } catch (error) {
    console.error(`Network error sending to ${recipientEmail}:`, error);
    return res.status(500).json({
      success: false,
      error: `Network error forwarding email: ${error.message}`
    });
  }
});

/**
 * Cleanup endpoint to manually delete processed attachments
 */
app.post('/api/cleanup', requireAuth, async (req, res) => {
  const { filename } = req.body;
  if (!filename) {
    return res.status(400).json({ success: false, error: 'Filename is required' });
  }

  try {
    const filePath = path.join(UPLOADS_DIR, filename);
    await fs.unlink(filePath);
    fileRegistry.delete(filename);
    res.json({ success: true, message: 'Attachment deleted successfully' });
  } catch (err) {
    res.json({ success: true, message: 'Attachment was already deleted or doesn\'t exist' });
  }
});

// Periodic background cleanup — deletes files older than 1 hour every 15 minutes
setInterval(async () => {
  try {
    const files = await fs.readdir(UPLOADS_DIR);
    const now = Date.now();
    const expiryAge = 60 * 60 * 1000;

    for (const file of files) {
      const filePath = path.join(UPLOADS_DIR, file);
      const stat = await fs.stat(filePath);

      if (now - stat.mtimeMs > expiryAge) {
        await fs.unlink(filePath);
        fileRegistry.delete(file);
        console.log(`Auto-cleaned expired file: ${file}`);
      }
    }
  } catch (err) {
    console.error('Background auto-cleanup error:', err);
  }
}, 15 * 60 * 1000);

// Start Express Server
app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`   POWER AUTOMATE MAIL MERGE SERVER IS RUNNING`);
  console.log(`   Local Server: http://localhost:${PORT}`);
  console.log(`   Press Ctrl+C to stop`);
  console.log(`=======================================================`);
});