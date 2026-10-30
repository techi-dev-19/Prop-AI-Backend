const express = require("express");
const router = express.Router();
const brevoWebhook = require("../controllers/brevoWebhookController");

// Public provider callback; protected by the configured secret header in Brevo.
router.post("/brevo", brevoWebhook.handler);
module.exports = router;
