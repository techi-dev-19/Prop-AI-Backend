// const OutboundJob = require("../../models/OutboundJob");
// const Lead = require("../../models/Lead");
// const Conversation = require("../../models/Conversation");
// const Notification = require("../../models/Notification");
// const Campaign = require("../../models/Campaign");

// const conversationEngine = require("../ai/conversationEngine");
// const settingsService = require("../settings/settingsService");
// const { sendCampaignEmail, getFromAddress, makeReplyAddress } = require("../email/mailer");
// const EmailMessage = require("../../models/EmailMessage");
// const crypto = require("crypto");
// const {
//   CHANNELS,
//   getCampaignStats,
//   getBatchStats,
//   recoverStuckJobs,
// } = require("./outboundQueue");
// const { emitToUser } = require("../../sockets");
// const logger = require("../../utils/logger");

// /**
//  * Bulk outreach worker (WhatsApp + Email).
//  *
//  * - Ek hi loop, ek time par SIRF ek message. Isliye frontend par bhi
//  *   "ek complete hua, ab doosra shuru" wala flow dikhta hai.
//  * - Same din ke jobs mein WhatsApp pehle chalta hai, Email baad mein
//  *   (claim sort: nextRunAt -> priority -> seq).
//  * - Per-day scheduling: job tabhi uthta hai jab `nextRunAt <= now`.
//  * - Jobs DB mein hain, isliye restart/crash par kuch nahi khota.
//  * - Har channel ka apna pause hai: WhatsApp rate-limit ho to Email chalta rahega.
//  *
//  * Error kinds:
//  *     rate_limit  -> channel 1 min rukta hai, attempt burn nahi
//  *     quota       -> channel 1 ghanta rukta hai (e.g. provider daily limit)
//  *     fatal_pause -> token/auth/config problem: channel 10 min rukta hai
//  *     retry       -> temporary problem: backoff ke saath retry (attempt burn hota hai)
//  *     permanent   -> number/email invalid etc: job seedha 'failed'
//  *
//  * Tuning (.env, optional):
//  *   BULK_SEND_INTERVAL_MS=1000        WhatsApp: do messages ke beech ka gap
//  *   BULK_EMAIL_INTERVAL_MS=2000       Email: do emails ke beech ka gap
//  */

// const SEND_INTERVAL_MS = {
//   whatsapp: parseInt(process.env.BULK_SEND_INTERVAL_MS || "1000", 10),
//   email: parseInt(process.env.BULK_EMAIL_INTERVAL_MS || "2000", 10),
// };
// const IDLE_POLL_MS = 2000;
// const PAUSE_MS = {
//   rate_limit: 60 * 1000,
//   fatal_pause: 10 * 60 * 1000,
//   quota: 60 * 60 * 1000,
// };
// const RETRY_BACKOFF_MS = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000];
// const RECOVER_EVERY_MS = 60 * 1000;

// // Meta error codes (https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes)
// const RATE_LIMIT_CODES = new Set(["130429", "131056", "80007", "4"]);
// const FATAL_PAUSE_CODES = new Set([
//   "190", // access token invalid/expired
//   "102", // session/token problem
//   "10", // permission denied
//   "131042", // payment / business eligibility problem
//   "131031", // account locked
//   "131048", // spam rate limit hit
//   "133010", // phone number not registered
//   "META_NOT_CONFIGURED",
//   "OPENING_TEMPLATE_MISSING",
// ]);
// const TEMP_RETRY_CODES = new Set(["131000", "131016", "131057"]);
// const NETWORK_ERROR_CODES = new Set([
//   "ECONNABORTED",
//   "ETIMEDOUT",
//   "ECONNRESET",
//   "ENOTFOUND",
//   "EAI_AGAIN",
//   "ECONNECTION",
//   "ESOCKET",
//   "ECONNREFUSED",
//   "EDNS",
// ]);

// let running = false;
// let lastRecoverAt = 0;
// const pausedUntil = { whatsapp: 0, email: 0 }; // channel-wise pause (timestamp ms)
// const lastPauseNotifyAt = { whatsapp: 0, email: 0 };
// const notifiedBatches = new Set(); // purane (campaign-less) batches ke liye

// const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// /* ------------------------------------------------------------------ */
// /* Error classification                                                */
// /* ------------------------------------------------------------------ */

// function classifyWhatsAppError(err) {
//   const code = String(err?.metaError?.code ?? err?.code ?? "");
//   const status = err?.response?.status;

//   if (RATE_LIMIT_CODES.has(code) || status === 429) return "rate_limit";
//   if (FATAL_PAUSE_CODES.has(code)) return "fatal_pause";
//   if (TEMP_RETRY_CODES.has(code)) return "retry";
//   if (NETWORK_ERROR_CODES.has(code)) return "retry";
//   if (status >= 500) return "retry";
//   if (!err?.response && !err?.metaError && !code) return "retry"; // unknown/network type error
//   return "permanent";
// }

// function classifyEmailError(err) {
//   const code = String(err?.code ?? "");
//   const status = Number(err?.status || err?.response?.status || err?.responseCode || 0);
//   const msg = String(err?.response?.data?.message || err?.message || err?.response || "").toLowerCase();

//   if (["BREVO_NOT_CONFIGURED", "BREVO_AUTH_ERROR", "SMTP_NOT_CONFIGURED", "EAUTH"].includes(code) || status === 401 || status === 403) {
//     return "fatal_pause";
//   }
//   if (code === "BREVO_INVALID_RECIPIENT" || code === "BREVO_INVALID_RESPONSE") return "permanent";
//   if (status === 429 || code === "BREVO_RATE_LIMIT" || /quota|rate limit|too many|daily user sending|sending limit/.test(msg)) {
//     return "quota";
//   }
//   if (["EENVELOPE", "EMESSAGE"].includes(code)) return "permanent";
//   if (status >= 500) return "retry";
//   if (status >= 400) return status === 408 ? "retry" : "permanent";
//   if (NETWORK_ERROR_CODES.has(code) || code.startsWith("E")) return "retry";
//   return "retry";
// }

