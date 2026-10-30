const express = require('express');
const router = express.Router();

router.use('/auth', require('./authRoutes'));
router.use('/uploads', require('./uploadRoutes'));
router.use('/email', require('./emailRoutes'));
router.use('/webhooks', require('./webhookRoutes'));
router.use('/leads', require('./leadRoutes'));
router.use('/audiences', require('./audienceRoutes'));
router.use('/campaigns', require('./campaignRoutes'));
router.use('/outreach', require('./outreachRoutes'));
router.use('/properties', require('./propertyRoutes'));
router.use('/sites', require('./siteRoutes'));
router.use('/whatsapp', require('./whatsappRoutes'));
router.use('/conversations', require('./conversationRoutes'));
router.use('/meetings', require('./meetingRoutes'));
router.use('/followups', require('./followupRoutes'));
router.use('/settings', require('./settingsRoutes'));
router.use('/sales-agent', require('./salesAgentRoutes'));
router.use('/analytics', require('./analyticsRoutes'));
router.use('/notifications', require('./notificationRoutes'));
router.use('/audit-logs', require('./auditLogRoutes'));

router.get('/health', (req, res) => res.json({ success: true, message: 'API is healthy' }));

module.exports = router;
