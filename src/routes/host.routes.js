const { Router } = require('express');
const hostController = require('../controllers/host.controller');
const gymsController = require('../controllers/gyms.controller');
const expensesController = require('../controllers/expenses.controller');
const payoutsController = require('../controllers/payouts.controller');
const authenticate = require('../middleware/authenticate');
const authorize = require('../middleware/authorize');
const tenantContext = require('../middleware/tenantContext');
const can = require('../middleware/can');
const idempotency = require('../middleware/idempotency');
const gymsValidators = require('../validators/gyms.validator');
const validate = require('../middleware/validate');
const upload = require('../middleware/upload');

const router = Router();

// NEW-108: authorize('GYM_HOST') before tenantContext checks the account role (the
// user owns *a* gym). After tenantContext, GYM_HOST means the owner of the tenant
// this request resolved to, so routes that act on req.user.tenantId check again.
const ownerHere = authorize('GYM_HOST');

// Payouts (PAY-10, SEC-13)
router.get('/payouts/balance', authenticate, tenantContext, can('payouts.view', { orgWide: true }), payoutsController.getBalance);
router.get('/payouts', authenticate, tenantContext, can('payouts.view', { orgWide: true }), payoutsController.listPayouts);
router.post('/payouts', authenticate, tenantContext, idempotency({ required: true }), validate.allowBody(['amount', 'branchId', 'notes', 'destinationJson', 'idempotencyKey']), payoutsController.requestPayout);

// Expense Categories
router.get('/expense-categories', authenticate, tenantContext, authorize('GYM_HOST', 'BRANCH_MANAGER'), expensesController.listExpenseCategories);
router.post('/expense-categories', authenticate, tenantContext, authorize('GYM_HOST', 'BRANCH_MANAGER'), validate.allowBody(['name']), expensesController.createExpenseCategory);

// Branch Expenses
router.get('/branches/:branchId/expenses', authenticate, tenantContext, authorize('GYM_HOST', 'BRANCH_MANAGER'), expensesController.listExpenses);
router.post('/branches/:branchId/expenses', authenticate, tenantContext, authorize('GYM_HOST', 'BRANCH_MANAGER'), validate.allowBody(['amount', 'categoryId', 'expenseDate', 'isRecurring', 'notes', 'paymentMethod', 'receiptUrl', 'recurrenceEndDate', 'recurrenceFrequency', 'title', 'vendorName']), expensesController.createExpense);
router.get('/branches/:branchId/expenses/summary', authenticate, tenantContext, authorize('GYM_HOST', 'BRANCH_MANAGER'), expensesController.getExpenseSummary);
router.get('/branches/:branchId/expenses/:expenseId', authenticate, tenantContext, authorize('GYM_HOST', 'BRANCH_MANAGER'), expensesController.getExpenseDetail);
router.patch('/branches/:branchId/expenses/:expenseId', authenticate, tenantContext, authorize('GYM_HOST', 'BRANCH_MANAGER'), validate.allowBody(['amount', 'categoryId', 'expenseDate', 'isRecurring', 'notes', 'paymentMethod', 'receiptUrl', 'recurrenceEndDate', 'recurrenceFrequency', 'title', 'vendorName']), expensesController.updateExpense);
router.delete('/branches/:branchId/expenses/:expenseId', authenticate, tenantContext, authorize('GYM_HOST', 'BRANCH_MANAGER'), validate.allowBody([]), expensesController.deleteExpense);