// function shortError(err) {
//   const msg = err?.metaError?.message || err?.message || "Unknown error";
//   return String(msg).slice(0, 500);
// }

// const errCode = (err) =>
//   String(err?.metaError?.code ?? err?.code ?? "") || null;

// /* ------------------------------------------------------------------ */
// /* Job state helpers                                                   */
// /* ------------------------------------------------------------------ */

// /** Atomic claim: do worker kabhi same job nahi uthayenge */
// async function claimNext(channels) {
//   return OutboundJob.findOneAndUpdate(
//     {
//       status: "pending",
//       channel: { $in: channels },
//       nextRunAt: { $lte: new Date() },
//     },
//     {
//       $set: { status: "processing", lockedAt: new Date() },
//       $inc: { attempts: 1 },
//     },
//     { sort: { nextRunAt: 1, priority: 1, seq: 1 }, new: true },
//   );
// }

// async function markSent(job) {
//   await OutboundJob.updateOne(
//     { _id: job._id },
//     {
//       $set: {
//         status: "sent",
//         sentAt: new Date(),
//         lockedAt: null,
//         lastError: null,
//         lastErrorCode: null,
//       },
//     },
//   );
// }

// async function markFailed(job, err, reason) {
//   await OutboundJob.updateOne(
//     { _id: job._id },
//     {
//       $set: {
//         status: "failed",
//         lockedAt: null,
//         lastError: reason || shortError(err),
//         lastErrorCode: err ? errCode(err) : null,
//       },
//     },
//   );
// }

// async function markCancelled(job, reason) {
//   await OutboundJob.updateOne(
//     { _id: job._id },
//     { $set: { status: "cancelled", lockedAt: null, lastError: reason } },
//   );
// }

// /** Job ko dobara pending karta hai (retry / channel pause ke liye) */
// async function requeue(job, err, delayMs, { burnAttempt }) {
//   await OutboundJob.updateOne(
//     { _id: job._id },
//     {
//       $set: {
//         status: "pending",
//         lockedAt: null,
//         nextRunAt: new Date(Date.now() + delayMs),
//         lastError: shortError(err),
//         lastErrorCode: errCode(err),
//       },
//       // claim par attempts +1 ho chuka hai; pause wale errors mein wapas kam kar do
//       ...(burnAttempt ? {} : { $inc: { attempts: -1 } }),
//     },
//   );
// }

// /* ------------------------------------------------------------------ */
// /* Realtime events + notifications                                     */
// /* ------------------------------------------------------------------ */

// /** Frontend ko batata hai ki ye job abhi kis state mein hai (ek-ek karke) */
// function emitJob(job, lead) {
//   emitToUser(job.ownerId, "outreach:job", {
//     jobId: String(job._id),
//     campaignId: job.campaignId ? String(job.campaignId) : null,
//     leadId: String(job.leadId),
//     channel: job.channel || "whatsapp",
//     status: job.status,
//     attempts: job.attempts,
//     sentAt: job.sentAt || null,
//     nextRunAt: job.nextRunAt,
//     lastError: job.lastError || null,
//     ...(lead
//       ? { name: lead.name, phone: lead.phone, email: lead.email || "" }
//       : {}),
//   });
// }

// async function emitCampaignProgress(job) {
//   if (!job.campaignId) return null;
//   try {
//     const stats = await getCampaignStats(job.campaignId);
//     emitToUser(job.ownerId, "outreach:progress", {
//       campaignId: String(job.campaignId),
//       stats,
//     });
//     return stats;
//   } catch (err) {
//     logger.warn("[queue] Could not emit campaign progress", {
//       error: err.message,
//     });
//     return null;
//   }
// }

// async function notify(ownerId, payload) {
//   try {
//     await Notification.create({ userId: ownerId, ...payload });
//     emitToUser(ownerId, "notification:new", {});
//   } catch (err) {
//     logger.warn("[queue] Could not create notification", { error: err.message });
//   }
// }

// const isFinished = (s) => s.pending + s.processing + s.paused === 0;

// /** Campaign (ya purana batch) poora khatam ho jaye to ek summary notification */
// async function checkCompletion(job, stats) {
//   if (job.campaignId) {
//     if (!stats) return;
//     if (!CHANNELS.every((ch) => isFinished(stats[ch]))) return;

//     // Atomic: sirf ek hi baar 'active' -> 'completed' hoga (restart-safe)
//     const done = await Campaign.findOneAndUpdate(
//       { _id: job.campaignId, status: "active" },
//       { $set: { status: "completed", completedAt: new Date() } },
//       { new: true },
//     );
//     if (!done) return;

//     const sent = stats.whatsapp.sent + stats.email.sent;
//     const failed = stats.whatsapp.failed + stats.email.failed;
//     emitToUser(job.ownerId, "outreach:campaign", {
//       campaignId: String(done._id),
//       status: "completed",
//     });
//     await notify(job.ownerId, {
//       type: "bulk_batch_done",
//       title: `Campaign "${done.name}" complete — ${sent} sent`,
//       body:
//         `WhatsApp: ${stats.whatsapp.sent}/${stats.whatsapp.total}, ` +
//         `Email: ${stats.email.sent}/${stats.email.total}.` +
//         (failed ? ` ${failed} fail hue — retry kar sakte ho.` : ""),
//       link: "/outreach/whatsapp",
//     });
//     return;
//   }

