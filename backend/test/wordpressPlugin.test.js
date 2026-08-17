// The Node test suite can't execute PHP, so this covers what it can:
// - the two shipped copies of the plugin never drift apart
// - basic structural/security invariants via static string checks
// Run `npm run lint:php` (needs Docker) separately for real PHP syntax
// validation — see README.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const CANONICAL_PATH = path.join(REPO_ROOT, 'wordpress-plugin', 'ai-seo-optimizer-connector.php');
const PUBLISHED_PATH = path.join(REPO_ROOT, 'frontend', 'public', 'ai-seo-optimizer-connector.php');

const canonical = fs.readFileSync(CANONICAL_PATH, 'utf8');
const published = fs.readFileSync(PUBLISHED_PATH, 'utf8');

test('wordpress plugin: the downloadable copy in frontend/public is byte-identical to the source copy', () => {
  assert.equal(
    published,
    canonical,
    'frontend/public/ai-seo-optimizer-connector.php has drifted from wordpress-plugin/ai-seo-optimizer-connector.php — copy the source file over the published one'
  );
});

test('wordpress plugin: starts with an ABSPATH guard so it can never be executed directly', () => {
  assert.match(canonical, /if\s*\(\s*!\s*defined\(\s*['"]ABSPATH['"]\s*\)\s*\)\s*\{\s*exit;/);
});

test('wordpress plugin: every REST route declares an explicit permission_callback (never left to default-public)', () => {
  const routeBlocks = canonical.split('register_rest_route(').slice(1);
  assert.ok(routeBlocks.length >= 3, 'expected at least ping/resolve/apply routes');
  for (const block of routeBlocks) {
    // permission_callback should appear before the closing of this register_rest_route(...) call.
    const closeIndex = block.indexOf("\n});");
    const relevant = closeIndex === -1 ? block : block.slice(0, closeIndex);
    assert.match(
      relevant,
      /'permission_callback'\s*=>/,
      `a register_rest_route call is missing an explicit permission_callback:\n${relevant.slice(0, 200)}`
    );
  }
});

test('wordpress plugin: the permission callback requires edit_posts, not is_user_logged_in or a public default', () => {
  assert.match(canonical, /function ai_seo_optimizer_can_edit\(\)\s*\{\s*return current_user_can\('edit_posts'\);/);
});

test('wordpress plugin: user-supplied text fields are sanitized before being written to the database', () => {
  // post_title, meta_description, image_alt all pass through sanitize_text_field.
  const sanitizedCalls = canonical.match(/sanitize_text_field\(/g) || [];
  assert.ok(sanitizedCalls.length >= 3, `expected sanitize_text_field on title/meta/alt, found ${sanitizedCalls.length} call(s)`);
});

test('wordpress plugin: the attachment lookup uses a parameterized wpdb query, never raw string interpolation', () => {
  const attachmentFn = canonical.slice(canonical.indexOf('function ai_seo_optimizer_find_attachment_by_src'));
  assert.match(attachmentFn, /\$wpdb->prepare\(/, 'the SQL query against wp_posts must go through $wpdb->prepare');
  assert.match(attachmentFn, /\$wpdb->esc_like\(/, 'the LIKE pattern must be escaped with $wpdb->esc_like');
});

test('wordpress plugin: contains no obviously dangerous PHP constructs', () => {
  const dangerous = ['eval(', 'system(', 'shell_exec(', 'passthru(', 'proc_open(', '`', 'unserialize('];
  for (const pattern of dangerous) {
    assert.ok(!canonical.includes(pattern), `plugin source must not contain "${pattern}"`);
  }
});

test('wordpress plugin: the wp_head output escapes the meta description but does not double-encode the JSON-LD schema', () => {
  assert.match(canonical, /esc_attr\(\$meta_description\)/);
  // Schema is emitted as raw JSON inside a <script> tag — esc_attr/esc_html would corrupt valid JSON-LD.
  assert.doesNotMatch(canonical.match(/echo '<script[^;]+;/)[0], /esc_attr|esc_html/);
});
