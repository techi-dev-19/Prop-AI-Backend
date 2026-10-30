const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const roleGuard = require('../middlewares/roleGuard');
const verifyMetaSignature = require('../middlewares/verifyMetaSignature');

const {
  verifyWebhook,
  receiveWebhook,
  receiveForwardedWebhook,
  sendTest,
  sendTestTemplate,
  getStatus,
  diagnostics,
  disconnect,
  reconnect,
  listApprovedTemplates,
  listAllTemplates,
  createTemplate,
  deleteTemplate,
} = require('../controllers/whatsappController');

// Public — these are the URLs registered in the Meta App Dashboard under
// WhatsApp -> Configuration -> Webhook, e.g.
//   https://your-domain.com/api/whatsapp/webhook
// No auth middleware: Meta calls these directly and can't send our
// JWT/cookies. GET is the one-time verify handshake; POST is every real
// event delivery afterwards (both checked/secured on Meta's side via the
// verify token + optional X-Hub-Signature-256 app-secret check).
router.get('/webhook', verifyWebhook);
router.post('/webhook', verifyMetaSignature, receiveWebhook);
router.post('/webhook/forward', receiveForwardedWebhook);

router.get('/status', authenticate, roleGuard('broker', 'admin'), getStatus);
router.get('/templates', authenticate, roleGuard('broker', 'admin'), listApprovedTemplates);
router.get('/templates/all', authenticate, roleGuard('broker', 'admin'), listAllTemplates);
router.post('/templates', authenticate, roleGuard('broker', 'admin'), createTemplate);
router.delete('/templates/:name', authenticate, roleGuard('broker', 'admin'), deleteTemplate);
router.get('/diagnostics', authenticate, roleGuard('broker', 'admin'), diagnostics);
router.post('/send-test', authenticate, roleGuard('broker'), sendTest);
router.post('/send-test-template', authenticate, roleGuard('broker'), sendTestTemplate);
router.post('/disconnect', authenticate, roleGuard('broker', 'builder'), disconnect);
router.post('/reconnect', authenticate, roleGuard('broker', 'builder'), reconnect);

module.exports = router;
