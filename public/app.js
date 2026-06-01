/**
 * FLOWMAIL FRONTEND APPLICATION CORE LOGIC
 * Manages Excel parsing, file uploads, campaign execution, and Excel report downloading.
 */

// Intercept all fetch requests globally to handle 401 Unauthorized
const originalFetch = window.fetch;
window.fetch = async function(...args) {
  try {
    const response = await originalFetch(...args);
    if (response.status === 401) {
      // Clear cookie and redirect to login
      document.cookie = 'session_token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT;';
      window.location.href = '/login.html';
      return new Response(JSON.stringify({ success: false, error: 'Session expired. Redirecting to login...' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return response;
  } catch (error) {
    throw error;
  }
};

// Application State
let contactsData = [];
let uploadedAttachment = null; // { filename, originalName, size }
let campaignState = 'idle'; // idle | running | paused | completed
let currentSendIndex = 0;
let stopRequested = false;

// Statistics
let stats = {
  total: 0,
  sent: 0,
  failed: 0,
  remaining: 0
};

// SVG Progress Ring Configuration
const progressCircle = document.getElementById('progress-circle');
const progressPercentage = document.getElementById('progress-percentage');
const radius = progressCircle ? progressCircle.r.baseVal.value : 50;
const circumference = radius * 2 * Math.PI;

if (progressCircle) {
  progressCircle.style.strokeDasharray = `${circumference} ${circumference}`;
  progressCircle.style.strokeDashoffset = circumference;
}

// DOM Elements
const elements = {
  // App
  envStatus: document.getElementById('env-status'),
  envStatusText: document.querySelector('#env-status .status-text'),
  btnGuide: document.getElementById('btn-guide'),
  btnLogout: document.getElementById('btn-logout'),
  
  // Guide Modal
  guideModal: document.getElementById('guide-modal'),
  btnCloseModal: document.getElementById('btn-close-modal'),
  btnCloseModalBottom: document.getElementById('btn-close-modal-bottom'),
  btnCopySchema: document.getElementById('btn-copy-schema'),
  schemaCode: document.getElementById('schema-code'),

  // Dropzones & Inputs
  dropzoneExcel: document.getElementById('dropzone-excel'),
  inputExcel: document.getElementById('input-excel'),
  excelFileInfo: document.getElementById('excel-file-info'),
  btnClearExcel: document.getElementById('btn-clear-excel'),

  dropzoneAttachment: document.getElementById('dropzone-attachment'),
  inputAttachment: document.getElementById('input-attachment'),
  attachmentFileInfo: document.getElementById('attachment-file-info'),
  btnClearAttachment: document.getElementById('btn-clear-attachment'),

  // Email Composer
  emailSubject: document.getElementById('email-subject'),
  emailBody: document.getElementById('email-body'),
  chkUseTemplate: document.getElementById('chk-use-template'),
  tagButtons: document.querySelectorAll('.tag-btn'),

  // Email Live Preview
  previewRowIndex: document.getElementById('preview-row-index'),
  previewSubjectText: document.getElementById('preview-subject-text'),
  previewBodyText: document.getElementById('preview-body-text'),

  // Campaign Dashboard
  campaignPanel: document.getElementById('campaign-panel'),
  btnStartCampaign: document.getElementById('btn-start-campaign'),
  btnPauseCampaign: document.getElementById('btn-pause-campaign'),
  btnCancelCampaign: document.getElementById('btn-cancel-campaign'),
  btnDownloadReport: document.getElementById('btn-download-report'),
  
  statTotal: document.getElementById('stat-total'),
  statSent: document.getElementById('stat-sent'),
  statFailed: document.getElementById('stat-failed'),
  statRemaining: document.getElementById('stat-remaining'),

  terminalBody: document.getElementById('terminal-body'),
  btnClearLogs: document.getElementById('btn-clear-logs'),

  // Contacts Table
  contactsCountBadge: document.getElementById('contacts-count-badge'),
  tablePlaceholder: document.getElementById('table-placeholder'),
  tableWrapper: document.getElementById('table-wrapper'),
  contactsTableBody: document.getElementById('contacts-table-body')
};

// ==========================================================================
// 1. INITIALIZATION & SERVER STATUS CHECKS
// ==========================================================================
document.addEventListener('DOMContentLoaded', () => {
  checkServerStatus();
  setupEventListeners();

  // Pre-populate with Amrita Recruitment Template matching user requirements
  if (elements.emailSubject && !elements.emailSubject.value) {
    elements.emailSubject.value = "Invitation for Campus Recruitment Drive - Amrita Vishwa Vidyapeetham";
  }
  
  if (elements.emailBody && !elements.emailBody.value) {
    elements.emailBody.value = `Dear {Name},

Greetings from Amrita University!

We are delighted to invite **{Company Name}** to participate in the Campus Recruitment drive for 2026 and 2027 batch at Amrita Vishwa Vidyapeetham.

As a multi-campus private university with 16+ schools, including Engineering, Medicine, arts, science, business, etc... and we are proud of our reputation for developing talented leaders.

**Amrita Vishwa Vidyapeetham – Rankings & Accreditations:**
🏆 **Ranked 8th among Private Universities** – NIRF
🏆 **NAAC A++ Accredited**
🏆 **#1 in India** – THE Impact Rankings

**Programs Offered at Amrita School of Engineering:**
• Cyber Security
• Computer Science & Engineering
• Artificial Intelligence
• Computer & Communication Engineering
• Civil Engineering
• Electronics & Communication Engineering
• Aerospace Engineering
• Electrical & Computer Engineering
• Mechanical Engineering
• Electronics & Computer Engineering
• Chemical Engineering
• Electrical & Electronics Engineering
• Automation & Robotics Engineering

**Amrita School of Business offers the following programs:**
• Marketing,
• Finance,
• Operations,
• Business Analytics and
• Human Resources.

Additionally, we offer students the flexibility to pursue **internships for a duration of 3 to 10 months** as part of their academic curriculum.

For further details, please find our **Course Template** attached. We look forward to exploring this opportunity for a meaningful collaboration.

Feel free to reach out for any additional information.

Regards,
Sreekrishna
General Manager - Corporate Relations and Placements
Amrita Vishwa Vidyapeetham, Amaravati Campus
Ph: +918555831697
b_sreekrishna@av.amrita.edu
https://www.amrita.edu/`;
  }

  updateLivePreview();
});

/**
 * Verifies backend server connection and Power Automate configuration
 */
async function checkServerStatus() {
  try {
    const response = await fetch('/api/config-status');
    const data = await response.json();
    
    if (data.success) {
      if (data.configured) {
        elements.envStatus.className = 'env-status-badge connected';
        elements.envStatusText.textContent = 'Power Automate Connected';
        logToTerminal('[SYSTEM] Connected to Express server. Power Automate Webhook detected.', 'system');
      } else {
        elements.envStatus.className = 'env-status-badge disconnected';
        elements.envStatusText.textContent = 'PA Webhook Missing';
        logToTerminal('[SYSTEM] WARNING: POWER_AUTOMATE_URL is empty or not configured in your server\'s .env file. Please click the Setup Guide to connect your Microsoft Power Automate flow.', 'warning');
      }
    } else {
      throw new Error(data.message || 'Config check returned failed status');
    }
  } catch (error) {
    console.error('Server status check error:', error);
    elements.envStatus.className = 'env-status-badge disconnected';
    elements.envStatusText.textContent = 'Server Offline';
    logToTerminal('[SYSTEM] ERROR: Failed to connect to Express backend. Ensure you ran "npm start" or "node server.js" in your workspace.', 'error');
  }
}

// ==========================================================================
// 2. MODAL & DOCUMENTATION HANDLERS
// ==========================================================================
function setupEventListeners() {
  // Modal toggle
  elements.btnGuide.addEventListener('click', () => elements.guideModal.classList.remove('hidden'));
  elements.btnCloseModal.addEventListener('click', () => elements.guideModal.classList.add('hidden'));
  elements.btnCloseModalBottom.addEventListener('click', () => elements.guideModal.classList.add('hidden'));
  
  // Close modal on background click
  elements.guideModal.addEventListener('click', (e) => {
    if (e.target === elements.guideModal) elements.guideModal.classList.add('hidden');
  });

  // Copy Schema Code to Clipboard
  elements.btnCopySchema.addEventListener('click', () => {
    navigator.clipboard.writeText(elements.schemaCode.textContent)
      .then(() => {
        elements.btnCopySchema.innerHTML = '<i class="fa-solid fa-check"></i> Copied!';
        elements.btnCopySchema.style.borderColor = '#10b981';
        elements.btnCopySchema.style.color = '#34d399';
        
        setTimeout(() => {
          elements.btnCopySchema.innerHTML = '<i class="fa-regular fa-copy"></i> Copy Schema';
          elements.btnCopySchema.style.borderColor = '';
          elements.btnCopySchema.style.color = '';
        }, 2000);
      })
      .catch(err => {
        console.error('Clipboard copy error:', err);
      });
  });

  // Dropzone File Drag-and-Drop Triggers
  setupDropzone(elements.dropzoneExcel, elements.inputExcel, handleExcelFile);
  setupDropzone(elements.dropzoneAttachment, elements.inputAttachment, handleAttachmentFile);

  // Clear file buttons
  elements.btnClearExcel.addEventListener('click', (e) => {
    e.stopPropagation();
    clearExcelData();
  });
  
  elements.btnClearAttachment.addEventListener('click', (e) => {
    e.stopPropagation();
    clearAttachmentData();
  });

  // Real-time Text Interpolation Previews
  elements.emailSubject.addEventListener('input', updateLivePreview);
  elements.emailBody.addEventListener('input', updateLivePreview);
  if (elements.chkUseTemplate) {
    elements.chkUseTemplate.addEventListener('change', updateLivePreview);
  }

  // Placeholder Helper Tag insertion
  elements.tagButtons.forEach(button => {
    button.addEventListener('click', () => {
      const tag = button.getAttribute('data-tag');
      insertTextAtCursor(elements.emailBody, tag);
      updateLivePreview();
    });
  });

  // Campaign Control Triggers
  elements.btnStartCampaign.addEventListener('click', startCampaign);
  elements.btnPauseCampaign.addEventListener('click', pauseCampaign);
  elements.btnCancelCampaign.addEventListener('click', cancelCampaign);
  elements.btnDownloadReport.addEventListener('click', downloadExcelReport);
  elements.btnClearLogs.addEventListener('click', () => {
    elements.terminalBody.innerHTML = '';
  });
  if (elements.btnLogout) {
    elements.btnLogout.addEventListener('click', logoutUser);
  }
}

/**
 * Triggers logout request to backend and redirects to login page
 */
async function logoutUser() {
  try {
    const response = await originalFetch('/api/logout', {
      method: 'POST'
    });
    if (response.ok) {
      window.location.href = '/login.html';
    }
  } catch (error) {
    console.error('Logout error:', error);
    window.location.href = '/login.html';
  }
}

/**
 * Configure standard Drag & Drop file listeners for custom panels
 */
function setupDropzone(dropzone, inputEl, fileHandler) {
  dropzone.addEventListener('click', () => inputEl.click());
  
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });

  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dragover');
  });

  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    
    if (e.dataTransfer.files.length > 0) {
      inputEl.files = e.dataTransfer.files;
      fileHandler(e.dataTransfer.files[0]);
    }
  });

  inputEl.addEventListener('change', () => {
    if (inputEl.files.length > 0) {
      fileHandler(inputEl.files[0]);
    }
  });
}

