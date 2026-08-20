// Tests for services/trustSignals.js. The contact/privacy path checks are
// exercised against a local fake Express server (in the pattern of
// test/crawlability.test.js — one server, several fixture "sites" mounted
// at different path prefixes). checkHttpsActive needs a real TLS listener
// to exercise its happy path, so a second server is spun up with a
// throwaway self-signed cert (via the system `openssl` binary) and
// NODE_TLS_REJECT_UNAUTHORIZED is disabled for the duration of this file's
// process only, so the default (non-test) cert validation behavior is
// unaffected everywhere else.
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  checkTrustSignals,
  checkHttpsActive,
  findFirstExistingPage,
} = require('../services/trustSignals');

let fakeHttpServer;
let httpBaseUrl;
let fakeHttpsServer;
let httpsBaseUrl;
let originalTlsReject;

function buildFakeHttpServer() {
  const api = express();

  // "with-contact" site: only the English contact path exists.
  api.get('/with-contact/contact', (req, res) => res.send('Contact us'));

  // "sobre-only" site: only the Portuguese contact path exists.
  api.get('/sobre-only/sobre', (req, res) => res.send('Sobre nós'));

  // "with-privacy" site: only a privacy policy page exists.
  api.get('/with-privacy/privacy-policy', (req, res) => res.send('Privacy Policy'));

  // "no-signals" site has no routes at all: every candidate path 404s.

  return api;
}

test.before(async () => {
  await new Promise((resolve) => {
    fakeHttpServer = buildFakeHttpServer().listen(0, resolve);
  });
  httpBaseUrl = `http://localhost:${fakeHttpServer.address().port}`;

  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-signals-cert-'));
  const keyPath = path.join(certDir, 'key.pem');
  const certPath = path.join(certDir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-subj', '/CN=localhost',
  ]);

  await new Promise((resolve) => {
    fakeHttpsServer = https
      .createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, (req, res) => res.end('ok'))
      .listen(0, resolve);
  });
  httpsBaseUrl = `https://localhost:${fakeHttpsServer.address().port}`;

  originalTlsReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // trust the throwaway self-signed cert above
});

test.after(async () => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalTlsReject;
  await new Promise((resolve) => fakeHttpServer.close(resolve));
  await new Promise((resolve) => fakeHttpsServer.close(resolve));
});

test('checkHttpsActive: true when the domain answers over HTTPS', async () => {
  assert.equal(await checkHttpsActive(httpsBaseUrl), true);
});

test('checkHttpsActive: false when the domain has no HTTPS listener at all', async () => {
  assert.equal(await checkHttpsActive(httpBaseUrl), false);
});

test('checkHttpsActive: false for an unreachable host', async () => {
  assert.equal(await checkHttpsActive('https://localhost:1'), false);
});

test('findFirstExistingPage: returns the first candidate path that responds 200', async () => {
  const result = await findFirstExistingPage(`${httpBaseUrl}/with-contact`, ['/contact', '/about', '/sobre', '/contacto']);
  assert.deepEqual(result, { found: true, url: `${httpBaseUrl}/with-contact/contact` });
});

test('findFirstExistingPage: falls through to a later candidate when earlier ones 404', async () => {
  const result = await findFirstExistingPage(`${httpBaseUrl}/sobre-only`, ['/contact', '/about', '/sobre', '/contacto']);
  assert.deepEqual(result, { found: true, url: `${httpBaseUrl}/sobre-only/sobre` });
});

test('findFirstExistingPage: reports not found when none of the candidates exist', async () => {
  const result = await findFirstExistingPage(`${httpBaseUrl}/no-signals`, ['/contact', '/about', '/sobre', '/contacto']);
  assert.deepEqual(result, { found: false, url: null });
});

test('checkTrustSignals: fixture domain with every signal present', async () => {
  const result = await checkTrustSignals(httpsBaseUrl);
  assert.equal(result.httpsActive, true);
  assert.equal(result.contactPage.found, true, 'the HTTPS fixture server answers 200 for every path');
  assert.equal(result.privacyPolicy.found, true, 'the HTTPS fixture server answers 200 for every path');
});

test('checkTrustSignals: fixture domain with none of the signals present', async () => {
  const result = await checkTrustSignals(`${httpBaseUrl}/no-signals`);
  assert.equal(result.httpsActive, false, 'no HTTPS listener runs on this fixture host/port');
  assert.deepEqual(result.contactPage, { found: false, url: null });
  assert.deepEqual(result.privacyPolicy, { found: false, url: null });
});

test('checkTrustSignals: reports each signal independently (contact found, privacy missing)', async () => {
  const result = await checkTrustSignals(`${httpBaseUrl}/with-contact`);
  assert.deepEqual(result.contactPage, { found: true, url: `${httpBaseUrl}/with-contact/contact` });
  assert.deepEqual(result.privacyPolicy, { found: false, url: null });
});

test('checkTrustSignals: reports each signal independently (privacy found, contact missing)', async () => {
  const result = await checkTrustSignals(`${httpBaseUrl}/with-privacy`);
  assert.deepEqual(result.contactPage, { found: false, url: null });
  assert.deepEqual(result.privacyPolicy, { found: true, url: `${httpBaseUrl}/with-privacy/privacy-policy` });
});
