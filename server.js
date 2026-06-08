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

    // Determine the public URL of the logo.
    // If running on Render, it uses the public Render URL.
    // If running locally on localhost, it falls back to the public Render URL so that external email clients can fetch it.
    const protocol = req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const renderUrl = process.env.RENDER_EXTERNAL_URL || 'https://mail-merge-jgn2.onrender.com';
    const publicHost = req.headers.host.includes('localhost') ? renderUrl : `${protocol}://${req.headers.host}`;
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

/**
 * Retrieve list of job postings from jobs.json
 */
app.get('/api/linkedin-jobs', requireAuth, async (req, res) => {
  const q = req.query.q || '';
  const location = req.query.location || '';

  const apiKey = process.env.RAPIDAPI_KEY;

  if (apiKey && apiKey.trim() !== '') {
    try {
      console.log(`[JOBS API] Fetching real-time jobs from JSearch. Query: "${q}", Location: "${location}"`);
      const searchQuery = `${q} ${location}`.trim() || 'Software Engineer';
      const url = `https://jsearch.p.rapidapi.com/search?query=${encodeURIComponent(searchQuery)}&page=1&num_pages=1`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'X-RapidAPI-Key': apiKey.trim(),
          'X-RapidAPI-Host': 'jsearch.p.rapidapi.com'
        }
      });

      if (!response.ok) {
        throw new Error(`JSearch API responded with status ${response.status}`);
      }

      const apiResult = await response.json();
      const apiJobs = apiResult.data || [];

      const normalizedJobs = apiJobs.map((job, idx) => {
        let jobLoc = '';
        if (job.job_city) jobLoc += job.job_city;
        if (job.job_state) jobLoc += (jobLoc ? ', ' : '') + job.job_state;
        if (job.job_country) jobLoc += (jobLoc ? ', ' : '') + job.job_country;
        if (!jobLoc) jobLoc = job.job_location || location || 'Remote';

        return {
          id: job.job_id || `job-api-${idx}-${Date.now()}`,
          companyName: job.employer_name || 'Unknown Company',
          title: job.job_title || 'Software Engineer',
          location: jobLoc,
          link: job.job_apply_link || 'https://www.linkedin.com/jobs',
          postedDate: job.job_posted_at_datetime_utc || new Date().toISOString()
        };
      });

      return res.json({
        success: true,
        hasRealTimeData: true,
        jobs: normalizedJobs
      });

    } catch (error) {
      console.error('[JOBS API] Failed to fetch from JSearch, falling back to local database:', error);
      // Fall through to fallback mock data
    }
  }

  // Fallback / Mock Data Logic
  try {
    const jobsPath = path.join(__dirname, 'jobs.json');
    let data;
    try {
      data = await fs.readFile(jobsPath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        const defaultJobs = [
          {
            "id": "job-001",
            "companyName": "Microsoft",
            "title": "Software Engineer Intern",
            "location": "Hyderabad, Telangana",
            "link": "https://www.linkedin.com/jobs/view/4012938481",
            "postedDate": "2026-06-01T10:00:00Z"
          },
          {
            "id": "job-002",
            "companyName": "TCS",
            "title": "Frontend Developer",
            "location": "Hyderabad, Telangana",
            "link": "https://www.linkedin.com/jobs/view/4028374921",
            "postedDate": "2026-06-01T08:30:00Z"
          },
          {
            "id": "job-003",
            "companyName": "Wipro",
            "title": "Data Analyst",
            "location": "Hyderabad, Telangana",
            "link": "https://www.linkedin.com/jobs/view/4039281745",
            "postedDate": "2026-05-31T14:20:00Z"
          },
          {
            "id": "job-004",
            "companyName": "Infosys",
            "title": "Systems Engineer",
            "location": "Bangalore, Karnataka",
            "link": "https://www.linkedin.com/jobs/view/4048372910",
            "postedDate": "2026-05-31T09:00:00Z"
          },
          {
            "id": "job-005",
            "companyName": "Accenture",
            "title": "Salesforce Developer",
            "location": "Hyderabad, Telangana",
            "link": "https://www.linkedin.com/jobs/view/4059283741",
            "postedDate": "2026-05-30T11:45:00Z"
          },
          {
            "id": "job-006",
            "companyName": "Amazon",
            "title": "Quality Assurance Engineer",
            "location": "Hyderabad, Telangana",
            "link": "https://www.linkedin.com/jobs/view/4069382711",
            "postedDate": "2026-05-30T16:10:00Z"
          },
          {
            "id": "job-007",
            "companyName": "Tech Mahindra",
            "title": "Associate Software Engineer",
            "location": "Hyderabad, Telangana",
            "link": "https://www.linkedin.com/jobs/view/4078371928",
            "postedDate": "2026-05-29T13:00:00Z"
          }
        ];
        await fs.writeFile(jobsPath, JSON.stringify(defaultJobs, null, 2), 'utf8');
        data = JSON.stringify(defaultJobs);
      } else {
        throw err;
      }
    }
    const jobs = JSON.parse(data);

    let filteredJobs = jobs;
    if (q.trim() !== '') {
      const qLower = q.toLowerCase().trim();
      filteredJobs = filteredJobs.filter(job => 
        job.companyName.toLowerCase().includes(qLower) || 
        job.title.toLowerCase().includes(qLower)
      );
    }
    if (location.trim() !== '') {
      const locLower = location.toLowerCase().trim();
      filteredJobs = filteredJobs.filter(job => 
        job.location.toLowerCase().includes(locLower)
      );
    }

    res.json({ 
      success: true, 
      hasRealTimeData: false, 
      jobs: filteredJobs 
    });

  } catch (error) {
    console.error('Error reading jobs.json:', error);
    res.status(500).json({ success: false, error: 'Failed to retrieve job listings.' });
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

/**
 * Endpoint to read bounce emails from Microsoft Power Automate HTTP trigger
 */
app.post('/api/check-bounces', requireAuth, async (req, res) => {
  const bounceUrl = process.env.POWER_AUTOMATE_BOUNCE_URL;

  if (!bounceUrl || bounceUrl.trim() === "") {
    return res.json({
      success: true,
      configured: false,
      totalScanned: 50,
      bounces: []
    });
  }

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
      const parsedBounces = parseBounceEmails(emailList);

      return res.json({
        success: true,
        configured: true,
        totalScanned: emailList.length,
        bounces: parsedBounces
      });
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