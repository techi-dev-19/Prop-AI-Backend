const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const roleGuard = require('../middlewares/roleGuard');
const validate = require('../middlewares/validate');

const { listFollowUps, updateFollowUp, deleteFollowUp } = require('../controllers/followUpController');
const { listFollowUpsSchema, updateFollowUpSchema, idParamSchema } = require('../validators/followUpValidators');

router.use(authenticate, roleGuard('broker', 'admin'));

router.get('/', validate(listFollowUpsSchema), listFollowUps);
router.patch('/:id', validate(updateFollowUpSchema), updateFollowUp);
router.delete('/:id', validate(idParamSchema), deleteFollowUp);

module.exports = router;