//   // Purana batch (single lead / manual start)
//   if (notifiedBatches.has(job.batchId)) return;
//   const s = await getBatchStats(job.batchId);
//   if (s.pending > 0 || s.processing > 0 || s.paused > 0) return;
//   notifiedBatches.add(job.batchId);
//   await notify(job.ownerId, {
//     type: "bulk_batch_done",
//     title: `Bulk messaging complete — ${s.sent}/${s.total} sent`,
//     body: s.failed
//       ? `${s.failed} lead(s) failed. Outreach page se retry kar sakte ho.`
//       : "Sab messages successfully chale gaye.",
//     link: "/outreach/whatsapp",
//   });
// }

// async function notifyPause(job, err, channel, kind) {
//   // 10 min mein ek hi baar per channel, warna notification spam ho jayega
//   if (Date.now() - lastPauseNotifyAt[channel] < PAUSE_MS.fatal_pause) return;
//   lastPauseNotifyAt[channel] = Date.now();

//   const minutes = Math.round(PAUSE_MS[kind] / 60000);
//   const label = channel === "email" ? "Email" : "WhatsApp";
//   await notify(job.ownerId, {
//     type: "whatsapp_send_failed",
//     title: `Bulk ${label} paused — ${label} problem`,
//     body:
//       `${label} error: ${shortError(err)}. ${label} sending ${minutes} minute ke liye ruka hai, ` +
//       `jobs safe hain.` +
//       (channel === "email"
//         ? " BREVO_API_KEY, BREVO_FROM_EMAIL, authenticated domain aur Brevo rate limit check karo."
//         : " Token/payment/template check karo."),
//     link: channel === "email" ? "/outreach/email" : "/whatsapp",
//   });
// }

// /* ------------------------------------------------------------------ */
// /* Channel processors                                                  */
// /* ------------------------------------------------------------------ */

// async function processWhatsApp(job, lead) {
//   const conversation = lead
//     ? await Conversation.findOne({ leadId: job.leadId })
//     : null;

//   if (!lead || !conversation) {
//     await markFailed(job, null, "Lead ya conversation delete ho chuka hai");
//     return;
//   }

//   const campaign = job.campaignId
//     ? await Campaign.findOne({ _id: job.campaignId, ownerId: job.ownerId }).lean()
//     : null;
//   const template = campaign?.whatsappTemplate?.name
//     ? {
//         name: campaign.whatsappTemplate.name,
//         language: campaign.whatsappTemplate.language,
//         variables: campaign.whatsappTemplate.variables || [],
//         headerImageUrl: campaign.whatsappTemplate.headerImageUrl || "",
//         body: campaign.whatsappTemplate.body || "",
//         header: campaign.whatsappTemplate.header || "",
//         footer: campaign.whatsappTemplate.footer || "",
//         buttons: campaign.whatsappTemplate.buttons || [],
//       }
//     : null;

//   const result = await conversationEngine.startConversation({
//     lead,
//     conversation,
//     templateOverride: template,
//     outboundJobId: template ? job._id : null,
//   });

//   if (result?.sent || result?.reason === "already_started") {
//     await markSent(job);
//     return;
//   }

//   if (result?.skipped) {
//     // AI pause ya WhatsApp disconnect: job 'paused' kar do, broker resume kar lega
//     if (
//       result.reason === "ai_paused" ||
//       result.reason === "whatsapp_disconnected"
//     ) {
//       await OutboundJob.updateOne(
//         { _id: job._id },
//         {
//           $set: {
//             status: "paused",
//             lockedAt: null,
//             lastError: `Skipped: ${result.reason}`,
//           },
//           $inc: { attempts: -1 },
//         },
//       );
//       return;
//     }
//     // not_ai_active (manual/closed): ab message bhejna sahi nahi
//     await markCancelled(job, `Skipped: ${result.reason}`);
//     return;
//   }

//   await markSent(job);
// }

// async function processEmail(job, lead) {
//   if (!lead) {
//     await markFailed(job, null, "Lead delete ho chuka hai");
//     return;
//   }
//   if (!lead.email) {
//     await markFailed(job, null, "Is lead ka email address nahi hai");
//     return;
//   }

//   const campaign = job.campaignId ? await Campaign.findById(job.campaignId).lean() : null;
//   if (!campaign || !campaign.email?.subject || !campaign.email?.body) {
//     await markFailed(job, null, "Campaign ka email subject/body missing hai");
//     return;
//   }
//   if (campaign.status === "cancelled") {
//     await markCancelled(job, "Campaign cancel ho gaya");
//     return;
//   }

//   const settings = await settingsService.getOrCreateSettings();
//   let tracked = await EmailMessage.findOne({ outboundJobId: job._id });
//   if (tracked?.status === "cancelled") {
//     await markCancelled(job, "Campaign email cancelled");
//     return;
//   }
//   if (tracked && ["sent", "delivered", "delivery_delayed", "bounced", "complained", "suppressed"].includes(tracked.status)) {
//     // Provider already accepted this idempotent job. Don't send it again after
//     // a worker restart/webhook race.
//     await markSent(job);
//     return;
//   }
//   if (!tracked) {
//     tracked = new EmailMessage({
//       ownerId: job.ownerId,
//       leadId: lead._id,
//       campaignId: campaign._id,
//       outboundJobId: job._id,
//       direction: "outbound",
//       kind: "campaign",
//       trackingId: crypto.randomBytes(16).toString("hex"),
//       from: getFromAddress(),
//       to: lead.email,
//       subject: campaign.email.subject,
//       text: campaign.email.body,
//       status: "queued",
//       replyStatus: "waiting",
//     });
//     await tracked.save();
//     tracked.threadId = tracked._id;
//     await tracked.save();
//   }

//   try {
//     tracked.status = "sending";
//     tracked.errorCode = null;
//     tracked.errorMessage = null;
//     await tracked.save();