// ==========================================================================
// 3. EXCEL PARSING (SHEETJS INTEGRATION)
// ==========================================================================
/**
 * Loads Excel, inspects columns, and hydrates contacts state
 */
function handleExcelFile(file) {
  const reader = new FileReader();
  
  reader.onload = (e) => {
    try {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];
      
      // Parse Sheet rows as Array of Arrays to inspect headers strictly
      const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
      
      if (rows.length < 2) {
        throw new Error('Spreadsheet has insufficient rows. Must contain at least a header row and one contact row.');
      }

      const headers = rows[0].map(h => String(h || '').trim().toLowerCase());
      
      // Target column indices
      const companyIndex = headers.indexOf('company name');
      const nameIndex = headers.indexOf('name');
      const emailIndex = headers.indexOf('email');

      // Strict validation
      if (companyIndex === -1 || nameIndex === -1 || emailIndex === -1) {
        throw new Error('Columns mismatch! Ensure sheet has exactly: "Company Name", "Name", and "Email" columns.');
      }

      // Convert rows to parsed array structures
      contactsData = [];
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length === 0) continue; // skip blank rows

        const email = String(row[emailIndex] || '').trim();
        const name = String(row[nameIndex] || '').trim();
        const company = String(row[companyIndex] || '').trim();

        // Skip if major data is completely empty
        if (!email && !name) continue;

        contactsData.push({
          rowIndex: i, // Excel line number representation (1-indexed header, so 2-indexed rows)
          companyName: company,
          name: name,
          email: email,
          status: 'Pending',
          logs: 'Queued in runner'
        });
      }

      if (contactsData.length === 0) {
        throw new Error('Excel parsed, but no contact rows with names and emails were found.');
      }

      // Hydrate HTML UI with spreadsheet details
      elements.excelFileInfo.classList.remove('hidden');
      elements.excelFileInfo.querySelector('.file-name').textContent = file.name;
      elements.excelFileInfo.querySelector('.file-details').textContent = `${contactsData.length} contacts parsed successfully`;
      elements.dropzoneExcel.querySelector('.dropzone-content').classList.add('hidden');
      
      logToTerminal(`[SYSTEM] Excel sheet parsed: ${file.name} (${contactsData.length} contacts found)`, 'success');
      
      // Refresh Contacts Grid View
      renderContactsTable();
      validateFormInputs();
      updateLivePreview();

    } catch (err) {
      logToTerminal(`[SYSTEM] ERROR parsing Excel sheet: ${err.message}`, 'error');
      alert(`Excel Parse Failed: ${err.message}`);
      clearExcelData();
    }
  };

  reader.readAsArrayBuffer(file);
}

