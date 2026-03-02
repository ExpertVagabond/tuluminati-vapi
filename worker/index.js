/**
 * Tuluminati VAPI Webhook Worker
 *
 * Features:
 * - VAPI webhook: end-of-call-report → lead storage + notifications
 * - VAPI tool calls: search_properties + get_property_details (live mid-call)
 * - Email follow-up: branded HTML to lead + internal team notification
 * - Lead dashboard: password-protected UI with Call Back button
 * - Outbound calls: ready-to-activate follow-up call trigger
 * - Property KV: seed from tuluminatirealestate.com/listings.json
 */

import { WorkerMailer } from "worker-mailer";

// ─── Static Property Data (for email matching without KV reads) ────

const PROPERTIES_STATIC = [
  { id: 1, name: "DUNA", type: "villa", price: 430000, location: "Tulum", bedrooms: 3, bathrooms: 3, roi: "15-20%", rentalPrice: 350, features: ["Unique Design", "Pool", "Premium Location"] },
  { id: 2, name: "LUMARA", type: "land", price: 78000, location: "Tulum", bedrooms: 0, bathrooms: 0, roi: "20-30%", rentalPrice: null, features: ["Titled", "Gated Community", "Clubhouse"] },
  { id: 3, name: "SUNSET", type: "condo", price: 116000, location: "Playa del Carmen", bedrooms: 1, bathrooms: 1, roi: "10-15%", rentalPrice: 120, features: ["Furnished", "Rooftop Pool", "Co-working"] },
  { id: 4, name: "ESENTIA", type: "villa", price: 450000, location: "Tulum", bedrooms: 4, bathrooms: 4, roi: "12-18%", rentalPrice: 450, features: ["Wooden Luxury", "Private Pool", "Jungle Setting"] },
  { id: 5, name: "BALI RECINTO", type: "villa", price: 200000, location: "Playa del Carmen", bedrooms: 3, bathrooms: 2, roi: "10-14%", rentalPrice: 275, features: ["Resort Community", "Cenote Access", "Pool"] },
  { id: 6, name: "SELVA ESCONDIDA", type: "villa", price: 320000, location: "Puerto Morelos", bedrooms: 3, bathrooms: 3, roi: "10-15%", rentalPrice: 300, features: ["Jungle Villa", "Private Pool", "Gated"] },
  { id: 7, name: "BALI CROZET", type: "villa", price: 225000, location: "Playa del Carmen", bedrooms: 2, bathrooms: 2, roi: "8-12%", rentalPrice: null, features: ["Retirement Community", "Amenities", "Garden"] },
  { id: 8, name: "OCEANVIEW", type: "condo", price: 650000, location: "Tulum Beach Zone", bedrooms: 2, bathrooms: 2, roi: "10-14%", rentalPrice: 500, features: ["Beachfront", "Luxury Finishes", "Rooftop"] },
  { id: 9, name: "COSTA AZUL", type: "villa", price: 1250000, location: "Sian Ka'an, Tulum", bedrooms: 4, bathrooms: 4, roi: "8-12%", rentalPrice: 800, features: ["Oceanfront", "Private Beach", "Infinity Pool"] },
  { id: 10, name: "MAREA TULUM", type: "condo", price: 485000, location: "Tulum Beach Road", bedrooms: 1, bathrooms: 1, roi: "12-16%", rentalPrice: 250, features: ["Beach Access", "Yoga Deck", "Boutique"] },
];

