/**
 * Tuluminati VAPI Webhook Worker
 * Receives call data from VAPI after each call, stores leads in KV,
 * sends push notifications via ntfy.sh, and serves a lead dashboard.
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Health check
    if (url.pathname === "/" && request.method === "GET") {
      return new Response(JSON.stringify({
        status: "ok",
        service: "Tuluminati VAPI Webhook",
        timestamp: new Date().toISOString(),
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Lead dashboard
    if (url.pathname === "/leads" && request.method === "GET") {
      const pw = url.searchParams.get("pw");
      if (pw !== env.DASHBOARD_PASSWORD) {
        return new Response("Unauthorized", { status: 401, headers: corsHeaders });
      }
      return serveDashboard(env, corsHeaders);
    }

    // API: Get single lead
    if (url.pathname.startsWith("/leads/") && request.method === "GET") {
      const pw = url.searchParams.get("pw");
      if (pw !== env.DASHBOARD_PASSWORD) {
        return new Response("Unauthorized", { status: 401, headers: corsHeaders });
      }
      const id = url.pathname.replace("/leads/", "");
      const lead = await env.LEADS.get(`lead:${id}`, "json");
      if (!lead) return new Response("Not found", { status: 404, headers: corsHeaders });
      return new Response(JSON.stringify(lead, null, 2), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Main VAPI webhook endpoint
    if (url.pathname === "/webhook" && request.method === "POST") {
      try {
        const payload = await request.json();
        const { message } = payload;

        if (message?.type === "end-of-call-report") {
          const lead = extractLeadFromReport(message);
          const leadId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          lead.id = leadId;

          console.log("Lead captured:", JSON.stringify(lead));

          // Store in KV
          await env.LEADS.put(`lead:${leadId}`, JSON.stringify(lead));

          // Update lead index
          const index = await env.LEADS.get("lead:index", "json") || [];
          index.unshift({ id: leadId, timestamp: lead.timestamp, callerName: lead.callerName, intent: lead.intent });
          // Keep last 500 leads in index
          if (index.length > 500) index.length = 500;
          await env.LEADS.put("lead:index", JSON.stringify(index));

          // Send push notification via ntfy.sh
          await sendNtfyNotification(env, lead);

          // Try WhatsApp via Twilio if configured
          if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) {
            await sendWhatsApp(env, lead);
          }

          return new Response(JSON.stringify({ status: "lead_captured", id: leadId }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // Acknowledge other VAPI message types
        return new Response(JSON.stringify({ status: "ok" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (err) {
        console.error("Webhook error:", err);
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },
};

// ─── Lead Extraction ───────────────────────────────────────────────

function extractLeadFromReport(report) {
  const transcript = report.transcript || "";
  const summary = report.summary || "";
  const duration = report.endedReason || "unknown";
  const recordingUrl = report.recordingUrl || null;
  const startedAt = report.startedAt || null;
  const endedAt = report.endedAt || null;

  let callDuration = "unknown";
  if (startedAt && endedAt) {
    const seconds = Math.round((new Date(endedAt) - new Date(startedAt)) / 1000);
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    callDuration = `${mins}m ${secs}s`;
  }

  const lead = {
    timestamp: new Date().toISOString(),
    callDuration,
    endedReason: duration,
    summary,
    transcript: typeof transcript === "string"
      ? transcript
      : formatTranscript(transcript),
    recordingUrl,
    callerName: extractField(transcript, ["my name is", "i'm", "this is", "i am"]),
    intent: extractIntent(transcript),
    budget: extractField(transcript, ["budget", "price range", "looking to spend", "around"]),
    location: extractLocation(transcript),
    contactInfo: extractContact(transcript),
  };

  return lead;
}

function formatTranscript(transcript) {
  if (Array.isArray(transcript)) {
    return transcript
      .map((t) => `${t.role === "assistant" ? "Luna" : "Caller"}: ${t.message}`)
      .join("\n");
  }
  return String(transcript);
}

function extractField(transcript, keywords) {
  const text = typeof transcript === "string"
    ? transcript.toLowerCase()
    : formatTranscript(transcript).toLowerCase();

  for (const keyword of keywords) {
    const idx = text.indexOf(keyword);
    if (idx !== -1) {
      const after = text.substring(idx + keyword.length, idx + keyword.length + 60);
      const cleaned = after.replace(/^[\s,.:]+/, "").split(/[.,!?\n]/)[0].trim();
      if (cleaned.length > 1 && cleaned.length < 50) {
        return cleaned;
      }
    }
  }
  return null;
}

function extractIntent(transcript) {
  const text = typeof transcript === "string"
    ? transcript.toLowerCase()
    : formatTranscript(transcript).toLowerCase();

  if (text.includes("buy") || text.includes("purchase") || text.includes("comprar")) return "Buying";
  if (text.includes("invest") || text.includes("roi") || text.includes("return")) return "Investment";
  if (text.includes("rent") || text.includes("vacation") || text.includes("alquil")) return "Vacation Rental";
  if (text.includes("sell") || text.includes("vender")) return "Selling";
  return "General Inquiry";
}

function extractLocation(transcript) {
  const text = typeof transcript === "string"
    ? transcript.toLowerCase()
    : formatTranscript(transcript).toLowerCase();

  const locations = [];
  if (text.includes("tulum")) locations.push("Tulum");
  if (text.includes("playa") || text.includes("carmen")) locations.push("Playa del Carmen");
  if (text.includes("cancun") || text.includes("cancún")) locations.push("Cancun");
  if (text.includes("cozumel")) locations.push("Cozumel");
  if (text.includes("puerto morelos")) locations.push("Puerto Morelos");
  if (text.includes("aldea zama")) locations.push("Aldea Zama");

  return locations.length > 0 ? locations.join(", ") : null;
}

function extractContact(transcript) {
  const text = typeof transcript === "string"
    ? transcript
    : formatTranscript(transcript);

  const emailMatch = text.match(/[\w.-]+@[\w.-]+\.\w+/i);
  const phoneMatch = text.match(/[+]?[\d\s\-().]{7,15}/);

  const contacts = {};
  if (emailMatch) contacts.email = emailMatch[0];
  if (phoneMatch) contacts.phone = phoneMatch[0].trim();

  return Object.keys(contacts).length > 0 ? contacts : null;
}

// ─── Notifications ─────────────────────────────────────────────────

async function sendNtfyNotification(env, lead) {
  const topic = env.NTFY_TOPIC || "tuluminati-leads";

  let body = "";
  if (lead.callerName) body += `Name: ${lead.callerName}\n`;
  body += `Intent: ${lead.intent || "General"}\n`;
  body += `Duration: ${lead.callDuration}\n`;
  if (lead.budget) body += `Budget: ${lead.budget}\n`;
  if (lead.location) body += `Location: ${lead.location}\n`;
  if (lead.contactInfo?.email) body += `Email: ${lead.contactInfo.email}\n`;
  if (lead.contactInfo?.phone) body += `Phone: ${lead.contactInfo.phone}\n`;
  if (lead.summary) body += `\n${lead.summary.substring(0, 200)}`;

  try {
    await fetch(`https://ntfy.sh/${topic}`, {
      method: "POST",
      headers: {
        "Title": `New Lead — Luna AI ${lead.intent ? "(" + lead.intent + ")" : ""}`,
        "Priority": lead.intent === "Buying" || lead.intent === "Investment" ? "high" : "default",
        "Tags": "house,phone",
      },
      body: body.trim(),
    });
  } catch (err) {
    console.error("ntfy.sh error:", err);
  }
}

async function sendWhatsApp(env, lead) {
  const message = formatLeadMessage(lead);

  const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;
  const auth = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);

  const body = new URLSearchParams({
    From: env.TWILIO_WHATSAPP_FROM || "whatsapp:+14155238886",
    To: `whatsapp:${env.TULUMINATI_PHONE}`,
    Body: message,
  });

  const response = await fetch(twilioUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const err = await response.text();
    console.error("Twilio WhatsApp error:", err);
  }

  return response.ok;
}

function formatLeadMessage(lead) {
  let msg = `🏠 *NEW LEAD — Luna AI*\n`;
  msg += `📅 ${new Date(lead.timestamp).toLocaleString("en-US", { timeZone: "America/Cancun" })}\n`;
  msg += `⏱️ Call: ${lead.callDuration}\n\n`;

  if (lead.callerName) msg += `👤 *Name:* ${lead.callerName}\n`;
  if (lead.intent) msg += `🎯 *Intent:* ${lead.intent}\n`;
  if (lead.budget) msg += `💰 *Budget:* ${lead.budget}\n`;
  if (lead.location) msg += `📍 *Location:* ${lead.location}\n`;

  if (lead.contactInfo) {
    if (lead.contactInfo.email) msg += `📧 *Email:* ${lead.contactInfo.email}\n`;
    if (lead.contactInfo.phone) msg += `📱 *Phone:* ${lead.contactInfo.phone}\n`;
  }

  msg += `\n📝 *Summary:*\n${lead.summary || "No summary available"}\n`;

  if (lead.recordingUrl) {
    msg += `\n🎙️ *Recording:* ${lead.recordingUrl}`;
  }

  return msg;
}

// ─── Lead Dashboard ────────────────────────────────────────────────

async function serveDashboard(env, corsHeaders) {
  const index = await env.LEADS.get("lead:index", "json") || [];

  // Fetch full lead data for the most recent 50
  const recentIds = index.slice(0, 50);
  const leads = [];
  for (const entry of recentIds) {
    const lead = await env.LEADS.get(`lead:${entry.id}`, "json");
    if (lead) leads.push(lead);
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Tuluminati Leads — Luna AI</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #0a0a0a; color: #f5f0e8; padding: 20px;
    max-width: 1200px; margin: 0 auto;
  }
  h1 { color: #c9a962; font-size: 1.8rem; margin-bottom: 8px; }
  .subtitle { color: #999; font-size: 0.9rem; margin-bottom: 30px; }
  .stats {
    display: flex; gap: 16px; margin-bottom: 30px; flex-wrap: wrap;
  }
  .stat {
    background: #1a1a1a; border: 1px solid #333; border-radius: 10px;
    padding: 16px 24px; flex: 1; min-width: 140px; text-align: center;
  }
  .stat-value { font-size: 2rem; font-weight: 700; color: #c9a962; }
  .stat-label { font-size: 0.75rem; color: #888; text-transform: uppercase; letter-spacing: 1px; margin-top: 4px; }
  .lead-card {
    background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 12px;
    padding: 20px; margin-bottom: 16px;
    transition: border-color 0.2s;
  }
  .lead-card:hover { border-color: #c9a962; }
  .lead-header {
    display: flex; justify-content: space-between; align-items: center;
    margin-bottom: 12px; flex-wrap: wrap; gap: 8px;
  }
  .lead-name { font-size: 1.1rem; font-weight: 600; }
  .lead-time { color: #888; font-size: 0.8rem; }
  .lead-meta { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
  .tag {
    display: inline-block; padding: 4px 10px; border-radius: 20px;
    font-size: 0.75rem; font-weight: 600;
  }
  .tag-buying { background: #1a3a2a; color: #4ade80; }
  .tag-investment { background: #1a2a3a; color: #60a5fa; }
  .tag-rental { background: #3a2a1a; color: #fbbf24; }
  .tag-selling { background: #3a1a2a; color: #f472b6; }
  .tag-general { background: #2a2a2a; color: #999; }
  .tag-duration { background: #2a2a2a; color: #c9a962; }
  .tag-location { background: #1a2a2a; color: #67e8f9; }
  .lead-summary { color: #ccc; font-size: 0.9rem; line-height: 1.5; margin-bottom: 12px; }
  .lead-contact { display: flex; gap: 16px; flex-wrap: wrap; font-size: 0.85rem; }
  .lead-contact span { color: #c9a962; }
  .transcript-toggle {
    background: none; border: 1px solid #333; color: #999; padding: 6px 12px;
    border-radius: 6px; cursor: pointer; font-size: 0.8rem; margin-top: 8px;
  }
  .transcript-toggle:hover { border-color: #c9a962; color: #c9a962; }
  .transcript {
    display: none; background: #111; border-radius: 8px; padding: 14px;
    margin-top: 12px; font-size: 0.8rem; line-height: 1.6;
    white-space: pre-wrap; color: #aaa; max-height: 300px; overflow-y: auto;
  }
  .transcript.open { display: block; }
  .recording-link {
    color: #c9a962; text-decoration: none; font-size: 0.85rem;
  }
  .recording-link:hover { text-decoration: underline; }
  .empty {
    text-align: center; padding: 60px 20px; color: #666;
  }
  .empty h2 { color: #c9a962; margin-bottom: 8px; }
  @media (max-width: 600px) {
    body { padding: 12px; }
    .stat { min-width: 100px; padding: 12px; }
    .stat-value { font-size: 1.4rem; }
  }
</style>
</head>
<body>
<h1>Luna AI — Lead Dashboard</h1>
<p class="subtitle">Tuluminati Real Estate | ${leads.length} lead${leads.length !== 1 ? "s" : ""} captured</p>

<div class="stats">
  <div class="stat">
    <div class="stat-value">${leads.length}</div>
    <div class="stat-label">Total Leads</div>
  </div>
  <div class="stat">
    <div class="stat-value">${leads.filter(l => l.intent === "Buying").length}</div>
    <div class="stat-label">Buyers</div>
  </div>
  <div class="stat">
    <div class="stat-value">${leads.filter(l => l.intent === "Investment").length}</div>
    <div class="stat-label">Investors</div>
  </div>
  <div class="stat">
    <div class="stat-value">${leads.filter(l => l.intent === "Vacation Rental").length}</div>
    <div class="stat-label">Rentals</div>
  </div>
</div>

${leads.length === 0 ? `
<div class="empty">
  <h2>No leads yet</h2>
  <p>Leads will appear here after calls with Luna.</p>
</div>
` : leads.map((lead, i) => `
<div class="lead-card">
  <div class="lead-header">
    <div class="lead-name">${lead.callerName || "Unknown Caller"}</div>
    <div class="lead-time">${new Date(lead.timestamp).toLocaleString("en-US", { timeZone: "America/Cancun" })}</div>
  </div>
  <div class="lead-meta">
    <span class="tag tag-${(lead.intent || "general").toLowerCase().replace(/\s+/g, "")}">${lead.intent || "General"}</span>
    <span class="tag tag-duration">${lead.callDuration}</span>
    ${lead.location ? `<span class="tag tag-location">${lead.location}</span>` : ""}
    ${lead.budget ? `<span class="tag tag-duration">${lead.budget}</span>` : ""}
  </div>
  <div class="lead-summary">${lead.summary || "No summary available"}</div>
  <div class="lead-contact">
    ${lead.contactInfo?.email ? `<div>Email: <span>${lead.contactInfo.email}</span></div>` : ""}
    ${lead.contactInfo?.phone ? `<div>Phone: <span>${lead.contactInfo.phone}</span></div>` : ""}
    ${lead.recordingUrl ? `<a href="${lead.recordingUrl}" class="recording-link" target="_blank">Listen to recording</a>` : ""}
  </div>
  <button class="transcript-toggle" onclick="this.nextElementSibling.classList.toggle('open');this.textContent=this.nextElementSibling.classList.contains('open')?'Hide Transcript':'Show Transcript'">Show Transcript</button>
  <div class="transcript">${(lead.transcript || "No transcript available").replace(/</g, "&lt;")}</div>
</div>
`).join("")}

<script>
  // Auto-refresh every 30 seconds
  setTimeout(() => location.reload(), 30000);
</script>
</body>
</html>`;

  return new Response(html, {
    headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" },
  });
}