/**
 * Resets contact list grid state and controls
 */
function clearExcelData() {
  contactsData = [];
  elements.inputExcel.value = '';
  elements.excelFileInfo.classList.add('hidden');
  elements.dropzoneExcel.querySelector('.dropzone-content').classList.remove('hidden');
  
  elements.contactsCountBadge.classList.add('hidden');
  elements.tablePlaceholder.classList.remove('hidden');
  elements.tableWrapper.classList.add('hidden');
  elements.contactsTableBody.innerHTML = '';
  
  logToTerminal('[SYSTEM] Contact list cleared.', 'system');
  validateFormInputs();
  updateLivePreview();
}

// ==========================================================================
// 4. ATTACHMENT FILE UPLOAD HANDLER
// ==========================================================================
/**
 * Sends attachment file to backend /api/upload endpoint
 */
async function handleAttachmentFile(file) {
  // Size limit validation (25MB)
  if (file.size > 25 * 1024 * 1024) {
    alert('Attachment file exceeds the maximum allowed size of 25MB.');
    clearAttachmentData();
    return;
  }

  logToTerminal(`[SYSTEM] Uploading attachment: ${file.name} (${formatBytes(file.size)})...`, 'system');

  const formData = new FormData();
  formData.append('attachment', file);

  try {
    // Show visual uploading state
    elements.dropzoneAttachment.querySelector('.dropzone-content').innerHTML = `
      <i class="fa-solid fa-spinner fa-spin dropzone-icon text-indigo"></i>
      <h3>Uploading to Server...</h3>
      <p class="dropzone-sub">${file.name}</p>
    `;

    const response = await fetch('/api/upload', {
      method: 'POST',
      body: formData
    });

    const result = await response.json();

    if (result.success) {
      uploadedAttachment = {
        filename: result.filename,
        originalName: result.originalName,
        size: result.size
      };

      // Update Attachment Info UI
      elements.attachmentFileInfo.classList.remove('hidden');
      elements.attachmentFileInfo.querySelector('.file-name').textContent = result.originalName;
      elements.attachmentFileInfo.querySelector('.file-details').textContent = formatBytes(result.size);
      elements.dropzoneAttachment.querySelector('.dropzone-content').classList.add('hidden');
      
      logToTerminal(`[SYSTEM] Attachment uploaded successfully: ${result.originalName}`, 'success');
    } else {
      throw new Error(result.error || 'Server rejected file upload');
    }
  } catch (error) {
    console.error('File uploading error:', error);
    logToTerminal(`[SYSTEM] File upload failed: ${error.message}`, 'error');
    alert(`File upload failed: ${error.message}`);
    clearAttachmentData();
  }
}

