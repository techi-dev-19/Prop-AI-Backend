const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const roleGuard = require('../middlewares/roleGuard');
const validate = require('../middlewares/validate');

const { listMeetings, createMeeting, updateMeeting, deleteMeeting } = require('../controllers/meetingController');
const { listMeetingsSchema, createMeetingSchema, updateMeetingSchema, idParamSchema } = require('../validators/meetingValidators');

router.use(authenticate, roleGuard('broker', 'admin'));

router.get('/', validate(listMeetingsSchema), listMeetings);
router.post('/', validate(createMeetingSchema), createMeeting);
router.patch('/:id', validate(updateMeetingSchema), updateMeeting);
router.delete('/:id', validate(idParamSchema), deleteMeeting);

module.exports = router;
