// Google Calendar integration — raw OAuth2 + Calendar API v3 over `fetch`,
// no googleapis SDK dependency (same "raw REST call" pattern as
// src/sms.js and src/ai.js use for Twilio/Anthropic). Entirely optional:
// gated on GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET — until both are set,
// googleCalendarEnabled is false and every route that needs this 501s.

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const googleCalendarEnabled = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);

// Read-only: this app pulls Google Calendar events in to check for
// conflicts and show them alongside family/group events — it doesn't
// create, edit, or delete anything on the user's real Google Calendar.
const SCOPES = 'https://www.googleapis.com/auth/calendar.readonly openid email';

function redirectUri(baseUrl) {
  return baseUrl + '/api/integrations/google/callback';
}

function buildAuthUrl(baseUrl, state) {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(baseUrl),
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
}

async function exchangeCode(baseUrl, code) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri(baseUrl)
    })
  });
  if (!res.ok) throw new Error('Google token exchange failed: ' + (await res.text().catch(() => res.status)));
  return res.json(); // { access_token, refresh_token, expires_in, id_token, ... }
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  });
  if (!res.ok) throw new Error('Google token refresh failed: ' + (await res.text().catch(() => res.status)));
  return res.json(); // { access_token, expires_in, ... } — no new refresh_token on a refresh
}

async function fetchUserInfo(accessToken) {
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: 'Bearer ' + accessToken } });
  if (!res.ok) return null;
  return res.json(); // { email, name, ... }
}

async function listEvents(accessToken, timeMinISO, timeMaxISO) {
  const params = new URLSearchParams({ timeMin: timeMinISO, timeMax: timeMaxISO, singleEvents: 'true', orderBy: 'startTime', maxResults: '250' });
  const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?' + params.toString(), {
    headers: { Authorization: 'Bearer ' + accessToken }
  });
  if (!res.ok) throw new Error('Google Calendar events.list failed: ' + (await res.text().catch(() => res.status)));
  const data = await res.json();
  return data.items || [];
}

module.exports = { googleCalendarEnabled, buildAuthUrl, exchangeCode, refreshAccessToken, fetchUserInfo, listEvents };
