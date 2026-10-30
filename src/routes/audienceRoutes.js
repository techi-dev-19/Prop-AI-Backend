const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const roleGuard = require('../middlewares/roleGuard');
const validate = require('../middlewares/validate');

const {
  listAudiences, createAudience, getAudience, getAudienceLeads, updateAudience, deleteAudience,
} = require('../controllers/audienceController');
const {
  createAudienceSchema, updateAudienceSchema, listAudiencesSchema, audienceLeadsSchema, idParamSchema,
} = require('../validators/audienceValidators');

router.use(authenticate, roleGuard('broker', 'admin'));

router.get('/', validate(listAudiencesSchema), listAudiences);
router.post('/', validate(createAudienceSchema), createAudience);
router.get('/:id/leads', validate(audienceLeadsSchema), getAudienceLeads);
router.get('/:id', validate(idParamSchema), getAudience);
router.patch('/:id', validate(updateAudienceSchema), updateAudience);
router.delete('/:id', validate(idParamSchema), deleteAudience);

module.exports = router;
