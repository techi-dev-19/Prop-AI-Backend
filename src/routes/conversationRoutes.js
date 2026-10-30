const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const roleGuard = require('../middlewares/roleGuard');
const validate = require('../middlewares/validate');

const {
  listConversations,
  getConversation,
  sendManualReply,
  takeOverChat,
  resumeAI,
  markRead,
  closeConversation,
} = require('../controllers/conversationController');

const {
  listConversationsSchema,
  getConversationSchema,
  idParamSchema,
  sendManualReplySchema,
} = require('../validators/conversationValidators');

// Conversations belong to brokers; admins can inspect via ?ownerId=.
router.use(authenticate, roleGuard('broker', 'admin'));

router.get('/', validate(listConversationsSchema), listConversations);
router.get('/:id', validate(getConversationSchema), getConversation);
router.post('/:id/messages', validate(sendManualReplySchema), sendManualReply);
router.post('/:id/takeover', validate(idParamSchema), takeOverChat);
router.post('/:id/resume-ai', validate(idParamSchema), resumeAI);
router.post('/:id/read', validate(idParamSchema), markRead);
router.post('/:id/close', validate(idParamSchema), closeConversation);

module.exports = router;
