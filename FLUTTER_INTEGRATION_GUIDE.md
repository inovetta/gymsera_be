# GymsEra Flutter Integration Guide

> **Generated from live codebase analysis — May 2026**  
> Base URL: `https://<your-domain>/api/v1`  
> Auth: JWT Bearer tokens (`Authorization: Bearer <accessToken>`)  
> Access token TTL: **15 min** · Refresh token TTL: **30 days**

---

## Table of Contents

1. [Architecture Blueprint](#1-architecture-blueprint)
2. [Dependency Setup](#2-dependency-setup)
3. [Type-Safe Data Models](#3-type-safe-data-models)
4. [Networking Layer — Dio Client](#4-networking-layer--dio-client)
5. [Repository Map](#5-repository-map)
   - 5.1 [Auth Repository](#51-auth-repository)
   - 5.2 [Me (Self-Service) Repository](#52-me-self-service-repository)
   - 5.3 [Cities Repository](#53-cities-repository)
   - 5.4 [Platform Packages Repository](#54-platform-packages-repository)
   - 5.5 [Tenants Repository](#55-tenants-repository)
   - 5.6 [Admin Repository](#56-admin-repository)
   - 5.7 [Gyms Repository](#57-gyms-repository)
   - 5.8 [Discovery Repository](#58-discovery-repository)
   - 5.9 [Membership Plans Repository](#59-membership-plans-repository)
   - 5.10 [Subscriptions Repository](#510-subscriptions-repository)
   - 5.11 [Payments Repository](#511-payments-repository)
   - 5.12 [Invoices Repository](#512-invoices-repository)
   - 5.13 [Attendance Repository](#513-attendance-repository)
   - 5.14 [Trainers Repository](#514-trainers-repository)
   - 5.15 [Reports Repository](#515-reports-repository)
   - 5.16 [Users Repository](#516-users-repository)
6. [File Upload Handling](#6-file-upload-handling)
7. [Pagination Synchronisation](#7-pagination-synchronisation)
8. [Error Handling Contract](#8-error-handling-contract)
9. [Rate Limiting Awareness](#9-rate-limiting-awareness)
10. [Role-Based Navigation Guards](#10-role-based-navigation-guards)

---

## 1. Architecture Blueprint

Feature-first folder structure using **flutter_riverpod** for state management and **go_router** for navigation.

```
lib/
├── core/
│   ├── constants/
│   │   ├── api_constants.dart          # Base URL, endpoint paths
│   │   ├── app_roles.dart              # UserRole enum
│   │   └── app_enums.dart             # All shared enums
│   ├── network/
│   │   ├── dio_client.dart            # Configured Dio singleton
│   │   ├── auth_interceptor.dart      # JWT injection
│   │   ├── error_interceptor.dart     # 401 refresh + error mapping
│   │   └── api_response.dart          # Generic response wrapper
│   ├── storage/
│   │   └── secure_storage.dart        # flutter_secure_storage wrapper
│   ├── errors/
│   │   └── app_exception.dart         # Domain exception types
│   └── router/
│       ├── app_router.dart            # go_router configuration
│       └── route_guards.dart          # Auth + role guards
│
├── features/
│   ├── auth/
│   │   ├── data/
│   │   │   ├── models/
│   │   │   │   ├── auth_response.dart
│   │   │   │   └── token_pair.dart
│   │   │   └── repositories/
│   │   │       └── auth_repository.dart
│   │   ├── domain/
│   │   │   └── auth_state.dart
│   │   └── presentation/
│   │       ├── providers/
│   │       │   └── auth_provider.dart
│   │       └── screens/
│   ├── me/
│   │   ├── data/models/
│   │   │   ├── user_profile.dart
│   │   │   └── account_statement.dart
│   │   └── data/repositories/
│   │       └── me_repository.dart
│   ├── discovery/
│   │   ├── data/models/
│   │   │   ├── gym_listing.dart
│   │   │   ├── gym_review.dart
│   │   │   └── map_pin.dart
│   │   └── data/repositories/
│   │       └── discovery_repository.dart
│   ├── membership_plans/
│   ├── subscriptions/
│   ├── payments/
│   ├── invoices/
│   ├── attendance/
│   ├── trainers/
│   ├── reports/
│   ├── gym_host/               # gyms/ routes (host-only)
│   ├── admin/
│   ├── cities/
│   ├── platform_packages/
│   └── users/
│
└── main.dart
```

---

## 2. Dependency Setup

```yaml
# pubspec.yaml
dependencies:
  flutter_riverpod: ^2.6.1
  riverpod_annotation: ^2.6.1
  go_router: ^14.6.3
  dio: ^5.7.0
  flutter_secure_storage: ^9.2.2
  freezed_annotation: ^2.4.4
  json_annotation: ^4.9.0
  image_picker: ^1.1.2
  path: ^1.9.0

dev_dependencies:
  build_runner: ^2.4.13
  freezed: ^2.5.7
  json_serializable: ^6.8.0
  riverpod_generator: ^2.6.1
```

---

## 3. Type-Safe Data Models

### 3.1 Enums

```dart
// lib/core/constants/app_enums.dart

enum UserRole { platformAdmin, gymHost, branchManager, trainer, member }

enum UserStatus { active, inactive, suspended }

enum TenantStatus {
  pendingReview, underReview, approved, rejected, suspended, active
}

enum KycStatus { notSubmitted, pending, approved, rejected }

enum GenderType { mixed, maleOnly, femaleOnly }

enum SubscriptionStatus { pending, active, frozen, expired, cancelled }

enum PaymentMethod { cash, bankTransfer, card, wallet, online, pos, test }

enum PaymentStatus { pending, completed, failed, refunded }

enum InvoiceStatus { draft, issued, paid, overdue, cancelled }

enum PaymentFor { membership, trainer, product, other }

enum DurationType { daily, weekly, monthly, quarterly, yearly }

enum BillingCycle { monthly, quarterly, yearly }

enum AttendanceType { checkIn, checkOut }

enum EntryMethod { qrScan, manual, rfid }

enum SourceChannel { online, walkIn, staff }

enum ReviewStatus { pending, approved, rejected }

enum EmploymentStatus { active, inactive, terminated }
```

### 3.2 Core API Response

```dart
// lib/core/network/api_response.dart
import 'package:freezed_annotation/freezed_annotation.dart';

part 'api_response.freezed.dart';
part 'api_response.g.dart';

@freezed
class ApiResponse<T> with _$ApiResponse<T> {
  const factory ApiResponse({
    required bool success,
    required String message,
    T? data,
    PaginationMeta? pagination,
  }) = _ApiResponse;

  factory ApiResponse.fromJson(
    Map<String, dynamic> json,
    T Function(Object?) fromJsonT,
  ) => _$ApiResponseFromJson(json, fromJsonT);
}

@freezed
class PaginationMeta with _$PaginationMeta {
  const factory PaginationMeta({
    required int total,
    required int page,
    required int limit,
    required int totalPages,
  }) = _PaginationMeta;

  factory PaginationMeta.fromJson(Map<String, dynamic> json) =>
      _$PaginationMetaFromJson(json);
}
```

### 3.3 User Model

```dart
// lib/features/auth/data/models/user_model.dart
import 'package:freezed_annotation/freezed_annotation.dart';
import '../../../../core/constants/app_enums.dart';

part 'user_model.freezed.dart';
part 'user_model.g.dart';

@freezed
class UserModel with _$UserModel {
  const factory UserModel({
    required String id,
    required String fullName,
    required String email,
    String? phone,
    required UserRole role,
    required UserStatus status,
    required bool isVerified,
    String? profileImageUrl,
    String? tenantId,
    DateTime? lastLoginAt,
    DateTime? createdAt,
  }) = _UserModel;

  factory UserModel.fromJson(Map<String, dynamic> json) =>
      _$UserModelFromJson(json);
}
```

### 3.4 Auth Response / Token Pair

```dart
// lib/features/auth/data/models/auth_response.dart
import 'package:freezed_annotation/freezed_annotation.dart';
import 'user_model.dart';

part 'auth_response.freezed.dart';
part 'auth_response.g.dart';

@freezed
class TokenPair with _$TokenPair {
  const factory TokenPair({
    required String accessToken,
    required String refreshToken,
  }) = _TokenPair;

  factory TokenPair.fromJson(Map<String, dynamic> json) =>
      _$TokenPairFromJson(json);
}

@freezed
class AuthResponse with _$AuthResponse {
  const factory AuthResponse({
    required String accessToken,
    required String refreshToken,
    required UserModel user,
  }) = _AuthResponse;

  factory AuthResponse.fromJson(Map<String, dynamic> json) =>
      _$AuthResponseFromJson(json);
}

@freezed
class RegisterResponse with _$RegisterResponse {
  const factory RegisterResponse({
    required String userId,
    required String email,
  }) = _RegisterResponse;

  factory RegisterResponse.fromJson(Map<String, dynamic> json) =>
      _$RegisterResponseFromJson(json);
}
```

### 3.5 GymListing Model

```dart
// lib/features/discovery/data/models/gym_listing.dart
import 'package:freezed_annotation/freezed_annotation.dart';
import '../../../../core/constants/app_enums.dart';

part 'gym_listing.freezed.dart';
part 'gym_listing.g.dart';

@freezed
class GymListing with _$GymListing {
  const factory GymListing({
    required String id,
    required String tenantId,
    String? branchId,
    required int cityId,
    int? areaId,
    required String title,
    String? shortDescription,
    String? logoUrl,
    String? coverImageUrl,
    GenderType? genderType,
    @Default(0.0) double averageRating,
    double? latitude,
    double? longitude,
    @Default(false) bool isFeatured,
    String? contactPhone,
    String? website,
    List<String>? facilitiesJson,
    required String status,
    DateTime? createdAt,
  }) = _GymListing;

  factory GymListing.fromJson(Map<String, dynamic> json) =>
      _$GymListingFromJson(json);
}

@freezed
class MapPin with _$MapPin {
  const factory MapPin({
    required String id,
    required String title,
    required double latitude,
    required double longitude,
    required double averageRating,
    String? logoUrl,
  }) = _MapPin;

  factory MapPin.fromJson(Map<String, dynamic> json) =>
      _$MapPinFromJson(json);
}
```

### 3.6 MembershipPlan Model

```dart
// lib/features/membership_plans/data/models/membership_plan.dart
import 'package:freezed_annotation/freezed_annotation.dart';
import '../../../../core/constants/app_enums.dart';

part 'membership_plan.freezed.dart';
part 'membership_plan.g.dart';

@freezed
class MembershipPlan with _$MembershipPlan {
  const factory MembershipPlan({
    required String id,
    required String gymId,
    String? branchId,
    required String name,
    String? description,
    required DurationType durationType,
    required int durationValue,
    required double price,
    @Default(0.0) double joiningFee,
    @Default(0.0) double securityFee,
    int? visitLimit,
    @Default(0) int freezeLimitDays,
    @Default(false) bool isTrial,
    required String status,
    String? posterUrl,
    DateTime? createdAt,
  }) = _MembershipPlan;

  factory MembershipPlan.fromJson(Map<String, dynamic> json) =>
      _$MembershipPlanFromJson(json);
}
```

### 3.7 MemberSubscription Model

```dart
// lib/features/subscriptions/data/models/member_subscription.dart
import 'package:freezed_annotation/freezed_annotation.dart';
import '../../../../core/constants/app_enums.dart';

part 'member_subscription.freezed.dart';
part 'member_subscription.g.dart';

@freezed
class MemberSubscription with _$MemberSubscription {
  const factory MemberSubscription({
    required String id,
    required String userId,
    required String branchId,
    required String membershipPlanId,
    required String startDate,
    required String endDate,
    required SubscriptionStatus status,
    @Default(false) bool autoRenew,
    String? qrCode,
    required DateTime subscribedAt,
    DateTime? cancelledAt,
    String? freezeFrom,
    String? freezeTo,
    int? remainingVisits,
    SourceChannel? sourceChannel,
    MembershipPlan? plan,
  }) = _MemberSubscription;

  factory MemberSubscription.fromJson(Map<String, dynamic> json) =>
      _$MemberSubscriptionFromJson(json);
}

@freezed
class UserGymMembership with _$UserGymMembership {
  const factory UserGymMembership({
    required String id,
    required String userId,
    required String tenantId,
    required String gymListingId,
    required String subscriptionId,
    String? gymName,
    String? planName,
    String? startDate,
    String? endDate,
    required SubscriptionStatus status,
  }) = _UserGymMembership;

  factory UserGymMembership.fromJson(Map<String, dynamic> json) =>
      _$UserGymMembershipFromJson(json);
}
```

### 3.8 Payment & Invoice Models

```dart
// lib/features/payments/data/models/payment_model.dart
import 'package:freezed_annotation/freezed_annotation.dart';
import '../../../../core/constants/app_enums.dart';

part 'payment_model.freezed.dart';
part 'payment_model.g.dart';

@freezed
class Payment with _$Payment {
  const factory Payment({
    required String id,
    required String userId,
    @Default(PaymentFor.membership) PaymentFor paymentFor,
    String? referenceEntityId,
    required PaymentMethod method,
    String? gatewayName,
    String? gatewayTransactionId,
    required double amount,
    @Default('PKR') String currency,
    required PaymentStatus status,
    DateTime? paidAt,
    DateTime? verifiedAt,
    String? verifiedBy,
    String? notes,
    String? proofUrl,
    String? rejectedReason,
    DateTime? createdAt,
  }) = _Payment;

  factory Payment.fromJson(Map<String, dynamic> json) =>
      _$PaymentFromJson(json);
}

@freezed
class Invoice with _$Invoice {
  const factory Invoice({
    required String id,
    required String userId,
    required String invoiceNo,
    required String invoiceType,
    String? referenceEntityId,
    required double subtotal,
    @Default(0.0) double discountAmount,
    @Default(0.0) double taxAmount,
    required double totalAmount,
    String? dueDate,
    DateTime? paidAt,
    required InvoiceStatus status,
    DateTime? createdAt,
  }) = _Invoice;

  factory Invoice.fromJson(Map<String, dynamic> json) =>
      _$InvoiceFromJson(json);
}
```

### 3.9 Tenant Model

```dart
// lib/features/tenants/data/models/tenant_model.dart
import 'package:freezed_annotation/freezed_annotation.dart';
import '../../../../core/constants/app_enums.dart';

part 'tenant_model.freezed.dart';
part 'tenant_model.g.dart';

@freezed
class TenantModel with _$TenantModel {
  const factory TenantModel({
    required String id,
    required String tenantCode,
    required String businessName,
    required String ownerUserId,
    required String email,
    String? phone,
    int? cityId,
    String? address,
    String? gymName,
    String? gymDescription,
    String? logoUrl,
    String? coverImageUrl,
    GenderType? genderType,
    required TenantStatus status,
    required KycStatus kycStatus,
    @Default(1) int onboardingStep,
    List<String>? kycDocumentsJson,
    String? selectedPackageId,
    DateTime? approvedAt,
    DateTime? rejectedAt,
    String? rejectionReason,
    DateTime? createdAt,
  }) = _TenantModel;

  factory TenantModel.fromJson(Map<String, dynamic> json) =>
      _$TenantModelFromJson(json);
}
```

### 3.10 Branch & Staff Models

```dart
// lib/features/gym_host/data/models/branch_model.dart
import 'package:freezed_annotation/freezed_annotation.dart';

part 'branch_model.freezed.dart';
part 'branch_model.g.dart';

@freezed
class Branch with _$Branch {
  const factory Branch({
    required String id,
    required String gymId,
    required String branchName,
    String? address,
    int? cityId,
    int? areaId,
    double? latitude,
    double? longitude,
    String? openingTime,
    String? closingTime,
    String? phone,
    List<String>? facilitiesJson,
    List<String>? imagesJson,
    required String status,
    DateTime? createdAt,
  }) = _Branch;

  factory Branch.fromJson(Map<String, dynamic> json) =>
      _$BranchFromJson(json);
}

@freezed
class GymStaff with _$GymStaff {
  const factory GymStaff({
    required String id,
    required String branchId,
    required String userId,
    String? designation,
    required String employmentStatus,
    DateTime? createdAt,
  }) = _GymStaff;

  factory GymStaff.fromJson(Map<String, dynamic> json) =>
      _$GymStaffFromJson(json);
}
```

### 3.11 Attendance & Trainer Models

```dart
// lib/features/attendance/data/models/attendance_log.dart
import 'package:freezed_annotation/freezed_annotation.dart';
import '../../../../core/constants/app_enums.dart';

part 'attendance_log.freezed.dart';
part 'attendance_log.g.dart';

@freezed
class AttendanceLog with _$AttendanceLog {
  const factory AttendanceLog({
    required String id,
    required String branchId,
    required String userId,
    required String memberSubscriptionId,
    required AttendanceType attendanceType,
    required DateTime checkInAt,
    DateTime? checkOutAt,
    required EntryMethod entryMethod,
    String? deviceId,
    String? notes,
    DateTime? createdAt,
  }) = _AttendanceLog;

  factory AttendanceLog.fromJson(Map<String, dynamic> json) =>
      _$AttendanceLogFromJson(json);
}

// lib/features/trainers/data/models/trainer_model.dart
@freezed
class TrainerModel with _$TrainerModel {
  const factory TrainerModel({
    required String id,
    required String userId,
    String? branchId,
    String? specialization,
    String? bio,
    @Default(0) int yearsExperience,
    List<dynamic>? certificationsJson,
    Map<String, dynamic>? availabilityJson,
    @Default(0.0) double ratingAvg,
    required String status,
    DateTime? createdAt,
  }) = _TrainerModel;

  factory TrainerModel.fromJson(Map<String, dynamic> json) =>
      _$TrainerModelFromJson(json);
}
```

### 3.12 Additional Platform Models

```dart
// lib/features/cities/data/models/city_model.dart
@freezed
class City with _$City {
  const factory City({
    required int id,
    required String name,
    @Default(true) bool isActive,
    List<Area>? areas,
  }) = _City;
  factory City.fromJson(Map<String, dynamic> json) => _$CityFromJson(json);
}

@freezed
class Area with _$Area {
  const factory Area({
    required int id,
    required int cityId,
    required String name,
  }) = _Area;
  factory Area.fromJson(Map<String, dynamic> json) => _$AreaFromJson(json);
}

// lib/features/platform_packages/data/models/platform_package.dart
@freezed
class PlatformPackage with _$PlatformPackage {
  const factory PlatformPackage({
    required String id,
    required String name,
    String? description,
    required double price,
    required BillingCycle billingCycle,
    @Default(1) int maxBranches,
    @Default(5) int maxTrainers,
    @Default(200) int maxMembers,
    Map<String, dynamic>? featureFlagsJson,
    required String status,
  }) = _PlatformPackage;
  factory PlatformPackage.fromJson(Map<String, dynamic> json) =>
      _$PlatformPackageFromJson(json);
}

// lib/features/discovery/data/models/gym_review.dart
@freezed
class GymReview with _$GymReview {
  const factory GymReview({
    required String id,
    required String gymListingId,
    required String userId,
    required String tenantId,
    required int rating,
    String? title,
    String? body,
    required ReviewStatus status,
    String? adminNote,
    DateTime? createdAt,
  }) = _GymReview;
  factory GymReview.fromJson(Map<String, dynamic> json) =>
      _$GymReviewFromJson(json);
}
```

---

## 4. Networking Layer — Dio Client

### 4.1 Secure Token Storage

```dart
// lib/core/storage/secure_storage.dart
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

part 'secure_storage.g.dart';

@riverpod
SecureTokenStorage secureTokenStorage(SecureTokenStorageRef ref) =>
    SecureTokenStorage();

class SecureTokenStorage {
  final FlutterSecureStorage _storage = const FlutterSecureStorage();

  static const _accessKey = 'access_token';
  static const _refreshKey = 'refresh_token';

  Future<void> saveTokens(String access, String refresh) async {
    await Future.wait([
      _storage.write(key: _accessKey, value: access),
      _storage.write(key: _refreshKey, value: refresh),
    ]);
  }

  Future<String?> getAccessToken() => _storage.read(key: _accessKey);
  Future<String?> getRefreshToken() => _storage.read(key: _refreshKey);

  Future<void> clearTokens() async {
    await Future.wait([
      _storage.delete(key: _accessKey),
      _storage.delete(key: _refreshKey),
    ]);
  }
}
```

### 4.2 API Constants

```dart
// lib/core/constants/api_constants.dart
class ApiConstants {
  static const String baseUrl = 'https://<your-domain>/api/v1';

  // Auth
  static const String register = '/auth/register';
  static const String otpVerify = '/auth/otp/verify';
  static const String otpResend = '/auth/otp/resend';
  static const String login = '/auth/login';
  static const String socialGoogle = '/auth/social/google';
  static const String refresh = '/auth/refresh';
  static const String passwordResetRequest = '/auth/password-reset/request';
  static const String passwordResetConfirm = '/auth/password-reset/confirm';
  static const String authMe = '/auth/me';

  // Me
  static const String meProfile = '/me/profile';
  static const String mePassword = '/me/password';
  static const String meProfileImage = '/me/profile-image';
  static const String meSubscriptions = '/me/subscriptions';
  static const String meAccountStatement = '/me/account-statement';
  static const String meAccountStatementExport = '/me/account-statement/export';
  static const String mePaymentRequests = '/me/payment-requests';
  static const String mePaymentRequest = '/me/payment-request';
  static String mePaymentProof(String id) => '/me/payment-requests/$id/proof';

  // Cities
  static const String cities = '/cities';
  static String cityAreas(int id) => '/cities/$id/areas';
  static String cityArea(int cityId, int areaId) => '/cities/$cityId/areas/$areaId';

  // Platform Packages
  static const String platformPackages = '/platform-packages';
  static String platformPackage(String id) => '/platform-packages/$id';

  // Tenants
  static const String tenantsMe = '/tenants/me';
  static const String tenantsRegister = '/tenants/register';
  static String tenantGymProfile(String id) => '/tenants/$id/gym-profile';
  static String tenantSelectPackage(String id) => '/tenants/$id/select-package';

  // Admin
  static const String adminTenants = '/admin/tenants';
  static String adminTenant(String id) => '/admin/tenants/$id';
  static String adminApproveTenant(String id) => '/admin/tenants/$id/approve';
  static String adminRejectTenant(String id) => '/admin/tenants/$id/reject';
  static const String adminPlatformReport = '/admin/reports/platform';
  static const String adminReviews = '/admin/reviews';
  static String adminModerateReview(String id) => '/admin/reviews/$id/moderate';

  // Gyms (Host)
  static const String gymProfile = '/gyms/profile';
  static const String gymBranches = '/gyms/branches';
  static String gymBranch(String branchId) => '/gyms/branches/$branchId';
  static String gymBranchStaff(String branchId) => '/gyms/branches/$branchId/staff';
  static String gymBranchStaffMember(String branchId, String staffId) =>
      '/gyms/branches/$branchId/staff/$staffId';

  // Discovery
  static const String discoveryCities = '/discovery/cities';
  static const String discoveryGymsFeatured = '/discovery/gyms/featured';
  static const String discoveryGymsTopRated = '/discovery/gyms/top-rated';
  static const String discoveryGymsNearby = '/discovery/gyms/nearby';
  static const String discoveryGymsMap = '/discovery/gyms/map';
  static const String discoveryGyms = '/discovery/gyms';
  static String discoveryGym(String id) => '/discovery/gyms/$id';
  static String discoveryGymReviews(String id) => '/discovery/gyms/$id/reviews';

  // Membership Plans
  static const String membershipPlans = '/membership-plans';
  static const String membershipPlansHost = '/membership-plans/host';
  static String membershipPlan(String id) => '/membership-plans/$id';
  static String membershipPlanStatus(String id) => '/membership-plans/$id/status';
  static String membershipPlanPoster(String id) => '/membership-plans/$id/poster';

  // Subscriptions
  static const String subscriptions = '/subscriptions';
  static String subscriptionFreeze(String id) => '/subscriptions/$id/freeze';
  static String subscriptionCancel(String id) => '/subscriptions/$id/cancel';
  static String subscriptionRenew(String id) => '/subscriptions/$id/renew';
  static const String subscriptionPreview = '/subscriptions/preview';
  static const String subscriptionsStaff = '/subscriptions/staff';
  static String subscriptionStaff(String id) => '/subscriptions/staff/$id';

  // Payments
  static const String payments = '/payments';
  static String paymentVerify(String id) => '/payments/$id/verify';
  static String paymentAction(String id) => '/payments/$id/action';
  static String paymentProof(String id) => '/payments/$id/proof';
  static const String paymentCollectionAction = '/payments/collection-action';

  // Invoices
  static const String invoices = '/invoices';
  static String invoice(String id) => '/invoices/$id';

  // Attendance
  static const String attendanceQrScan = '/attendance/qr-scan';
  static const String attendanceManual = '/attendance/manual';
  static const String attendance = '/attendance';
  static const String attendanceToday = '/attendance/today';
  static const String attendanceRange = '/attendance/range';
  static String attendanceCustomer(String userId) => '/attendance/customer/$userId';
  static String attendanceReport(String period) => '/attendance/report/$period';

  // Trainers
  static const String trainers = '/trainers';
  static String trainer(String id) => '/trainers/$id';
  static String trainerAssign(String id) => '/trainers/$id/assign';

  // Reports
  static const String reportsDashboard = '/reports/dashboard';
  static const String reportsMonthly = '/reports/monthly';
  static const String reportsMonthlyExportPdf = '/reports/monthly/export-pdf';
  static const String reportsMonthlyPrintLayout = '/reports/monthly/print-layout';

  // Users
  static const String users = '/users';
  static String user(String id) => '/users/$id';
  static String userStatus(String id) => '/users/$id/status';
  static String userPassword(String id) => '/users/$id/password';
  static String userProfileImage(String id) => '/users/$id/profile-image';
  static String userAccountStatement(String id) => '/users/$id/account-statement';
  static String userAccountStatementExport(String id) =>
      '/users/$id/account-statement/export';

  // Health
  static const String health = '/health';
}
```

### 4.3 App Exception

```dart
// lib/core/errors/app_exception.dart
sealed class AppException implements Exception {
  final String message;
  const AppException(this.message);
}

class UnauthorizedException extends AppException {
  const UnauthorizedException([super.message = 'Session expired. Please log in again.']);
}

class ForbiddenException extends AppException {
  const ForbiddenException([super.message = 'You do not have permission to perform this action.']);
}

class NotFoundException extends AppException {
  const NotFoundException([super.message = 'The requested resource was not found.']);
}

class ConflictException extends AppException {
  const ConflictException(super.message);
}

class ValidationException extends AppException {
  final List<String> errors;
  const ValidationException(super.message, {this.errors = const []});
}

class RateLimitException extends AppException {
  const RateLimitException([super.message = 'Too many requests. Please try again later.']);
}

class ServerException extends AppException {
  final int? statusCode;
  const ServerException(super.message, {this.statusCode});
}

class NetworkException extends AppException {
  const NetworkException([super.message = 'No internet connection.']);
}
```

### 4.4 Auth Interceptor

```dart
// lib/core/network/auth_interceptor.dart
import 'package:dio/dio.dart';
import '../storage/secure_storage.dart';

class AuthInterceptor extends Interceptor {
  final SecureTokenStorage _storage;

  AuthInterceptor(this._storage);

  @override
  Future<void> onRequest(
    RequestOptions options,
    RequestInterceptorHandler handler,
  ) async {
    // Skip token injection for public auth endpoints
    const publicPaths = [
      '/auth/register',
      '/auth/login',
      '/auth/otp/verify',
      '/auth/otp/resend',
      '/auth/social/google',
      '/auth/refresh',
      '/auth/password-reset/request',
      '/auth/password-reset/confirm',
    ];

    final isPublic = publicPaths.any((p) => options.path.endsWith(p));
    if (!isPublic) {
      final token = await _storage.getAccessToken();
      if (token != null) {
        options.headers['Authorization'] = 'Bearer $token';
      }
    }
    handler.next(options);
  }
}
```

### 4.5 Error & Refresh Interceptor

```dart
// lib/core/network/error_interceptor.dart
import 'package:dio/dio.dart';
import '../constants/api_constants.dart';
import '../errors/app_exception.dart';
import '../storage/secure_storage.dart';

class ErrorInterceptor extends Interceptor {
  final Dio _dio;
  final SecureTokenStorage _storage;
  final Future<void> Function() _onSessionExpired;

  ErrorInterceptor(this._dio, this._storage, this._onSessionExpired);

  @override
  Future<void> onError(
    DioException err,
    ErrorInterceptorHandler handler,
  ) async {
    final response = err.response;

    if (response == null) {
      return handler.reject(
        err.copyWith(error: const NetworkException()),
      );
    }

    final statusCode = response.statusCode ?? 0;
    final message = _extractMessage(response.data);

    // 401 — attempt silent token refresh once
    if (statusCode == 401 &&
        !err.requestOptions.path.contains('/auth/refresh')) {
      try {
        final refreshToken = await _storage.getRefreshToken();
        if (refreshToken == null) throw Exception('No refresh token');

        final refreshResponse = await _dio.post(
          ApiConstants.refresh,
          data: {'refreshToken': refreshToken},
          options: Options(extra: {'skipAuthInterceptor': true}),
        );

        final data = refreshResponse.data['data'];
        final newAccess = data['accessToken'] as String;
        final newRefresh = data['refreshToken'] as String;
        await _storage.saveTokens(newAccess, newRefresh);

        // Retry the original request with the new token
        err.requestOptions.headers['Authorization'] = 'Bearer $newAccess';
        final retried = await _dio.fetch(err.requestOptions);
        return handler.resolve(retried);
      } catch (_) {
        await _storage.clearTokens();
        await _onSessionExpired();
        return handler.reject(
          err.copyWith(error: const UnauthorizedException()),
        );
      }
    }

    final appException = switch (statusCode) {
      401 => const UnauthorizedException(),
      403 => const ForbiddenException(),
      404 => NotFoundException(message),
      409 => ConflictException(message),
      422 => ValidationException(message),
      429 => const RateLimitException(),
      _ => ServerException(message, statusCode: statusCode),
    };

    handler.reject(err.copyWith(error: appException));
  }

  String _extractMessage(dynamic data) {
    if (data is Map<String, dynamic>) {
      return data['message']?.toString() ?? 'An unexpected error occurred.';
    }
    return 'An unexpected error occurred.';
  }
}
```

### 4.6 Dio Client Assembly

```dart
// lib/core/network/dio_client.dart
import 'package:dio/dio.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';
import '../constants/api_constants.dart';
import '../storage/secure_storage.dart';
import 'auth_interceptor.dart';
import 'error_interceptor.dart';

part 'dio_client.g.dart';

@riverpod
Dio dioClient(DioClientRef ref) {
  final storage = ref.watch(secureTokenStorageProvider);

  final dio = Dio(
    BaseOptions(
      baseUrl: ApiConstants.baseUrl,
      connectTimeout: const Duration(seconds: 15),
      receiveTimeout: const Duration(seconds: 30),
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    ),
  );

  dio.interceptors.addAll([
    AuthInterceptor(storage),
    ErrorInterceptor(
      dio,
      storage,
      () async {
        // Navigate to login — resolve via a global nav key or signal provider
        ref.read(sessionExpiredProvider.notifier).trigger();
      },
    ),
    LogInterceptor(
      requestBody: true,
      responseBody: true,
      logPrint: (o) => debugPrint(o.toString()),
    ),
  ]);

  return dio;
}

// Simple notifier to signal logout from interceptor
@riverpod
class SessionExpired extends _$SessionExpired {
  @override
  bool build() => false;
  void trigger() => state = true;
}
```

---

## 5. Repository Map

All repositories follow the same base pattern:

```dart
abstract class BaseRepository {
  final Dio dio;
  const BaseRepository(this.dio);
}
```

---

### 5.1 Auth Repository

**Backed by**: `POST /auth/register`, `POST /auth/otp/verify`, `POST /auth/otp/resend`, `POST /auth/login`, `POST /auth/social/google`, `POST /auth/refresh`, `POST /auth/password-reset/request`, `POST /auth/password-reset/confirm`, `GET /auth/me`

> **Rate limit**: 20 requests / 15 minutes on all `/auth` routes.

```dart
// lib/features/auth/data/repositories/auth_repository.dart
import 'package:dio/dio.dart';
import '../../../../core/constants/api_constants.dart';
import '../models/auth_response.dart';
import '../models/user_model.dart';

class AuthRepository {
  final Dio _dio;
  const AuthRepository(this._dio);

  /// POST /auth/register
  /// Body: { fullName, email, password, phone? }
  /// Returns: { userId, email }
  Future<RegisterResponse> register({
    required String fullName,
    required String email,
    required String password,
    String? phone,
  }) async {
    final response = await _dio.post(
      ApiConstants.register,
      data: {
        'fullName': fullName,
        'email': email,
        'password': password,
        if (phone != null) 'phone': phone,
      },
    );
    return RegisterResponse.fromJson(response.data['data']);
  }

  /// POST /auth/otp/verify
  /// Body: { email, code }  — code is a 6-digit string
  /// Returns: { accessToken, refreshToken, user }
  Future<AuthResponse> verifyOtp({
    required String email,
    required String code,
  }) async {
    final response = await _dio.post(
      ApiConstants.otpVerify,
      data: {'email': email, 'code': code},
    );
    return AuthResponse.fromJson(response.data['data']);
  }

  /// POST /auth/otp/resend
  /// Body: { email }
  Future<void> resendOtp({required String email}) async {
    await _dio.post(ApiConstants.otpResend, data: {'email': email});
  }

  /// POST /auth/login
  /// Body: { email, password }
  /// Returns: { accessToken, refreshToken, user }
  Future<AuthResponse> login({
    required String email,
    required String password,
  }) async {
    final response = await _dio.post(
      ApiConstants.login,
      data: {'email': email, 'password': password},
    );
    return AuthResponse.fromJson(response.data['data']);
  }

  /// POST /auth/social/google
  /// Body: { idToken }  — Google ID token from Firebase/Google Sign-In SDK
  /// Returns: { accessToken, refreshToken, user }
  Future<AuthResponse> googleLogin({required String idToken}) async {
    final response = await _dio.post(
      ApiConstants.socialGoogle,
      data: {'idToken': idToken},
    );
    return AuthResponse.fromJson(response.data['data']);
  }

  /// POST /auth/refresh
  /// Body: { refreshToken }
  /// Returns: { accessToken, refreshToken }
  /// NOTE: This is called automatically by ErrorInterceptor on 401 — you
  /// do NOT need to call it manually in most cases.
  Future<TokenPair> refreshToken({required String refreshToken}) async {
    final response = await _dio.post(
      ApiConstants.refresh,
      data: {'refreshToken': refreshToken},
    );
    return TokenPair.fromJson(response.data['data']);
  }

  /// POST /auth/password-reset/request
  /// Body: { email }
  /// Always returns 200 to prevent email enumeration.
  Future<void> requestPasswordReset({required String email}) async {
    await _dio.post(
      ApiConstants.passwordResetRequest,
      data: {'email': email},
    );
  }

  /// POST /auth/password-reset/confirm
  /// Body: { email, code, password }
  /// password must: ≥8 chars, 1 uppercase, 1 lowercase, 1 digit, 1 special char
  Future<void> confirmPasswordReset({
    required String email,
    required String code,
    required String password,
  }) async {
    await _dio.post(
      ApiConstants.passwordResetConfirm,
      data: {'email': email, 'code': code, 'password': password},
    );
  }

  /// GET /auth/me — JWT introspection (no DB call, just decodes the token)
  /// Returns: { sub, email, role, tenantId, isVerified }
  Future<Map<String, dynamic>> introspect() async {
    final response = await _dio.get(ApiConstants.authMe);
    return Map<String, dynamic>.from(response.data['data']);
  }
}
```

---

### 5.2 Me (Self-Service) Repository

**Backed by**: All `/me/*` routes — require JWT (any role)

```dart
// lib/features/me/data/repositories/me_repository.dart
import 'package:dio/dio.dart';
import '../../../../core/constants/api_constants.dart';
import '../models/user_profile.dart';

class MeRepository {
  final Dio _dio;
  const MeRepository(this._dio);

  /// GET /me/profile — full DB profile including MemberProfile fitness fields
  Future<Map<String, dynamic>> getProfile() async {
    final response = await _dio.get(ApiConstants.meProfile);
    return Map<String, dynamic>.from(response.data['data']);
  }

  /// PUT /me/profile
  /// Body (all optional): { fullName, phone, gender, dateOfBirth, heightCm, weightKg, fitnessGoal }
  /// gender enum: MALE | FEMALE | OTHER
  /// dateOfBirth format: YYYY-MM-DD
  Future<Map<String, dynamic>> updateProfile({
    String? fullName,
    String? phone,
    String? gender,
    String? dateOfBirth,
    double? heightCm,
    double? weightKg,
    String? fitnessGoal,
  }) async {
    final response = await _dio.put(
      ApiConstants.meProfile,
      data: {
        if (fullName != null) 'fullName': fullName,
        if (phone != null) 'phone': phone,
        if (gender != null) 'gender': gender,
        if (dateOfBirth != null) 'dateOfBirth': dateOfBirth,
        if (heightCm != null) 'heightCm': heightCm,
        if (weightKg != null) 'weightKg': weightKg,
        if (fitnessGoal != null) 'fitnessGoal': fitnessGoal,
      },
    );
    return Map<String, dynamic>.from(response.data['data']);
  }

  /// POST /me/password
  /// Body: { currentPassword, newPassword }
  Future<void> changePassword({
    required String currentPassword,
    required String newPassword,
  }) async {
    await _dio.post(
      ApiConstants.mePassword,
      data: {'currentPassword': currentPassword, 'newPassword': newPassword},
    );
  }

  /// POST /me/profile-image — multipart/form-data, field name: "image"
  /// Accepts: JPEG, PNG, WebP — max 10 MB
  /// See §6 for MultipartFile usage
  Future<String> uploadProfileImage(String filePath) async {
    final formData = FormData.fromMap({
      'image': await MultipartFile.fromFile(filePath, filename: 'profile.jpg'),
    });
    final response = await _dio.post(
      ApiConstants.meProfileImage,
      data: formData,
      options: Options(contentType: 'multipart/form-data'),
    );
    return response.data['data']['profileImageUrl'] as String;
  }

  /// GET /me/subscriptions
  /// Query: ?status=PENDING|ACTIVE|FROZEN|EXPIRED|CANCELLED, ?page=1, ?limit=10 (max 50)
  Future<Map<String, dynamic>> listSubscriptions({
    String? status,
    int page = 1,
    int limit = 10,
  }) async {
    final response = await _dio.get(
      ApiConstants.meSubscriptions,
      queryParameters: {
        if (status != null) 'status': status,
        'page': page,
        'limit': limit,
      },
    );
    return response.data;
  }

  /// GET /me/account-statement
  /// Query: ?from=YYYY-MM-DD, ?to=YYYY-MM-DD, ?page=1, ?limit=20
  Future<Map<String, dynamic>> getAccountStatement({
    String? from,
    String? to,
    int page = 1,
    int limit = 20,
  }) async {
    final response = await _dio.get(
      ApiConstants.meAccountStatement,
      queryParameters: {
        if (from != null) 'from': from,
        if (to != null) 'to': to,
        'page': page,
        'limit': limit,
      },
    );
    return response.data;
  }

  /// GET /me/account-statement/export — returns PDF binary
  /// Use openFilex or share_plus to present the downloaded file
  Future<List<int>> exportAccountStatement() async {
    final response = await _dio.get(
      ApiConstants.meAccountStatementExport,
      options: Options(responseType: ResponseType.bytes),
    );
    return List<int>.from(response.data);
  }

  /// GET /me/payment-requests — list own pending payment requests
  Future<Map<String, dynamic>> getPaymentRequests() async {
    final response = await _dio.get(ApiConstants.mePaymentRequests);
    return response.data;
  }

  /// POST /me/payment-request
  /// Body: { subscriptionId (uuid), method (CASH|BANK_TRANSFER|ONLINE|POS), amount, notes? }
  Future<Map<String, dynamic>> submitPaymentRequest({
    required String subscriptionId,
    required String method,
    required double amount,
    String? notes,
  }) async {
    final response = await _dio.post(
      ApiConstants.mePaymentRequest,
      data: {
        'subscriptionId': subscriptionId,
        'method': method,
        'amount': amount,
        if (notes != null) 'notes': notes,
      },
    );
    return Map<String, dynamic>.from(response.data['data']);
  }

  /// POST /me/payment-requests/:id/proof — multipart/form-data, field: "image"
  Future<void> uploadPaymentProof({
    required String paymentRequestId,
    required String filePath,
  }) async {
    final formData = FormData.fromMap({
      'image': await MultipartFile.fromFile(filePath, filename: 'proof.jpg'),
    });
    await _dio.post(
      ApiConstants.mePaymentProof(paymentRequestId),
      data: formData,
      options: Options(contentType: 'multipart/form-data'),
    );
  }
}
```

---

### 5.3 Cities Repository

**Backed by**: `/cities` routes

```dart
// lib/features/cities/data/repositories/cities_repository.dart
class CitiesRepository {
  final Dio _dio;
  const CitiesRepository(this._dio);

  /// GET /cities — public; admins also see inactive cities
  Future<List<City>> listCities() async {
    final response = await _dio.get(ApiConstants.cities);
    return (response.data['data']['cities'] as List)
        .map((e) => City.fromJson(e))
        .toList();
  }

  /// GET /cities/:id/areas — public
  Future<Map<String, dynamic>> listAreas(int cityId) async {
    final response = await _dio.get(ApiConstants.cityAreas(cityId));
    return Map<String, dynamic>.from(response.data['data']);
  }

  /// POST /cities — PLATFORM_ADMIN only
  /// Body: { name, isActive? }
  Future<City> createCity({required String name, bool? isActive}) async {
    final response = await _dio.post(
      ApiConstants.cities,
      data: {'name': name, if (isActive != null) 'isActive': isActive},
    );
    return City.fromJson(response.data['data']);
  }

  /// PATCH /cities/:id — PLATFORM_ADMIN only
  /// Body: { name?, isActive? }
  Future<City> updateCity(int id, {String? name, bool? isActive}) async {
    final response = await _dio.patch(
      '/cities/$id',
      data: {
        if (name != null) 'name': name,
        if (isActive != null) 'isActive': isActive,
      },
    );
    return City.fromJson(response.data['data']);
  }

  /// POST /cities/:id/areas — PLATFORM_ADMIN only
  /// Body: { name }
  Future<Area> createArea(int cityId, {required String name}) async {
    final response = await _dio.post(
      ApiConstants.cityAreas(cityId),
      data: {'name': name},
    );
    return Area.fromJson(response.data['data']);
  }

  /// PATCH /cities/:id/areas/:areaId — PLATFORM_ADMIN only
  /// Body: { name? }
  Future<Area> updateArea(int cityId, int areaId, {String? name}) async {
    final response = await _dio.patch(
      ApiConstants.cityArea(cityId, areaId),
      data: {if (name != null) 'name': name},
    );
    return Area.fromJson(response.data['data']);
  }
}
```

---

### 5.4 Platform Packages Repository

**Backed by**: `/platform-packages` routes

```dart
// lib/features/platform_packages/data/repositories/packages_repository.dart
class PlatformPackagesRepository {
  final Dio _dio;
  const PlatformPackagesRepository(this._dio);

  /// GET /platform-packages — public (admins see inactive too)
  Future<List<PlatformPackage>> listPackages() async {
    final response = await _dio.get(ApiConstants.platformPackages);
    return (response.data['data']['packages'] as List)
        .map((e) => PlatformPackage.fromJson(e))
        .toList();
  }

  /// GET /platform-packages/:id — public
  Future<PlatformPackage> getPackage(String id) async {
    final response = await _dio.get(ApiConstants.platformPackage(id));
    return PlatformPackage.fromJson(response.data['data']);
  }

  /// POST /platform-packages — PLATFORM_ADMIN only
  /// Body: { name, price, description?, billingCycle (MONTHLY|QUARTERLY|YEARLY)?,
  ///         maxBranches?, maxTrainers?, maxMembers?, featureFlagsJson? }
  Future<PlatformPackage> createPackage({
    required String name,
    required double price,
    String? description,
    String? billingCycle,
    int? maxBranches,
    int? maxTrainers,
    int? maxMembers,
    Map<String, dynamic>? featureFlagsJson,
  }) async {
    final response = await _dio.post(
      ApiConstants.platformPackages,
      data: {
        'name': name,
        'price': price,
        if (description != null) 'description': description,
        if (billingCycle != null) 'billingCycle': billingCycle,
        if (maxBranches != null) 'maxBranches': maxBranches,
        if (maxTrainers != null) 'maxTrainers': maxTrainers,
        if (maxMembers != null) 'maxMembers': maxMembers,
        if (featureFlagsJson != null) 'featureFlagsJson': featureFlagsJson,
      },
    );
    return PlatformPackage.fromJson(response.data['data']);
  }

  /// PATCH /platform-packages/:id — PLATFORM_ADMIN only
  /// Body: same fields as create + status (ACTIVE|INACTIVE)
  Future<PlatformPackage> updatePackage(
    String id, {
    String? name,
    String? description,
    double? price,
    String? billingCycle,
    int? maxBranches,
    int? maxTrainers,
    int? maxMembers,
    Map<String, dynamic>? featureFlagsJson,
    String? status,
  }) async {
    final response = await _dio.patch(
      ApiConstants.platformPackage(id),
      data: {
        if (name != null) 'name': name,
        if (description != null) 'description': description,
        if (price != null) 'price': price,
        if (billingCycle != null) 'billingCycle': billingCycle,
        if (maxBranches != null) 'maxBranches': maxBranches,
        if (maxTrainers != null) 'maxTrainers': maxTrainers,
        if (maxMembers != null) 'maxMembers': maxMembers,
        if (featureFlagsJson != null) 'featureFlagsJson': featureFlagsJson,
        if (status != null) 'status': status,
      },
    );
    return PlatformPackage.fromJson(response.data['data']);
  }
}
```

---

### 5.5 Tenants Repository

**Backed by**: `/tenants` routes

```dart
// lib/features/tenants/data/repositories/tenants_repository.dart
class TenantsRepository {
  final Dio _dio;
  const TenantsRepository(this._dio);

  /// GET /tenants/me — GYM_HOST only; gets own tenant record
  Future<TenantModel> getMyTenant() async {
    final response = await _dio.get(ApiConstants.tenantsMe);
    return TenantModel.fromJson(response.data['data']);
  }

  /// POST /tenants/register
  /// Promotes the caller to GYM_HOST role; creates tenant in PENDING_REVIEW.
  /// Body: { businessName, email, phone?, cityId? }
  Future<TenantModel> registerTenant({
    required String businessName,
    required String email,
    String? phone,
    int? cityId,
  }) async {
    final response = await _dio.post(
      ApiConstants.tenantsRegister,
      data: {
        'businessName': businessName,
        'email': email,
        if (phone != null) 'phone': phone,
        if (cityId != null) 'cityId': cityId,
      },
    );
    return TenantModel.fromJson(response.data['data']);
  }

  /// POST /tenants/:id/gym-profile — GYM_HOST only
  /// Advances onboardingStep from 1 → 2; sets kycStatus to PENDING.
  /// Body: { gymName, gymDescription?, genderType (MIXED|MALE_ONLY|FEMALE_ONLY)?,
  ///         address?, kycDocumentsJson (array of URLs)?, logoUrl?, coverImageUrl? }
  Future<TenantModel> submitGymProfile(
    String tenantId, {
    required String gymName,
    String? gymDescription,
    String? genderType,
    String? address,
    List<String>? kycDocumentsJson,
    String? logoUrl,
    String? coverImageUrl,
  }) async {
    final response = await _dio.post(
      ApiConstants.tenantGymProfile(tenantId),
      data: {
        'gymName': gymName,
        if (gymDescription != null) 'gymDescription': gymDescription,
        if (genderType != null) 'genderType': genderType,
        if (address != null) 'address': address,
        if (kycDocumentsJson != null) 'kycDocumentsJson': kycDocumentsJson,
        if (logoUrl != null) 'logoUrl': logoUrl,
        if (coverImageUrl != null) 'coverImageUrl': coverImageUrl,
      },
    );
    return TenantModel.fromJson(response.data['data']);
  }

  /// POST /tenants/:id/select-package — GYM_HOST only
  /// Advances onboardingStep from 2 → 3.
  /// Body: { packageId (uuid) }
  Future<TenantModel> selectPackage(
    String tenantId, {
    required String packageId,
  }) async {
    final response = await _dio.post(
      ApiConstants.tenantSelectPackage(tenantId),
      data: {'packageId': packageId},
    );
    return TenantModel.fromJson(response.data['data']);
  }
}
```

---

### 5.6 Admin Repository

**Backed by**: `/admin/*` routes — PLATFORM_ADMIN only

```dart
// lib/features/admin/data/repositories/admin_repository.dart
class AdminRepository {
  final Dio _dio;
  const AdminRepository(this._dio);

  /// GET /admin/tenants
  /// Query: ?status=PENDING_REVIEW|UNDER_REVIEW|APPROVED|REJECTED|SUSPENDED|ACTIVE,
  ///        ?page=1, ?limit=20
  Future<Map<String, dynamic>> listTenants({
    String? status,
    int page = 1,
    int limit = 20,
  }) async {
    final response = await _dio.get(
      ApiConstants.adminTenants,
      queryParameters: {
        if (status != null) 'status': status,
        'page': page,
        'limit': limit,
      },
    );
    return response.data;
  }

  /// GET /admin/tenants/:id
  Future<TenantModel> getTenant(String id) async {
    final response = await _dio.get(ApiConstants.adminTenant(id));
    return TenantModel.fromJson(response.data['data']);
  }

  /// POST /admin/tenants/:id/approve
  /// Triggers async DB provisioning — status moves to ACTIVE when done.
  Future<void> approveTenant(String id) async {
    await _dio.post(ApiConstants.adminApproveTenant(id));
  }

  /// POST /admin/tenants/:id/reject
  /// Body: { reason } — sent to gym host via email
  Future<void> rejectTenant(String id, {required String reason}) async {
    await _dio.post(
      ApiConstants.adminRejectTenant(id),
      data: {'reason': reason},
    );
  }

  /// GET /admin/reports/platform — platform-wide analytics summary
  Future<Map<String, dynamic>> getPlatformReport() async {
    final response = await _dio.get(ApiConstants.adminPlatformReport);
    return Map<String, dynamic>.from(response.data['data']);
  }

  /// GET /admin/reviews
  /// Query: ?status=PENDING|APPROVED|REJECTED, ?gymListingId=uuid,
  ///        ?page=1, ?limit=20
  Future<Map<String, dynamic>> listReviews({
    String? status,
    String? gymListingId,
    int page = 1,
    int limit = 20,
  }) async {
    final response = await _dio.get(
      ApiConstants.adminReviews,
      queryParameters: {
        if (status != null) 'status': status,
        if (gymListingId != null) 'gymListingId': gymListingId,
        'page': page,
        'limit': limit,
      },
    );
    return response.data;
  }

  /// POST /admin/reviews/:id/moderate
  /// Body: { action (approve|reject), adminNote? (max 300 chars) }
  Future<void> moderateReview(
    String id, {
    required String action,
    String? adminNote,
  }) async {
    await _dio.post(
      ApiConstants.adminModerateReview(id),
      data: {
        'action': action,
        if (adminNote != null) 'adminNote': adminNote,
      },
    );
  }
}
```

---

### 5.7 Gyms Repository

**Backed by**: `/gyms/*` routes — GYM_HOST or BRANCH_MANAGER + tenant context required

```dart
// lib/features/gym_host/data/repositories/gyms_repository.dart
class GymsRepository {
  final Dio _dio;
  const GymsRepository(this._dio);

  /// GET /gyms/profile
  Future<Map<String, dynamic>> getProfile() async {
    final response = await _dio.get(ApiConstants.gymProfile);
    return Map<String, dynamic>.from(response.data['data']);
  }

  /// PATCH /gyms/profile — also syncs the public GymListing
  /// Body (all optional): { name, description, contactPhone, contactEmail,
  ///                        website, genderType (MIXED|MALE_ONLY|FEMALE_ONLY),
  ///                        logoUrl, coverImageUrl, socialLinksJson }
  Future<Map<String, dynamic>> updateProfile({
    String? name,
    String? description,
    String? contactPhone,
    String? contactEmail,
    String? website,
    String? genderType,
    String? logoUrl,
    String? coverImageUrl,
    Map<String, dynamic>? socialLinksJson,
  }) async {
    final response = await _dio.patch(
      ApiConstants.gymProfile,
      data: {
        if (name != null) 'name': name,
        if (description != null) 'description': description,
        if (contactPhone != null) 'contactPhone': contactPhone,
        if (contactEmail != null) 'contactEmail': contactEmail,
        if (website != null) 'website': website,
        if (genderType != null) 'genderType': genderType,
        if (logoUrl != null) 'logoUrl': logoUrl,
        if (coverImageUrl != null) 'coverImageUrl': coverImageUrl,
        if (socialLinksJson != null) 'socialLinksJson': socialLinksJson,
      },
    );
    return Map<String, dynamic>.from(response.data['data']);
  }

  /// GET /gyms/branches
  Future<List<Branch>> listBranches() async {
    final response = await _dio.get(ApiConstants.gymBranches);
    return (response.data['data']['branches'] as List)
        .map((e) => Branch.fromJson(e))
        .toList();
  }

  /// POST /gyms/branches — GYM_HOST only
  /// Body: { branchName (required), address?, cityId?, areaId?, latitude?,
  ///         longitude?, phone?, openingTime? (HH:mm), closingTime? (HH:mm),
  ///         facilitiesJson? (string[]), imagesJson? (URL[]) }
  Future<Branch> createBranch({
    required String branchName,
    String? address,
    int? cityId,
    int? areaId,
    double? latitude,
    double? longitude,
    String? phone,
    String? openingTime,
    String? closingTime,
    List<String>? facilitiesJson,
    List<String>? imagesJson,
  }) async {
    final response = await _dio.post(
      ApiConstants.gymBranches,
      data: {
        'branchName': branchName,
        if (address != null) 'address': address,
        if (cityId != null) 'cityId': cityId,
        if (areaId != null) 'areaId': areaId,
        if (latitude != null) 'latitude': latitude,
        if (longitude != null) 'longitude': longitude,
        if (phone != null) 'phone': phone,
        if (openingTime != null) 'openingTime': openingTime,
        if (closingTime != null) 'closingTime': closingTime,
        if (facilitiesJson != null) 'facilitiesJson': facilitiesJson,
        if (imagesJson != null) 'imagesJson': imagesJson,
      },
    );
    return Branch.fromJson(response.data['data']);
  }

  /// GET /gyms/branches/:branchId
  Future<Branch> getBranch(String branchId) async {
    final response = await _dio.get(ApiConstants.gymBranch(branchId));
    return Branch.fromJson(response.data['data']);
  }

  /// PATCH /gyms/branches/:branchId — same optional fields as createBranch
  Future<Branch> updateBranch(
    String branchId, {
    String? branchName,
    String? address,
    int? cityId,
    int? areaId,
    double? latitude,
    double? longitude,
    String? phone,
    String? openingTime,
    String? closingTime,
    List<String>? facilitiesJson,
    List<String>? imagesJson,
  }) async {
    final response = await _dio.patch(
      ApiConstants.gymBranch(branchId),
      data: {
        if (branchName != null) 'branchName': branchName,
        if (address != null) 'address': address,
        if (cityId != null) 'cityId': cityId,
        if (areaId != null) 'areaId': areaId,
        if (latitude != null) 'latitude': latitude,
        if (longitude != null) 'longitude': longitude,
        if (phone != null) 'phone': phone,
        if (openingTime != null) 'openingTime': openingTime,
        if (closingTime != null) 'closingTime': closingTime,
        if (facilitiesJson != null) 'facilitiesJson': facilitiesJson,
        if (imagesJson != null) 'imagesJson': imagesJson,
      },
    );
    return Branch.fromJson(response.data['data']);
  }

  /// DELETE /gyms/branches/:branchId — GYM_HOST only (soft delete)
  Future<void> deleteBranch(String branchId) async {
    await _dio.delete(ApiConstants.gymBranch(branchId));
  }

  /// GET /gyms/branches/:branchId/staff
  Future<List<GymStaff>> listStaff(String branchId) async {
    final response = await _dio.get(ApiConstants.gymBranchStaff(branchId));
    return (response.data['data']['staff'] as List)
        .map((e) => GymStaff.fromJson(e))
        .toList();
  }

  /// POST /gyms/branches/:branchId/staff — GYM_HOST only
  /// Body: { userId (platform user uuid), designation? }
  Future<GymStaff> assignStaff(
    String branchId, {
    required String userId,
    String? designation,
  }) async {
    final response = await _dio.post(
      ApiConstants.gymBranchStaff(branchId),
      data: {
        'userId': userId,
        if (designation != null) 'designation': designation,
      },
    );
    return GymStaff.fromJson(response.data['data']);
  }

  /// DELETE /gyms/branches/:branchId/staff/:staffId — GYM_HOST only
  Future<void> removeStaff(String branchId, String staffId) async {
    await _dio.delete(ApiConstants.gymBranchStaffMember(branchId, staffId));
  }
}
```

---

### 5.8 Discovery Repository

**Backed by**: `/discovery/*` routes — all public except `POST /discovery/gyms/:id/reviews`

```dart
// lib/features/discovery/data/repositories/discovery_repository.dart
class DiscoveryRepository {
  final Dio _dio;
  const DiscoveryRepository(this._dio);

  /// GET /discovery/cities — cities with active gym counts (home page city picker)
  Future<List<Map<String, dynamic>>> listCitiesWithCounts() async {
    final response = await _dio.get(ApiConstants.discoveryCities);
    return List<Map<String, dynamic>>.from(response.data['data']['cities']);
  }

  /// GET /discovery/gyms/featured — ?limit (default 12, max 50)
  Future<List<GymListing>> featuredGyms({int limit = 12}) async {
    final response = await _dio.get(
      ApiConstants.discoveryGymsFeatured,
      queryParameters: {'limit': limit},
    );
    return (response.data['data']['gyms'] as List)
        .map((e) => GymListing.fromJson(e))
        .toList();
  }

  /// GET /discovery/gyms/top-rated — ?cityId?, ?limit (default 12, max 50)
  Future<List<GymListing>> topRatedGyms({int? cityId, int limit = 12}) async {
    final response = await _dio.get(
      ApiConstants.discoveryGymsTopRated,
      queryParameters: {
        if (cityId != null) 'cityId': cityId,
        'limit': limit,
      },
    );
    return (response.data['data']['gyms'] as List)
        .map((e) => GymListing.fromJson(e))
        .toList();
  }

  /// GET /discovery/gyms/nearby
  /// Query: lat (required), lng (required), radius (km, default 10, max 100),
  ///        limit (default 20), page (default 1)
  /// Response includes distanceKm on each gym object
  Future<Map<String, dynamic>> nearbyGyms({
    required double lat,
    required double lng,
    double radius = 10,
    int limit = 20,
    int page = 1,
  }) async {
    final response = await _dio.get(
      ApiConstants.discoveryGymsNearby,
      queryParameters: {
        'lat': lat,
        'lng': lng,
        'radius': radius,
        'limit': limit,
        'page': page,
      },
    );
    return response.data;
  }

  /// GET /discovery/gyms/map — lightweight pin data for map view
  /// Query: ?cityId
  Future<List<MapPin>> getMapPins({int? cityId}) async {
    final response = await _dio.get(
      ApiConstants.discoveryGymsMap,
      queryParameters: {if (cityId != null) 'cityId': cityId},
    );
    return (response.data['data']['gyms'] as List)
        .map((e) => MapPin.fromJson(e))
        .toList();
  }

  /// GET /discovery/gyms — public directory
  /// Query: ?cityId, ?areaId, ?genderType (MIXED|MALE_ONLY|FEMALE_ONLY),
  ///        ?search, ?featured (bool), ?page (default 1), ?limit (default 12, max 50)
  Future<Map<String, dynamic>> listGyms({
    int? cityId,
    int? areaId,
    String? genderType,
    String? search,
    bool? featured,
    int page = 1,
    int limit = 12,
  }) async {
    final response = await _dio.get(
      ApiConstants.discoveryGyms,
      queryParameters: {
        if (cityId != null) 'cityId': cityId,
        if (areaId != null) 'areaId': areaId,
        if (genderType != null) 'genderType': genderType,
        if (search != null) 'search': search,
        if (featured != null) 'featured': featured,
        'page': page,
        'limit': limit,
      },
    );
    return response.data;
  }

  /// GET /discovery/gyms/:id — includes available membership plans
  Future<Map<String, dynamic>> getGym(String id) async {
    final response = await _dio.get(ApiConstants.discoveryGym(id));
    return Map<String, dynamic>.from(response.data['data']);
  }

  /// GET /discovery/gyms/:id/reviews — approved reviews (public)
  /// Query: ?page (default 1), ?limit (default 10)
  Future<Map<String, dynamic>> listReviews(
    String gymId, {
    int page = 1,
    int limit = 10,
  }) async {
    final response = await _dio.get(
      ApiConstants.discoveryGymReviews(gymId),
      queryParameters: {'page': page, 'limit': limit},
    );
    return response.data;
  }

  /// POST /discovery/gyms/:id/reviews — auth required (any role)
  /// Requires active or past membership at this gym. One review per user per gym.
  /// Body: { rating (1–5, required), title? (max 150), body? (max 2000) }
  /// Review starts as PENDING — admin must approve before it appears publicly.
  Future<GymReview> submitReview(
    String gymId, {
    required int rating,
    String? title,
    String? body,
  }) async {
    final response = await _dio.post(
      ApiConstants.discoveryGymReviews(gymId),
      data: {
        'rating': rating,
        if (title != null) 'title': title,
        if (body != null) 'body': body,
      },
    );
    return GymReview.fromJson(response.data['data']);
  }
}
```

---

### 5.9 Membership Plans Repository

**Backed by**: `/membership-plans/*` routes

```dart
// lib/features/membership_plans/data/repositories/membership_plans_repository.dart
class MembershipPlansRepository {
  final Dio _dio;
  const MembershipPlansRepository(this._dio);

  /// GET /membership-plans — public
  /// Query: gymListingId (REQUIRED), ?branchId
  Future<List<MembershipPlan>> listPublic({
    required String gymListingId,
    String? branchId,
  }) async {
    final response = await _dio.get(
      ApiConstants.membershipPlans,
      queryParameters: {
        'gymListingId': gymListingId,
        if (branchId != null) 'branchId': branchId,
      },
    );
    return (response.data['data']['plans'] as List)
        .map((e) => MembershipPlan.fromJson(e))
        .toList();
  }

  /// GET /membership-plans/host — GYM_HOST or BRANCH_MANAGER
  /// Query: ?branchId — shows all plans including inactive
  Future<List<MembershipPlan>> listForHost({String? branchId}) async {
    final response = await _dio.get(
      ApiConstants.membershipPlansHost,
      queryParameters: {if (branchId != null) 'branchId': branchId},
    );
    return (response.data['data']['plans'] as List)
        .map((e) => MembershipPlan.fromJson(e))
        .toList();
  }

  /// GET /membership-plans/:id — public
  /// Query: gymListingId (REQUIRED)
  Future<MembershipPlan> getPublic(String id, {required String gymListingId}) async {
    final response = await _dio.get(
      ApiConstants.membershipPlan(id),
      queryParameters: {'gymListingId': gymListingId},
    );
    return MembershipPlan.fromJson(response.data['data']);
  }

  /// POST /membership-plans — GYM_HOST or BRANCH_MANAGER
  /// Body: { name, durationType (DAILY|WEEKLY|MONTHLY|QUARTERLY|YEARLY),
  ///         durationValue (≥1), price (≥0), description?, branchId?,
  ///         joiningFee?, securityFee?, visitLimit? (null=unlimited),
  ///         freezeLimitDays?, isTrial? }
  Future<MembershipPlan> createPlan({
    required String name,
    required String durationType,
    required int durationValue,
    required double price,
    String? description,
    String? branchId,
    double? joiningFee,
    double? securityFee,
    int? visitLimit,
    int? freezeLimitDays,
    bool? isTrial,
  }) async {
    final response = await _dio.post(
      ApiConstants.membershipPlans,
      data: {
        'name': name,
        'durationType': durationType,
        'durationValue': durationValue,
        'price': price,
        if (description != null) 'description': description,
        if (branchId != null) 'branchId': branchId,
        if (joiningFee != null) 'joiningFee': joiningFee,
        if (securityFee != null) 'securityFee': securityFee,
        if (visitLimit != null) 'visitLimit': visitLimit,
        if (freezeLimitDays != null) 'freezeLimitDays': freezeLimitDays,
        if (isTrial != null) 'isTrial': isTrial,
      },
    );
    return MembershipPlan.fromJson(response.data['data']);
  }

  /// PATCH /membership-plans/:id — GYM_HOST or BRANCH_MANAGER
  Future<MembershipPlan> updatePlan(String id, {
    String? name,
    String? description,
    String? durationType,
    int? durationValue,
    double? price,
    double? joiningFee,
    double? securityFee,
    int? visitLimit,
    int? freezeLimitDays,
    bool? isTrial,
  }) async {
    final response = await _dio.patch(
      ApiConstants.membershipPlan(id),
      data: {
        if (name != null) 'name': name,
        if (description != null) 'description': description,
        if (durationType != null) 'durationType': durationType,
        if (durationValue != null) 'durationValue': durationValue,
        if (price != null) 'price': price,
        if (joiningFee != null) 'joiningFee': joiningFee,
        if (securityFee != null) 'securityFee': securityFee,
        if (visitLimit != null) 'visitLimit': visitLimit,
        if (freezeLimitDays != null) 'freezeLimitDays': freezeLimitDays,
        if (isTrial != null) 'isTrial': isTrial,
      },
    );
    return MembershipPlan.fromJson(response.data['data']);
  }

  /// DELETE /membership-plans/:id — GYM_HOST only (soft archive)
  Future<void> deletePlan(String id) async {
    await _dio.delete(ApiConstants.membershipPlan(id));
  }

  /// POST /membership-plans/:id/status — GYM_HOST or BRANCH_MANAGER
  /// Toggles ACTIVE ↔ INACTIVE
  Future<MembershipPlan> toggleStatus(String id) async {
    final response = await _dio.post(ApiConstants.membershipPlanStatus(id));
    return MembershipPlan.fromJson(response.data['data']);
  }

  /// POST /membership-plans/:id/poster — multipart/form-data, field: "image"
  Future<String> uploadPoster(String id, String filePath) async {
    final formData = FormData.fromMap({
      'image': await MultipartFile.fromFile(filePath, filename: 'poster.jpg'),
    });
    final response = await _dio.post(
      ApiConstants.membershipPlanPoster(id),
      data: formData,
      options: Options(contentType: 'multipart/form-data'),
    );
    return response.data['data']['posterUrl'] as String;
  }
}
```

---

### 5.10 Subscriptions Repository

**Backed by**: `/subscriptions/*` routes — all require auth

```dart
// lib/features/subscriptions/data/repositories/subscriptions_repository.dart
class SubscriptionsRepository {
  final Dio _dio;
  const SubscriptionsRepository(this._dio);

  /// POST /subscriptions
  /// Body: { planId (uuid), gymListingId (uuid), branchId (uuid),
  ///         autoRenew? (default false), sourceChannel? (ONLINE|WALK_IN|STAFF, default ONLINE) }
  /// Returns subscription with qrCode token
  Future<MemberSubscription> subscribe({
    required String planId,
    required String gymListingId,
    required String branchId,
    bool autoRenew = false,
    String sourceChannel = 'ONLINE',
  }) async {
    final response = await _dio.post(
      ApiConstants.subscriptions,
      data: {
        'planId': planId,
        'gymListingId': gymListingId,
        'branchId': branchId,
        'autoRenew': autoRenew,
        'sourceChannel': sourceChannel,
      },
    );
    return MemberSubscription.fromJson(response.data['data']);
  }

  /// POST /subscriptions/:id/freeze
  /// Body: { freezeFrom (YYYY-MM-DD), freezeTo (YYYY-MM-DD) }
  /// Fails if plan freezeLimitDays = 0 or limit already exhausted
  Future<MemberSubscription> freeze(
    String id, {
    required String freezeFrom,
    required String freezeTo,
  }) async {
    final response = await _dio.post(
      ApiConstants.subscriptionFreeze(id),
      data: {'freezeFrom': freezeFrom, 'freezeTo': freezeTo},
    );
    return MemberSubscription.fromJson(response.data['data']);
  }

  /// POST /subscriptions/:id/cancel
  Future<MemberSubscription> cancel(String id) async {
    final response = await _dio.post(ApiConstants.subscriptionCancel(id));
    return MemberSubscription.fromJson(response.data['data']);
  }

  /// POST /subscriptions/:id/renew — extends end date by one plan cycle
  /// Issues a new qrCode token on success
  Future<MemberSubscription> renew(String id) async {
    final response = await _dio.post(ApiConstants.subscriptionRenew(id));
    return MemberSubscription.fromJson(response.data['data']);
  }

  /// POST /subscriptions/preview — GYM_HOST | BRANCH_MANAGER | PLATFORM_ADMIN
  /// Dry-run: calculates startDate, endDate, totalPrice without creating a record
  /// Body: { planId (uuid), startDate? (YYYY-MM-DD), autoRenew? (bool) }
  Future<Map<String, dynamic>> preview({
    required String planId,
    String? startDate,
    bool? autoRenew,
  }) async {
    final response = await _dio.post(
      ApiConstants.subscriptionPreview,
      data: {
        'planId': planId,
        if (startDate != null) 'startDate': startDate,
        if (autoRenew != null) 'autoRenew': autoRenew,
      },
    );
    return Map<String, dynamic>.from(response.data['data']);
  }

  /// GET /subscriptions/staff — GYM_HOST | BRANCH_MANAGER | PLATFORM_ADMIN
  /// Query: ?status (PENDING|ACTIVE|FROZEN|EXPIRED|CANCELLED), ?branchId,
  ///        ?userId, ?page (default 1), ?limit (default 20, max 100)
  Future<Map<String, dynamic>> listForStaff({
    String? status,
    String? branchId,
    String? userId,
    int page = 1,
    int limit = 20,
  }) async {
    final response = await _dio.get(
      ApiConstants.subscriptionsStaff,
      queryParameters: {
        if (status != null) 'status': status,
        if (branchId != null) 'branchId': branchId,
        if (userId != null) 'userId': userId,
        'page': page,
        'limit': limit,
      },
    );
    return response.data;
  }

  /// GET /subscriptions/staff/:id — GYM_HOST | BRANCH_MANAGER | PLATFORM_ADMIN
  /// Returns full subscription detail with payment history
  Future<Map<String, dynamic>> getForStaff(String id) async {
    final response = await _dio.get(ApiConstants.subscriptionStaff(id));
    return Map<String, dynamic>.from(response.data['data']);
  }
}
```

---

### 5.11 Payments Repository

**Backed by**: `/payments/*` routes — GYM_HOST or BRANCH_MANAGER + tenantContext

```dart
// lib/features/payments/data/repositories/payments_repository.dart
class PaymentsRepository {
  final Dio _dio;
  const PaymentsRepository(this._dio);

  /// POST /payments — Record a payment
  /// Body: { userId (uuid), method (CASH|BANK_TRANSFER|CARD|WALLET|ONLINE|POS|TEST),
  ///         amount (≥0.01), paymentFor? (MEMBERSHIP|TRAINER|PRODUCT|OTHER),
  ///         referenceEntityId? (uuid), gatewayName?, gatewayTransactionId?,
  ///         currency? (default PKR), notes? }
  /// NOTE: method=TEST requires header X-Test-Payment-Key matching PAYMENT_TEST_KEY env var
  Future<Payment> recordPayment({
    required String userId,
    required String method,
    required double amount,
    String paymentFor = 'MEMBERSHIP',
    String? referenceEntityId,
    String? gatewayName,
    String? gatewayTransactionId,
    String currency = 'PKR',
    String? notes,
    String? testPaymentKey,
  }) async {
    final response = await _dio.post(
      ApiConstants.payments,
      data: {
        'userId': userId,
        'method': method,
        'amount': amount,
        'paymentFor': paymentFor,
        if (referenceEntityId != null) 'referenceEntityId': referenceEntityId,
        if (gatewayName != null) 'gatewayName': gatewayName,
        if (gatewayTransactionId != null)
          'gatewayTransactionId': gatewayTransactionId,
        'currency': currency,
        if (notes != null) 'notes': notes,
      },
      options: testPaymentKey != null
          ? Options(headers: {'X-Test-Payment-Key': testPaymentKey})
          : null,
    );
    return Payment.fromJson(response.data['data']);
  }

  /// GET /payments
  /// Query: ?userId, ?status (PENDING|COMPLETED|FAILED|REFUNDED),
  ///        ?method (CASH|BANK_TRANSFER|CARD|WALLET),
  ///        ?from (YYYY-MM-DD), ?to (YYYY-MM-DD),
  ///        ?page (default 1), ?limit (default 20, max 100)
  Future<Map<String, dynamic>> listPayments({
    String? userId,
    String? status,
    String? method,
    String? from,
    String? to,
    int page = 1,
    int limit = 20,
  }) async {
    final response = await _dio.get(
      ApiConstants.payments,
      queryParameters: {
        if (userId != null) 'userId': userId,
        if (status != null) 'status': status,
        if (method != null) 'method': method,
        if (from != null) 'from': from,
        if (to != null) 'to': to,
        'page': page,
        'limit': limit,
      },
    );
    return response.data;
  }

  /// POST /payments/:id/verify — marks payment as COMPLETED; auto-marks invoice PAID
  Future<Payment> verifyPayment(String id) async {
    final response = await _dio.post(ApiConstants.paymentVerify(id));
    return Payment.fromJson(response.data['data']);
  }

  /// POST /payments/:id/action — verify or reject a pending payment
  /// Body: { action (verify|reject), notes?, rejectedReason? }
  Future<Payment> paymentAction(
    String id, {
    required String action,
    String? notes,
    String? rejectedReason,
  }) async {
    final response = await _dio.post(
      ApiConstants.paymentAction(id),
      data: {
        'action': action,
        if (notes != null) 'notes': notes,
        if (rejectedReason != null) 'rejectedReason': rejectedReason,
      },
    );
    return Payment.fromJson(response.data['data']);
  }

  /// POST /payments/:id/proof — multipart/form-data, field: "image"
  Future<void> uploadProof(String id, String filePath) async {
    final formData = FormData.fromMap({
      'image': await MultipartFile.fromFile(filePath, filename: 'proof.jpg'),
    });
    await _dio.post(
      ApiConstants.paymentProof(id),
      data: formData,
      options: Options(contentType: 'multipart/form-data'),
    );
  }

  /// POST /payments/collection-action — mark multiple cash payments as collected
  /// Body: { paymentIds: [uuid, uuid, ...] }
  Future<void> collectionAction({required List<String> paymentIds}) async {
    await _dio.post(
      ApiConstants.paymentCollectionAction,
      data: {'paymentIds': paymentIds},
    );
  }
}
```

---

### 5.12 Invoices Repository

**Backed by**: `/invoices/*` routes — auth + tenantContext

```dart
// lib/features/invoices/data/repositories/invoices_repository.dart
class InvoicesRepository {
  final Dio _dio;
  const InvoicesRepository(this._dio);

  /// GET /invoices
  /// Members see only their own invoices; hosts/managers see all.
  /// Query: ?userId (uuid, host/manager filter), ?status (ISSUED|PAID|CANCELLED|OVERDUE),
  ///        ?from (YYYY-MM-DD), ?to (YYYY-MM-DD),
  ///        ?page (default 1), ?limit (default 20, max 100)
  Future<Map<String, dynamic>> listInvoices({
    String? userId,
    String? status,
    String? from,
    String? to,
    int page = 1,
    int limit = 20,
  }) async {
    final response = await _dio.get(
      ApiConstants.invoices,
      queryParameters: {
        if (userId != null) 'userId': userId,
        if (status != null) 'status': status,
        if (from != null) 'from': from,
        if (to != null) 'to': to,
        'page': page,
        'limit': limit,
      },
    );
    return response.data;
  }

  /// GET /invoices/:id — members see own; hosts see all
  Future<Invoice> getInvoice(String id) async {
    final response = await _dio.get(ApiConstants.invoice(id));
    return Invoice.fromJson(response.data['data']['invoice']);
  }
}
```

---

### 5.13 Attendance Repository

**Backed by**: `/attendance/*` routes

```dart
// lib/features/attendance/data/repositories/attendance_repository.dart
class AttendanceRepository {
  final Dio _dio;
  const AttendanceRepository(this._dio);

  /// POST /attendance/qr-scan — GYM_HOST | BRANCH_MANAGER
  /// Body: { qrCode (string from subscription), branchId (uuid), deviceId? }
  /// Validates subscription status before recording. Decrements remainingVisits.
  Future<AttendanceLog> qrScan({
    required String qrCode,
    required String branchId,
    String? deviceId,
  }) async {
    final response = await _dio.post(
      ApiConstants.attendanceQrScan,
      data: {
        'qrCode': qrCode,
        'branchId': branchId,
        if (deviceId != null) 'deviceId': deviceId,
      },
    );
    return AttendanceLog.fromJson(response.data['data']);
  }

  /// POST /attendance/manual — GYM_HOST | BRANCH_MANAGER
  /// Body: { userId (uuid), branchId (uuid), subscriptionId (uuid), notes? }
  Future<AttendanceLog> manualCheckIn({
    required String userId,
    required String branchId,
    required String subscriptionId,
    String? notes,
  }) async {
    final response = await _dio.post(
      ApiConstants.attendanceManual,
      data: {
        'userId': userId,
        'branchId': branchId,
        'subscriptionId': subscriptionId,
        if (notes != null) 'notes': notes,
      },
    );
    return AttendanceLog.fromJson(response.data['data']);
  }

  /// GET /attendance — GYM_HOST | BRANCH_MANAGER
  /// Query: ?branchId, ?date (YYYY-MM-DD), ?userId,
  ///        ?page (default 1), ?limit (default 20, max 100)
  Future<Map<String, dynamic>> listLogs({
    String? branchId,
    String? date,
    String? userId,
    int page = 1,
    int limit = 20,
  }) async {
    final response = await _dio.get(
      ApiConstants.attendance,
      queryParameters: {
        if (branchId != null) 'branchId': branchId,
        if (date != null) 'date': date,
        if (userId != null) 'userId': userId,
        'page': page,
        'limit': limit,
      },
    );
    return response.data;
  }

  /// GET /attendance/today — GYM_HOST | BRANCH_MANAGER
  /// Query: ?branchId, ?page (default 1), ?limit (default 20)
  Future<Map<String, dynamic>> todayLogs({
    String? branchId,
    int page = 1,
    int limit = 20,
  }) async {
    final response = await _dio.get(
      ApiConstants.attendanceToday,
      queryParameters: {
        if (branchId != null) 'branchId': branchId,
        'page': page,
        'limit': limit,
      },
    );
    return response.data;
  }

  /// GET /attendance/range — GYM_HOST | BRANCH_MANAGER
  /// Query: from (YYYY-MM-DD, REQUIRED), to (YYYY-MM-DD, REQUIRED),
  ///        ?branchId, ?userId, ?page (default 1), ?limit (default 20)
  Future<Map<String, dynamic>> rangeLogs({
    required String from,
    required String to,
    String? branchId,
    String? userId,
    int page = 1,
    int limit = 20,
  }) async {
    final response = await _dio.get(
      ApiConstants.attendanceRange,
      queryParameters: {
        'from': from,
        'to': to,
        if (branchId != null) 'branchId': branchId,
        if (userId != null) 'userId': userId,
        'page': page,
        'limit': limit,
      },
    );
    return response.data;
  }

  /// GET /attendance/customer/:userId — GYM_HOST | BRANCH_MANAGER
  /// Full attendance history for a specific member
  /// Query: ?page (default 1), ?limit (default 20)
  Future<Map<String, dynamic>> memberHistory(
    String userId, {
    int page = 1,
    int limit = 20,
  }) async {
    final response = await _dio.get(
      ApiConstants.attendanceCustomer(userId),
      queryParameters: {'page': page, 'limit': limit},
    );
    return response.data;
  }

  /// GET /attendance/report/:period — GYM_HOST | BRANCH_MANAGER
  /// period: daily | weekly | monthly | yearly
  /// Query: ?year (int), ?month (int, required for daily),
  ///        ?branchId — returns aggregated check-in counts
  Future<Map<String, dynamic>> getReport({
    required String period,
    int? year,
    int? month,
    String? branchId,
  }) async {
    final response = await _dio.get(
      ApiConstants.attendanceReport(period),
      queryParameters: {
        if (year != null) 'year': year,
        if (month != null) 'month': month,
        if (branchId != null) 'branchId': branchId,
      },
    );
    return Map<String, dynamic>.from(response.data['data']);
  }
}
```

---

### 5.14 Trainers Repository

**Backed by**: `/trainers/*` routes — GYM_HOST or BRANCH_MANAGER + tenantContext

```dart
// lib/features/trainers/data/repositories/trainers_repository.dart
class TrainersRepository {
  final Dio _dio;
  const TrainersRepository(this._dio);

  /// GET /trainers
  /// Query: ?branchId, ?status (ACTIVE|INACTIVE),
  ///        ?page (default 1), ?limit (default 20, max 100)
  Future<Map<String, dynamic>> listTrainers({
    String? branchId,
    String? status,
    int page = 1,
    int limit = 20,
  }) async {
    final response = await _dio.get(
      ApiConstants.trainers,
      queryParameters: {
        if (branchId != null) 'branchId': branchId,
        if (status != null) 'status': status,
        'page': page,
        'limit': limit,
      },
    );
    return response.data;
  }

  /// POST /trainers — GYM_HOST only
  /// Body: { userId (uuid, platform user), branchId? (uuid),
  ///         specialization?, bio?, yearsExperience? (≥0),
  ///         certificationsJson? (array), availabilityJson? (object) }
  Future<TrainerModel> createTrainer({
    required String userId,
    String? branchId,
    String? specialization,
    String? bio,
    int? yearsExperience,
    List<dynamic>? certificationsJson,
    Map<String, dynamic>? availabilityJson,
  }) async {
    final response = await _dio.post(
      ApiConstants.trainers,
      data: {
        'userId': userId,
        if (branchId != null) 'branchId': branchId,
        if (specialization != null) 'specialization': specialization,
        if (bio != null) 'bio': bio,
        if (yearsExperience != null) 'yearsExperience': yearsExperience,
        if (certificationsJson != null) 'certificationsJson': certificationsJson,
        if (availabilityJson != null) 'availabilityJson': availabilityJson,
      },
    );
    return TrainerModel.fromJson(response.data['data']);
  }

  /// PATCH /trainers/:id — GYM_HOST or BRANCH_MANAGER
  /// Body: same optional fields as createTrainer
  Future<TrainerModel> updateTrainer(
    String id, {
    String? branchId,
    String? specialization,
    String? bio,
    int? yearsExperience,
    List<dynamic>? certificationsJson,
    Map<String, dynamic>? availabilityJson,
    String? status,
  }) async {
    final response = await _dio.patch(
      ApiConstants.trainer(id),
      data: {
        if (branchId != null) 'branchId': branchId,
        if (specialization != null) 'specialization': specialization,
        if (bio != null) 'bio': bio,
        if (yearsExperience != null) 'yearsExperience': yearsExperience,
        if (certificationsJson != null) 'certificationsJson': certificationsJson,
        if (availabilityJson != null) 'availabilityJson': availabilityJson,
        if (status != null) 'status': status,
      },
    );
    return TrainerModel.fromJson(response.data['data']);
  }

  /// POST /trainers/:id/assign — GYM_HOST only
  /// Body: { branchId (uuid) }
  Future<TrainerModel> assignToBranch(String id, {required String branchId}) async {
    final response = await _dio.post(
      ApiConstants.trainerAssign(id),
      data: {'branchId': branchId},
    );
    return TrainerModel.fromJson(response.data['data']);
  }
}
```

---

### 5.15 Reports Repository

**Backed by**: `/reports/*` routes — GYM_HOST or BRANCH_MANAGER + tenantContext

```dart
// lib/features/reports/data/repositories/reports_repository.dart
class ReportsRepository {
  final Dio _dio;
  const ReportsRepository(this._dio);

  /// GET /reports/dashboard — host dashboard KPIs
  /// Returns: { members, attendance, revenue, plans, branches }
  Future<Map<String, dynamic>> getDashboard() async {
    final response = await _dio.get(ApiConstants.reportsDashboard);
    return Map<String, dynamic>.from(response.data['data']);
  }

  /// GET /reports/monthly — daily-granular breakdown
  /// Query: ?year (default current), ?month (1–12, default current)
  Future<Map<String, dynamic>> getMonthlyBreakdown({int? year, int? month}) async {
    final response = await _dio.get(
      ApiConstants.reportsMonthly,
      queryParameters: {
        if (year != null) 'year': year,
        if (month != null) 'month': month,
      },
    );
    return Map<String, dynamic>.from(response.data['data']);
  }

  /// GET /reports/monthly/export-pdf — returns PDF binary
  Future<List<int>> exportMonthlyPdf({int? year, int? month}) async {
    final response = await _dio.get(
      ApiConstants.reportsMonthlyExportPdf,
      queryParameters: {
        if (year != null) 'year': year,
        if (month != null) 'month': month,
      },
      options: Options(responseType: ResponseType.bytes),
    );
    return List<int>.from(response.data);
  }

  /// GET /reports/monthly/print-layout — returns HTML string for printing
  Future<String> getMonthlyPrintLayout({int? year, int? month}) async {
    final response = await _dio.get(
      ApiConstants.reportsMonthlyPrintLayout,
      queryParameters: {
        if (year != null) 'year': year,
        if (month != null) 'month': month,
      },
      options: Options(responseType: ResponseType.plain),
    );
    return response.data as String;
  }
}
```

---

### 5.16 Users Repository

**Backed by**: `/users/*` routes — GYM_HOST | BRANCH_MANAGER | PLATFORM_ADMIN (management); some actions restricted to GYM_HOST | PLATFORM_ADMIN

```dart
// lib/features/users/data/repositories/users_repository.dart
class UsersRepository {
  final Dio _dio;
  const UsersRepository(this._dio);

  /// GET /users — paginated member search
  /// Query: ?q (search by name/email/phone), ?role (MEMBER|TRAINER|GYM_HOST|BRANCH_MANAGER),
  ///        ?status (ACTIVE|INACTIVE|SUSPENDED), ?page (default 1), ?limit (default 20, max 100)
  Future<Map<String, dynamic>> searchUsers({
    String? q,
    String? role,
    String? status,
    int page = 1,
    int limit = 20,
  }) async {
    final response = await _dio.get(
      ApiConstants.users,
      queryParameters: {
        if (q != null) 'q': q,
        if (role != null) 'role': role,
        if (status != null) 'status': status,
        'page': page,
        'limit': limit,
      },
    );
    return response.data;
  }

  /// POST /users — staff creates member (bypasses OTP flow)
  /// Body: { fullName, email, phone?, password?, gender (MALE|FEMALE|OTHER)?,
  ///         dateOfBirth (YYYY-MM-DD)? }
  Future<UserModel> createMember({
    required String fullName,
    required String email,
    String? phone,
    String? password,
    String? gender,
    String? dateOfBirth,
  }) async {
    final response = await _dio.post(
      ApiConstants.users,
      data: {
        'fullName': fullName,
        'email': email,
        if (phone != null) 'phone': phone,
        if (password != null) 'password': password,
        if (gender != null) 'gender': gender,
        if (dateOfBirth != null) 'dateOfBirth': dateOfBirth,
      },
    );
    return UserModel.fromJson(response.data['data']);
  }

  /// GET /users/:id — with profile
  Future<Map<String, dynamic>> getUserById(String id) async {
    final response = await _dio.get(ApiConstants.user(id));
    return Map<String, dynamic>.from(response.data['data']);
  }

  /// PUT /users/:id — update platform + tenant profile fields
  Future<Map<String, dynamic>> updateUser(String id, Map<String, dynamic> fields) async {
    final response = await _dio.put(ApiConstants.user(id), data: fields);
    return Map<String, dynamic>.from(response.data['data']);
  }

  /// POST /users/:id/status — GYM_HOST | PLATFORM_ADMIN only
  /// Body: { status (ACTIVE|INACTIVE|SUSPENDED), reason? }
  Future<void> setUserStatus(
    String id, {
    required String status,
    String? reason,
  }) async {
    await _dio.post(
      ApiConstants.userStatus(id),
      data: {
        'status': status,
        if (reason != null) 'reason': reason,
      },
    );
  }

  /// POST /users/:id/password — GYM_HOST | PLATFORM_ADMIN — force-reset password
  Future<void> adminResetPassword(String id, {required String newPassword}) async {
    await _dio.post(
      ApiConstants.userPassword(id),
      data: {'password': newPassword},
    );
  }

  /// POST /users/:id/profile-image — multipart/form-data, field: "image"
  Future<String> uploadProfileImage(String userId, String filePath) async {
    final formData = FormData.fromMap({
      'image': await MultipartFile.fromFile(filePath, filename: 'profile.jpg'),
    });
    final response = await _dio.post(
      ApiConstants.userProfileImage(userId),
      data: formData,
      options: Options(contentType: 'multipart/form-data'),
    );
    return response.data['data']['profileImageUrl'] as String;
  }

  /// GET /users/:id/account-statement
  /// Query: ?from (YYYY-MM-DD), ?to (YYYY-MM-DD), ?page (default 1), ?limit (default 20)
  Future<Map<String, dynamic>> getAccountStatement(
    String id, {
    String? from,
    String? to,
    int page = 1,
    int limit = 20,
  }) async {
    final response = await _dio.get(
      ApiConstants.userAccountStatement(id),
      queryParameters: {
        if (from != null) 'from': from,
        if (to != null) 'to': to,
        'page': page,
        'limit': limit,
      },
    );
    return response.data;
  }

  /// GET /users/:id/account-statement/export — returns PDF binary
  Future<List<int>> exportAccountStatement(
    String id, {
    String? from,
    String? to,
  }) async {
    final response = await _dio.get(
      ApiConstants.userAccountStatementExport(id),
      queryParameters: {
        if (from != null) 'from': from,
        if (to != null) 'to': to,
      },
      options: Options(responseType: ResponseType.bytes),
    );
    return List<int>.from(response.data);
  }
}
```

---

## 6. File Upload Handling

All file upload routes use `multipart/form-data` with a **single** field named `image`. Allowed MIME types: `image/jpeg`, `image/png`, `image/webp`. Max size: **10 MB**.

### Upload from gallery / camera using image_picker

```dart
// lib/core/utils/image_upload_helper.dart
import 'package:image_picker/image_picker.dart';
import 'package:dio/dio.dart';

class ImageUploadHelper {
  static final ImagePicker _picker = ImagePicker();

  /// Pick from gallery and return an XFile (null if user cancelled)
  static Future<XFile?> pickFromGallery() =>
      _picker.pickImage(source: ImageSource.gallery, imageQuality: 85);

  /// Pick from camera and return an XFile (null if user cancelled)
  static Future<XFile?> pickFromCamera() =>
      _picker.pickImage(source: ImageSource.camera, imageQuality: 85);

  /// Build a MultipartFile from an XFile path.
  /// The [fieldName] must match the backend field ('image').
  static Future<MultipartFile> toMultipart(
    XFile file, {
    String fieldName = 'image',
  }) async {
    final ext = file.path.split('.').last.toLowerCase();
    final mime = switch (ext) {
      'png' => 'image/png',
      'webp' => 'image/webp',
      _ => 'image/jpeg',
    };
    return MultipartFile.fromFile(
      file.path,
      filename: '$fieldName.$ext',
      contentType: DioMediaType.parse(mime),
    );
  }
}
```

### Example: Upload profile image from a screen

```dart
Future<void> _pickAndUploadProfileImage(WidgetRef ref) async {
  final file = await ImageUploadHelper.pickFromGallery();
  if (file == null) return;

  // Guard: check file size before uploading
  final bytes = await file.readAsBytes();
  if (bytes.lengthInBytes > 10 * 1024 * 1024) {
    // show snackbar: "File must be under 10 MB"
    return;
  }

  final repo = ref.read(meRepositoryProvider);
  await repo.uploadProfileImage(file.path);
}
```

### Upload routes at a glance

| Route | Field | Notes |
|---|---|---|
| `POST /me/profile-image` | `image` | Own profile image |
| `POST /me/payment-requests/:id/proof` | `image` | Bank receipt proof |
| `POST /users/:id/profile-image` | `image` | Staff uploads for member |
| `POST /payments/:id/proof` | `image` | Payment proof (host/manager) |
| `POST /membership-plans/:id/poster` | `image` | Plan promotional image |

---

## 7. Pagination Synchronisation

The backend uses a **1-based page index**. Every paginated response includes a `pagination` object at the top level alongside `data`:

```json
{
  "success": true,
  "message": "Success",
  "data": { "items": [...] },
  "pagination": {
    "total": 143,
    "page": 2,
    "limit": 20,
    "totalPages": 8
  }
}
```

### Reusable paginated list notifier pattern

```dart
// lib/core/utils/paginated_notifier.dart
import 'package:riverpod_annotation/riverpod_annotation.dart';
import '../network/api_response.dart';

abstract class PaginatedNotifier<T> extends AutoDisposeAsyncNotifier<List<T>> {
  int _page = 1;
  bool _hasMore = true;
  final int _limit = 20;

  bool get hasMore => _hasMore;

  /// Subclasses implement the actual fetch
  Future<(List<T>, PaginationMeta?)> fetch(int page, int limit);

  @override
  Future<List<T>> build() async {
    final (items, meta) = await fetch(1, _limit);
    _hasMore = meta != null && _page < meta.totalPages;
    return items;
  }

  Future<void> loadNextPage() async {
    if (!_hasMore || state.isLoading) return;
    _page++;
    final previous = state.valueOrNull ?? [];
    state = const AsyncValue.loading();
    state = await AsyncValue.guard(() async {
      final (items, meta) = await fetch(_page, _limit);
      _hasMore = meta != null && _page < meta.totalPages;
      return [...previous, ...items];
    });
  }

  Future<void> refresh() async {
    _page = 1;
    _hasMore = true;
    ref.invalidateSelf();
  }
}
```

### Default limits by endpoint

| Endpoint | Default limit | Max limit |
|---|---|---|
| `/me/subscriptions` | 10 | 50 |
| `/discovery/gyms` | 12 | 50 |
| `/discovery/gyms/featured` | 12 | 50 |
| `/discovery/gyms/top-rated` | 12 | 50 |
| `/discovery/gyms/nearby` | 20 | — |
| `/discovery/gyms/:id/reviews` | 10 | — |
| `/admin/tenants` | 20 | — |
| `/admin/reviews` | 20 | — |
| `/subscriptions/staff` | 20 | 100 |
| `/payments` | 20 | 100 |
| `/invoices` | 20 | 100 |
| `/attendance` | 20 | 100 |
| `/trainers` | 20 | 100 |
| `/users` | 20 | 100 |
| `/me/account-statement` | 20 | — |

---

## 8. Error Handling Contract

Every error response from the backend has this shape:

```json
{
  "success": false,
  "message": "Email already registered"
}
```

Validation errors (422) have the same shape — the `message` field contains the first validation failure string. Map errors to user-facing strings using the `AppException` hierarchy defined in §4.3.

### Global error handler widget

```dart
// lib/core/utils/error_handler.dart
import '../errors/app_exception.dart';

String userFacingMessage(Object? error) {
  return switch (error) {
    UnauthorizedException e => e.message,
    ForbiddenException e => e.message,
    NotFoundException e => e.message,
    ConflictException e => e.message,
    ValidationException e => e.message,
    RateLimitException e => e.message,
    ServerException e => e.message,
    NetworkException e => e.message,
    DioException e => e.message ?? 'An unexpected error occurred.',
    _ => 'An unexpected error occurred.',
  };
}
```

---

## 9. Rate Limiting Awareness

The backend enforces two rate-limit tiers:

| Scope | Limit | Window |
|---|---|---|
| All `/api/v1/*` routes | **200 requests** | 15 minutes |
| `/api/v1/auth/*` routes only | **20 requests** | 15 minutes |

When a limit is exceeded the backend responds with HTTP **429** and:
```json
{ "success": false, "message": "Too many requests, please try again later." }
```

The `ErrorInterceptor` maps this to `RateLimitException`. In the UI, present a user-friendly message and **disable the offending button** for at least 30 seconds using a `Timer` to prevent rage-clicking. Do **not** automatically retry 429 responses — back-off is the user's responsibility.

---

## 10. Role-Based Navigation Guards

The JWT payload contains: `{ sub, email, role, tenantId, isVerified }`.  
After login, decode this from the `AuthResponse.user` object and persist it.

### Roles

| Role constant | String in JWT | Access scope |
|---|---|---|
| `UserRole.platformAdmin` | `PLATFORM_ADMIN` | `/admin/*`, all other routes |
| `UserRole.gymHost` | `GYM_HOST` | `/gyms/*`, `/trainers/*`, `/reports/*`, `/attendance/*`, `/payments/*`, tenant routes |
| `UserRole.branchManager` | `BRANCH_MANAGER` | `/gyms/*` (read + limited write), `/trainers/*`, `/attendance/*`, `/payments/*` |
| `UserRole.trainer` | `TRAINER` | `/me/*`, discovery, subscriptions (read own) |
| `UserRole.member` | `MEMBER` | `/me/*`, discovery, subscriptions (own), invoices (own) |

### go_router redirect guard

```dart
// lib/core/router/route_guards.dart
import 'package:go_router/go_router.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';
import '../../features/auth/domain/auth_state.dart';

String? authGuard(GoRouterState state, AuthState auth) {
  final loggedIn = auth.isAuthenticated;
  final onAuthRoute = state.matchedLocation.startsWith('/auth');

  if (!loggedIn && !onAuthRoute) return '/auth/login';
  if (loggedIn && onAuthRoute) return '/home';
  return null;
}

String? roleGuard(GoRouterState state, AuthState auth, List<UserRole> allowed) {
  if (!allowed.contains(auth.user?.role)) return '/unauthorized';
  return null;
}
```

### Example route configuration

```dart
GoRoute(
  path: '/admin',
  redirect: (context, state) {
    final auth = ref.read(authStateProvider);
    return roleGuard(state, auth, [UserRole.platformAdmin]);
  },
  builder: (_, __) => const AdminDashboardScreen(),
),
GoRoute(
  path: '/gym/dashboard',
  redirect: (context, state) {
    final auth = ref.read(authStateProvider);
    return roleGuard(state, auth, [UserRole.gymHost, UserRole.branchManager]);
  },
  builder: (_, __) => const GymDashboardScreen(),
),
```

> **Tenant context note**: Routes backed by `/gyms/*`, `/trainers/*`, `/reports/*`, `/attendance/*`, `/payments/*`, and `/invoices/*` require the JWT to include a `tenantId` claim. The backend's `tenantContext` middleware rejects requests with a `400` if `tenantId` is absent from the token. Users with `GYM_HOST` or `BRANCH_MANAGER` role receive a `tenantId` in their JWT after their tenant is approved and provisioned (status = `ACTIVE`). Gate these screens in the router until `auth.user?.tenantId != null`.
