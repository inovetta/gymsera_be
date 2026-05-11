const authService = require('../services/auth.service');
const { sendSuccess, createError } = require('../utils/response.utils');

// ── Register ──────────────────────────────────────────────────────────────────
const register = async (req, res, next) => {
  try {
    const result = await authService.register(req.body);
    return sendSuccess(
      res,
      result,
      'Registration successful. Please check your email for the OTP verification code.',
      201
    );
  } catch (err) {
    next(err);
  }
};

// ── OTP Verify ────────────────────────────────────────────────────────────────
const verifyOtp = async (req, res, next) => {
  try {
    const result = await authService.verifyOtp(
      req.body,
      req.ip,
      req.headers['user-agent']
    );
    return sendSuccess(res, result, 'Email verified successfully. Welcome to GymsEra!');
  } catch (err) {
    next(err);
  }
};

// ── OTP Resend ────────────────────────────────────────────────────────────────
const resendOtp = async (req, res, next) => {
  try {
    const result = await authService.resendOtp(req.body);
    return sendSuccess(res, null, result.message);
  } catch (err) {
    next(err);
  }
};

// ── Login ─────────────────────────────────────────────────────────────────────
const login = async (req, res, next) => {
  try {
    const result = await authService.login(
      req.body,
      req.ip,
      req.headers['user-agent']
    );
    return sendSuccess(res, result, 'Login successful');
  } catch (err) {
    // If the user exists but is unverified the service attaches `pendingOtp`
    // instead of returning a generic 403. Return success:false with OTP meta.
    if (err.pendingOtp) {
      return res.status(403).json({
        success: false,
        message: err.message,
        data: err.pendingOtp,
      });
    }
    next(err);
  }
};

// ── Google Social Login ───────────────────────────────────────────────────────
const googleLogin = async (req, res, next) => {
  try {
    const result = await authService.googleLogin(
      req.body,
      req.ip,
      req.headers['user-agent']
    );
    return sendSuccess(res, result, 'Google login successful');
  } catch (err) {
    next(err);
  }
};

// ── Refresh Token ─────────────────────────────────────────────────────────────
const refreshToken = async (req, res, next) => {
  try {
    const { refreshToken: token } = req.body;
    const result = await authService.refreshTokens(
      token,
      req.ip,
      req.headers['user-agent']
    );
    return sendSuccess(res, result, 'Token refreshed successfully');
  } catch (err) {
    next(err);
  }
};

// ── Password Reset — Request ──────────────────────────────────────────────────
const passwordResetRequest = async (req, res, next) => {
  try {
    const result = await authService.passwordResetRequest(req.body);
    return sendSuccess(res, null, result.message);
  } catch (err) {
    next(err);
  }
};

// ── Password Reset — Confirm ──────────────────────────────────────────────────
const passwordResetConfirm = async (req, res, next) => {
  try {
    const result = await authService.passwordResetConfirm(req.body);
    return sendSuccess(res, null, result.message);
  } catch (err) {
    next(err);
  }
};

// ── GET /auth/me — full DB profile lookup ─────────────────────────────────────
const me = async (req, res, next) => {
  try {
    const profile = await authService.getMe(req.user.sub);
    return sendSuccess(res, profile, 'Profile retrieved successfully');
  } catch (err) {
    next(err);
  }
};

module.exports = {
  register,
  verifyOtp,
  resendOtp,
  login,
  googleLogin,
  refreshToken,
  passwordResetRequest,
  passwordResetConfirm,
  me,
};