/**
 * Resets attachment state on browser and triggers backend deletion
 */
async function clearAttachmentData() {
  const fileToDelete = uploadedAttachment ? uploadedAttachment.filename : null;
  
  uploadedAttachment = null;
  elements.inputAttachment.value = '';
  elements.attachmentFileInfo.classList.add('hidden');
  
  // Revert dropzone content structure
  elements.dropzoneAttachment.querySelector('.dropzone-content').innerHTML = `
    <i class="fa-solid fa-paperclip dropzone-icon"></i>
    <h3>Attach single file</h3>
    <p class="dropzone-sub">PDF, Word, Images, Zip, etc.</p>
    <span class="btn btn-secondary btn-sm">Browse File</span>
  `;
  elements.dropzoneAttachment.querySelector('.dropzone-content').classList.remove('hidden');

  logToTerminal('[SYSTEM] Attachment cleared.', 'system');

  // Trigger manual API cleanup
  if (fileToDelete) {
    try {
      await fetch('/api/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: fileToDelete })
      });
    } catch (err) {
      console.warn('API cleanup error:', err);
    }
  }
}

// ==========================================================================
// 5. LIVE PREVIEW INTERPOLATOR & UTILS
// ==========================================================================
/**
 * Inserts placeholder tags at the exact cursor point inside textareas
 */
function insertTextAtCursor(textarea, text) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const originalVal = textarea.value;
  
  textarea.value = originalVal.substring(0, start) + text + originalVal.substring(end);
  
  // Put caret position right after inserted element
  textarea.selectionStart = textarea.selectionEnd = start + text.length;
  textarea.focus();
}