//     const sent = await sendCampaignEmail({
//       to: lead.email,
//       subject: campaign.email.subject,
//       body: campaign.email.body,
//       imageUrl: campaign.email.imageUrl || "",
//       companyName: settings.companyName || "",
//       replyTo: makeReplyAddress(tracked.trackingId),
//       idempotencyKey: `propai-campaign-${job._id}`,
//       tags: [
//         { name: "product", value: "propai" },
//         { name: "channel", value: "campaign" },
//         { name: "propai_job_id", value: String(job._id) },
//         { name: "propai_message_id", value: String(tracked._id) },
//       ],
//       vars: {
//         name: lead.name,
//         firstName: String(lead.name || "").trim().split(/\s+/)[0],
//         phone: lead.phone || "",
//         city: lead.city || "",
//         company: settings.companyName || "",
//       },
//     });

//     // Do not overwrite a faster delivery webhook (delivered/bounced/etc).
//     await EmailMessage.updateOne(
//       { _id: tracked._id },
//       { $set: { providerMessageId: sent.providerMessageId, rfcMessageId: sent.rfcMessageId || sent.providerMessageId, sentAt: tracked.sentAt || new Date(), from: getFromAddress() || tracked.from } },
//     );
//     await EmailMessage.updateOne(
//       { _id: tracked._id, status: { $in: ["queued", "sending"] } },
//       { $set: { status: "sent" } },
//     );
//     await markSent(job);
//   } catch (err) {
//     await EmailMessage.updateOne(
//       { _id: tracked._id, status: { $in: ["queued", "sending"] } },
//       { $set: { status: "failed", errorCode: String(err.code || "EMAIL_SEND_FAILED"), errorMessage: String(err.message || "Email send failed").slice(0, 500) } },
//     ).catch((saveErr) => logger.error("[email] Could not persist failed send", { error: saveErr.message }));
//     throw err;
//   }
// }

// /** Ek job process karta hai. Lead return karta hai (events mein naam bhejne ke liye). */
// async function processJob(job) {
//   const channel = job.channel || "whatsapp";
//   const lead = await Lead.findById(job.leadId);

//   // Frontend: "ab ye lead bheji ja rahi hai" (spinner)
//   emitJob(job, lead);

//   try {
//     if (channel === "email") await processEmail(job, lead);
//     else await processWhatsApp(job, lead);
//   } catch (err) {
//     await handleError(job, err, channel);
//   }
//   return lead;
// }

// async function handleError(job, err, channel) {
//   const kind =
//     channel === "email" ? classifyEmailError(err) : classifyWhatsAppError(err);

//   if (PAUSE_MS[kind]) {
//     pausedUntil[channel] = Date.now() + PAUSE_MS[kind];
//     logger.warn(
//       `[queue] ${channel} ${kind} — channel ${Math.round(PAUSE_MS[kind] / 60000)} min ke liye ruk raha hai`,
//       { error: shortError(err), code: errCode(err) },
//     );
//     // delay 0: order bacha rehta hai; pausedUntil is channel ko rok ke rakhta hai
//     await requeue(job, err, 0, { burnAttempt: false });
//     if (kind !== "rate_limit") await notifyPause(job, err, channel, kind);
//     return;
//   }

//   if (kind === "retry") {
//     if (job.attempts >= job.maxAttempts) {
//       await markFailed(job, err, `Max attempts reached: ${shortError(err)}`);
//       return;
//     }
//     const delay =
//       RETRY_BACKOFF_MS[Math.min(job.attempts - 1, RETRY_BACKOFF_MS.length - 1)];
//     await requeue(job, err, delay, { burnAttempt: true });
//     return;
//   }

//   // permanent
//   await markFailed(job, err);
// }

// /* ------------------------------------------------------------------ */
// /* Main loop                                                           */
// /* ------------------------------------------------------------------ */

// async function loop() {
//   while (running) {
//     try {
//       // Periodically stuck jobs recover karo
//       if (Date.now() - lastRecoverAt > RECOVER_EVERY_MS) {
//         lastRecoverAt = Date.now();
//         const recovered = await recoverStuckJobs();
//         if (recovered)
//           logger.warn(`[queue] ${recovered} stuck job(s) wapas pending kiye`);
//       }

//       // Jo channels abhi paused nahi hain, sirf unhi ke jobs uthao
//       const now = Date.now();
//       const allowed = CHANNELS.filter((ch) => now >= pausedUntil[ch]);
//       if (!allowed.length) {
//         await sleep(IDLE_POLL_MS);
//         continue;
//       }

//       const job = await claimNext(allowed);
//       if (!job) {
//         await sleep(IDLE_POLL_MS);
//         continue;
//       }

//       const lead = await processJob(job);

//       // Final state (sent / failed / retry / paused) ek event mein
//       const fresh = await OutboundJob.findById(job._id).lean();
//       if (fresh) {
//         emitJob(fresh, lead);
//         const stats = await emitCampaignProgress(fresh);
//         await checkCompletion(fresh, stats);
//       }

//       // Do messages ke beech gap (+ thoda random jitter, bot jaisa na lage)
//       const gap = SEND_INTERVAL_MS[job.channel || "whatsapp"];
//       await sleep(gap + Math.floor(Math.random() * 300));
//     } catch (err) {
//       logger.error("[queue] Worker loop error", { error: err.message });
//       await sleep(5000); // crash-loop se bachne ke liye
//     }
//   }
//   logger.info("[queue] Bulk worker stopped");
// }

// async function startBulkWorker() {
//   if (running) return;
//   running = true;

//   try {
//     // Pre-campaign jobs ko 'whatsapp' channel de do (naye claim query ke liye)
//     const migrated = await OutboundJob.updateMany(
//       { channel: { $exists: false } },
//       { $set: { channel: "whatsapp", priority: 0 } },
//     );
//     if (migrated.modifiedCount)
//       logger.info(
//         `[queue] ${migrated.modifiedCount} purane job(s) ko channel=whatsapp set kiya`,
//       );

//     const recovered = await recoverStuckJobs(0); // boot par saare 'processing' jobs purane hain
//     if (recovered)
//       logger.warn(
//         `[queue] Boot recovery: ${recovered} job(s) wapas pending kiye`,
//       );
//   } catch (err) {
//     logger.error("[queue] Boot recovery failed", { error: err.message });
//   }

