const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const roleGuard = require('../middlewares/roleGuard');
const validate = require('../middlewares/validate');
const { uploadCsv } = require('../middlewares/upload');

const {
  previewImport,
  previewText,
  confirmImport,
  startConversations,
  createLead,
  listLeads,
  listImportFiles,
  getLead,
  updateLead,
  deleteLead,
  bulkDeleteLeads,
  updateTags,
  exportLeads,
} = require('../controllers/leadController');

const {
  createLeadSchema,
  updateLeadSchema,
  listLeadsQuerySchema,
  idParamSchema,
  bulkDeleteSchema,
  tagsUpdateSchema,
  importConfirmSchema,
  parseTextSchema,
  startConversationsSchema,
} = require('../validators/leadValidators');

// Leads are owned by brokers; admins can view/manage across brokers via ?ownerId=.
// Builders don't touch this resource directly.
router.use(authenticate, roleGuard('broker', 'admin'));

router.post('/import/preview', uploadCsv.single('file'), previewImport);
router.post('/import/parse-text', validate(parseTextSchema), previewText);
router.post('/import/confirm', validate(importConfirmSchema), confirmImport);
router.post('/start-conversations', validate(startConversationsSchema), startConversations);

router.get('/export', exportLeads);
router.get('/import-files', listImportFiles);
router.post('/bulk-delete', validate(bulkDeleteSchema), bulkDeleteLeads);

router.get('/', validate(listLeadsQuerySchema), listLeads);
router.post('/', validate(createLeadSchema), createLead);
router.get('/:id', validate(idParamSchema), getLead);
router.patch('/:id', validate(updateLeadSchema), updateLead);
router.delete('/:id', validate(idParamSchema), deleteLead);
router.post('/:id/tags', validate(tagsUpdateSchema), updateTags);

module.exports = router;
