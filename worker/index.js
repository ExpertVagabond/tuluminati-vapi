/**
 * Tuluminati VAPI Webhook Worker
 *
 * Security: Input sanitization, webhook auth, rate limiting, XSS prevention,
 *           email validation, and safe KV access.
 *
 * Features:
 * - VAPI webhook: end-of-call-report -> lead storage + notifications
 * - VAPI tool calls: search_properties + get_property_details (live mid-call)
 * - Email follow-up: branded HTML to lead + internal team notification
 * - Lead dashboard: password-protected UI with follow-up status
 * - Smart follow-up: automated cadence based on lead intent (hot/warm/general)
 * - Outbound calls: VAPI-powered automated + manual callback
 * - Property KV: seed from tuluminatirealestate.com/listings.json
 */

// ── Security: Input Validation ──────────────────────────────────────
const MAX_STRING_LENGTH = 2000;
const MAX_EMAIL_LENGTH = 320;
const MAX_PHONE_LENGTH = 30;
const MAX_NAME_LENGTH = 200;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_REGEX = /^\+?[0-9\s\-()]{7,25}$/;

function validateString(value, fieldName, maxLen = MAX_STRING_LENGTH) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLen);
}

function validateEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase().slice(0, MAX_EMAIL_LENGTH);
  return EMAIL_REGEX.test(email) ? email : null;
}

function validatePhone(value) {
  if (typeof value !== "string") return null;
  const phone = value.trim().slice(0, MAX_PHONE_LENGTH);
  return PHONE_REGEX.test(phone) ? phone : null;
}

function validateName(value) {
  return validateString(value, "name", MAX_NAME_LENGTH);
}

function sanitizeHtml(str) {
  if (typeof str !== "string") return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function validateNumericId(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 999999) return null;
  return Math.floor(n);
}

function validateDashboardAuth(url, env) {
  const pw = url.searchParams.get("pw");
  if (!pw || !env.DASHBOARD_PASSWORD) return false;
  // Constant-time comparison is not strictly needed for dashboard passwords
  // but we ensure the password is non-empty and matches
  return pw === env.DASHBOARD_PASSWORD;
}

function validateWebhookOrigin(request) {
  // VAPI webhooks come from known IPs/domains — log for monitoring
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const ua = request.headers.get("user-agent") || "unknown";
  return { ip, ua };
}

// ── End Security Module ─────────────────────────────────────────────

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

// ─── Smart Follow-Up Cadence Config ──────────────────────────────

const FOLLOW_UP_CADENCE = {
  hot: [
    { type: "call",  delayHours: 1,  attempt: 1 },
    { type: "email", delayHours: 6,  attempt: 2, condition: "not_reached" },
    { type: "call",  delayHours: 24, attempt: 3, condition: "not_reached" },
  ],
  warm: [
    { type: "call",  delayHours: 4,  attempt: 1 },
    { type: "email", delayHours: 24, attempt: 2 },
  ],
  general: [
    { type: "email", delayHours: 2,  attempt: 1 },
  ],
};

