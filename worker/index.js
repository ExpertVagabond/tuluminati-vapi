/**
 * Tuluminati VAPI Webhook Worker
 * Receives call data from VAPI after each call and forwards lead info
 * via WhatsApp (Twilio) or email fallback.
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS headers for VAPI
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

    // Main VAPI webhook endpoint
    if (url.pathname === "/webhook" && request.method === "POST") {
      try {
        const payload = await request.json();
        const { message } = payload;

        // VAPI sends different message types — we care about end-of-call-report
        if (message?.type === "end-of-call-report") {
          const lead = extractLeadFromReport(message);

          console.log("Lead captured:", JSON.stringify(lead));

          // Try WhatsApp via Twilio first, fall back to email
          if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) {
            await sendWhatsApp(env, lead);
          }

          return new Response(JSON.stringify({ status: "lead_captured", lead }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // For other VAPI message types (function-call, etc.), acknowledge
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

/**
 * Extract lead info from VAPI end-of-call-report
 */
function extractLeadFromReport(report) {
  const transcript = report.transcript || "";
  const summary = report.summary || "";
  const duration = report.endedReason || "unknown";
  const recordingUrl = report.recordingUrl || null;
  const startedAt = report.startedAt || null;
  const endedAt = report.endedAt || null;

  // Calculate call duration
  let callDuration = "unknown";
  if (startedAt && endedAt) {
    const seconds = Math.round((new Date(endedAt) - new Date(startedAt)) / 1000);
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    callDuration = `${mins}m ${secs}s`;
  }

  // Try to extract structured info from transcript
  const lead = {
    timestamp: new Date().toISOString(),
    callDuration,
    endedReason: duration,
    summary,
    transcript: typeof transcript === "string"
      ? transcript
      : formatTranscript(transcript),
    recordingUrl,
    // These will be extracted from the conversation
    callerName: extractField(transcript, ["my name is", "i'm", "this is", "i am"]),
    intent: extractIntent(transcript),
    budget: extractField(transcript, ["budget", "price range", "looking to spend", "around"]),
    location: extractLocation(transcript),
    contactInfo: extractContact(transcript),
  };

  return lead;
}

/**
 * Format transcript array into readable text
 */
function formatTranscript(transcript) {
  if (Array.isArray(transcript)) {
    return transcript
      .map((t) => `${t.role === "assistant" ? "Luna" : "Caller"}: ${t.message}`)
      .join("\n");
  }
  return String(transcript);
}

/**
 * Extract a field value following certain keywords in transcript
 */
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

/**
 * Detect caller intent from transcript
 */
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

/**
 * Detect location preference
 */
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

/**
 * Extract contact info (email, phone)
 */
function extractContact(transcript) {
  const text = typeof transcript === "string"
    ? transcript
    : formatTranscript(transcript);

  // Email regex
  const emailMatch = text.match(/[\w.-]+@[\w.-]+\.\w+/i);
  // Phone regex (various formats)
  const phoneMatch = text.match(/[\+]?[\d\s\-().]{7,15}/);

  const contacts = {};
  if (emailMatch) contacts.email = emailMatch[0];
  if (phoneMatch) contacts.phone = phoneMatch[0].trim();

  return Object.keys(contacts).length > 0 ? contacts : null;
}

/**
 * Send WhatsApp notification via Twilio
 */
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

/**
 * Format lead data into a WhatsApp-friendly message
 */
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
