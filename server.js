const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
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
// In-memory cache of base64-encoded attachment payloads to prevent redundant disk I/O and CPU blocking
const attachmentCache = new Map();

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

  try {
    let attachmentPayload = null;

    // Process attachment if provided
    if (attachmentFilename) {
      const filePath = path.join(UPLOADS_DIR, attachmentFilename);

      try {
        if (attachmentCache.has(attachmentFilename)) {
          attachmentPayload = attachmentCache.get(attachmentFilename);
        } else {
          const fileBuffer = await fs.readFile(filePath);
          const originalName = fileRegistry.get(attachmentFilename) || 'attachment' + path.extname(attachmentFilename);

          attachmentPayload = {
            name: originalName,
            contentBytes: fileBuffer.toString('base64')
          };
          attachmentCache.set(attachmentFilename, attachmentPayload);
        }
      } catch (fileErr) {
        console.error('File read error:', fileErr);
        return res.status(400).json({
          success: false,
          error: `Failed to process attachment: ${fileErr.message}`
        });
      }
    }

    // Determine the public URL of the logo.
    // If running on Render, it uses the public Render URL.
    // If running locally on localhost, it falls back to the public Render URL so that external email clients can fetch it.
    const protocol = req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const renderUrl = process.env.RENDER_EXTERNAL_URL || 'https://mail-merge-jgn2.onrender.com';
    const host = req.headers.host || '';
    const publicHost = host.includes('localhost') ? renderUrl : `${protocol}://${host}`;
    const absoluteLogoUrl = `${publicHost}/amrita-logo.png`;
    const processedBody = body.replace(/\/amrita-logo\.png/g, absoluteLogoUrl).replace(/amrita-logo\.png/g, absoluteLogoUrl);

    // Construct the payload for Power Automate HTTP Trigger
    const payload = {
      email: recipientEmail.trim(),
      name: recipientName.trim(),
      companyName: (recipientCompany || '').trim(),
      subject: subject,
      body: processedBody
    };

    if (attachmentPayload) {
      payload.attachment = attachmentPayload;
    }

    console.log(`Forwarding email to ${payload.email} via Power Automate...`);

    // Setup fetch request with abort controller for a 30-second timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, 30000);

    // Call Power Automate HTTP endpoint
    try {
      const response = await fetch(powerAutomateUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      clearTimeout(timeoutId);
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
    } catch (fetchError) {
      clearTimeout(timeoutId);
      if (fetchError.name === 'AbortError') {
        console.error(`Request to Power Automate timed out for ${payload.email}`);
        return res.status(504).json({
          success: false,
          error: 'Power Automate request timed out (30 seconds limit reached).'
        });
      }
      throw fetchError;
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
    attachmentCache.delete(filename);
    res.json({ success: true, message: 'Attachment deleted successfully' });
  } catch (err) {
    res.json({ success: true, message: 'Attachment was already deleted or doesn\'t exist' });
  }
});


/**
 * Parser helper to extract bounced recipient and reason from raw emails
 */
