const http = require("http");
const app = require("./src/app");
const connectDB = require("./src/config/db");
const env = require("./src/config/env");
const logger = require("./src/utils/logger");
const { initSocket } = require("./src/sockets");
const {
  startDailyReportScheduler,
} = require("./src/services/scheduler/dailyReportScheduler");
const conversationEngine = require("./src/services/ai/conversationEngine");
const metaWhatsappClient = require("./src/services/whatsapp/metaWhatsappClient");
const {
  startBulkWorker,
  stopBulkWorker,
} = require("./src/services/queue/bulkWorker");

(async () => {
  await connectDB();

  const server = http.createServer(app);
  initSocket(server);

  server.listen(env.port, async () => {
    logger.info(`[server] Listening on port ${env.port} (${env.nodeEnv})`);

    startBulkWorker().catch((err) => {
      logger.error("[server] Failed to start bulk worker", {
        error: err.message,
      });
    });

    const metaReady = Boolean(
      env.metaWhatsapp.accessToken && env.metaWhatsapp.phoneNumberId,
    );

    if (!metaReady) {
      logger.warn(
        "[server] Meta WhatsApp is not configured — set META_WHATSAPP_ACCESS_TOKEN and META_WHATSAPP_PHONE_NUMBER_ID.",
      );
    } else {
      logger.info(
        `[server] Meta WhatsApp configured. Phone Number ID: ${env.metaWhatsapp.phoneNumberId}`,
      );

      // Validate the sender asset at startup. This catches the most common
      // Meta mistakes (wrong token, WABA, or Phone Number ID) before a lead
      // is created and a message mysteriously fails in the background.
      try {
        const info = await metaWhatsappClient.getAccountInfo();
        logger.info("[server] Meta sender verified.", {
          phoneNumber: info.phoneNumber,
          verifiedName: info.verifiedName,
          qualityRating: info.qualityRating,
        });
      } catch (err) {
        logger.error(
          "[server] Meta sender verification failed. Outbound WhatsApp will not work until the token/Phone Number ID are corrected.",
          {
            error: err.metaError || err.response?.data || err.message,
            code: err.code,
          },
        );
      }

      if (!env.metaWhatsapp.openingTemplateName) {
        logger.warn(
          "[server] META_WHATSAPP_OPENING_TEMPLATE_NAME is missing. Leads outside the 24h customer-service window will require an approved template before the first outbound message can be sent.",
        );
      }

      // Make sure Meta has this app subscribed to the WABA so inbound messages
      // and delivery/read status events can reach this backend. If another app
      // (for example n8n) owns the same Meta App webhook, set
      // META_WHATSAPP_AUTO_SUBSCRIBE=false and use the forwarding setup in
      // WHATSAPP_SETUP.md instead of replacing that callback URL blindly.
      if (
        env.metaWhatsapp.businessAccountId &&
        env.metaWhatsapp.autoSubscribe
      ) {
        try {
          await metaWhatsappClient.ensureWabaSubscription();
          logger.info(
            "[server] Meta WABA webhook subscription request succeeded.",
          );
        } catch (err) {
          logger.error(
            "[server] Could not subscribe this app to the Meta WABA. Inbound webhooks may not arrive.",
            {
              error: err.metaError || err.response?.data || err.message,
              code: err.code,
            },
          );
        }
      } else if (!env.metaWhatsapp.businessAccountId) {
        logger.warn(
          "[server] META_WHATSAPP_BUSINESS_ACCOUNT_ID is missing — cannot configure WABA webhook subscription.",
        );
      }
    }

    // Retry any lead whose opening template failed while the server was down
    // or Meta was temporarily unavailable. startConversation() is idempotent.
    try {
      const User = require("./src/models/User");
      const owners = await User.find({
        role: { $in: ["broker", "admin"] },
        isActive: true,
      })
        .select("_id")
        .lean();
      for (const owner of owners) {
        conversationEngine
          .catchUpPendingConversations(owner._id)
          .catch((err) =>
            logger.error(
              `[server] Pending WhatsApp auto-start failed for owner ${owner._id}`,
              { error: err.message },
            ),
          );
      }
    } catch (err) {
      logger.warn("[server] Could not run pending WhatsApp auto-start sweep", {
        error: err.message,
      });
    }
  });

  startDailyReportScheduler();

  // Graceful shutdown
  const shutdown = (signal) => {
    logger.info(`[server] Received ${signal}, shutting down gracefully...`);
    stopBulkWorker();
    server.close(() => {
      logger.info("[server] Closed remaining connections.");
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  process.on("unhandledRejection", (reason) => {
    logger.error("[server] Unhandled promise rejection:", reason);
  });
})();
