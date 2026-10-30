const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const roleGuard = require('../middlewares/roleGuard');
const { listAuditLogs } = require('../controllers/auditLogController');

router.use(authenticate, roleGuard('admin'));
router.get('/', listAuditLogs);

module.exports = router;