function parseBounceEmails(emails) {
  const result = [];
  const senderEmail = 'b_sreekrishna@av.amrita.edu';

  for (const email of emails) {
    const subject = email.subject || '';
    const body = email.body || email.bodyPreview || '';
    const receivedTime = email.receivedDateTime || new Date().toISOString();
    
    const lowerSubject = subject.toLowerCase();
    const lowerBody = body.toLowerCase();
    const emailFromAddress = typeof email.from === 'string' 
      ? email.from 
      : (email.from && email.from.emailAddress && email.from.emailAddress.address || '');
    const lowerFrom = emailFromAddress.toLowerCase();

    // Verify this is a bounce/undeliverable notification
    const hasBounceSubject = lowerSubject.startsWith('undeliverable:') || 
                             lowerSubject.startsWith('returned mail') ||
                             lowerSubject.includes('delivery status notification') || 
                             lowerSubject.includes('delivery failure');
                             
    const isSystemSender = lowerFrom.includes('postmaster') || 
                           lowerFrom.includes('mailer-daemon') || 
                           lowerFrom.includes('microsoftexchange');
                           
    const hasBounceBodyPhrases = lowerBody.includes('could not be delivered') ||
                                 lowerBody.includes("couldn't be delivered") ||
                                 lowerBody.includes("wasn't found") ||
                                 lowerBody.includes('was not found') ||
                                 lowerBody.includes('delivery failed') ||
                                 lowerBody.includes('delivery to the following recipients failed') ||
                                 lowerBody.includes('delivery to these recipients or groups failed');
                                 
    const isBounce = hasBounceSubject || isSystemSender || (lowerSubject.includes('failed') && hasBounceBodyPhrases);
    
    if (!isBounce) {
      continue; // Skip normal emails
    }

    let bouncedEmail = '';
    
    // 1. Look for typical headers in bounce messages (e.g. "To: recipient@example.com")
    const toMatch = body.match(/To:\s*(?:&lt;|<)?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})(?:&gt;|>)?/i);
    if (toMatch && toMatch[1]) {
      const emailFound = toMatch[1].trim();
      if (emailFound.toLowerCase() !== senderEmail.toLowerCase()) {
        bouncedEmail = emailFound;
      }
    }

    // 2a. Look for Exchange "Your message to recipient couldn't be delivered"
    if (!bouncedEmail) {
      const msgToMatch = body.match(/message\s+to\s+([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\s+(?:couldn't|could\s+not|wasn't|was\s+not)\s+be\s+delivered/i);
      if (msgToMatch && msgToMatch[1]) {
        const emailFound = msgToMatch[1].trim();
        if (emailFound.toLowerCase() !== senderEmail.toLowerCase()) {
          bouncedEmail = emailFound;
        }
      }
    }

    // 2b. Look for Exchange "recipient wasn't found at domain"
    if (!bouncedEmail) {
      const wasntFoundMatch = body.match(/([a-zA-Z0-9._%+-]+)\s+(?:was\s+not|wasn't)\s+found\s+at\s+([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
      if (wasntFoundMatch && wasntFoundMatch[1] && wasntFoundMatch[2]) {
        const emailFound = `${wasntFoundMatch[1].trim()}@${wasntFoundMatch[2].trim()}`;
        if (emailFound.toLowerCase() !== senderEmail.toLowerCase()) {
          bouncedEmail = emailFound;
        }
      }
    }
    
    // 2c. Look for delivery failure headers (e.g. "failed to deliver to: user@domain.com")
    if (!bouncedEmail) {
      const failedToMatch = body.match(/(?:failed|undeliverable|delivery to the following recipients failed|could not be delivered to|recipient|target|error-recipient)\s*:?\s*(?:&lt;|<)?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})(?:&gt;|>)?/i);
      if (failedToMatch && failedToMatch[1]) {
        const emailFound = failedToMatch[1].trim();
        if (emailFound.toLowerCase() !== senderEmail.toLowerCase()) {
          bouncedEmail = emailFound;
        }
      }
    }
    
    // 3. Fallback: extract all email addresses and exclude sender, system, or postmaster domains
    if (!bouncedEmail) {
      const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
      const allEmails = [];
      let match;
      
      while ((match = emailRegex.exec(subject)) !== null) {
        allEmails.push(match[0]);
      }
      while ((match = emailRegex.exec(body)) !== null) {
        allEmails.push(match[0]);
      }
      
      // Do NOT exclude av.amrita.edu/amrita.edu to handle internal network bounces
      const excludedDomains = ['outlook.com', 'microsoft.com', 'hotmail.com', 'google.com', 'gmail.com', 'microsoftexchange'];
      const excludedPrefixes = ['postmaster', 'mailer-daemon', 'mailer', 'noreply', 'no-reply'];
      
      for (const candidate of allEmails) {
        const lowerCandidate = candidate.toLowerCase();
        const [prefix, domain] = lowerCandidate.split('@');
        
        const isExcluded = lowerCandidate === senderEmail.toLowerCase() ||
                           excludedDomains.some(d => domain && domain.includes(d)) ||
                           excludedPrefixes.some(p => prefix && prefix.startsWith(p));
                           
        if (!isExcluded) {
          bouncedEmail = candidate;
          break;
        }
      }
    }

    // Extract failure reason
    let reason = 'Undeliverable / Mailbox not found or spam block';
    
    // Check for inline Exchange text (e.g. "recipient wasn't found at domain")
    const wasntFoundReason = body.match(/([a-zA-Z0-9._%+-]+\s+(?:was not|wasn't)\s+found\s+at\s+[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
    if (wasntFoundReason && wasntFoundReason[1]) {
      reason = wasntFoundReason[1].trim();
    } else {
      const reasonMatch = body.match(/(?:diagnostic-code|details|error|reason|action required)\s*:?\s*([^\r\n]+)/i);
      if (reasonMatch && reasonMatch[1]) {
        reason = reasonMatch[1].replace(/<\/?[^>]+(>|$)/g, "").trim();
        if (reason.length > 250) {
          reason = reason.substring(0, 247) + '...';
        }
      } else {
        const cleanBody = body.replace(/<\/?[?^>]+(>|$)/g, " ").replace(/\s+/g, " ");
        const diagnosticIndex = cleanBody.toLowerCase().indexOf('diagnostic-code');
        const wasnFoundIndex = cleanBody.toLowerCase().indexOf("wasn't found");
        const errorIndex = cleanBody.toLowerCase().indexOf('error');

        if (diagnosticIndex !== -1) {
          reason = cleanBody.substring(diagnosticIndex, diagnosticIndex + 200).trim() + '...';
        } else if (wasnFoundIndex !== -1) {
          reason = cleanBody.substring(Math.max(0, wasnFoundIndex - 30), wasnFoundIndex + 100).trim() + '...';
        } else if (errorIndex !== -1) {
          reason = cleanBody.substring(errorIndex, errorIndex + 200).trim() + '...';
        } else if (email.bodyPreview) {
          reason = email.bodyPreview;
        }
      }
    }

    
    result.push({
      id: email.id || Math.random().toString(36).substring(7),
      subject: subject,
      receivedTime: receivedTime,
      bouncedEmail: bouncedEmail || 'Unknown Recipient',
      reason: reason
    });
  }
  return result;
}

const BOUNCES_FILE = path.join(__dirname, 'bounces_repository.json');

async function readBouncesRepository() {
  try {
    const data = await fs.readFile(BOUNCES_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return [];
    }
    console.error('Error reading bounces repository:', err);
    return [];
  }
}

async function writeBouncesRepository(bounces) {
  try {
    await fs.writeFile(BOUNCES_FILE, JSON.stringify(bounces, null, 2), 'utf8');
  } catch (err) {
    console.error('Error writing bounces repository:', err);
  }
}

/**
 * Endpoint to get all bounces from repository
 */
app.get('/api/bounces', requireAuth, async (req, res) => {
  const repository = await readBouncesRepository();
  res.json({ success: true, bounces: repository });
});

/**
 * Endpoint to clear the entire bounces repository
 */
app.post('/api/clear-bounces', requireAuth, async (req, res) => {
  await writeBouncesRepository([]);
  res.json({ success: true });
});

/**
 * Endpoint to delete a single bounce by ID
 */
app.post('/api/delete-bounce', requireAuth, async (req, res) => {
  const { id } = req.body;
  if (!id) {
    return res.status(400).json({ success: false, error: 'Bounce ID is required' });
  }
  const repository = await readBouncesRepository();
  const filtered = repository.filter(b => b.id !== id);
  await writeBouncesRepository(filtered);
  res.json({ success: true });
});

/**
 * Endpoint to read bounce emails from Microsoft Power Automate HTTP trigger
 */
app.post('/api/check-bounces', requireAuth, async (req, res) => {
  const { contacts, campaignStartTime } = req.body;
  const bounceUrl = process.env.POWER_AUTOMATE_BOUNCE_URL;

  // If no contacts list is loaded/sent, just return the existing repository without scanning
  if (!contacts || !Array.isArray(contacts) || contacts.length === 0) {
    const repository = await readBouncesRepository();
    return res.json({
      success: true,
      configured: !!(bounceUrl && bounceUrl.trim() !== ""),
      totalScanned: 0,
      addedCount: 0,
      bounces: repository
    });
  }

  let parsedBounces = [];
  let configured = false;
  let totalScanned = 0;

  if (!bounceUrl || bounceUrl.trim() === "") {
    // Mock Mode Bounces: generate mock bounces for the first 3 contacts in the campaign
    configured = false;
    totalScanned = 50;

    const mockEmails = contacts.slice(0, 3);
    const reasons = [
      "550 5.1.1 User Unknown: The email account that you tried to reach does not exist.",
      "Remote Server returned '550 5.4.11 Host Unknown: DNS lookup failed for target domain'",
      "552 5.2.2 Mailbox Full: The recipient's mailbox is full and can't accept messages now."
    ];

    const baseTime = campaignStartTime ? new Date(campaignStartTime).getTime() : Date.now();

    parsedBounces = mockEmails.map((email, idx) => {
      const receivedTime = new Date(baseTime + (idx + 1) * 60 * 1000).toISOString();
      return {
        id: `mock-bounce-${email}`,
        receivedTime: receivedTime,
        bouncedEmail: email,
        subject: `Undeliverable: Amrita University - Invite for Campus Hiring - ${email.split('@')[0]}`,
        reason: reasons[idx % reasons.length]
      };
    });
  } else {
    configured = true;
    try {
      console.log(`Forwarding bounce check request to Power Automate...`);
      const response = await fetch(bounceUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({})
      });

      const responseText = await response.text();

      if (response.ok) {
        let emails = [];
        try {
          emails = JSON.parse(responseText);
        } catch (e) {
          console.error('Failed to parse bounce response from Power Automate:', responseText);
          throw new Error('Power Automate did not return valid JSON.');
        }

        const emailList = Array.isArray(emails) ? emails : (emails.value || []);
        totalScanned = emailList.length;
        parsedBounces = parseBounceEmails(emailList);
      } else {
        console.error(`Power Automate bounce check failed: Status ${response.status} - ${responseText}`);
        return res.status(response.status).json({
          success: false,
          error: `Power Automate error (${response.status}): ${responseText || response.statusText}`
        });
      }
    } catch (error) {
      console.error('Bounce retrieval error:', error);
      return res.status(500).json({
        success: false,
        error: `Network error retrieving bounce list: ${error.message}`
      });
    }
  }

  // Filter newly parsed/mocked bounces by the active campaign contact list & campaignStartTime
  const contactsSet = new Set(contacts.map(c => c.toLowerCase().trim()));
  const filteredBounces = parsedBounces.filter(b => {
    const matchesEmail = contactsSet.has(b.bouncedEmail.toLowerCase().trim());
    const matchesTime = campaignStartTime ? (new Date(b.receivedTime) >= new Date(campaignStartTime)) : true;
    return matchesEmail && matchesTime;
  });

  // Merge into repository, checking if the email address is already present
  const repository = await readBouncesRepository();
  const existingEmails = new Set(repository.map(b => b.bouncedEmail.toLowerCase().trim()));
  const existingIds = new Set(repository.map(b => b.id));

  let addedCount = 0;
  for (const b of filteredBounces) {
    const emailKey = b.bouncedEmail.toLowerCase().trim();
    if (!existingIds.has(b.id) && !existingEmails.has(emailKey)) {
      repository.push(b);
      addedCount++;
    }
  }

  // Sort repository by receivedTime descending
  repository.sort((a, b) => new Date(b.receivedTime) - new Date(a.receivedTime));

  await writeBouncesRepository(repository);

  return res.json({
    success: true,
    configured: configured,
    totalScanned: totalScanned,
    addedCount: addedCount,
    bounces: repository
  });
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
        attachmentCache.delete(file);
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