//   lastRecoverAt = Date.now();
//   logger.info(
//     `[queue] Bulk worker started (whatsapp ~${SEND_INTERVAL_MS.whatsapp}ms, email ~${SEND_INTERVAL_MS.email}ms)`,
//   );
//   loop(); // background mein chalta rahega (await nahi)
// }

// function stopBulkWorker() {
//   running = false;
// }

// module.exports = { startBulkWorker, stopBulkWorker };

const OutboundJob = require("../../models/OutboundJob");
const Lead = require("../../models/Lead");
const Conversation = require("../../models/Conversation");
const Notification = require("../../models/Notification");
const Campaign = require("../../models/Campaign");

const conversationEngine = require("../ai/conversationEngine");
const settingsService = require("../settings/settingsService");
const {
  sendCampaignEmail,
  getFromAddress,
  makeReplyAddress,
} = require("../email/mailer");
const EmailMessage = require("../../models/EmailMessage");
const crypto = require("crypto");
const {
  CHANNELS,
  getCampaignStats,
  getBatchStats,
  recoverStuckJobs,
} = require("./outboundQueue");
const { emitToUser } = require("../../sockets");
const logger = require("../../utils/logger");

/**
 * Bulk outreach worker (WhatsApp + Email).
 *
 * - Ek hi loop, ek time par SIRF ek message. Isliye frontend par bhi
 *   "ek complete hua, ab doosra shuru" wala flow dikhta hai.
 * - Same din ke jobs mein WhatsApp pehle chalta hai, Email baad mein
 *   (claim sort: nextRunAt -> priority -> seq).
 * - Per-day scheduling: job tabhi uthta hai jab `nextRunAt <= now`.
 * - Jobs DB mein hain, isliye restart/crash par kuch nahi khota.
 * - Har channel ka apna pause hai: WhatsApp rate-limit ho to Email chalta rahega.
 *
 * Error kinds:
 *     rate_limit  -> channel 1 min rukta hai, attempt burn nahi
 *     quota       -> channel 1 ghanta rukta hai (e.g. provider daily limit)
 *     fatal_pause -> token/auth/config problem: channel 10 min rukta hai
 *     retry       -> temporary problem: backoff ke saath retry (attempt burn hota hai)
 *     permanent   -> number/email invalid etc: job seedha 'failed'
 *
 * Tuning (.env, optional):
 *   BULK_SEND_INTERVAL_MS=1000        WhatsApp: do messages ke beech ka gap
 *   BULK_EMAIL_INTERVAL_MS=2000       Email: do emails ke beech ka gap
 */

const SEND_INTERVAL_MS = {
  whatsapp: parseInt(process.env.BULK_SEND_INTERVAL_MS || "1000", 10),
  email: parseInt(process.env.BULK_EMAIL_INTERVAL_MS || "2000", 10),
};
const IDLE_POLL_MS = 2000;
const PAUSE_MS = {
  rate_limit: 60 * 1000,
  fatal_pause: 10 * 60 * 1000,
  quota: 60 * 60 * 1000,
};
const RETRY_BACKOFF_MS = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000];
const RECOVER_EVERY_MS = 60 * 1000;

// Meta error codes (https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes)
const RATE_LIMIT_CODES = new Set(["130429", "131056", "80007", "4"]);
const FATAL_PAUSE_CODES = new Set([
  "190", // access token invalid/expired
  "102", // session/token problem
  "10", // permission denied
  "131042", // payment / business eligibility problem
  "131031", // account locked
  "131048", // spam rate limit hit
  "133010", // phone number not registered
  "META_NOT_CONFIGURED",
  "OPENING_TEMPLATE_MISSING",
]);
const TEMP_RETRY_CODES = new Set(["131000", "131016", "131057"]);
const NETWORK_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ETIMEDOUT",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNECTION",
  "ESOCKET",
  "ECONNREFUSED",
  "EDNS",
]);

let running = false;
let lastRecoverAt = 0;
const pausedUntil = { whatsapp: 0, email: 0 }; // channel-wise pause (timestamp ms)
const lastPauseNotifyAt = { whatsapp: 0, email: 0 };
const notifiedBatches = new Set(); // purane (campaign-less) batches ke liye

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
/* Error classification                                                */
/* ------------------------------------------------------------------ */

function classifyWhatsAppError(err) {
  const code = String(err?.metaError?.code ?? err?.code ?? "");
  const status = err?.response?.status;

  if (RATE_LIMIT_CODES.has(code) || status === 429) return "rate_limit";
  if (FATAL_PAUSE_CODES.has(code)) return "fatal_pause";
  if (TEMP_RETRY_CODES.has(code)) return "retry";
  if (NETWORK_ERROR_CODES.has(code)) return "retry";
  if (status >= 500) return "retry";
  if (!err?.response && !err?.metaError && !code) return "retry"; // unknown/network type error
  return "permanent";
}

function classifyEmailError(err) {
  const code = String(err?.code ?? "");
  const status = Number(
    err?.status || err?.response?.status || err?.responseCode || 0,
  );
  const msg = String(
    err?.response?.data?.message || err?.message || err?.response || "",
  ).toLowerCase();

  if (
    [
      "BREVO_NOT_CONFIGURED",
      "BREVO_AUTH_ERROR",
      "SMTP_NOT_CONFIGURED",
      "EAUTH",
    ].includes(code) ||
    status === 401 ||
    status === 403
  ) {
    return "fatal_pause";
  }
  if (code === "BREVO_INVALID_RECIPIENT" || code === "BREVO_INVALID_RESPONSE")
    return "permanent";
  if (
    status === 429 ||
    code === "BREVO_RATE_LIMIT" ||
    /quota|rate limit|too many|daily user sending|sending limit/.test(msg)
  ) {
    return "quota";
  }
  if (["EENVELOPE", "EMESSAGE"].includes(code)) return "permanent";
  if (status >= 500) return "retry";
  if (status >= 400) return status === 408 ? "retry" : "permanent";
  if (NETWORK_ERROR_CODES.has(code) || code.startsWith("E")) return "retry";
  return "retry";
}