/**
 * Computes live string interpolation utilizing contact details
 */
function updateLivePreview() {
  const subjectTemplate = elements.emailSubject.value;
  const bodyTemplate = elements.emailBody.value;

  // Use the first contact row as dummy, or standard placeholders if empty
  const hasContacts = contactsData.length > 0;
  const context = hasContacts ? contactsData[0] : {
    name: 'John Doe',
    companyName: 'Acme Corp',
    email: 'johndoe@acme.com'
  };

  elements.previewRowIndex.textContent = hasContacts 
    ? `Showing row: #${context.rowIndex} (${context.name})` 
    : 'Showing default preview';

  // Apply bracket replacements
  const interpolatedSubject = interpolate(subjectTemplate, context);
  const interpolatedBody = interpolate(bodyTemplate, context);

  elements.previewSubjectText.textContent = interpolatedSubject || '(Empty Subject)';
  
  if (elements.chkUseTemplate && elements.chkUseTemplate.checked && interpolatedBody) {
    const htmlContent = convertMarkdownToHtml(interpolatedBody);

    elements.previewBodyText.innerHTML = `
<div style="background-color: #ffffff; padding: 25px; border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.1); font-family: Arial, Helvetica, sans-serif; font-size: 15px; color: #000000; margin-top: 5px; text-align: left; line-height: 1.6;">
  ${htmlContent}
</div>`;
  } else {
    elements.previewBodyText.innerHTML = (interpolatedBody || '(Empty Body)').replace(/\n/g, '<br>');
  }
  
  validateFormInputs();
}

/**
 * Parses plain text with simple Markdown formatting (bold, bullet lists, emojis) into professional inline HTML.
 */
function convertMarkdownToHtml(text) {
  if (!text) return '';

  // 1. Escape HTML first to prevent code injection
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // 2. Bold text translation: **text** -> strong tag
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong style="font-weight: bold; color: #000000;">$1</strong>');

  // 3. Paragraph splitting by double line break
  const blocks = html.split(/\n\n+/);
  
  const parsedBlocks = blocks.map(block => {
    block = block.trim();
    if (!block) return '';

    const lines = block.split('\n');
    
    // Check if the block consists of bullet list items (lines starting with •, *, -, or 🏆)
    const isBulletList = lines.every(line => {
      const trimmed = line.trim();
      return trimmed.startsWith('•') || trimmed.startsWith('*') || trimmed.startsWith('-') || trimmed.startsWith('🏆');
    });

    if (isBulletList) {
      const listItems = lines.map(line => {
        let content = line.trim();
        let bulletStyle = '';
        
        if (content.startsWith('•')) {
          content = content.substring(1).trim();
          bulletStyle = 'list-style-type: disc; margin-left: 20px;';
        } else if (content.startsWith('*')) {
          content = content.substring(1).trim();
          bulletStyle = 'list-style-type: disc; margin-left: 20px;';
        } else if (content.startsWith('-')) {
          content = content.substring(1).trim();
          bulletStyle = 'list-style-type: disc; margin-left: 20px;';
        } else if (content.startsWith('🏆')) {
          bulletStyle = 'list-style-type: none; margin-left: 0; padding-left: 0;';
        }

        return `<li style="margin-bottom: 6px; line-height: 1.6; color: #000000; font-size: 15px; ${bulletStyle}">${content}</li>`;
      }).join('');
      
      return `<ul style="padding-left: 0; margin: 0 0 16px 0; list-style-position: outside;">${listItems}</ul>`;
    }

    // Check if it is a signature block
    const isSignature = block.toLowerCase().includes('regards') || block.toLowerCase().includes('sreekrishna');
    if (isSignature) {
      const sigLines = lines.map(line => {
        let lineContent = line.trim();
        // Convert URLs and emails into links
        if (lineContent.startsWith('http://') || lineContent.startsWith('https://')) {
          lineContent = `<a href="${lineContent}" target="_blank" style="color: #0066cc; text-decoration: none; font-weight: normal;">${lineContent}</a>`;
        } else if (lineContent.includes('@') && !lineContent.includes(' ')) {
          lineContent = `<a href="mailto:${lineContent}" style="color: #0066cc; text-decoration: none; font-weight: normal;">${lineContent}</a>`;
        }
        return lineContent;
      }).join('<br>');
      return `<p style="margin: 0 0 16px 0; line-height: 1.6; color: #000000; font-size: 15px;">${sigLines}</p>`;
    }

    // Default paragraph block
    return `<p style="margin: 0 0 16px 0; line-height: 1.6; color: #000000; font-size: 15px;">${block.replace(/\n/g, '<br>')}</p>`;
  });

  return parsedBlocks.join('');
}

