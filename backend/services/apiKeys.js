const crypto = require('crypto');

const API_KEY_PREFIX = 'saeo_';
const KEY_PREFIX_DISPLAY_LENGTH = 12;

function generateApiKey() {
  const key = API_KEY_PREFIX + crypto.randomBytes(24).toString('hex');
  return { key, keyPrefix: key.slice(0, KEY_PREFIX_DISPLAY_LENGTH) };
}

// Deterministic hash so a key can be looked up by an indexed equality check
// (`WHERE key_hash = $1`) on every request, unlike bcrypt — which is
// intentionally non-deterministic per hash and would require fetching every
// row to compare. That tradeoff exists to slow down brute-forcing low-entropy
// user passwords; an API key is already ~192 bits of random data, so SHA-256
// (same pattern as users.reset_token_hash) gives the same practical security
// without losing lookup-by-hash. Only the hash is ever stored — the plaintext
// key is shown once, at creation, and never persisted.
function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

module.exports = { API_KEY_PREFIX, generateApiKey, hashApiKey };