function shortError(err) {
  const msg = err?.metaError?.message || err?.message || "Unknown error";
  return String(msg).slice(0, 500);
}

const errCode = (err) =>
  String(err?.metaError?.code ?? err?.code ?? "") || null;

/* ------------------------------------------------------------------ */
/* Job state helpers                                                   */
/* ------------------------------------------------------------------ */

/** Atomic claim: do worker kabhi same job nahi uthayenge */
async function claimNext(channels) {
  return OutboundJob.findOneAndUpdate(
    {
      status: "pending",
      channel: { $in: channels },
      nextRunAt: { $lte: new Date() },
    },
    {
      $set: { status: "processing", lockedAt: new Date() },
      $inc: { attempts: 1 },
    },
    { sort: { nextRunAt: 1, priority: 1, seq: 1 }, new: true },
  );
}

async function markSent(job) {
  await OutboundJob.updateOne(
    // Agar Meta ka delivery-failed webhook pehle aa gaya, to use "sent" se overwrite mat karo
    { _id: job._id, deliveryFailed: { $ne: true } },
    {
      $set: {
        status: "sent",
        sentAt: new Date(),
        lockedAt: null,
        lastError: null,
        lastErrorCode: null,
      },
    },
  );
}

async function markFailed(job, err, reason) {
  await OutboundJob.updateOne(
    { _id: job._id },
    {
      $set: {
        status: "failed",
        lockedAt: null,
        lastError: reason || shortError(err),
        lastErrorCode: err ? errCode(err) : null,
      },
    },
  );
}

async function markCancelled(job, reason) {
  await OutboundJob.updateOne(
    { _id: job._id },
    { $set: { status: "cancelled", lockedAt: null, lastError: reason } },
  );
}

/** Job ko dobara pending karta hai (retry / channel pause ke liye) */
async function requeue(job, err, delayMs, { burnAttempt }) {
  await OutboundJob.updateOne(
    { _id: job._id },
    {
      $set: {
        status: "pending",
        lockedAt: null,
        nextRunAt: new Date(Date.now() + delayMs),
        lastError: shortError(err),
        lastErrorCode: errCode(err),
      },
      // claim par attempts +1 ho chuka hai; pause wale errors mein wapas kam kar do
      ...(burnAttempt ? {} : { $inc: { attempts: -1 } }),
    },
  );
}

/* ------------------------------------------------------------------ */
/* Realtime events + notifications                                     */
/* ------------------------------------------------------------------ */

/** Frontend ko batata hai ki ye job abhi kis state mein hai (ek-ek karke) */
function emitJob(job, lead) {
  emitToUser(job.ownerId, "outreach:job", {
    jobId: String(job._id),
    campaignId: job.campaignId ? String(job.campaignId) : null,
    leadId: String(job.leadId),
    channel: job.channel || "whatsapp",
    status: job.status,
    attempts: job.attempts,
    sentAt: job.sentAt || null,
    nextRunAt: job.nextRunAt,
    lastError: job.lastError || null,
    ...(lead
      ? { name: lead.name, phone: lead.phone, email: lead.email || "" }
      : {}),
  });
}

async function emitCampaignProgress(job) {
  if (!job.campaignId) return null;
  try {
    const stats = await getCampaignStats(job.campaignId);
    emitToUser(job.ownerId, "outreach:progress", {
      campaignId: String(job.campaignId),
      stats,
    });
    return stats;
  } catch (err) {
    logger.warn("[queue] Could not emit campaign progress", {
      error: err.message,
    });
    return null;
  }
}

async function notify(ownerId, payload) {
  try {
    await Notification.create({ userId: ownerId, ...payload });
    emitToUser(ownerId, "notification:new", {});
  } catch (err) {
    logger.warn("[queue] Could not create notification", {
      error: err.message,
    });
  }
}

const isFinished = (s) => s.pending + s.processing + s.paused === 0;

/** Campaign (ya purana batch) poora khatam ho jaye to ek summary notification */
async function checkCompletion(job, stats) {
  if (job.campaignId) {
    if (!stats) return;
    if (!CHANNELS.every((ch) => isFinished(stats[ch]))) return;

    // Atomic: sirf ek hi baar 'active' -> 'completed' hoga (restart-safe)
    const done = await Campaign.findOneAndUpdate(
      { _id: job.campaignId, status: "active" },
      { $set: { status: "completed", completedAt: new Date() } },
      { new: true },
    );
    if (!done) return;

    const sent = stats.whatsapp.sent + stats.email.sent;
    const failed = stats.whatsapp.failed + stats.email.failed;
    emitToUser(job.ownerId, "outreach:campaign", {
      campaignId: String(done._id),
      status: "completed",
    });
    await notify(job.ownerId, {
      type: "bulk_batch_done",
      title: `Campaign "${done.name}" complete — ${sent} sent`,
      body:
        `WhatsApp: ${stats.whatsapp.sent}/${stats.whatsapp.total}, ` +
        `Email: ${stats.email.sent}/${stats.email.total}.` +
        (failed ? ` ${failed} fail hue — retry kar sakte ho.` : ""),
      link: "/outreach/whatsapp",
    });
    return;
  }

  // Purana batch (single lead / manual start)
  if (notifiedBatches.has(job.batchId)) return;
  const s = await getBatchStats(job.batchId);
  if (s.pending > 0 || s.processing > 0 || s.paused > 0) return;
  notifiedBatches.add(job.batchId);
  await notify(job.ownerId, {
    type: "bulk_batch_done",
    title: `Bulk messaging complete — ${s.sent}/${s.total} sent`,
    body: s.failed
      ? `${s.failed} lead(s) failed. Outreach page se retry kar sakte ho.`
      : "Sab messages successfully chale gaye.",
    link: "/outreach/whatsapp",
  });
}

