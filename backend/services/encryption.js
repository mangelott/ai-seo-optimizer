const pool = require('../db/pool');

async function encryptSecret(plaintext) {
  const { rows } = await pool.query('SELECT pgp_sym_encrypt($1, $2) AS enc', [
    plaintext,
    process.env.WP_CREDENTIALS_ENCRYPTION_KEY,
  ]);
  return rows[0].enc;
}

async function decryptSecret(encryptedBuffer) {
  const { rows } = await pool.query('SELECT pgp_sym_decrypt($1, $2) AS dec', [
    encryptedBuffer,
    process.env.WP_CREDENTIALS_ENCRYPTION_KEY,
  ]);
  return rows[0].dec;
}

module.exports = { encryptSecret, decryptSecret };
