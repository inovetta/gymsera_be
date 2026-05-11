/**
 * Test helpers — shared utilities for all test files.
 * Uses axios to hit the live server at http://localhost:3000.
 */
const axios = require('axios');

const BASE = 'http://localhost:3000/api/v1';

const api = axios.create({
  baseURL: BASE,
  validateStatus: () => true, // never throw — let tests assert status codes
  timeout: 15000,
});

/** Attach a Bearer token to every request. Returns a new instance. */
const authed = (token) =>
  axios.create({
    baseURL: BASE,
    headers: { Authorization: `Bearer ${token}` },
    validateStatus: () => true,
    timeout: 15000,
  });

/**
 * Full login flow for seeded users.
 * Seeded users are already verified — login returns tokens directly.
 */
const loginAs = async (email, password) => {
  const res = await api.post('/auth/login', { email, password });
  if (res.status !== 200) {
    throw new Error(`loginAs(${email}) failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  return res.data.data; // { accessToken, refreshToken, user }
};

module.exports = { api, authed, loginAs, BASE };
