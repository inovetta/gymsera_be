const { Router } = require('express');
const hostController = require('../controllers/host.controller');
const gymsController = require('../controllers/gyms.controller');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const tenantContext = require('../middleware/tenantContext');
const gymsValidators = require('../validators/gyms.validator');
const validate = require('../middleware/validate');

const router = Router();

router.get('/today-summary', authenticate, authorize('GYM_HOST'), hostController.getTodaySummary);
router.get('/branch-quota', authenticate, authorize('GYM_HOST'), hostController.getBranchQuota);
router.get('/organization-quota', authenticate, authorize('GYM_HOST'), hostController.getOrganizationQuota);
router.get('/listings', authenticate, authorize('GYM_HOST'), hostController.getListings);
router.post('/listings', authenticate, authorize('GYM_HOST'), tenantContext, hostController.createListing);
router.put('/listings/:id', authenticate, authorize('GYM_HOST'), tenantContext, hostController.updateListing);
router.patch('/listings/:id', authenticate, authorize('GYM_HOST'), tenantContext, hostController.updateListing);
router.get('/subscription/current', authenticate, authorize('GYM_HOST'), hostController.getCurrentSubscription);
router.post('/subscription/upgrade', authenticate, authorize('GYM_HOST'), hostController.upgradeSubscription);

// Branches routes mapped to gymsController but under /host prefix
router.get('/branches', authenticate, authorize('GYM_HOST'), tenantContext, gymsController.listBranches);
router.post(
  '/branches',
  authenticate,
  authorize('GYM_HOST'),
  tenantContext,
  validate(gymsValidators.createBranch),
  gymsController.createBranch
);

// GET /host/listings/:listingId/branches — branches scoped to an org listing
router.get('/listings/:listingId/branches', authenticate, authorize('GYM_HOST'), tenantContext, gymsController.listBranches);
router.get('/gyms/:gymId/branches', authenticate, authorize('GYM_HOST'), tenantContext, gymsController.listBranches);

// GET /host/branches/:branchId/listing-content — get all storefront fields
router.get(
  '/branches/:branchId/listing-content',
  authenticate,
  authorize('GYM_HOST'),
  tenantContext,
  gymsController.getBranchListingContent
);

// PATCH /host/branches/:branchId/listing-content — content fields only (photos, amenities)
router.patch(
  '/branches/:branchId/listing-content',
  authenticate,
  authorize('GYM_HOST'),
  tenantContext,
  gymsController.updateBranchListingContent
);

// DELETE /host/branches/:branchId — delete/deactivate a branch
router.delete(
  '/branches/:branchId',
  authenticate,
  authorize('GYM_HOST'),
  tenantContext,
  gymsController.deleteBranch
);

// Branch-scoped endpoints for Branch Detail screen tabs
router.get('/branches/:branchId/dashboard', authenticate, authorize('GYM_HOST'), tenantContext, hostController.getBranchDashboard);
router.get('/branches/:branchId/members/lookup', authenticate, authorize('GYM_HOST'), tenantContext, hostController.lookupBranchMember);
router.post('/branches/:branchId/members', authenticate, authorize('GYM_HOST'), tenantContext, hostController.createBranchMember);
router.get('/branches/:branchId/members', authenticate, authorize('GYM_HOST'), tenantContext, hostController.getBranchMembers);
router.get('/branches/:branchId/checkins', authenticate, authorize('GYM_HOST'), tenantContext, hostController.getBranchCheckins);
router.get('/branches/:branchId/announcements', authenticate, authorize('GYM_HOST'), tenantContext, hostController.getBranchAnnouncements);
router.post('/branches/:branchId/announcements', authenticate, authorize('GYM_HOST'), tenantContext, hostController.createBranchAnnouncement);
router.delete('/branches/:branchId/announcements/:announcementId', authenticate, authorize('GYM_HOST'), tenantContext, hostController.deleteBranchAnnouncement);
router.get('/branches/:branchId/schedule', authenticate, authorize('GYM_HOST'), tenantContext, hostController.getBranchSchedule);
router.post('/branches/:branchId/schedule', authenticate, authorize('GYM_HOST'), tenantContext, hostController.createBranchSchedule);
router.patch('/branches/:branchId/resubmit-visibility', authenticate, authorize('GYM_HOST'), tenantContext, hostController.resubmitBranchReview);

// Inbox & Inquiries
router.get('/inbox/inquiries', authenticate, authorize('GYM_HOST'), hostController.listInquiries);
router.get('/inbox/inquiries/:inquiryId', authenticate, authorize('GYM_HOST'), hostController.getInquiryDetail);
router.post('/inbox/inquiries/:inquiryId/reply', authenticate, authorize('GYM_HOST'), hostController.replyToInquiry);
router.patch('/inbox/inquiries/:inquiryId/read', authenticate, authorize('GYM_HOST'), hostController.markInquiryRead);

module.exports = router;