async function notifyPause(job, err, channel, kind) {
  // 10 min mein ek hi baar per channel, warna notification spam ho jayega
  if (Date.now() - lastPauseNotifyAt[channel] < PAUSE_MS.fatal_pause) return;
  lastPauseNotifyAt[channel] = Date.now();

  const minutes = Math.round(PAUSE_MS[kind] / 60000);
  const label = channel === "email" ? "Email" : "WhatsApp";
  await notify(job.ownerId, {
    type: "whatsapp_send_failed",
    title: `Bulk ${label} paused — ${label} problem`,
    body:
      `${label} error: ${shortError(err)}. ${label} sending ${minutes} minute ke liye ruka hai, ` +
      `jobs safe hain.` +
      (channel === "email"
        ? " BREVO_API_KEY, BREVO_FROM_EMAIL, authenticated domain aur Brevo rate limit check karo."
        : " Token/payment/template check karo."),
    link: channel === "email" ? "/outreach/email" : "/whatsapp",
  });
}

/* ------------------------------------------------------------------ */
/* Channel processors                                                  */
/* ------------------------------------------------------------------ */

async function processWhatsApp(job, lead) {
  const conversation = lead
    ? await Conversation.findOne({ leadId: job.leadId })
    : null;

  if (!lead || !conversation) {
    await markFailed(job, null, "Lead ya conversation delete ho chuka hai");
    return;
  }

  const campaign = job.campaignId
    ? await Campaign.findOne({
        _id: job.campaignId,
        ownerId: job.ownerId,
      }).lean()
    : null;
  const template = campaign?.whatsappTemplate?.name
    ? {
        name: campaign.whatsappTemplate.name,
        language: campaign.whatsappTemplate.language,
        variables: campaign.whatsappTemplate.variables || [],
        headerImageUrl: campaign.whatsappTemplate.headerImageUrl || "",
        body: campaign.whatsappTemplate.body || "",
        header: campaign.whatsappTemplate.header || "",
        footer: campaign.whatsappTemplate.footer || "",
        buttons: campaign.whatsappTemplate.buttons || [],
      }
    : null;

  const result = await conversationEngine.startConversation({
    lead,
    conversation,
    templateOverride: template,
    outboundJobId: template ? job._id : null,
  });

  if (result?.sent || result?.reason === "already_started") {
    await markSent(job);
    return;
  }

  if (result?.skipped) {
    // AI pause ya WhatsApp disconnect: job 'paused' kar do, broker resume kar lega
    if (
      result.reason === "ai_paused" ||
      result.reason === "whatsapp_disconnected"
    ) {
      await OutboundJob.updateOne(
        { _id: job._id },
        {
          $set: {
            status: "paused",
            lockedAt: null,
            lastError: `Skipped: ${result.reason}`,
          },
          $inc: { attempts: -1 },
        },
      );
      return;
    }
    // not_ai_active (manual/closed): ab message bhejna sahi nahi
    await markCancelled(job, `Skipped: ${result.reason}`);
    return;
  }

  await markSent(job);
}

async function processEmail(job, lead) {
  if (!lead) {
    await markFailed(job, null, "Lead delete ho chuka hai");
    return;
  }
  if (!lead.email) {
    await markFailed(job, null, "Is lead ka email address nahi hai");
    return;
  }

  const campaign = job.campaignId
    ? await Campaign.findById(job.campaignId).lean()
    : null;
  if (!campaign || !campaign.email?.subject || !campaign.email?.body) {
    await markFailed(job, null, "Campaign ka email subject/body missing hai");
    return;
  }
  if (campaign.status === "cancelled") {
    await markCancelled(job, "Campaign cancel ho gaya");
    return;
  }

  const settings = await settingsService.getOrCreateSettings();
  let tracked = await EmailMessage.findOne({ outboundJobId: job._id });
  if (tracked?.status === "cancelled") {
    await markCancelled(job, "Campaign email cancelled");
    return;
  }
  if (
    tracked &&
    [
      "sent",
      "delivered",
      "delivery_delayed",
      "bounced",
      "complained",
      "suppressed",
    ].includes(tracked.status)
  ) {
    // Provider already accepted this idempotent job. Don't send it again after
    // a worker restart/webhook race.
    await markSent(job);
    return;
  }
  if (!tracked) {
    tracked = new EmailMessage({
      ownerId: job.ownerId,
      leadId: lead._id,
      campaignId: campaign._id,
      outboundJobId: job._id,
      direction: "outbound",
      kind: "campaign",
      trackingId: crypto.randomBytes(16).toString("hex"),
      from: getFromAddress(),
      to: lead.email,
      subject: campaign.email.subject,
      text: campaign.email.body,
      status: "queued",
      replyStatus: "waiting",
    });
    await tracked.save();
    tracked.threadId = tracked._id;
    await tracked.save();
  }

  try {
    tracked.status = "sending";
    tracked.errorCode = null;
    tracked.errorMessage = null;
    await tracked.save();

    const sent = await sendCampaignEmail({
      to: lead.email,
      subject: campaign.email.subject,
      body: campaign.email.body,
      imageUrl: campaign.email.imageUrl || "",
      companyName: settings.companyName || "",
      replyTo: makeReplyAddress(tracked.trackingId),
      idempotencyKey: `propai-campaign-${job._id}`,
      tags: [
        { name: "product", value: "propai" },
        { name: "channel", value: "campaign" },
        { name: "propai_job_id", value: String(job._id) },
        { name: "propai_message_id", value: String(tracked._id) },
      ],
      vars: {
        name: lead.name,
        firstName: String(lead.name || "")
          .trim()
          .split(/\s+/)[0],
        phone: lead.phone || "",
        city: lead.city || "",
        company: settings.companyName || "",
      },
    });

    // Do not overwrite a faster delivery webhook (delivered/bounced/etc).
    await EmailMessage.updateOne(
      { _id: tracked._id },
      {
        $set: {
          providerMessageId: sent.providerMessageId,
          rfcMessageId: sent.rfcMessageId || sent.providerMessageId,
          sentAt: tracked.sentAt || new Date(),
          from: getFromAddress() || tracked.from,
        },
      },
    );
    await EmailMessage.updateOne(
      { _id: tracked._id, status: { $in: ["queued", "sending"] } },
      { $set: { status: "sent" } },
    );
    await markSent(job);
  } catch (err) {
    await EmailMessage.updateOne(
      { _id: tracked._id, status: { $in: ["queued", "sending"] } },
      {
        $set: {
          status: "failed",
          errorCode: String(err.code || "EMAIL_SEND_FAILED"),
          errorMessage: String(err.message || "Email send failed").slice(
            0,
            500,
          ),
        },
      },
    ).catch((saveErr) =>
      logger.error("[email] Could not persist failed send", {
        error: saveErr.message,
      }),
    );
    throw err;
  }
}