/**
 * Wraps plain text email body in clean, standard, highly-compatible sans-serif rich-text HTML format.
 */
function wrapInEmailTemplate(bodyText) {
  const htmlContent = convertMarkdownToHtml(bodyText);

  return `
<div style="font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 1.6; color: #000000; text-align: left; max-width: 650px;">
  ${htmlContent}
</div>
`;
}

/**
 * Regex bracket translator
 */
function interpolate(template, data) {
  if (!template) return '';
  return template
    .replace(/{Name}/g, data.name || '')
    .replace(/{Company Name}/g, data.companyName || '')
    .replace(/{Email}/g, data.email || '');
}

/**
 * Controls "Launch Campaign" button based on fields fulfillment
 */
function validateFormInputs() {
  const hasSubject = elements.emailSubject.value.trim() !== "";
  const hasBody = elements.emailBody.value.trim() !== "";
  const hasContacts = contactsData.length > 0;

  const isFormValid = hasSubject && hasBody && hasContacts;
  
  if (campaignState === 'idle') {
    elements.btnStartCampaign.disabled = !isFormValid;
  }
}

// ==========================================================================
// 6. CONTACTS GRID RENDERER
// ==========================================================================
function renderContactsTable() {
  if (contactsData.length === 0) {
    elements.contactsCountBadge.classList.add('hidden');
    elements.tablePlaceholder.classList.remove('hidden');
    elements.tableWrapper.classList.add('hidden');
    return;
  }

  elements.contactsCountBadge.classList.remove('hidden');
  elements.contactsCountBadge.textContent = `${contactsData.length} Contacts Loaded`;
  elements.tablePlaceholder.classList.add('hidden');
  elements.tableWrapper.classList.remove('hidden');

  elements.contactsTableBody.innerHTML = '';
  
  contactsData.forEach((contact, idx) => {
    const tr = document.createElement('tr');
    tr.id = `row-${idx}`;
    tr.innerHTML = `
      <td>#${contact.rowIndex}</td>
      <td><strong>${escapeHtml(contact.companyName || '-')}</strong></td>
      <td>${escapeHtml(contact.name || '-')}</td>
      <td><code class="text-indigo">${escapeHtml(contact.email)}</code></td>
      <td><span class="status-badge ${contact.status.toLowerCase()}">${contact.status}</span></td>
      <td class="td-logs" title="${escapeHtml(contact.logs)}">${escapeHtml(contact.logs)}</td>
    `;
    elements.contactsTableBody.appendChild(tr);
  });
}

/**
 * Updates a single table row dynamic HTML states
 */
function updateTableRow(idx) {
  const contact = contactsData[idx];
  const rowEl = document.getElementById(`row-${idx}`);
  if (!rowEl) return;

  const badgeCell = rowEl.querySelector('.status-badge');
  const logsCell = rowEl.querySelector('.td-logs');

  if (badgeCell) {
    badgeCell.className = `status-badge ${contact.status.toLowerCase()}`;
    badgeCell.textContent = contact.status;
  }
  
  if (logsCell) {
    logsCell.textContent = contact.logs;
    logsCell.title = contact.logs;
  }
}

// ==========================================================================
// 7. ASYNC CAMPAIGN DISPATCH QUEUE RUNNER
// ==========================================================================
/**
 * Starts a new mail campaign or resumes a paused one
 */
async function startCampaign() {
  if (campaignState === 'idle' || campaignState === 'completed') {
    // Fresh initialization
    campaignState = 'running';
    currentSendIndex = 0;
    stopRequested = false;
    
    // Clear previous execution state from contacts data array
    contactsData.forEach(c => {
      c.status = 'Pending';
      c.logs = 'Queued in runner';
    });
    renderContactsTable();

    // Setup metrics state
    stats.total = contactsData.length;
    stats.sent = 0;
    stats.failed = 0;
    stats.remaining = stats.total;

    updateMetricsDashboard();

    // Trigger visual transitions
    elements.campaignPanel.classList.remove('hidden');
    elements.campaignPanel.scrollIntoView({ behavior: 'smooth' });
    logToTerminal(`[CAMPAIGN] Starting new campaign for ${stats.total} contacts...`, 'system');

  } else if (campaignState === 'paused') {
    // Resuming campaign execution
    campaignState = 'running';
    logToTerminal('[CAMPAIGN] Campaign Resumed.', 'system');
  }

  // Set Control triggers
  setCampaignButtonStates();
  runCampaignQueue();
}

/**
 * Core loop executing requests row-by-row
 */