// Phase 7 P2: no authorize — the answer is the caller's own host status (NONE for a non-host).
router.get('/status', authenticate, hostController.getHostStatus);
router.get('/today-summary', authenticate, authorize('GYM_HOST'), hostController.getTodaySummary);
router.get('/branch-quota', authenticate, authorize('GYM_HOST'), hostController.getBranchQuota);
router.get('/organization-quota', authenticate, authorize('GYM_HOST'), hostController.getOrganizationQuota);
router.get('/listings', authenticate, authorize('GYM_HOST'), hostController.getListings);
router.post(
  '/listings/staging-images',
  authenticate,
  authorize('GYM_HOST'),
  upload.images('images', 10),
  upload.handleMulterError,
  validate.allowBody([]), hostController.uploadListingStagingImages
);
router.post('/listings', authenticate, authorize('GYM_HOST'), tenantContext, ownerHere, validate.allowBody(['address', 'areaId', 'branchSource', 'cityId', 'contactPhone', 'coverImageUrl', 'genderType', 'gymDescription', 'gymName', 'images', 'latitude', 'logoUrl', 'longitude', 'packages']), hostController.createListing);
router.put('/listings/:id', authenticate, authorize('GYM_HOST'), tenantContext, ownerHere, validate.allowBody(['areaId', 'cityId', 'contactPhone', 'coverImageUrl', 'genderType', 'gymDescription', 'gymName', 'latitude', 'logoUrl', 'longitude']), hostController.updateListing);
router.patch('/listings/:id', authenticate, authorize('GYM_HOST'), tenantContext, ownerHere, validate.allowBody(['areaId', 'cityId', 'contactPhone', 'coverImageUrl', 'genderType', 'gymDescription', 'gymName', 'latitude', 'logoUrl', 'longitude']), hostController.updateListing);
router.delete('/listings/:id', authenticate, authorize('GYM_HOST'), tenantContext, ownerHere, validate.allowBody(['cascade', 'cascadeDelete', 'strategy', 'targetListingId', 'idToken', 'password', 'provider', 'reauthIdToken', 'reauthProvider']), hostController.deleteListing);
router.post('/listings/:id/reserved-slots/transfer', authenticate, authorize('GYM_HOST'), validate.allowBody(['count', 'toListingId']), hostController.transferReservedSlots);
router.post('/branches/:branchId/move', authenticate, authorize('GYM_HOST'), tenantContext, ownerHere, validate.allowBody(['confirmOrganizationDeletion', 'targetListingId']), hostController.moveBranchToOrganization);
router.post('/branches/:branchId/restore', authenticate, authorize('GYM_HOST'), tenantContext, ownerHere, validate.allowBody([]), hostController.restoreBranch);
router.get('/subscription/current', authenticate, authorize('GYM_HOST'), hostController.getCurrentSubscription);
router.post('/subscription/upgrade', authenticate, authorize('GYM_HOST'), validate.allowBody(['newPlanId', 'planId']), hostController.upgradeSubscription);

// Branches routes mapped to gymsController but under /host prefix
router.get('/branches', authenticate, authorize('GYM_HOST'), tenantContext, ownerHere, gymsController.listBranches);
router.post(
  '/branches',
  authenticate,
  authorize('GYM_HOST'),
  tenantContext,
  ownerHere,
  // SEC-06: facilities is the key the CMS sends (the service reads facilitiesJson); country is ignored
  validate.strict(gymsValidators.createBranch, { stage: 2, allow: ['facilities', 'country'] }),
  gymsController.createBranch
);

// GET /host/listings/:listingId/branches — branches scoped to an org listing
router.get('/listings/:listingId/branches', authenticate, authorize('GYM_HOST'), tenantContext, ownerHere, gymsController.listBranches);
router.get('/gyms/:gymId/branches', authenticate, authorize('GYM_HOST'), tenantContext, ownerHere, gymsController.listBranches);

// GET /host/branches/:branchId/listing-content — get all storefront fields
router.get(
  '/branches/:branchId/listing-content',
  authenticate,
  authorize('GYM_HOST'),
  tenantContext,
  ownerHere,
  gymsController.getBranchListingContent
);

// PATCH /host/branches/:branchId/listing-content — content fields only (photos, amenities)
router.patch(
  '/branches/:branchId/listing-content',
  authenticate,
  authorize('GYM_HOST'),
  tenantContext,
  ownerHere,
  validate.allowBody(['address', 'addressLine1', 'addressLine2', 'areaId', 'branchName', 'category', 'cityId', 'closingTime', 'country', 'description', 'establishedYear', 'facilitiesJson', 'floorArea', 'imagesJson', 'latitude', 'longitude', 'openingTime', 'phone', 'postalCode', 'tagline', 'tagsJson']),
  gymsController.updateBranchListingContent
);