/** Ek job process karta hai. Lead return karta hai (events mein naam bhejne ke liye). */
async function processJob(job) {
  const channel = job.channel || "whatsapp";
  const lead = await Lead.findById(job.leadId);

  // Frontend: "ab ye lead bheji ja rahi hai" (spinner)
  emitJob(job, lead);

  try {
    if (channel === "email") await processEmail(job, lead);
    else await processWhatsApp(job, lead);
  } catch (err) {
    await handleError(job, err, channel);
  }
  return lead;
}

async function handleError(job, err, channel) {
  const kind =
    channel === "email" ? classifyEmailError(err) : classifyWhatsAppError(err);

  if (PAUSE_MS[kind]) {
    pausedUntil[channel] = Date.now() + PAUSE_MS[kind];
    logger.warn(
      `[queue] ${channel} ${kind} — channel ${Math.round(PAUSE_MS[kind] / 60000)} min ke liye ruk raha hai`,
      { error: shortError(err), code: errCode(err) },
    );
    // delay 0: order bacha rehta hai; pausedUntil is channel ko rok ke rakhta hai
    await requeue(job, err, 0, { burnAttempt: false });
    if (kind !== "rate_limit") await notifyPause(job, err, channel, kind);
    return;
  }

  if (kind === "retry") {
    if (job.attempts >= job.maxAttempts) {
      await markFailed(job, err, `Max attempts reached: ${shortError(err)}`);
      return;
    }
    const delay =
      RETRY_BACKOFF_MS[Math.min(job.attempts - 1, RETRY_BACKOFF_MS.length - 1)];
    await requeue(job, err, delay, { burnAttempt: true });
    return;
  }

  // permanent
  await markFailed(job, err);
}

/* ------------------------------------------------------------------ */
/* Main loop                                                           */
/* ------------------------------------------------------------------ */

async function loop() {
  while (running) {
    try {
      // Periodically stuck jobs recover karo
      if (Date.now() - lastRecoverAt > RECOVER_EVERY_MS) {
        lastRecoverAt = Date.now();
        const recovered = await recoverStuckJobs();
        if (recovered)
          logger.warn(`[queue] ${recovered} stuck job(s) wapas pending kiye`);
      }

      // Jo channels abhi paused nahi hain, sirf unhi ke jobs uthao
      const now = Date.now();
      const allowed = CHANNELS.filter((ch) => now >= pausedUntil[ch]);
      if (!allowed.length) {
        await sleep(IDLE_POLL_MS);
        continue;
      }

      const job = await claimNext(allowed);
      if (!job) {
        await sleep(IDLE_POLL_MS);
        continue;
      }

      const lead = await processJob(job);

      // Final state (sent / failed / retry / paused) ek event mein
      const fresh = await OutboundJob.findById(job._id).lean();
      if (fresh) {
        emitJob(fresh, lead);
        const stats = await emitCampaignProgress(fresh);
        await checkCompletion(fresh, stats);
      }

      // Do messages ke beech gap (+ thoda random jitter, bot jaisa na lage)
      const gap = SEND_INTERVAL_MS[job.channel || "whatsapp"];
      await sleep(gap + Math.floor(Math.random() * 300));
    } catch (err) {
      logger.error("[queue] Worker loop error", { error: err.message });
      await sleep(5000); // crash-loop se bachne ke liye
    }
  }
  logger.info("[queue] Bulk worker stopped");
}

async function startBulkWorker() {
  if (running) return;
  running = true;

  try {
    // Pre-campaign jobs ko 'whatsapp' channel de do (naye claim query ke liye)
    const migrated = await OutboundJob.updateMany(
      { channel: { $exists: false } },
      { $set: { channel: "whatsapp", priority: 0 } },
    );
    if (migrated.modifiedCount)
      logger.info(
        `[queue] ${migrated.modifiedCount} purane job(s) ko channel=whatsapp set kiya`,
      );

    const recovered = await recoverStuckJobs(0); // boot par saare 'processing' jobs purane hain
    if (recovered)
      logger.warn(
        `[queue] Boot recovery: ${recovered} job(s) wapas pending kiye`,
      );
  } catch (err) {
    logger.error("[queue] Boot recovery failed", { error: err.message });
  }

  lastRecoverAt = Date.now();
  logger.info(
    `[queue] Bulk worker started (whatsapp ~${SEND_INTERVAL_MS.whatsapp}ms, email ~${SEND_INTERVAL_MS.email}ms)`,
  );
  loop(); // background mein chalta rahega (await nahi)
}

function stopBulkWorker() {
  running = false;
}

module.exports = { startBulkWorker, stopBulkWorker };
