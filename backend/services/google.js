const axios = require('axios');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

function getAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: process.env.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    prompt: 'select_account',
    ...(state ? { state } : {}),
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function exchangeCodeForProfile(code) {
  const { data: tokens } = await axios.post(
    TOKEN_URL,
    new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: process.env.GOOGLE_REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  const { data: profile } = await axios.get(USERINFO_URL, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  return {
    googleId: profile.sub,
    email: profile.email,
    name: profile.name,
    emailVerified: profile.email_verified,
  };
}

module.exports = { getAuthUrl, exchangeCodeForProfile };