async function runCampaignQueue() {
  const subjectTemplate = elements.emailSubject.value;
  const bodyTemplate = elements.emailBody.value;
  const attachmentFile = uploadedAttachment ? uploadedAttachment.filename : null;

  while (currentSendIndex < contactsData.length && campaignState === 'running') {
    if (stopRequested) {
      handleCampaignStopped();
      return;
    }

    const index = currentSendIndex;
    const contact = contactsData[index];

    // Update row status to Sending
    contact.status = 'Pending';
    contact.logs = 'Sending mail...';
    updateTableRow(index);
    scrollTableToRow(index);

    logToTerminal(`[SENDING] Row #${contact.rowIndex}: Sending to ${contact.name} (${contact.email})...`, 'system');

    // Perform placeholders replacement
    const personalizedSubject = interpolate(subjectTemplate, contact);
    const personalizedBody = interpolate(bodyTemplate, contact);

    let finalBody = personalizedBody;
    if (elements.chkUseTemplate && elements.chkUseTemplate.checked) {
      finalBody = wrapInEmailTemplate(personalizedBody);
    }

    try {
      const payload = {
        recipientEmail: contact.email,
        recipientName: contact.name,
        recipientCompany: contact.companyName,
        subject: personalizedSubject,
        body: finalBody,
        attachmentFilename: attachmentFile
      };

      const response = await fetch('/api/send-email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const data = await response.json();

      if (response.ok && data.success) {
        contact.status = 'Sent';
        contact.logs = 'Successfully sent';
        stats.sent++;
        logToTerminal(`[SUCCESS] Email sent to ${contact.email}`, 'success');
      } else {
        throw new Error(data.error || `HTTP Status ${response.status}`);
      }

    } catch (err) {
      contact.status = 'Failed';
      contact.logs = err.message;
      stats.failed++;
      logToTerminal(`[FAILED] Row #${contact.rowIndex} (${contact.email}): ${err.message}`, 'error');
    }

    // Refresh row and stats
    stats.remaining--;
    updateTableRow(index);
    updateMetricsDashboard();
    
    currentSendIndex++;

    // Add artificial delay (800ms) to prevent server rate throttling
    if (currentSendIndex < contactsData.length && campaignState === 'running') {
      await sleep(800);
    }
  }

  // Campaign complete triggers
  if (currentSendIndex >= contactsData.length) {
    handleCampaignCompleted();
  }
}

/**
 * Standard sleep timing helper
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Handles visual Pause state toggles
 */
function pauseCampaign() {
  if (campaignState === 'running') {
    campaignState = 'paused';
    logToTerminal('[CAMPAIGN] Paused by user. Will stop after finishing the current row.', 'warning');
    setCampaignButtonStates();
  }
}

/**
 * Handles visual Stop button triggers
 */
function cancelCampaign() {
  if (confirm('Are you sure you want to stop this mail campaign? You can download reports for emails processed so far.')) {
    stopRequested = true;
    logToTerminal('[CAMPAIGN] Stop requested. Shutting down queue...', 'warning');
    if (campaignState === 'paused') {
      handleCampaignStopped();
    }
  }
}

/**
 * Campaign completes naturally
 */
function handleCampaignCompleted() {
  campaignState = 'completed';
  logToTerminal(`[CAMPAIGN] Completed! Total: ${stats.total} | Sent: ${stats.sent} | Failed: ${stats.failed}`, 'success');
  alert(`Campaign Completed!\nSent: ${stats.sent}\nFailed: ${stats.failed}`);
  setCampaignButtonStates();
}

/**
 * Campaign stops pre-maturely
 */
function handleCampaignStopped() {
  campaignState = 'completed'; // revert states to idle / completed
  logToTerminal(`[CAMPAIGN] Campaign stopped by user. Processed ${currentSendIndex} of ${stats.total} rows.`, 'warning');
  alert(`Campaign stopped by user.\nProcessed: ${currentSendIndex}\nSent: ${stats.sent}\nFailed: ${stats.failed}`);
  setCampaignButtonStates();
}

/**
 * Controls lock-down and release of UI control panel elements based on states
 */
function setCampaignButtonStates() {
  if (campaignState === 'running') {
    elements.btnStartCampaign.disabled = true;
    elements.btnPauseCampaign.classList.remove('hidden');
    elements.btnPauseCampaign.innerHTML = '<i class="fa-solid fa-pause"></i> Pause';
    elements.btnCancelCampaign.classList.remove('hidden');
    elements.btnDownloadReport.disabled = true;
    
    // Lock forms
    elements.emailSubject.disabled = true;
    elements.emailBody.disabled = true;
    elements.btnClearExcel.disabled = true;
    elements.btnClearAttachment.disabled = true;
    elements.dropzoneExcel.style.pointerEvents = 'none';
    elements.dropzoneAttachment.style.pointerEvents = 'none';
    elements.tagButtons.forEach(b => b.disabled = true);
    
  } else if (campaignState === 'paused') {
    elements.btnPauseCampaign.innerHTML = '<i class="fa-solid fa-play"></i> Resume';
    elements.btnStartCampaign.disabled = true;
    elements.btnDownloadReport.disabled = false;
    
  } else if (campaignState === 'completed' || campaignState === 'idle') {
    elements.btnStartCampaign.disabled = false;
    elements.btnStartCampaign.innerHTML = '<i class="fa-solid fa-rocket"></i> Relaunch Campaign';
    elements.btnPauseCampaign.classList.add('hidden');
    elements.btnCancelCampaign.classList.add('hidden');
    elements.btnDownloadReport.disabled = false;
    
    // Unlock forms
    elements.emailSubject.disabled = false;
    elements.emailBody.disabled = false;
    elements.btnClearExcel.disabled = false;
    elements.btnClearAttachment.disabled = false;
    elements.dropzoneExcel.style.pointerEvents = '';
    elements.dropzoneAttachment.style.pointerEvents = '';
    elements.tagButtons.forEach(b => b.disabled = false);
    validateFormInputs();
  }
}

/**
 * Hydrates metrics fields and renders Progress Radial ring
 */
function updateMetricsDashboard() {
  elements.statTotal.textContent = stats.total;
  elements.statSent.textContent = stats.sent;
  elements.statFailed.textContent = stats.failed;
  elements.statRemaining.textContent = stats.remaining;

  const percent = stats.total > 0 ? Math.round(((stats.sent + stats.failed) / stats.total) * 100) : 0;
  progressPercentage.textContent = `${percent}%`;

  // Draw circular stroke animation offset
  if (progressCircle) {
    const offset = circumference - (percent / 100) * circumference;
    progressCircle.style.strokeDashoffset = offset;
  }
}

// ==========================================================================
// 8. EXPORTS STATUS EXCEL SPREADSHEET REPORT
// ==========================================================================
/**
 * Compiles contactsState back into standard downloadable Excel worksheet file
 */
function downloadExcelReport() {
  if (contactsData.length === 0) return;
  
  logToTerminal('[SYSTEM] Compiling campaign report worksheet...', 'system');

  try {
    // Maps state data back to original table arrays
    const excelHeaders = ['Company Name', 'Name', 'Email', 'Sent Status', 'Logs & Details'];
    const sheetData = [excelHeaders];

    contactsData.forEach(c => {
      sheetData.push([
        c.companyName,
        c.name,
        c.email,
        c.status === 'Sent' ? 'Sent' : 'Not Sent',
        c.logs
      ]);
    });

    const worksheet = XLSX.utils.aoa_to_sheet(sheetData);
    
    // Set custom column widths to make sheet look very clean & professional
    worksheet['!cols'] = [
      { wch: 25 }, // Company Name
      { wch: 20 }, // Name
      { wch: 30 }, // Email
      { wch: 15 }, // Sent Status
      { wch: 45 }  // Logs & Details
    ];

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Campaign Report');

    // Trigger browser file download
    XLSX.writeFile(workbook, `Mail_Merge_Report_${Date.now()}.xlsx`);
    
    logToTerminal('[SYSTEM] Excel status report downloaded successfully.', 'success');
  } catch (err) {
    console.error('Download report error:', err);
    logToTerminal(`[SYSTEM] ERROR downloading Excel report: ${err.message}`, 'error');
  }
}

// ==========================================================================
// 9. LOGS & UTILITIES
// ==========================================================================
/**
 * Console-like scrolling terminal logs builder
 */
function logToTerminal(message, type = 'system') {
  const line = document.createElement('div');
  line.className = `log-line ${type}`;
  
  const timestamp = new Date().toLocaleTimeString();
  line.textContent = `[${timestamp}] ${message}`;
  
  elements.terminalBody.appendChild(line);
  elements.terminalBody.scrollTop = elements.terminalBody.scrollHeight;
}

/**
 * Scrolls active row into screen viewport in contacts tables
 */
function scrollTableToRow(index) {
  const row = document.getElementById(`row-${index}`);
  if (row) {
    row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    row.style.background = 'rgba(99, 102, 241, 0.1)';
    
    // Remove highlight background after a few seconds
    setTimeout(() => {
      row.style.background = '';
    }, 1800);
  }
}

/**
 * Format bytes into readables strings (MB, KB etc.)
 */
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

/**
 * Basic HTML tag escapes helper
 */
function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