// DELETE /host/branches/:branchId — delete/deactivate a branch
router.delete(
  '/branches/:branchId',
  authenticate,
  authorize('GYM_HOST'),
  tenantContext,
  ownerHere,
  validate.allowBody(['confirmOrganizationDeletion', 'idToken', 'password', 'provider', 'reauthIdToken', 'reauthProvider']),
  gymsController.deleteBranch
);

// Branch-scoped endpoints for Branch Detail screen tabs
router.get('/branches/:branchId/dashboard', authenticate, tenantContext, authorize('GYM_HOST', 'BRANCH_MANAGER'), can('dashboard.view'), hostController.getBranchDashboard);
router.get('/branches/:branchId/members/lookup', authenticate, tenantContext, authorize('GYM_HOST', 'BRANCH_MANAGER'), can('members.view'), hostController.lookupBranchMember);
router.post('/branches/:branchId/members', authenticate, tenantContext, authorize('GYM_HOST', 'BRANCH_MANAGER'), can('members.create'), validate.allowBody(['email', 'fullName', 'phone', 'planId', 'startDate', 'notes', 'paymentMethod']), hostController.createBranchMember);
router.get('/branches/:branchId/members', authenticate, tenantContext, authorize('GYM_HOST', 'BRANCH_MANAGER'), can('members.view'), hostController.getBranchMembers);
router.get('/branches/:branchId/checkins', authenticate, tenantContext, authorize('GYM_HOST', 'BRANCH_MANAGER'), can('checkins.view'), hostController.getBranchCheckins);
router.get('/branches/:branchId/announcements', authenticate, tenantContext, authorize('GYM_HOST', 'BRANCH_MANAGER'), can('announcements.view'), hostController.getBranchAnnouncements);
router.post('/branches/:branchId/announcements', authenticate, tenantContext, authorize('GYM_HOST', 'BRANCH_MANAGER'), can('announcements.create'), validate.allowBody(['message', 'status', 'tag', 'title']), hostController.createBranchAnnouncement);
router.delete('/branches/:branchId/announcements/:announcementId', authenticate, tenantContext, authorize('GYM_HOST', 'BRANCH_MANAGER'), can('announcements.delete'), validate.allowBody([]), hostController.deleteBranchAnnouncement);
router.get('/branches/:branchId/schedule', authenticate, tenantContext, authorize('GYM_HOST', 'BRANCH_MANAGER'), can('schedule.view'), hostController.getBranchSchedule);
router.post('/branches/:branchId/schedule', authenticate, tenantContext, authorize('GYM_HOST', 'BRANCH_MANAGER'), can('schedule.class.create'), validate.allowBody(['day', 'instructor', 'maxCapacity', 'name', 'time']), hostController.createBranchSchedule);
router.patch('/branches/:branchId/resubmit-visibility', authenticate, tenantContext, authorize('GYM_HOST', 'BRANCH_MANAGER'), can('branch.settings'), validate.allowBody([]), hostController.resubmitBranchReview);

// Inbox & Inquiries
router.get('/inbox/inquiries', authenticate, authorize('GYM_HOST'), hostController.listInquiries);
router.post('/inbox/conversations', authenticate, authorize('GYM_HOST'), validate.allowBody(['branchId', 'initialMessage', 'userId']), hostController.findOrCreateConversation);
router.get('/inbox/inquiries/:inquiryId', authenticate, authorize('GYM_HOST'), hostController.getInquiryDetail);
router.post('/inbox/inquiries/:inquiryId/reply', authenticate, authorize('GYM_HOST'), validate.allowBody(['clientMessageId', 'client_message_id', 'text']), hostController.replyToInquiry);
router.patch('/inbox/inquiries/:inquiryId/read', authenticate, authorize('GYM_HOST'), validate.allowBody([]), hostController.markInquiryRead);

module.exports = router;
