/**
 * Single source of truth error copy table (spec §4.2).
 * Maps machine-readable error codes to localized copy (en, ur, ar)
 * and recommended client UI actions: 'open_upsell' | 'retry' | 'contact_owner' | 'none'.
 */
const ERROR_COPY = {
  branch_limit_reached: {
    en: 'You have reached the maximum number of branches allowed by your current plan.',
    ur: 'آپ کے موجودہ پلان میں برانچز کی مقرر کردہ حد ختم ہو چکی ہے۔',
    ar: 'لقد وصلت إلى الحد الأقصى لعدد الفروع المسموح به في خطتك الحالية.',
    action: 'open_upsell',
  },
  account_over_quota: {
    en: 'Your account is over its branch quota. Upgrade your plan to add or activate more branches.',
    ur: 'آپ کا اکاؤنٹ برانچ کوٹہ سے تجاوز کر گیا ہے۔ مزید برانچز شامل کرنے کے لیے اپنا پلان اپ گریڈ کریں۔',
    ar: 'حسابك تجاوز الحصة المسموح بها من الفروع. قم بترقية خطتك لإضافة فروع إضافية.',
    action: 'open_upsell',
  },
  last_branch_in_organization: {
    en: 'An organization must have at least one branch. You cannot delete the only branch.',
    ur: 'کسی تنظیم میں کم از کم ایک برانچ کا ہونا ضروری ہے۔ آپ واحد برانچ کو حذف نہیں کر سکتے۔',
    ar: 'يجب أن تحتوي المنظمة على فرع واحد على الأقل. لا يمكنك حذف الفرع الوحيد.',
    action: 'none',
  },
  iap_subscription_active: {
    en: 'This plan is billed through Apple or Google Play. Manage or cancel it through the store.',
    ur: 'یہ پلان ایپل یا گوگل پلے کے ذریعے بل کیا جاتا ہے۔ براہ کرم اسٹور کے ذریعے اس کا نظم کریں۔',
    ar: 'تتم فوترة هذه الخطة من خلال Apple أو Google Play. يمكنك إدارتها أو إلغاؤها من متجر التطبيقات.',
    action: 'none',
  },
  branch_status_immutable_here: {
    en: 'Branch status cannot be changed directly. Use the proper lifecycle actions (delete or restore).',
    ur: 'برانچ کی حیثیت براہ راست تبدیل نہیں کی جا سکتی۔ مناسب کارروائی (حذف یا بحال) کا استعمال کریں۔',
    ar: 'لا يمكن تغيير حالة الفرع مباشرة. استخدم الإجراء المناسب (حذف أو استعادة).',
    action: 'none',
  },
  store_subscription_active: {
    en: 'An active store subscription exists. Please cancel it in your Apple or Google account before deleting.',
    ur: 'ایک فعال اسٹور سبسکرپشن موجود ہے۔ اکاؤنٹ حذف کرنے سے پہلے اسے ایپل یا گوگل میں منسوخ کریں۔',
    ar: 'يوجد اشتراك نشط عبر المتجر. يرجى إلغاؤه من حساب Apple أو Google الخاص بك قبل الحذف.',
    action: 'none',
  },
  no_deletion_pending: {
    en: 'No deletion request is pending for this account.',
    ur: 'اس اکاؤنٹ کے لیے حذف کرنے کی کوئی زیر التواء درخواست نہیں ہے۔',
    ar: 'لا يوجد طلب حذف معلق لهذا الحساب.',
    action: 'none',
  },
  deletion_window_ended: {
    en: 'The 30-day grace period for undoing deletion has expired.',
    ur: 'حذف منسوخ کرنے کی 30 دن کی مہلت ختم ہو چکی ہے۔',
    ar: 'انتهت فترة السماح البالغة 30 يوماً للتراجع عن الحذف.',
    action: 'none',
  },
  account_pending_deletion: {
    en: 'Your account is scheduled for deletion. Cancel the deletion to keep using GymsEra.',
    ur: 'آپ کا اکاؤنٹ حذف کرنے کے لیے مقرر ہے۔ جمز ایرا کا استعمال جاری رکھنے کے لیے حذف کا عمل منسوخ کریں۔',
    ar: 'حسابك مجدول للحذف. قم بإلغاء الحذف للاستمرار في استخدام GymsEra.',
    action: 'none',
  },
  ledger_day_closed: {
    en: 'This ledger day is closed. Payments for this date cannot be modified.',
    ur: 'لیجر کا یہ دن بند ہو چکا ہے۔ اس تاریخ کی ادائیگیوں میں ترمیم نہیں کی جا سکتی۔',
    ar: 'تم إغلاق دفتر اليومية لهذا اليوم. لا يمكن تعديل المدفوعات المسجلة لهذا التاريخ.',
    action: 'none',
  },
  reauth_required: {
    en: 'Please confirm your password to complete this sensitive action.',
    ur: 'اس حساس کارروائی کو مکمل کرنے کے لیے براہ کرم اپنے پاس ورڈ کی تصدیق کریں۔',
    ar: 'يرجى تأكيد كلمة المرور الخاصة بك لإتمام هذا الإجراء الحساس.',
    action: 'none',
  },
  invalid_credentials: {
    en: 'Invalid email or password.',
    ur: 'غلط ای میل یا پاس ورڈ۔',
    ar: 'البريد الإلكتروني أو كلمة المرور غير صحيحة.',
    action: 'retry',
  },
  branch_billing_locked: {
    en: 'This branch is locked due to plan limits. Upgrade your plan to restore full access.',
    ur: 'پلان کی حد کی وجہ سے یہ برانچ لاک ہے۔ مکمل رسائی بحال کرنے کے لیے اپنا پلان اپ گریڈ کریں۔',
    ar: 'هذا الفرع مغلق بسبب قيود الخطة. قم بترقية خطتك لاستعادة الوصول الكامل.',
    action: 'open_upsell',
  },
  member_checkin_grace_expired: {
    en: 'The check-in grace period for this branch has expired.',
    ur: 'اس برانچ کے لیے چیک اِن کی رعایتی مدت ختم ہو چکی ہے۔',
    ar: 'انتهت فترة السماح لتسجيل الدخول في هذا الفرع.',
    action: 'open_upsell',
  },
  subscription_owned_by_other_account: {
    en: 'This subscription is already linked to another GymsEra account.',
    ur: 'یہ سبسکرپشن پہلے ہی دوسرے جمز ایرا اکاؤنٹ سے منسلک ہے۔',
    ar: 'هذا الاشتراك مرتبط بالفعل بحساب GymsEra آخر.',
    action: 'contact_owner',
  },
  duplicate_billing: {
    en: 'A superseded subscription is still billing at the store. Please manage your store subscriptions.',
    ur: 'پچھلی سبسکرپشن اب بھی بل ہو رہی ہے۔ براہ کرم اپنے اسٹور میں سبسکرپشن کا انتظام کریں۔',
    ar: 'لا تزال خطة سابقة تتم فوترتها عبر متجر التطبيقات. يرجى إدارتها من متجر التطبيقات.',
    action: 'contact_owner',
  },
  cross_provider_blocked: {
    en: 'You already have an active subscription on another platform. Please manage your existing subscription before switching.',
    ur: 'آپ کی سبسکرپشن پہلے ہی دوسرے پلیٹ فارم پر فعال ہے۔ نیا پلان خریدنے سے پہلے پرانی سبسکرپشن کا انتظام کریں۔',
    ar: 'لديك بالفعل اشتراك نشط على منصة أخرى. يرجى إدارة اشتراكك الحالي قبل التبديل.',
    action: 'contact_owner',
  },
  validation_error: {
    en: 'Some information you entered is invalid. Please review and correct it.',
    ur: 'درج کردہ معلومات درست نہیں ہے۔ براہ کرم جانچ پڑتال کریں۔',
    ar: 'بعض المعلومات المدخلة غير صحيحة. يرجى المراجعة والتصحيح.',
    action: 'retry',
  },
  tenant_not_found: {
    en: 'Tenant not found or not active.',
    ur: 'ادارہ نہیں ملا یا غیر فعال ہے۔',
    ar: 'المؤسسة غير موجودة أو غير نشطة.',
    action: 'none',
  },
  unauthorized: {
    en: 'You are not signed in or your session has expired. Please sign in again.',
    ur: 'آپ لاگ ان نہیں ہیں یا آپ کا سیشن ختم ہو چکا ہے۔ براہ کرم دوبارہ لاگ ان کریں۔',
    ar: 'لم يتم تسجيل دخولك أو انتهت جلستك. يرجى تسجيل الدخول مرة أخرى.',
    action: 'retry',
  },
  token_expired: {
    en: 'Your session token has expired. Please refresh your session or sign in again.',
    ur: 'آپ کا سیشن ٹوکن ختم ہو چکا ہے۔ براہ کرم دوبارہ لاگ ان کریں۔',
    ar: 'انتهت صلاحية رمز الجلسة. يرجى تسجيل الدخول مرة أخرى.',
    action: 'retry',
  },
  token_revoked: {
    en: 'Your session has been signed out or revoked. Please sign in again.',
    ur: 'آپ کا سیشن ختم کر دیا گیا ہے۔ براہ کرم دوبارہ لاگ ان کریں۔',
    ar: 'تم إلغاء الجلسة. يرجى تسجيل الدخول مرة أخرى.',
    action: 'retry',
  },
  forbidden: {
    en: 'You do not have permission to perform this action.',
    ur: 'آپ کو یہ کارروائی کرنے کی اجازت نہیں ہے۔',
    ar: 'ليس لديك الإذن للقيام بهذا الإجراء.',
    action: 'none',
  },
  not_found: {
    en: 'The requested resource was not found.',
    ur: 'درخواست کردہ ریکارڈ نہیں ملا۔',
    ar: 'المورد المطلوب غير موجود.',
    action: 'none',
  },
  conflict: {
    en: 'A record with this information already exists or has been modified.',
    ur: 'اس معلومات کے ساتھ ریکارڈ پہلے سے موجود ہے یا تبدیل ہو چکا ہے۔',
    ar: 'يوجد سجل بهذه البيانات بالفعل أو تم تعديله.',
    action: 'retry',
  },
  request_in_progress: {
    en: 'A request with this idempotency key is already in progress. Please wait.',
    ur: 'اس کلید کے ساتھ درخواست پر پہلے سے عمل جاری ہے۔ براہ کرم انتظار کریں۔',
    ar: 'الطلب قيد المعالجة بالفعل. يرجى الانتظار.',
    action: 'retry',
  },
  idempotency_key_reuse: {
    en: 'This idempotency key was previously used with a different request payload.',
    ur: 'یہ آئیڈیمپوٹینسی کلید پہلے مختلف ڈیٹا کے ساتھ استعمال ہو چکی ہے۔',
    ar: 'تم استخدام مفتاح عدم التكرار هذا مسبقاً مع حمولة مختلفة.',
    action: 'none',
  },
  rate_limit_exceeded: {
    en: 'Too many requests. Please wait a moment before trying again.',
    ur: 'بہت زیادہ درخواستیں۔ براہ کرم کچھ دیر بعد کوشش کریں۔',
    ar: 'طلبات كثيرة جداً. يرجى الانتظار لحظة والمحاولة لاحقاً.',
    action: 'retry',
  },
  internal_error: {
    en: 'An unexpected server error occurred. Please try again later.',
    ur: 'سرور کی غیر متوقع خرابی۔ براہ کرم کچھ دیر بعد کوشش کریں۔',
    ar: 'حدث خطأ غير متوقع في الخادم. يرجى المحاولة لاحقاً.',
    action: 'retry',
  },
  request_timeout: {
    en: 'The server took too long to process your request. Please try again.',
    ur: 'سرور کو آپ کی درخواست پر عمل کرنے میں بہت وقت لگا۔ براہ کرم دوبارہ کوشش کریں۔',
    ar: 'استغرق الخادم وقتاً أطول من المتوقع لمعالجة طلبك. يرجى المحاولة مرة أخرى.',
    action: 'retry',
  },
};

module.exports = { ERROR_COPY };