// ─── Main Handler ──────────────────────────────────────────────────

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
        version: "2.0.0",
        features: ["tool-calls", "email-followup", "lead-dashboard", "outbound-ready"],
        timestamp: new Date().toISOString(),
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Lead Dashboard ──
    if (url.pathname === "/leads" && request.method === "GET") {
      if (url.searchParams.get("pw") !== env.DASHBOARD_PASSWORD) {
        return new Response("Unauthorized", { status: 401, headers: corsHeaders });
      }
      return serveDashboard(env, corsHeaders);
    }

    // ── Single Lead API ──
    if (url.pathname.startsWith("/leads/") && request.method === "GET") {
      if (url.searchParams.get("pw") !== env.DASHBOARD_PASSWORD) {
        return new Response("Unauthorized", { status: 401, headers: corsHeaders });
      }
      const id = url.pathname.replace("/leads/", "");
      const lead = await env.LEADS.get(`lead:${id}`, "json");
      if (!lead) return new Response("Not found", { status: 404, headers: corsHeaders });
      return new Response(JSON.stringify(lead, null, 2), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Seed Properties ──
    if (url.pathname === "/api/seed-properties" && request.method === "POST") {
      if (url.searchParams.get("pw") !== env.DASHBOARD_PASSWORD) {
        return new Response("Unauthorized", { status: 401, headers: corsHeaders });
      }
      return seedProperties(env, corsHeaders);
    }

    // ── Outbound Follow-up Call ──
    if (url.pathname.startsWith("/api/follow-up/") && request.method === "POST") {
      if (url.searchParams.get("pw") !== env.DASHBOARD_PASSWORD) {
        return new Response("Unauthorized", { status: 401, headers: corsHeaders });
      }
      const leadId = url.pathname.replace("/api/follow-up/", "");
      return handleOutboundCall(env, leadId, corsHeaders);
    }

    // ── Properties API ──
    if (url.pathname === "/api/properties" && request.method === "GET") {
      return new Response(JSON.stringify(PROPERTIES_STATIC), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Main VAPI Webhook ──
    if (url.pathname === "/webhook" && request.method === "POST") {
      try {
        const payload = await request.json();
        const { message } = payload;

        // Tool calls from Luna mid-conversation
        if (message?.type === "tool-calls") {
          const results = await handleToolCalls(message.toolCallList, env);
          return new Response(JSON.stringify({ results }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // End of call — capture lead
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
          if (index.length > 500) index.length = 500;
          await env.LEADS.put("lead:index", JSON.stringify(index));

          // Push notification via ntfy.sh
          sendNtfyNotification(env, lead).catch(err => console.error("ntfy error:", err));

          // Email follow-up to lead (if email captured)
          if (lead.contactInfo?.email) {
            sendFollowUpEmail(env, lead).catch(err => console.error("Follow-up email error:", err));
          }

          // Internal team notification email
          sendInternalEmail(env, lead).catch(err => console.error("Internal email error:", err));

          // WhatsApp via Twilio (if configured)
          if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) {
            sendWhatsApp(env, lead).catch(err => console.error("WhatsApp error:", err));
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

// ─── VAPI Tool Call Handler ────────────────────────────────────────

async function handleToolCalls(toolCallList, env) {
  const results = [];

  for (const call of toolCallList) {
    const { id, name, arguments: args } = call;
    let result;

    if (name === "search_properties") {
      result = await searchProperties(args || {}, env);
    } else if (name === "get_property_details") {
      result = await getPropertyDetails(args?.propertyName || "", env);
    } else {
      result = "I don't have that tool available right now.";
    }

    results.push({ toolCallId: id, result });
  }

  return results;
}

async function searchProperties(filters, env) {
  // Try KV first, fall back to static
  let properties;
  try {
    properties = await env.PROPERTIES.get("property:index", "json");
  } catch (e) { /* ignore */ }
  if (!properties) properties = PROPERTIES_STATIC;

  let matches = [...properties];

  if (filters.maxPrice) matches = matches.filter(p => p.price <= filters.maxPrice);
  if (filters.minPrice) matches = matches.filter(p => p.price >= filters.minPrice);
  if (filters.type) matches = matches.filter(p => p.type === filters.type.toLowerCase());
  if (filters.bedrooms) matches = matches.filter(p => p.bedrooms >= filters.bedrooms);
  if (filters.forRent === true) matches = matches.filter(p => p.rentalPrice !== null && p.rentalPrice > 0);
  if (filters.location) {
    const loc = filters.location.toLowerCase();
    matches = matches.filter(p => p.location.toLowerCase().includes(loc));
  }

  if (matches.length === 0) {
    return "We don't have any properties matching those exact criteria right now. Let me have our team reach out with some options that haven't been listed yet.";
  }

  const top = matches.slice(0, 3);
  const lines = top.map(p => {
    const rental = p.rentalPrice ? `, renting for $${p.rentalPrice} per night` : "";
    const beds = p.bedrooms ? `${p.bedrooms}-bedroom ` : "";
    return `${p.name}: ${beds}${p.type} in ${p.location} at $${p.price.toLocaleString()}, ${p.roi} annual ROI${rental}`;
  });

  return `I found ${matches.length} matching ${matches.length === 1 ? "property" : "properties"}. Here are the top picks: ${lines.join(". ")}. Would you like more details on any of these?`;
}

async function getPropertyDetails(name, env) {
  const nameMap = {
    "DUNA": 1, "LUMARA": 2, "SUNSET": 3, "ESENTIA": 4,
    "BALI RECINTO": 5, "SELVA ESCONDIDA": 6, "BALI CROZET": 7,
    "OCEANVIEW": 8, "COSTA AZUL": 9, "MAREA TULUM": 10,
  };

  const normalized = name.toUpperCase().trim();
  const id = nameMap[normalized];
  if (!id) {
    return `I couldn't find a property called ${name}. Our current listings include: DUNA, LUMARA, SUNSET, ESENTIA, BALI RECINTO, SELVA ESCONDIDA, BALI CROZET, OCEANVIEW, COSTA AZUL, and MAREA TULUM. Which one interests you?`;
  }

  // Try KV for full details first
  let property;
  try {
    property = await env.PROPERTIES.get(`property:${id}`, "json");
  } catch (e) { /* ignore */ }

  // Fall back to static
  if (!property) {
    const p = PROPERTIES_STATIC.find(x => x.id === id);
    if (!p) return "I'm having trouble loading those details right now.";
    const rental = p.rentalPrice ? ` It rents for $${p.rentalPrice} per night.` : "";
    const beds = p.bedrooms ? `${p.bedrooms} bedrooms, ${p.bathrooms} bathrooms, ` : "";
    return `${p.name} is a ${beds}${p.type} in ${p.location} priced at $${p.price.toLocaleString()} USD. Features include ${p.features.join(", ")}. Expected ROI: ${p.roi}.${rental}`;
  }

  // Full KV record with descriptions
  const p = property;
  const title = typeof p.title === "object" ? p.title.en : p.name;
  const desc = typeof p.description === "object" ? p.description.en : (p.description || "");
  const rental = p.rentalPrice ? ` It rents for $${p.rentalPrice} per night.` : "";
  const beds = p.bedrooms ? `${p.bedrooms} bedrooms, ${p.bathrooms} bathrooms, ` : "";
  const area = p.area ? `${p.area} square meters, ` : "";
  const features = Array.isArray(p.features) ? p.features.join(", ") : "";
  const delivery = p.delivery ? ` Delivery: ${p.delivery}.` : "";

  return `${title} is a ${beds}${area}${p.type} in ${p.location} priced at $${p.price.toLocaleString()} USD. ${desc} Features: ${features}. Expected ROI: ${p.roi}.${rental}${delivery}`;
}

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

  return {
    timestamp: new Date().toISOString(),
    callDuration,
    endedReason: duration,
    summary,
    transcript: typeof transcript === "string" ? transcript : formatTranscript(transcript),
    recordingUrl,
    callerName: extractField(transcript, ["my name is", "i'm", "this is", "i am"]),
    intent: extractIntent(transcript),
    budget: extractField(transcript, ["budget", "price range", "looking to spend", "around"]),
    location: extractLocation(transcript),
    contactInfo: extractContact(transcript),
  };
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
      if (cleaned.length > 1 && cleaned.length < 50) return cleaned;
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
  const text = typeof transcript === "string" ? transcript : formatTranscript(transcript);
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

  await fetch(`https://ntfy.sh/${topic}`, {
    method: "POST",
    headers: {
      "Title": `New Lead — Luna AI ${lead.intent ? "(" + lead.intent + ")" : ""}`,
      "Priority": lead.intent === "Buying" || lead.intent === "Investment" ? "high" : "default",
      "Tags": "house,phone",
    },
    body: body.trim(),
  });
}

async function sendWhatsApp(env, lead) {
  const message = formatWhatsAppMessage(lead);
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

  if (!response.ok) console.error("Twilio error:", await response.text());
  return response.ok;
}

function formatWhatsAppMessage(lead) {
  let msg = `🏠 *NEW LEAD — Luna AI*\n`;
  msg += `📅 ${new Date(lead.timestamp).toLocaleString("en-US", { timeZone: "America/Cancun" })}\n`;
  msg += `⏱️ Call: ${lead.callDuration}\n\n`;
  if (lead.callerName) msg += `👤 *Name:* ${lead.callerName}\n`;
  if (lead.intent) msg += `🎯 *Intent:* ${lead.intent}\n`;
  if (lead.budget) msg += `💰 *Budget:* ${lead.budget}\n`;
  if (lead.location) msg += `📍 *Location:* ${lead.location}\n`;
  if (lead.contactInfo?.email) msg += `📧 *Email:* ${lead.contactInfo.email}\n`;
  if (lead.contactInfo?.phone) msg += `📱 *Phone:* ${lead.contactInfo.phone}\n`;
  msg += `\n📝 *Summary:*\n${lead.summary || "No summary"}\n`;
  if (lead.recordingUrl) msg += `\n🎙️ *Recording:* ${lead.recordingUrl}`;
  return msg;
}

// ─── Email Follow-up ───────────────────────────────────────────────

async function getMailer(env) {
  return await WorkerMailer.connect({
    host: env.SMTP_HOST,
    port: parseInt(env.SMTP_PORT || "587"),
    secure: false,
    credentials: {
      username: env.SMTP_USER,
      password: env.SMTP_PASS,
    },
    authType: "plain",
  });
}

async function sendFollowUpEmail(env, lead) {
  const recommended = getRecommendedProperties(lead);
  const name = lead.callerName ? capitalize(lead.callerName) : "there";

  const propertyRows = recommended.map(p => {
    const rental = p.rentalPrice ? `$${p.rentalPrice}/night` : "—";
    return `<tr>
      <td style="padding:12px;border-bottom:1px solid #2a2a2a;"><strong style="color:#c9a962;">${p.name}</strong><br><span style="color:#999;font-size:12px;">${p.type} in ${p.location}</span></td>
      <td style="padding:12px;border-bottom:1px solid #2a2a2a;color:#f5f0e8;">$${p.price.toLocaleString()}</td>
      <td style="padding:12px;border-bottom:1px solid #2a2a2a;color:#f5f0e8;">${p.bedrooms || "—"}</td>
      <td style="padding:12px;border-bottom:1px solid #2a2a2a;color:#f5f0e8;">${p.roi}</td>
      <td style="padding:12px;border-bottom:1px solid #2a2a2a;color:#f5f0e8;">${rental}</td>
    </tr>`;
  }).join("");

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="background:#0a0a0a;color:#f5f0e8;font-family:'Helvetica Neue',Arial,sans-serif;padding:0;margin:0;">
<div style="max-width:600px;margin:0 auto;padding:40px 24px;">

  <div style="text-align:center;margin-bottom:32px;padding-bottom:24px;border-bottom:1px solid #222;">
    <h1 style="color:#c9a962;font-size:24px;margin:0 0 4px 0;font-weight:400;letter-spacing:2px;">TULUMINATI</h1>
    <p style="color:#888;font-size:12px;margin:0;letter-spacing:3px;text-transform:uppercase;">Real Estate — Riviera Maya</p>
  </div>

  <p style="font-size:16px;line-height:1.6;margin-bottom:20px;">Hi ${name},</p>

  <p style="font-size:15px;line-height:1.7;color:#ccc;margin-bottom:24px;">
    Thank you for speaking with me! Based on our conversation, I've selected some properties
    I think you'll love. Here are my top recommendations for you:
  </p>

  ${recommended.length > 0 ? `
  <table style="width:100%;border-collapse:collapse;margin-bottom:28px;font-size:14px;">
    <tr style="color:#888;font-size:11px;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #333;">
      <th style="padding:10px 12px;text-align:left;">Property</th>
      <th style="padding:10px 12px;text-align:left;">Price</th>
      <th style="padding:10px 12px;text-align:left;">Beds</th>
      <th style="padding:10px 12px;text-align:left;">ROI</th>
      <th style="padding:10px 12px;text-align:left;">Rental</th>
    </tr>
    ${propertyRows}
  </table>` : ""}

  <div style="text-align:center;margin:32px 0;">
    <a href="https://tuluminatirealestate.com" style="display:inline-block;background:#c9a962;color:#0a0a0a;padding:14px 36px;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px;letter-spacing:1px;">VIEW ALL LISTINGS</a>
  </div>

  <p style="font-size:14px;line-height:1.7;color:#aaa;margin-bottom:24px;">
    A member of our team will be in touch within 24 hours to answer any questions
    and schedule a property tour — virtual or in-person. You can also reach us
    directly on WhatsApp at <a href="https://wa.me/529983702679" style="color:#c9a962;">+52 998 370 2679</a>.
  </p>

  <p style="font-size:14px;color:#aaa;">
    Warm regards,<br>
    <strong style="color:#c9a962;">Luna</strong> — AI Concierge<br>
    Tuluminati Real Estate
  </p>

  <div style="margin-top:40px;padding-top:20px;border-top:1px solid #222;text-align:center;font-size:12px;color:#666;">
    <p>Tuluminati Real Estate | Aldea Zama, Tulum, Q.R., Mexico</p>
    <a href="https://tuluminatirealestate.com" style="color:#c9a962;text-decoration:none;">tuluminatirealestate.com</a>
  </div>

</div>
</body></html>`;

  const mailer = await getMailer(env);
  await mailer.send({
    from: { name: env.SMTP_FROM_NAME || "Luna — Tuluminati", email: env.SMTP_USER },
    to: { name: lead.callerName || "Valued Client", email: lead.contactInfo.email },
    subject: "Your Tuluminati Property Recommendations",
    text: `Hi ${name}, thank you for speaking with Tuluminati Real Estate! Visit tuluminatirealestate.com to view our full listings. Our team will contact you within 24 hours.`,
    html,
  });
}

async function sendInternalEmail(env, lead) {
  if (!env.SMTP_PASS) return; // Skip if SMTP not configured

  const subject = `New Luna Lead: ${lead.callerName || "Unknown"} — ${lead.intent || "General"}`;
  const text = [
    `New lead captured by Luna AI`,
    ``,
    `Name: ${lead.callerName || "Unknown"}`,
    `Intent: ${lead.intent || "General Inquiry"}`,
    `Budget: ${lead.budget || "Not mentioned"}`,
    `Location: ${lead.location || "Not specified"}`,
    `Duration: ${lead.callDuration}`,
    `Ended: ${lead.endedReason}`,
    ``,
    `Contact:`,
    `  Email: ${lead.contactInfo?.email || "None captured"}`,
    `  Phone: ${lead.contactInfo?.phone || "None captured"}`,
    ``,
    `Summary: ${lead.summary || "No summary"}`,
    ``,
    `Recording: ${lead.recordingUrl || "None"}`,
    `Dashboard: https://tuluminati-webhook.purplesquirrelnetworks.workers.dev/leads?pw=${env.DASHBOARD_PASSWORD}`,
  ].join("\n");

  const mailer = await getMailer(env);
  await mailer.send({
    from: { name: "Luna AI — Lead Alert", email: env.SMTP_USER },
    to: { name: "Tuluminati Team", email: env.NOTIFICATION_EMAIL },
    subject,
    text,
  });
}

function getRecommendedProperties(lead) {
  let candidates = [...PROPERTIES_STATIC];

  // Filter by intent
  if (lead.intent === "Vacation Rental") {
    candidates = candidates.filter(p => p.rentalPrice);
  }

  // Filter by location
  if (lead.location) {
    const loc = lead.location.toLowerCase().split(",")[0].trim();
    const locFiltered = candidates.filter(p => p.location.toLowerCase().includes(loc));
    if (locFiltered.length > 0) candidates = locFiltered;
  }

  // Filter by budget
  if (lead.budget) {
    const budgetNum = parseBudget(lead.budget);
    if (budgetNum) {
      const budgetFiltered = candidates.filter(p => p.price <= budgetNum * 1.3);
      if (budgetFiltered.length > 0) candidates = budgetFiltered;
    }
  }

  return candidates.slice(0, 3);
}

function parseBudget(str) {
  if (!str) return null;
  const cleaned = str.replace(/[^0-9kKmM.]/g, "");
  const num = parseFloat(cleaned);
  if (isNaN(num)) return null;
  if (/million|[mM]/.test(str)) return num * 1000000;
  if (/thousand|[kK]/.test(str)) return num * 1000;
  if (num < 1000) return num * 1000; // "300" probably means 300k
  return num;
}

function capitalize(str) {
  return str.replace(/\b\w/g, c => c.toUpperCase());
}

// ─── Seed Properties ───────────────────────────────────────────────

async function seedProperties(env, corsHeaders) {
  try {
    const resp = await fetch("https://tuluminatirealestate.com/listings.json");
    if (!resp.ok) throw new Error(`listings.json returned ${resp.status}`);

    const data = await resp.json();
    const properties = data.properties || [];

    // Build index (lightweight for search)
    const index = properties.map(p => ({
      id: p.id,
      name: (typeof p.title === "object" ? p.title.en : p.title).split(" - ")[0].split(" –")[0].trim(),
      type: p.type,
      price: p.price,
      location: p.location,
      bedrooms: p.bedrooms || 0,
      bathrooms: p.bathrooms || 0,
      roi: p.roi,
      rentalPrice: p.rentalPrice || null,
      features: p.features || [],
    }));

    // Write each property + index
    for (const p of properties) {
      await env.PROPERTIES.put(`property:${p.id}`, JSON.stringify(p));
    }
    await env.PROPERTIES.put("property:index", JSON.stringify(index));

    return new Response(JSON.stringify({
      status: "seeded",
      count: properties.length,
      properties: index.map(p => `${p.name} ($${p.price.toLocaleString()})`),
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}

// ─── Outbound Calls (Ready-to-Activate) ────────────────────────────

async function handleOutboundCall(env, leadId, corsHeaders) {
  const lead = await env.LEADS.get(`lead:${leadId}`, "json");
  if (!lead) {
    return new Response(JSON.stringify({ error: "Lead not found" }), {
      status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!lead.contactInfo?.phone) {
    return new Response(JSON.stringify({ error: "No phone number for this lead" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!env.VAPI_PRIVATE_KEY || !env.VAPI_PHONE_NUMBER_ID) {
    return new Response(JSON.stringify({
      error: "Outbound calls not configured. Set VAPI_PRIVATE_KEY and VAPI_PHONE_NUMBER_ID worker secrets.",
    }), {
      status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const customerName = lead.callerName ? capitalize(lead.callerName) : "there";
  const callDate = new Date(lead.timestamp).toLocaleDateString("en-US", { month: "long", day: "numeric" });

  const body = {
    assistant: {
      name: "Luna Follow-Up",
      model: {
        provider: "openai",
        model: "gpt-4o",
        temperature: 0.7,
        maxTokens: 200,
        messages: [{
          role: "system",
          content: `You are Luna, the AI concierge for Tuluminati Real Estate. You are calling back ${customerName} who contacted you on ${callDate}.

Their interest: ${lead.intent || "General inquiry"}
Budget: ${lead.budget || "Not specified"}
Location preference: ${lead.location || "Riviera Maya"}

Your goals:
1. Confirm they received the property recommendations email
2. Answer any questions about the properties
3. Offer to schedule a virtual or in-person tour
4. If they are ready, offer to connect with a human agent

Keep the call brief and warm — under 5 minutes. This is a friendly follow-up, not a sales pitch.

Current listings: DUNA ($430k villa Tulum), LUMARA ($78k land Tulum), SUNSET ($116k condo PDC), ESENTIA ($450k villa Tulum), BALI RECINTO ($200k villa PDC), SELVA ESCONDIDA ($320k villa Puerto Morelos), BALI CROZET ($225k villa PDC), OCEANVIEW ($650k condo Tulum Beach), COSTA AZUL ($1.25M villa Sian Ka'an), MAREA TULUM ($485k condo Tulum Beach).`,
        }],
      },
      voice: { provider: "11labs", voiceId: "21m00Tcm4TlvDq8ikWAM" },
      transcriber: { provider: "deepgram", model: "nova-2", language: "multi" },
      firstMessage: `Hi, is this ${customerName}? This is Luna calling back from Tuluminati Real Estate. I wanted to follow up on our conversation — do you have a quick moment?`,
      endCallMessage: "Thank you so much! We'll follow up with everything we discussed. Have a wonderful day!",
      silenceTimeoutSeconds: 20,
      maxDurationSeconds: 300,
      serverUrl: "https://tuluminati-webhook.purplesquirrelnetworks.workers.dev/webhook",
    },
    phoneNumberId: env.VAPI_PHONE_NUMBER_ID,
    customer: { number: lead.contactInfo.phone },
  };

  const response = await fetch("https://api.vapi.ai/call", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.VAPI_PRIVATE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const result = await response.json();
  if (!response.ok) {
    return new Response(JSON.stringify({ error: "VAPI call failed", details: result }), {
      status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ status: "call_initiated", callId: result.id, leadId }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Lead Dashboard ────────────────────────────────────────────────

async function serveDashboard(env, corsHeaders) {
  const index = await env.LEADS.get("lead:index", "json") || [];
  const recentIds = index.slice(0, 50);
  const leads = [];
  for (const entry of recentIds) {
    const lead = await env.LEADS.get(`lead:${entry.id}`, "json");
    if (lead) leads.push(lead);
  }

  const intentCounts = { Buying: 0, Investment: 0, "Vacation Rental": 0, Selling: 0, "General Inquiry": 0 };
  leads.forEach(l => { if (l.intent && intentCounts[l.intent] !== undefined) intentCounts[l.intent]++; });

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Tuluminati Leads — Luna AI</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0a;color:#f5f0e8;padding:20px;max-width:1200px;margin:0 auto}
  h1{color:#c9a962;font-size:1.8rem;margin-bottom:8px}
  .subtitle{color:#999;font-size:.9rem;margin-bottom:30px}
  .stats{display:flex;gap:16px;margin-bottom:30px;flex-wrap:wrap}
  .stat{background:#1a1a1a;border:1px solid #333;border-radius:10px;padding:16px 24px;flex:1;min-width:120px;text-align:center}
  .stat-value{font-size:2rem;font-weight:700;color:#c9a962}
  .stat-label{font-size:.75rem;color:#888;text-transform:uppercase;letter-spacing:1px;margin-top:4px}
  .lead-card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;padding:20px;margin-bottom:16px;transition:border-color .2s}
  .lead-card:hover{border-color:#c9a962}
  .lead-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px}
  .lead-name{font-size:1.1rem;font-weight:600}
  .lead-time{color:#888;font-size:.8rem}
  .lead-meta{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
  .tag{display:inline-block;padding:4px 10px;border-radius:20px;font-size:.75rem;font-weight:600}
  .tag-buying{background:#1a3a2a;color:#4ade80}
  .tag-investment{background:#1a2a3a;color:#60a5fa}
  .tag-vacationrental{background:#3a2a1a;color:#fbbf24}
  .tag-selling{background:#3a1a2a;color:#f472b6}
  .tag-generalinquiry{background:#2a2a2a;color:#999}
  .tag-duration{background:#2a2a2a;color:#c9a962}
  .tag-location{background:#1a2a2a;color:#67e8f9}
  .lead-summary{color:#ccc;font-size:.9rem;line-height:1.5;margin-bottom:12px}
  .lead-contact{display:flex;gap:16px;flex-wrap:wrap;font-size:.85rem}
  .lead-contact span{color:#c9a962}
  .btn{background:none;border:1px solid #333;color:#999;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:.8rem;margin-top:8px;margin-right:8px}
  .btn:hover{border-color:#c9a962;color:#c9a962}
  .btn-call{border-color:#4ade80;color:#4ade80}
  .btn-call:hover{background:#4ade80;color:#0a0a0a}
  .transcript{display:none;background:#111;border-radius:8px;padding:14px;margin-top:12px;font-size:.8rem;line-height:1.6;white-space:pre-wrap;color:#aaa;max-height:300px;overflow-y:auto}
  .transcript.open{display:block}
  .recording-link{color:#c9a962;text-decoration:none;font-size:.85rem}
  .recording-link:hover{text-decoration:underline}
  .empty{text-align:center;padding:60px 20px;color:#666}
  .empty h2{color:#c9a962;margin-bottom:8px}
  @media(max-width:600px){body{padding:12px}.stat{min-width:80px;padding:12px}.stat-value{font-size:1.4rem}}
</style>
</head>
<body>
<h1>Luna AI — Lead Dashboard</h1>
<p class="subtitle">Tuluminati Real Estate | ${leads.length} lead${leads.length !== 1 ? "s" : ""} captured</p>

<div class="stats">
  <div class="stat"><div class="stat-value">${leads.length}</div><div class="stat-label">Total</div></div>
  <div class="stat"><div class="stat-value">${intentCounts.Buying}</div><div class="stat-label">Buyers</div></div>
  <div class="stat"><div class="stat-value">${intentCounts.Investment}</div><div class="stat-label">Investors</div></div>
  <div class="stat"><div class="stat-value">${intentCounts["Vacation Rental"]}</div><div class="stat-label">Rentals</div></div>
  <div class="stat"><div class="stat-value">${leads.filter(l => l.contactInfo?.email).length}</div><div class="stat-label">Emails</div></div>
</div>

${leads.length === 0 ? `<div class="empty"><h2>No leads yet</h2><p>Leads will appear here after calls with Luna.</p></div>` : leads.map(lead => `
<div class="lead-card">
  <div class="lead-header">
    <div class="lead-name">${lead.callerName ? capitalize(lead.callerName) : "Unknown Caller"}</div>
    <div class="lead-time">${new Date(lead.timestamp).toLocaleString("en-US", { timeZone: "America/Cancun" })}</div>
  </div>
  <div class="lead-meta">
    <span class="tag tag-${(lead.intent || "generalinquiry").toLowerCase().replace(/\s+/g, "")}">${lead.intent || "General"}</span>
    <span class="tag tag-duration">${lead.callDuration}</span>
    ${lead.location ? `<span class="tag tag-location">${lead.location}</span>` : ""}
    ${lead.budget ? `<span class="tag tag-duration">${lead.budget}</span>` : ""}
  </div>
  <div class="lead-summary">${(lead.summary || "No summary available").replace(/</g, "&lt;")}</div>
  <div class="lead-contact">
    ${lead.contactInfo?.email ? `<div>Email: <span>${lead.contactInfo.email}</span></div>` : ""}
    ${lead.contactInfo?.phone ? `<div>Phone: <span>${lead.contactInfo.phone}</span></div>` : ""}
    ${lead.recordingUrl ? `<a href="${lead.recordingUrl}" class="recording-link" target="_blank">Recording</a>` : ""}
  </div>
  <div style="margin-top:10px;">
    <button class="btn" onclick="toggleTranscript(this)">Show Transcript</button>
    ${lead.contactInfo?.phone ? `<button class="btn btn-call" onclick="triggerFollowUp('${lead.id}')">Call Back</button>` : ""}
  </div>
  <div class="transcript">${(lead.transcript || "No transcript").replace(/</g, "&lt;")}</div>
</div>`).join("")}

<script>
function toggleTranscript(btn){
  const t=btn.parentElement.nextElementSibling;
  t.classList.toggle('open');
  btn.textContent=t.classList.contains('open')?'Hide Transcript':'Show Transcript';
}
async function triggerFollowUp(id){
  if(!confirm('Trigger an outbound follow-up call to this lead?'))return;
  const r=await fetch('/api/follow-up/'+id+'?pw=${env.DASHBOARD_PASSWORD}',{method:'POST'});
  const d=await r.json();
  if(d.error)alert('Error: '+d.error);
  else alert('Follow-up call initiated! Call ID: '+d.callId);
}
setTimeout(()=>location.reload(),30000);
</script>
</body></html>`;

  return new Response(html, {
    headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" },
  });
}