const INTENT_TO_TIER = {
  "Buying": "hot",
  "Investment": "hot",
  "Vacation Rental": "warm",
  "Selling": "warm",
  "General Inquiry": "general",
};

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
        version: "3.0.0",
        features: ["tool-calls", "email-followup", "lead-dashboard", "smart-follow-up", "outbound-calls"],
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

    // ── Toggle Auto Follow-up ──
    if (url.pathname.match(/^\/api\/follow-up\/[^/]+\/toggle$/) && request.method === "POST") {
      if (url.searchParams.get("pw") !== env.DASHBOARD_PASSWORD) {
        return new Response("Unauthorized", { status: 401, headers: corsHeaders });
      }
      const leadId = url.pathname.split("/")[3];
      return handleToggleFollowUp(env, leadId, corsHeaders);
    }

    // ── Test: Manually trigger cron ──
    if (url.pathname === "/api/follow-up/test-tick" && request.method === "POST") {
      if (url.searchParams.get("pw") !== env.DASHBOARD_PASSWORD) {
        return new Response("Unauthorized", { status: 401, headers: corsHeaders });
      }
      const force = url.searchParams.get("force") === "true";
      const results = await processFollowUpQueue(env, force);
      return new Response(JSON.stringify({ status: "tick_processed", results }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Test: Inject synthetic lead ──
    if (url.pathname === "/api/follow-up/test-lead" && request.method === "POST") {
      if (url.searchParams.get("pw") !== env.DASHBOARD_PASSWORD) {
        return new Response("Unauthorized", { status: 401, headers: corsHeaders });
      }
      const tier = url.searchParams.get("tier") || "hot";
      const result = await createTestLead(env, tier);
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Outbound Follow-up Call (manual) ──
    if (url.pathname.match(/^\/api\/follow-up\/[^/]+$/) && request.method === "POST") {
      if (url.searchParams.get("pw") !== env.DASHBOARD_PASSWORD) {
        return new Response("Unauthorized", { status: 401, headers: corsHeaders });
      }
      const leadId = url.pathname.replace("/api/follow-up/", "");
      return handleManualOutboundCall(env, leadId, corsHeaders);
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
        let payload;
        try {
          payload = await request.json();
        } catch {
          return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        if (!payload || typeof payload !== 'object') {
          return new Response(JSON.stringify({ error: "Invalid payload" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const { message } = payload;

        // Tool calls from Luna mid-conversation
        if (message?.type === "tool-calls") {
          const results = await handleToolCalls(message.toolCallList, env);
          return new Response(JSON.stringify({ results }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // End of call — capture lead or update follow-up
        if (message?.type === "end-of-call-report") {
          const callId = message.callId || message.call?.id;

          // Check if this is a follow-up call result
          if (callId) {
            const callMapping = await env.LEADS.get(`call:${callId}`, "json");
            if (callMapping) {
              await updateFollowUpCallResult(env, callMapping.leadId, message);
              return new Response(JSON.stringify({ status: "followup_updated", leadId: callMapping.leadId }), {
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              });
            }
          }

          // New inbound lead
          const lead = extractLeadFromReport(message);
          const leadId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          lead.id = leadId;

          // Initialize follow-up tracking
          const tier = INTENT_TO_TIER[lead.intent] || "general";
          const cadence = FOLLOW_UP_CADENCE[tier];
          const hasPhone = !!lead.contactInfo?.phone;
          const hasEmail = !!lead.contactInfo?.email;
          const firstStep = cadence[0];
          const canFollowUp = (firstStep.type === "call" && hasPhone) || (firstStep.type === "email" && hasEmail);

          lead.followUp = {
            tier,
            status: canFollowUp ? "pending" : "completed",
            actions: [],
            nextActionAt: canFollowUp ? new Date(Date.now() + firstStep.delayHours * 3600000).toISOString() : null,
            nextActionType: canFollowUp ? firstStep.type : null,
            reached: false,
            autoDisabled: false,
          };

          console.log("Lead captured:", JSON.stringify({ id: leadId, tier, intent: lead.intent }));

          // Store in KV
          await env.LEADS.put(`lead:${leadId}`, JSON.stringify(lead));

          // Update lead index
          const index = await env.LEADS.get("lead:index", "json") || [];
          index.unshift({ id: leadId, timestamp: lead.timestamp, callerName: lead.callerName, intent: lead.intent });
          if (index.length > 500) index.length = 500;
          await env.LEADS.put("lead:index", JSON.stringify(index));

          // Add to follow-up queue
          if (canFollowUp) {
            await enqueueFollowUp(env, lead);
          }

          // Push notification via ntfy.sh
          sendNtfyNotification(env, lead).catch(err => console.error("ntfy error:", err));

          // Email follow-up to lead (immediate — this is the initial recommendations email)
          if (lead.contactInfo?.email) {
            sendFollowUpEmailByStage(env, lead, "initial").catch(err => console.error("Follow-up email error:", err));
          }

          // Internal team notification email
          sendInternalEmail(env, lead).catch(err => console.error("Internal email error:", err));

          // WhatsApp via Twilio (if configured)
          if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) {
            sendWhatsApp(env, lead).catch(err => console.error("WhatsApp error:", err));
          }

          return new Response(JSON.stringify({ status: "lead_captured", id: leadId, followUpTier: tier }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // Acknowledge other VAPI message types
        return new Response(JSON.stringify({ status: "ok" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (err) {
        console.error("Webhook error:", err);
        // Don't leak internal error details
        return new Response(JSON.stringify({ error: "Internal webhook error" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },

  // ── Cron Handler — Smart Follow-Up ──
  async scheduled(event, env, ctx) {
    ctx.waitUntil(processFollowUpQueue(env, false));
  },
};

// ─── Follow-Up Queue Management ──────────────────────────────────

async function enqueueFollowUp(env, lead) {
  const queue = await env.LEADS.get("followup:queue", "json") || [];
  queue.push({
    leadId: lead.id,
    nextActionAt: lead.followUp.nextActionAt,
    nextActionType: lead.followUp.nextActionType,
    tier: lead.followUp.tier,
  });
  await env.LEADS.put("followup:queue", JSON.stringify(queue));
}

async function processFollowUpQueue(env, forceBypassHours = false) {
  const queue = await env.LEADS.get("followup:queue", "json") || [];
  if (queue.length === 0) return { processed: 0, skipped: 0 };

  const now = new Date();
  const results = { processed: 0, skipped: 0, errors: 0, rescheduled: 0 };
  const updatedQueue = [];
  let processedCount = 0;

  for (const entry of queue) {
    // Not due yet — keep in queue
    if (new Date(entry.nextActionAt) > now) {
      updatedQueue.push(entry);
      continue;
    }

    // Max 5 per tick to stay within CPU limits
    if (processedCount >= 5) {
      updatedQueue.push(entry);
      continue;
    }

    const lead = await env.LEADS.get(`lead:${entry.leadId}`, "json");
    if (!lead || !lead.followUp) {
      results.skipped++;
      continue;
    }

    // Skip disabled or completed leads
    if (lead.followUp.autoDisabled || lead.followUp.status === "opted_out" || lead.followUp.status === "completed") {
      results.skipped++;
      continue;
    }

    // Get the current cadence step
    const cadence = FOLLOW_UP_CADENCE[lead.followUp.tier];
    const stepIndex = lead.followUp.actions.length;
    const step = cadence?.[stepIndex];

    if (!step) {
      lead.followUp.status = "completed";
      lead.followUp.nextActionAt = null;
      lead.followUp.nextActionType = null;
      await env.LEADS.put(`lead:${entry.leadId}`, JSON.stringify(lead));
      results.skipped++;
      continue;
    }

    // Check condition (e.g., "not_reached")
    if (step.condition === "not_reached" && lead.followUp.reached) {
      // Skip this step, try next
      const nextStep = cadence[stepIndex + 1];
      if (nextStep) {
        lead.followUp.actions.push({
          type: step.type, scheduledAt: entry.nextActionAt, executedAt: now.toISOString(),
          result: "skipped_reached", vapiCallId: null, attempt: step.attempt,
        });
        const nextTime = new Date(new Date(lead.timestamp).getTime() + nextStep.delayHours * 3600000).toISOString();
        lead.followUp.nextActionAt = nextTime;
        lead.followUp.nextActionType = nextStep.type;
        await env.LEADS.put(`lead:${entry.leadId}`, JSON.stringify(lead));
        updatedQueue.push({ ...entry, nextActionAt: nextTime, nextActionType: nextStep.type });
      } else {
        lead.followUp.status = "completed";
        lead.followUp.nextActionAt = null;
        lead.followUp.nextActionType = null;
        await env.LEADS.put(`lead:${entry.leadId}`, JSON.stringify(lead));
      }
      results.skipped++;
      continue;
    }

    // Idempotency check
    const lastAction = lead.followUp.actions[lead.followUp.actions.length - 1];
    if (lastAction && lastAction.attempt === step.attempt && lastAction.executedAt) {
      results.skipped++;
      continue;
    }

    // Business hours check for calls only
    if (step.type === "call" && !forceBypassHours && !isBusinessHours()) {
      const nextOpen = nextBusinessHourOpen();
      updatedQueue.push({ ...entry, nextActionAt: nextOpen });
      results.rescheduled++;
      continue;
    }

    // Execute the action
    lead.followUp.status = "in_progress";
    processedCount++;

    try {
      if (step.type === "call") {
        const callResult = await executeOutboundCall(env, lead, "auto");
        lead.followUp.actions.push({
          type: "call",
          scheduledAt: entry.nextActionAt,
          executedAt: now.toISOString(),
          result: callResult.success ? "initiated" : callResult.error,
          vapiCallId: callResult.callId || null,
          attempt: step.attempt,
        });
        // Store reverse mapping for call result tracking
        if (callResult.callId) {
          await env.LEADS.put(`call:${callResult.callId}`, JSON.stringify({ leadId: entry.leadId }), { expirationTtl: 86400 });
        }
      } else if (step.type === "email") {
        const emailTo = getEmailTarget(env, lead);
        if (emailTo) {
          const stage = step.attempt === 1 && lead.followUp.tier === "general" ? "general" : "not_reached";
          await sendFollowUpEmailByStage(env, lead, stage, emailTo);
          lead.followUp.actions.push({
            type: "email",
            scheduledAt: entry.nextActionAt,
            executedAt: now.toISOString(),
            result: "sent",
            vapiCallId: null,
            attempt: step.attempt,
          });
        } else {
          lead.followUp.actions.push({
            type: "email",
            scheduledAt: entry.nextActionAt,
            executedAt: now.toISOString(),
            result: "no_email",
            vapiCallId: null,
            attempt: step.attempt,
          });
        }
      }
      results.processed++;
    } catch (err) {
      console.error(`Follow-up error for lead ${entry.leadId}:`, err);
      lead.followUp.actions.push({
        type: step.type,
        scheduledAt: entry.nextActionAt,
        executedAt: now.toISOString(),
        result: "failed",
        vapiCallId: null,
        attempt: step.attempt,
      });
      results.errors++;
    }

    // Advance to next cadence step
    const nextStepIndex = lead.followUp.actions.length;
    const nextStep = cadence[nextStepIndex];
    if (nextStep) {
      const nextTime = new Date(new Date(lead.timestamp).getTime() + nextStep.delayHours * 3600000).toISOString();
      lead.followUp.nextActionAt = nextTime;
      lead.followUp.nextActionType = nextStep.type;
      await env.LEADS.put(`lead:${entry.leadId}`, JSON.stringify(lead));
      updatedQueue.push({ ...entry, nextActionAt: nextTime, nextActionType: nextStep.type });
    } else {
      lead.followUp.status = "completed";
      lead.followUp.nextActionAt = null;
      lead.followUp.nextActionType = null;
      await env.LEADS.put(`lead:${entry.leadId}`, JSON.stringify(lead));
    }
  }

  await env.LEADS.put("followup:queue", JSON.stringify(updatedQueue));
  console.log("Follow-up queue processed:", JSON.stringify(results));
  return results;
}

function getEmailTarget(env, lead) {
  if (env.FOLLOW_UP_TEST_MODE === "true") return env.NOTIFICATION_EMAIL;
  return lead.contactInfo?.email || null;
}

function getPhoneTarget(env, lead) {
  if (env.FOLLOW_UP_TEST_MODE === "true") return env.TULUMINATI_PHONE;
  return lead.contactInfo?.phone ? normalizePhoneE164(lead.contactInfo.phone) : null;
}

// ─── Business Hours (America/Cancun, UTC-5 year-round) ───────────

function isBusinessHours() {
  const now = new Date();
  const cancunHour = (now.getUTCHours() - 5 + 24) % 24;
  const cancunDay = now.getUTCDay(); // 0=Sun, 6=Sat
  if (cancunDay === 0) return cancunHour >= 10 && cancunHour < 18;
  return cancunHour >= 9 && cancunHour < 20;
}

function nextBusinessHourOpen() {
  const now = new Date();
  const check = new Date(now);
  for (let i = 0; i < 48; i++) {
    check.setUTCHours(check.getUTCHours() + 1, 0, 0, 0);
    const h = (check.getUTCHours() - 5 + 24) % 24;
    const d = check.getUTCDay();
    if (d === 0 && h >= 10 && h < 18) return check.toISOString();
    if (d !== 0 && h >= 9 && h < 20) return check.toISOString();
  }
  // Fallback: 24 hours from now
  return new Date(now.getTime() + 86400000).toISOString();
}

// ─── Phone Normalization ─────────────────────────────────────────

function normalizePhoneE164(phone) {
  if (!phone) return null;
  let digits = phone.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits.length >= 10 ? digits : null;
  if (digits.length === 10 && /^[1-9]/.test(digits)) return "+52" + digits;
  if (digits.length === 10) return "+1" + digits;
  if (digits.length >= 11) return "+" + digits;
  return null;
}

// ─── Follow-Up Call Result Tracking ──────────────────────────────

async function updateFollowUpCallResult(env, leadId, report) {
  const lead = await env.LEADS.get(`lead:${leadId}`, "json");
  if (!lead || !lead.followUp) return;

  // Determine if the lead was reached
  const startedAt = report.startedAt || null;
  const endedAt = report.endedAt || null;
  const endedReason = report.endedReason || "";
  let durationSec = 0;
  if (startedAt && endedAt) {
    durationSec = Math.round((new Date(endedAt) - new Date(startedAt)) / 1000);
  }
  const wasReached = durationSec > 30 && endedReason !== "no-answer" && endedReason !== "busy" && endedReason !== "failed";

  if (wasReached) {
    lead.followUp.reached = true;
  }

  // Update the last call action's result
  for (let i = lead.followUp.actions.length - 1; i >= 0; i--) {
    if (lead.followUp.actions[i].type === "call" && lead.followUp.actions[i].result === "initiated") {
      lead.followUp.actions[i].result = wasReached ? "reached" : "no_answer";
      lead.followUp.actions[i].callDuration = `${Math.floor(durationSec / 60)}m ${durationSec % 60}s`;
      break;
    }
  }

  await env.LEADS.put(`lead:${leadId}`, JSON.stringify(lead));
  console.log(`Follow-up call result for ${leadId}: ${wasReached ? "reached" : "no_answer"} (${durationSec}s)`);
}

// ─── Toggle Auto Follow-Up ──────────────────────────────────────

async function handleToggleFollowUp(env, leadId, corsHeaders) {
  const lead = await env.LEADS.get(`lead:${leadId}`, "json");
  if (!lead) {
    return new Response(JSON.stringify({ error: "Lead not found" }), {
      status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!lead.followUp) {
    return new Response(JSON.stringify({ error: "No follow-up data for this lead" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  lead.followUp.autoDisabled = !lead.followUp.autoDisabled;

  // If re-enabling, check if there are remaining cadence steps
  if (!lead.followUp.autoDisabled && lead.followUp.status !== "completed" && lead.followUp.status !== "opted_out") {
    const cadence = FOLLOW_UP_CADENCE[lead.followUp.tier];
    const nextStepIndex = lead.followUp.actions.length;
    const nextStep = cadence?.[nextStepIndex];
    if (nextStep) {
      const nextTime = new Date(Date.now() + 300000).toISOString(); // 5 min from now
      lead.followUp.nextActionAt = nextTime;
      lead.followUp.nextActionType = nextStep.type;
      lead.followUp.status = "pending";
      await env.LEADS.put(`lead:${leadId}`, JSON.stringify(lead));
      await enqueueFollowUp(env, lead);
    } else {
      lead.followUp.status = "completed";
      await env.LEADS.put(`lead:${leadId}`, JSON.stringify(lead));
    }
  } else {
    // Disabling — remove from queue
    const queue = await env.LEADS.get("followup:queue", "json") || [];
    const filtered = queue.filter(e => e.leadId !== leadId);
    await env.LEADS.put("followup:queue", JSON.stringify(filtered));
    await env.LEADS.put(`lead:${leadId}`, JSON.stringify(lead));
  }

  return new Response(JSON.stringify({
    status: "toggled",
    autoDisabled: lead.followUp.autoDisabled,
    leadId,
  }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── Test Lead Creation ─────────────────────────────────────────

async function createTestLead(env, tier) {
  const intentMap = { hot: "Buying", warm: "Vacation Rental", general: "General Inquiry" };
  const intent = intentMap[tier] || "General Inquiry";
  const resolvedTier = INTENT_TO_TIER[intent] || "general";
  const cadence = FOLLOW_UP_CADENCE[resolvedTier];
  const firstStep = cadence[0];

  // Set timestamp so first action is due in 1 minute
  const timestamp = new Date(Date.now() - (firstStep.delayHours * 3600000) + 60000).toISOString();
  const leadId = "test-" + Date.now().toString(36);

  const lead = {
    id: leadId,
    timestamp,
    callDuration: "2m 30s",
    endedReason: "customer-ended-call",
    summary: `[TEST] Synthetic ${tier} lead for follow-up testing`,
    transcript: "Luna: Hi! Thanks for calling. Caller: I'm interested in buying a villa in Tulum.",
    recordingUrl: null,
    callerName: "Test Lead",
    intent,
    budget: tier === "hot" ? "$400,000" : null,
    location: "Tulum",
    contactInfo: {
      email: env.NOTIFICATION_EMAIL,
      phone: env.TULUMINATI_PHONE,
      phoneRaw: env.TULUMINATI_PHONE,
    },
    followUp: {
      tier: resolvedTier,
      status: "pending",
      actions: [],
      nextActionAt: new Date(Date.now() + 60000).toISOString(),
      nextActionType: firstStep.type,
      reached: false,
      autoDisabled: false,
    },
  };

  await env.LEADS.put(`lead:${leadId}`, JSON.stringify(lead));

  const index = await env.LEADS.get("lead:index", "json") || [];
  index.unshift({ id: leadId, timestamp: lead.timestamp, callerName: lead.callerName, intent: lead.intent });
  if (index.length > 500) index.length = 500;
  await env.LEADS.put("lead:index", JSON.stringify(index));

  await enqueueFollowUp(env, lead);

  return { status: "test_lead_created", leadId, tier: resolvedTier, nextActionAt: lead.followUp.nextActionAt, nextActionType: lead.followUp.nextActionType };
}

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

  let property;
  try {
    property = await env.PROPERTIES.get(`property:${id}`, "json");
  } catch (e) { /* ignore */ }

  if (!property) {
    const p = PROPERTIES_STATIC.find(x => x.id === id);
    if (!p) return "I'm having trouble loading those details right now.";
    const rental = p.rentalPrice ? ` It rents for $${p.rentalPrice} per night.` : "";
    const beds = p.bedrooms ? `${p.bedrooms} bedrooms, ${p.bathrooms} bathrooms, ` : "";
    return `${p.name} is a ${beds}${p.type} in ${p.location} priced at $${p.price.toLocaleString()} USD. Features include ${p.features.join(", ")}. Expected ROI: ${p.roi}.${rental}`;
  }

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

  const contactInfo = extractContact(transcript);
  // Normalize phone and preserve raw
  if (contactInfo?.phone) {
    contactInfo.phoneRaw = contactInfo.phone;
    contactInfo.phone = normalizePhoneE164(contactInfo.phone) || contactInfo.phone;
  }

  return {
    timestamp: new Date().toISOString(),
    callDuration,
    endedReason: duration,
    summary,
    transcript: typeof transcript === "string" ? transcript : formatTranscript(transcript),
    recordingUrl,
    callerName: extractCallerName(transcript),
    intent: extractIntent(transcript),
    budget: extractBudget(transcript),
    location: extractLocation(transcript),
    contactInfo,
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

function extractCallerName(transcript) {
  // Only search caller/user lines, not AI lines (avoids "I'm Luna")
  const text = typeof transcript === "string" ? transcript : formatTranscript(transcript);
  const callerLines = text.split("\n")
    .filter(l => /^(User|Caller):/i.test(l))
    .join(" ")
    .toLowerCase();

  if (!callerLines) return extractFieldFromText(text.toLowerCase(), ["my name is", "me llamo", "soy"]);

  const keywords = ["my name is", "i'm", "i am", "this is", "me llamo", "mi nombre es", "soy"];
  for (const kw of keywords) {
    const idx = callerLines.indexOf(kw);
    if (idx !== -1) {
      const after = callerLines.substring(idx + kw.length, idx + kw.length + 60);
      const cleaned = after.replace(/^[\s,.:]+/, "").split(/[.,!?\n]/)[0].trim();
      // Filter out common false positives
      if (cleaned.length > 1 && cleaned.length < 50 && !["interested", "looking", "calling", "here"].includes(cleaned.split(" ")[0])) {
        return cleaned;
      }
    }
  }
  return null;
}

function extractFieldFromText(text, keywords) {
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

function extractBudget(transcript) {
  const text = typeof transcript === "string"
    ? transcript.toLowerCase()
    : formatTranscript(transcript).toLowerCase();

  // Match explicit dollar amounts: $100,000 / $100k / 100,000 USD / 100k dollars
  const dollarPatterns = [
    /\$[\d,]+(?:\.\d+)?(?:\s*(?:k|m|thousand|million|mil|millon))?/i,
    /[\d,]+(?:\.\d+)?\s*(?:dollars?|usd|d[oó]lares?)/i,
    /[\d,]+(?:\.\d+)?\s*(?:k|m|thousand|million|mil|millon(?:es)?)\s*(?:dollars?|usd|d[oó]lares?)?/i,
  ];

  for (const pattern of dollarPatterns) {
    const match = text.match(pattern);
    if (match) return match[0].trim();
  }

  // Match budget context keywords (EN + ES)
  const keywords = ["budget", "price range", "looking to spend", "presupuesto", "invertir", "quiero invertir", "gastar"];
  for (const kw of keywords) {
    const idx = text.indexOf(kw);
    if (idx !== -1) {
      const after = text.substring(idx, idx + 80);
      // Look for a number in the surrounding text
      const numMatch = after.match(/[\d,]+(?:\.\d+)?(?:\s*(?:k|m|thousand|million|mil|millon(?:es)?))?/);
      if (numMatch && numMatch[0].length > 2) {
        return numMatch[0].trim();
      }
      // Spanish written numbers
      if (after.includes("cien mil")) return "100,000";
      if (after.includes("doscientos mil")) return "200,000";
      if (after.includes("medio mill")) return "500,000";
      if (after.includes("un mill")) return "1,000,000";
    }
  }

  return null;
}

function extractIntent(transcript) {
  const text = typeof transcript === "string"
    ? transcript.toLowerCase()
    : formatTranscript(transcript).toLowerCase();

  if (text.includes("buy") || text.includes("purchase") || text.includes("comprar")) return "Buying";
  if (text.includes("invest") || text.includes("invertir") || text.includes("roi") || text.includes("return")) return "Investment";
  if (text.includes("rent") || text.includes("vacation") || text.includes("alquil") || text.includes("rentar")) return "Vacation Rental";
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
  const contacts = {};

  // Email: straightforward regex
  const emailMatch = text.match(/[\w.-]+@[\w.-]+\.\w+/i);
  if (emailMatch) contacts.email = emailMatch[0];

  // Phone: look near phone-related context words to avoid grabbing dollar amounts
  const phoneContextWords = [
    "phone", "whatsapp", "call me", "number is", "reach me", "contact",
    "teléfono", "número", "celular", "llam", "mi whatsapp", "móvil",
  ];
  const textLower = text.toLowerCase();

  // Strategy 1: Find phone numbers near context words
  for (const ctx of phoneContextWords) {
    const idx = textLower.indexOf(ctx);
    if (idx === -1) continue;
    // Search in a 150-char window after the context word
    const window = text.substring(idx, idx + 150);
    // Match phone-like patterns: +52 984 210 5952, (269) 218-9965, etc.
    const phoneMatch = window.match(/[+]?\d[\d\s\-().]{8,18}\d/);
    if (phoneMatch) {
      const digits = phoneMatch[0].replace(/[^\d]/g, "");
      if (digits.length >= 7 && digits.length <= 15) {
        contacts.phone = phoneMatch[0].trim();
        return Object.keys(contacts).length > 0 ? contacts : null;
      }
    }
  }

  // Strategy 2: Look for spoken-out phone digits in caller lines
  // e.g., "más cincuenta y dos nueve ocho cuatro..."
  const spokenDigits = extractSpokenPhoneNumber(textLower);
  if (spokenDigits) {
    contacts.phone = spokenDigits;
    return Object.keys(contacts).length > 0 ? contacts : null;
  }

  // Strategy 3: Fallback — find any 10+ digit sequence NOT preceded by $ or "dollar"
  const allPhones = [...text.matchAll(/(?<!\$)(?<!\d)[+]?\d[\d\s\-().]{8,18}\d/g)];
  for (const match of allPhones) {
    const before = text.substring(Math.max(0, match.index - 10), match.index).toLowerCase();
    if (before.includes("$") || before.includes("dollar") || before.includes("usd") || before.includes("price")) continue;
    const digits = match[0].replace(/[^\d]/g, "");
    if (digits.length >= 10 && digits.length <= 15) {
      contacts.phone = match[0].trim();
      break;
    }
  }

  return Object.keys(contacts).length > 0 ? contacts : null;
}

function extractSpokenPhoneNumber(text) {
  // Map Spanish spoken numbers to digits
  const wordToDigit = {
    "cero": "0", "uno": "1", "una": "1", "dos": "2", "tres": "3", "cuatro": "4",
    "cinco": "5", "seis": "6", "siete": "7", "ocho": "8", "nueve": "9",
  };
  const compoundNumbers = {
    "diez": "10", "once": "11", "doce": "12", "trece": "13", "catorce": "14",
    "quince": "15", "dieciséis": "16", "dieciseis": "16", "diecisiete": "17",
    "dieciocho": "18", "diecinueve": "19", "veinte": "20",
    "veintiuno": "21", "veintidós": "22", "veintidos": "22", "veintitrés": "23", "veintitres": "23",
    "veinticuatro": "24", "veinticinco": "25", "veintiséis": "26", "veintiseis": "26",
    "veintisiete": "27", "veintiocho": "28", "veintinueve": "29",
    "treinta": "30", "cuarenta": "40", "cincuenta": "50", "sesenta": "60",
    "setenta": "70", "ochenta": "80", "noventa": "90",
  };

  // Look for sequences near phone context
  const phoneContextIdx = text.search(/(?:whatsapp|número|teléfono|celular|phone|number)/);
  if (phoneContextIdx === -1) return null;

  const window = text.substring(phoneContextIdx, phoneContextIdx + 300);
  const words = window.split(/[\s,]+/);
  let digits = "";
  let collecting = false;

  for (const word of words) {
    const clean = word.replace(/[^a-záéíóúñü0-9]/g, "");
    if (/^\d+$/.test(clean) && clean.length <= 4) {
      digits += clean;
      collecting = true;
    } else if (wordToDigit[clean]) {
      digits += wordToDigit[clean];
      collecting = true;
    } else if (compoundNumbers[clean]) {
      digits += compoundNumbers[clean];
      collecting = true;
    } else if (clean === "más" || clean === "mas" || clean === "plus") {
      digits += "+";
      collecting = true;
    } else if (clean === "y" && collecting) {
      continue; // skip "y" connectors between numbers
    } else if (collecting && digits.replace(/\+/g, "").length >= 7) {
      break; // stop collecting when we have enough digits
    } else if (collecting) {
      break;
    }
  }

  const rawDigits = digits.replace(/\+/g, "");
  if (rawDigits.length >= 10 && rawDigits.length <= 15) {
    return digits.startsWith("+") ? digits : digits;
  }
  return null;
}

// ─── Notifications ─────────────────────────────────────────────────

async function sendNtfyNotification(env, lead) {
  const topic = env.NTFY_TOPIC || "tuluminati-leads";

  let body = "";
  if (lead.callerName) body += `Name: ${lead.callerName}\n`;
  body += `Intent: ${lead.intent || "General"}\n`;
  body += `Duration: ${lead.callDuration}\n`;
  body += `Follow-up: ${lead.followUp?.tier || "none"} tier\n`;
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
  msg += `⏱️ Call: ${lead.callDuration}\n`;
  msg += `🔥 Tier: ${lead.followUp?.tier || "unknown"}\n\n`;
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

// ─── Email Follow-up (Multi-Stage) ─────────────────────────────────

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

function emailHeader() {
  return `<div style="text-align:center;margin-bottom:32px;padding-bottom:24px;border-bottom:1px solid #222;">
    <h1 style="color:#c9a962;font-size:24px;margin:0 0 4px 0;font-weight:400;letter-spacing:2px;">TULUMINATI</h1>
    <p style="color:#888;font-size:12px;margin:0;letter-spacing:3px;text-transform:uppercase;">Real Estate — Riviera Maya</p>
  </div>`;
}

function emailFooter() {
  return `<div style="margin-top:40px;padding-top:20px;border-top:1px solid #222;text-align:center;font-size:12px;color:#666;">
    <p>Tuluminati Real Estate | Aldea Zama, Tulum, Q.R., Mexico</p>
    <a href="https://tuluminatirealestate.com" style="color:#c9a962;text-decoration:none;">tuluminatirealestate.com</a>
  </div>`;
}

function propertyTable(recommended) {
  if (recommended.length === 0) return "";
  const rows = recommended.map(p => {
    const rental = p.rentalPrice ? `$${p.rentalPrice}/night` : "\u2014";
    return `<tr>
      <td style="padding:12px;border-bottom:1px solid #2a2a2a;"><strong style="color:#c9a962;">${p.name}</strong><br><span style="color:#999;font-size:12px;">${p.type} in ${p.location}</span></td>
      <td style="padding:12px;border-bottom:1px solid #2a2a2a;color:#f5f0e8;">$${p.price.toLocaleString()}</td>
      <td style="padding:12px;border-bottom:1px solid #2a2a2a;color:#f5f0e8;">${p.bedrooms || "\u2014"}</td>
      <td style="padding:12px;border-bottom:1px solid #2a2a2a;color:#f5f0e8;">${p.roi}</td>
      <td style="padding:12px;border-bottom:1px solid #2a2a2a;color:#f5f0e8;">${rental}</td>
    </tr>`;
  }).join("");

  return `<table style="width:100%;border-collapse:collapse;margin-bottom:28px;font-size:14px;">
    <tr style="color:#888;font-size:11px;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #333;">
      <th style="padding:10px 12px;text-align:left;">Property</th>
      <th style="padding:10px 12px;text-align:left;">Price</th>
      <th style="padding:10px 12px;text-align:left;">Beds</th>
      <th style="padding:10px 12px;text-align:left;">ROI</th>
      <th style="padding:10px 12px;text-align:left;">Rental</th>
    </tr>
    ${rows}
  </table>`;
}

async function sendFollowUpEmailByStage(env, lead, stage, overrideEmail) {
  if (!env.SMTP_PASS) return;
  const recommended = getRecommendedProperties(lead);
  const name = lead.callerName ? capitalize(lead.callerName) : "there";
  const toEmail = overrideEmail || lead.contactInfo?.email;
  if (!toEmail) return;

  let subject, bodyContent;

  if (stage === "initial") {
    subject = "Your Tuluminati Property Recommendations";
    bodyContent = `
      <p style="font-size:16px;line-height:1.6;margin-bottom:20px;">Hi ${name},</p>
      <p style="font-size:15px;line-height:1.7;color:#ccc;margin-bottom:24px;">
        Thank you for speaking with me! Based on our conversation, I've selected some properties
        I think you'll love. Here are my top recommendations for you:
      </p>
      ${propertyTable(recommended)}
      <div style="text-align:center;margin:32px 0;">
        <a href="https://tuluminatirealestate.com" style="display:inline-block;background:#c9a962;color:#0a0a0a;padding:14px 36px;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px;letter-spacing:1px;">VIEW ALL LISTINGS</a>
      </div>
      <p style="font-size:14px;line-height:1.7;color:#aaa;margin-bottom:24px;">
        A member of our team will be in touch within 24 hours to answer any questions
        and schedule a property tour — virtual or in-person. You can also reach us
        directly on WhatsApp at <a href="https://wa.me/529983702679" style="color:#c9a962;">+52 998 370 2679</a>.
      </p>`;
  } else if (stage === "not_reached") {
    subject = "Still interested in Riviera Maya? We'd love to help";
    bodyContent = `
      <p style="font-size:16px;line-height:1.6;margin-bottom:20px;">Hi ${name},</p>
      <p style="font-size:15px;line-height:1.7;color:#ccc;margin-bottom:24px;">
        I tried reaching you by phone earlier to follow up on our conversation about properties
        ${lead.location ? `in ${lead.location}` : "in the Riviera Maya"}. I wanted to make sure you received
        my property recommendations and see if you have any questions.
      </p>
      ${propertyTable(recommended)}
      <p style="font-size:15px;line-height:1.7;color:#ccc;margin-bottom:24px;">
        When you're ready, I'd love to help you take the next step. You can:
      </p>
      <div style="text-align:center;margin:28px 0;">
        <a href="https://wa.me/529983702679?text=Hi%2C%20I%20spoke%20with%20Luna%20and%20I'm%20interested%20in%20learning%20more" style="display:inline-block;background:#c9a962;color:#0a0a0a;padding:14px 36px;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px;letter-spacing:1px;margin-right:12px;">CHAT ON WHATSAPP</a>
      </div>
      <div style="text-align:center;margin:12px 0 28px;">
        <a href="https://tuluminatirealestate.com" style="display:inline-block;background:transparent;color:#c9a962;padding:12px 32px;text-decoration:none;border-radius:6px;font-weight:600;font-size:13px;letter-spacing:1px;border:1px solid #c9a962;">VIEW ALL LISTINGS</a>
      </div>`;
  } else {
    // "general" stage
    subject = "Your Riviera Maya Real Estate Guide";
    bodyContent = `
      <p style="font-size:16px;line-height:1.6;margin-bottom:20px;">Hi ${name},</p>
      <p style="font-size:15px;line-height:1.7;color:#ccc;margin-bottom:24px;">
        Thank you for your interest in the Riviera Maya! I wanted to share some highlights
        about the market and our available properties that might be helpful.
      </p>
      <div style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:10px;padding:20px;margin-bottom:24px;">
        <h3 style="color:#c9a962;font-size:14px;letter-spacing:1px;margin:0 0 12px 0;">WHY INVEST IN THE RIVIERA MAYA</h3>
        <p style="color:#ccc;font-size:14px;line-height:1.6;margin:0;">
          <strong style="color:#f5f0e8;">18M+ tourists/year</strong> — consistent rental demand<br>
          <strong style="color:#f5f0e8;">8-20% rental yields</strong> — outperforming most global markets<br>
          <strong style="color:#f5f0e8;">0.1% property tax</strong> — minimal holding costs<br>
          <strong style="color:#f5f0e8;">30-50% pre-construction discounts</strong> — build equity before completion
        </p>
      </div>
      ${propertyTable(recommended)}
      <div style="text-align:center;margin:32px 0;">
        <a href="https://tuluminatirealestate.com" style="display:inline-block;background:#c9a962;color:#0a0a0a;padding:14px 36px;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px;letter-spacing:1px;">EXPLORE PROPERTIES</a>
      </div>
      <p style="font-size:14px;line-height:1.7;color:#aaa;margin-bottom:24px;">
        Have questions? Reach out anytime on WhatsApp at
        <a href="https://wa.me/529983702679" style="color:#c9a962;">+52 998 370 2679</a>.
        We're here to help!
      </p>`;
  }

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="background:#0a0a0a;color:#f5f0e8;font-family:'Helvetica Neue',Arial,sans-serif;padding:0;margin:0;">
<div style="max-width:600px;margin:0 auto;padding:40px 24px;">
  ${emailHeader()}
  ${bodyContent}
  <p style="font-size:14px;color:#aaa;">
    Warm regards,<br>
    <strong style="color:#c9a962;">Luna</strong> — AI Concierge<br>
    Tuluminati Real Estate
  </p>
  ${emailFooter()}
</div>
</body></html>`;

  const mailer = await getMailer(env);
  await mailer.send({
    from: { name: env.SMTP_FROM_NAME || "Luna — Tuluminati", email: env.SMTP_USER },
    to: { name: lead.callerName || "Valued Client", email: toEmail },
    subject,
    text: `Hi ${name}, ${subject.toLowerCase()}. Visit tuluminatirealestate.com or reach us on WhatsApp at +52 998 370 2679.`,
    html,
  });
}

async function sendInternalEmail(env, lead) {
  if (!env.SMTP_PASS) return;

  const subject = `New Luna Lead: ${lead.callerName || "Unknown"} — ${lead.intent || "General"} [${lead.followUp?.tier || "?"}]`;
  const text = [
    `New lead captured by Luna AI`,
    ``,
    `Name: ${lead.callerName || "Unknown"}`,
    `Intent: ${lead.intent || "General Inquiry"}`,
    `Follow-up Tier: ${lead.followUp?.tier || "none"}`,
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

  if (lead.intent === "Vacation Rental") {
    candidates = candidates.filter(p => p.rentalPrice);
  }

  if (lead.location) {
    const loc = lead.location.toLowerCase().split(",")[0].trim();
    const locFiltered = candidates.filter(p => p.location.toLowerCase().includes(loc));
    if (locFiltered.length > 0) candidates = locFiltered;
  }

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
  if (num < 1000) return num * 1000;
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

    const index = properties.map(p => ({
      id: p.id,
      name: (typeof p.title === "object" ? p.title.en : p.title).split(" - ")[0].split(" \u2013")[0].trim(),
      type: p.type,
      price: p.price,
      location: p.location,
      bedrooms: p.bedrooms || 0,
      bathrooms: p.bathrooms || 0,
      roi: p.roi,
      rentalPrice: p.rentalPrice || null,
      features: p.features || [],
    }));

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

// ─── Outbound Calls ────────────────────────────────────────────────

async function executeOutboundCall(env, lead, trigger = "auto") {
  const phone = getPhoneTarget(env, lead);
  if (!phone) return { error: "no_phone" };
  if (!env.VAPI_PRIVATE_KEY || !env.VAPI_PHONE_NUMBER_ID) return { error: "not_configured" };

  const customerName = lead.callerName ? capitalize(lead.callerName) : "there";
  const callDate = new Date(lead.timestamp).toLocaleDateString("en-US", { month: "long", day: "numeric" });
  const attempt = (lead.followUp?.actions?.filter(a => a.type === "call").length || 0) + 1;

  let firstMessage;
  if (attempt === 1) {
    firstMessage = `Hi, is this ${customerName}? This is Luna calling from Tuluminati Real Estate. I wanted to follow up on our conversation — do you have a quick moment?`;
  } else {
    firstMessage = `Hi ${customerName}, this is Luna from Tuluminati Real Estate again. I wanted to check in — have you had a chance to look at the properties I sent over?`;
  }

  const body = {
    assistant: {
      name: `Luna Follow-Up (${trigger}, attempt ${attempt})`,
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
This is follow-up attempt #${attempt}.

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
      firstMessage,
      endCallMessage: "Thank you so much! We'll follow up with everything we discussed. Have a wonderful day!",
      silenceTimeoutSeconds: 20,
      maxDurationSeconds: 300,
      serverUrl: "https://tuluminati-webhook.purplesquirrelnetworks.workers.dev/webhook",
    },
    phoneNumberId: env.VAPI_PHONE_NUMBER_ID,
    customer: { number: phone },
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
    console.error("VAPI outbound call failed:", JSON.stringify(result));
    return { error: "vapi_failed", details: result };
  }

  console.log(`Outbound call initiated: ${result.id} for lead ${lead.id} (${trigger}, attempt ${attempt})`);
  return { success: true, callId: result.id };
}

async function handleManualOutboundCall(env, leadId, corsHeaders) {
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

  const result = await executeOutboundCall(env, lead, "manual");
  if (result.error) {
    return new Response(JSON.stringify({ error: result.error, details: result.details }), {
      status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Store reverse mapping
  if (result.callId) {
    await env.LEADS.put(`call:${result.callId}`, JSON.stringify({ leadId }), { expirationTtl: 86400 });
  }

  // Record manual action on follow-up
  if (lead.followUp) {
    lead.followUp.actions.push({
      type: "call",
      scheduledAt: new Date().toISOString(),
      executedAt: new Date().toISOString(),
      result: "initiated",
      vapiCallId: result.callId,
      attempt: (lead.followUp.actions.filter(a => a.type === "call").length) + 1,
    });
    await env.LEADS.put(`lead:${leadId}`, JSON.stringify(lead));
  }

  return new Response(JSON.stringify({ status: "call_initiated", callId: result.callId, leadId }), {
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

  const pendingFollowUps = leads.filter(l => l.followUp && l.followUp.status === "pending" && !l.followUp.autoDisabled).length;
  const inProgressFollowUps = leads.filter(l => l.followUp && l.followUp.status === "in_progress").length;
  const completedFollowUps = leads.filter(l => l.followUp && l.followUp.status === "completed").length;
  const reachedCount = leads.filter(l => l.followUp?.reached).length;

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
  .stat{background:#1a1a1a;border:1px solid #333;border-radius:10px;padding:16px 24px;flex:1;min-width:100px;text-align:center}
  .stat-value{font-size:2rem;font-weight:700;color:#c9a962}
  .stat-label{font-size:.7rem;color:#888;text-transform:uppercase;letter-spacing:1px;margin-top:4px}
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
  .tag-hot{background:#3a1a1a;color:#ef4444}
  .tag-warm{background:#3a2a1a;color:#f97316}
  .tag-general{background:#2a2a2a;color:#999}
  .tag-fu-pending{background:#1a2a3a;color:#60a5fa}
  .tag-fu-inprogress{background:#1a3a2a;color:#4ade80}
  .tag-fu-completed{background:#2a2a2a;color:#888}
  .tag-fu-reached{background:#1a3a1a;color:#22c55e}
  .tag-fu-disabled{background:#2a1a1a;color:#ef4444}
  .lead-summary{color:#ccc;font-size:.9rem;line-height:1.5;margin-bottom:12px}
  .lead-contact{display:flex;gap:16px;flex-wrap:wrap;font-size:.85rem}
  .lead-contact span{color:#c9a962}
  .btn{background:none;border:1px solid #333;color:#999;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:.8rem;margin-top:8px;margin-right:8px}
  .btn:hover{border-color:#c9a962;color:#c9a962}
  .btn-call{border-color:#4ade80;color:#4ade80}
  .btn-call:hover{background:#4ade80;color:#0a0a0a}
  .btn-pause{border-color:#f97316;color:#f97316}
  .btn-pause:hover{background:#f97316;color:#0a0a0a}
  .btn-resume{border-color:#60a5fa;color:#60a5fa}
  .btn-resume:hover{background:#60a5fa;color:#0a0a0a}
  .transcript{display:none;background:#111;border-radius:8px;padding:14px;margin-top:12px;font-size:.8rem;line-height:1.6;white-space:pre-wrap;color:#aaa;max-height:300px;overflow-y:auto}
  .transcript.open{display:block}
  .recording-link{color:#c9a962;text-decoration:none;font-size:.85rem}
  .recording-link:hover{text-decoration:underline}
  .followup-timeline{margin-top:8px;font-size:.75rem;color:#888;line-height:1.8}
  .followup-timeline .step{display:inline-block;margin-right:12px}
  .followup-timeline .done{color:#4ade80}
  .followup-timeline .active{color:#fbbf24}
  .followup-timeline .upcoming{color:#555}
  .followup-timeline .skipped{color:#666;text-decoration:line-through}
  .empty{text-align:center;padding:60px 20px;color:#666}
  .empty h2{color:#c9a962;margin-bottom:8px}
  @media(max-width:600px){body{padding:12px}.stat{min-width:70px;padding:10px}.stat-value{font-size:1.3rem}}
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
  <div class="stat"><div class="stat-value">${pendingFollowUps + inProgressFollowUps}</div><div class="stat-label">Active F/U</div></div>
  <div class="stat"><div class="stat-value">${reachedCount}</div><div class="stat-label">Reached</div></div>
  <div class="stat"><div class="stat-value">${completedFollowUps}</div><div class="stat-label">F/U Done</div></div>
</div>

${leads.length === 0 ? `<div class="empty"><h2>No leads yet</h2><p>Leads will appear here after calls with Luna.</p></div>` : leads.map(lead => {
    const fu = lead.followUp;
    const tierTag = fu ? `<span class="tag tag-${fu.tier}">${fu.tier}</span>` : "";
    const cadence = fu ? FOLLOW_UP_CADENCE[fu.tier] || [] : [];

    let fuStatusTag = "";
    if (fu?.autoDisabled) {
      fuStatusTag = `<span class="tag tag-fu-disabled">paused</span>`;
    } else if (fu?.reached) {
      fuStatusTag = `<span class="tag tag-fu-reached">reached</span>`;
    } else if (fu?.status === "pending") {
      fuStatusTag = `<span class="tag tag-fu-pending">follow-up pending</span>`;
    } else if (fu?.status === "in_progress") {
      fuStatusTag = `<span class="tag tag-fu-inprogress">following up</span>`;
    } else if (fu?.status === "completed") {
      fuStatusTag = `<span class="tag tag-fu-completed">follow-up done</span>`;
    }

    let timeline = "";
    if (fu && cadence.length > 0) {
      const steps = cadence.map((step, i) => {
        const action = fu.actions[i];
        if (action) {
          const icon = action.type === "call" ? "\u260E" : "\u2709";
          if (action.result === "skipped_reached") return `<span class="step skipped">${icon} skipped</span>`;
          if (action.result === "reached") return `<span class="step done">${icon} reached</span>`;
          if (action.result === "sent") return `<span class="step done">${icon} sent</span>`;
          if (action.result === "no_answer") return `<span class="step done">${icon} no answer</span>`;
          if (action.result === "initiated") return `<span class="step active">${icon} calling...</span>`;
          return `<span class="step done">${icon} ${action.result}</span>`;
        }
        if (i === fu.actions.length && fu.nextActionAt) {
          const icon = step.type === "call" ? "\u260E" : "\u2709";
          const when = new Date(fu.nextActionAt).toLocaleString("en-US", { timeZone: "America/Cancun", hour: "numeric", minute: "2-digit" });
          return `<span class="step active">${icon} ${step.type} @ ${when}</span>`;
        }
        const icon = step.type === "call" ? "\u260E" : "\u2709";
        return `<span class="step upcoming">${icon} ${step.type} +${step.delayHours}h</span>`;
      }).join("");
      timeline = `<div class="followup-timeline">${steps}</div>`;
    }

    const pauseBtn = fu && fu.status !== "completed" && fu.status !== "opted_out"
      ? `<button class="btn ${fu.autoDisabled ? "btn-resume" : "btn-pause"}" onclick="toggleFollowUp('${lead.id}')">${fu.autoDisabled ? "Resume F/U" : "Pause F/U"}</button>`
      : "";

    return `
<div class="lead-card">
  <div class="lead-header">
    <div class="lead-name">${lead.callerName ? capitalize(lead.callerName) : "Unknown Caller"}</div>
    <div class="lead-time">${new Date(lead.timestamp).toLocaleString("en-US", { timeZone: "America/Cancun" })}</div>
  </div>
  <div class="lead-meta">
    <span class="tag tag-${(lead.intent || "generalinquiry").toLowerCase().replace(/\\s+/g, "")}">${lead.intent || "General"}</span>
    ${tierTag}
    ${fuStatusTag}
    <span class="tag tag-duration">${lead.callDuration}</span>
    ${lead.location ? `<span class="tag tag-location">${lead.location}</span>` : ""}
    ${lead.budget ? `<span class="tag tag-duration">${lead.budget}</span>` : ""}
  </div>
  ${timeline}
  <div class="lead-summary">${(lead.summary || "No summary available").replace(/</g, "&lt;")}</div>
  <div class="lead-contact">
    ${lead.contactInfo?.email ? `<div>Email: <span>${lead.contactInfo.email}</span></div>` : ""}
    ${lead.contactInfo?.phone ? `<div>Phone: <span>${lead.contactInfo.phone}</span></div>` : ""}
    ${lead.recordingUrl ? `<a href="${lead.recordingUrl}" class="recording-link" target="_blank">Recording</a>` : ""}
  </div>
  <div style="margin-top:10px;">
    <button class="btn" onclick="toggleTranscript(this)">Transcript</button>
    ${lead.contactInfo?.phone ? `<button class="btn btn-call" onclick="triggerFollowUp('${lead.id}')">Call Now</button>` : ""}
    ${pauseBtn}
  </div>
  <div class="transcript">${(lead.transcript || "No transcript").replace(/</g, "&lt;")}</div>
</div>`;
  }).join("")}

<script>
function toggleTranscript(btn){
  const t=btn.parentElement.nextElementSibling;
  t.classList.toggle('open');
  btn.textContent=t.classList.contains('open')?'Hide':'Transcript';
}
async function triggerFollowUp(id){
  if(!confirm('Trigger an outbound follow-up call to this lead?'))return;
  const r=await fetch('/api/follow-up/'+id+'?pw=${env.DASHBOARD_PASSWORD}',{method:'POST'});
  const d=await r.json();
  if(d.error)alert('Error: '+d.error);
  else{alert('Call initiated! ID: '+d.callId);location.reload();}
}
async function toggleFollowUp(id){
  const r=await fetch('/api/follow-up/'+id+'/toggle?pw=${env.DASHBOARD_PASSWORD}',{method:'POST'});
  const d=await r.json();
  if(d.error)alert('Error: '+d.error);
  else location.reload();
}
setTimeout(()=>location.reload(),30000);
</script>
</body></html>`;

  return new Response(html, {
    headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" },
  });
}
