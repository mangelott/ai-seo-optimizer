<?php
/**
 * Plugin Name: AI SEO Optimizer Connector
 * Description: Lets your AI SEO Optimizer account apply approved fixes (title, meta description, image alt text, structured data) directly to this site via the REST API, authenticated with a WordPress Application Password.
 * Version: 1.0.0
 * Author: AI SEO Optimizer
 * License: GPL-2.0-or-later
 */

if (!defined('ABSPATH')) {
    exit;
}

define('AI_SEO_OPTIMIZER_VERSION', '1.0.0');

add_action('rest_api_init', function () {
    register_rest_route('ai-seo-optimizer/v1', '/ping', [
        'methods' => 'GET',
        'callback' => function () {
            return ['ok' => true, 'version' => AI_SEO_OPTIMIZER_VERSION];
        },
        'permission_callback' => 'ai_seo_optimizer_can_edit',
    ]);

    register_rest_route('ai-seo-optimizer/v1', '/resolve', [
        'methods' => 'GET',
        'callback' => 'ai_seo_optimizer_resolve_url',
        'permission_callback' => 'ai_seo_optimizer_can_edit',
        'args' => [
            'url' => ['required' => true],
        ],
    ]);

    register_rest_route('ai-seo-optimizer/v1', '/apply', [
        'methods' => 'POST',
        'callback' => 'ai_seo_optimizer_apply_fix',
        'permission_callback' => 'ai_seo_optimizer_can_edit',
        'args' => [
            'postId' => ['required' => true],
            'field' => ['required' => true],
            'value' => ['required' => true],
        ],
    ]);
});

function ai_seo_optimizer_can_edit() {
    return current_user_can('edit_posts');
}

function ai_seo_optimizer_resolve_url(WP_REST_Request $req) {
    $url = $req->get_param('url');

    $post_id = url_to_postid($url);

    if (!$post_id) {
        $front_page_id = (int) get_option('page_on_front');
        if ($front_page_id) {
            $post_id = $front_page_id;
        }
    }

    if (!$post_id) {
        return new WP_Error('ai_seo_optimizer_not_found', 'Could not resolve that URL to a post or page on this site.', ['status' => 404]);
    }

    return [
        'postId' => $post_id,
        'postType' => get_post_type($post_id),
    ];
}

function ai_seo_optimizer_apply_fix(WP_REST_Request $req) {
    $post_id = (int) $req->get_param('postId');
    $field = $req->get_param('field');
    $value = $req->get_param('value');
    $target = $req->get_param('target');

    if (!$post_id || !get_post($post_id)) {
        return new WP_Error('ai_seo_optimizer_not_found', 'Post not found.', ['status' => 404]);
    }

    switch ($field) {
        case 'post_title':
            $result = wp_update_post([
                'ID' => $post_id,
                'post_title' => sanitize_text_field($value),
            ], true);
            if (is_wp_error($result)) {
                return $result;
            }
            return ['ok' => true];

        case 'meta_description':
            update_post_meta($post_id, '_ai_seo_optimizer_meta_description', sanitize_text_field($value));
            return ['ok' => true];

        case 'schema':
            $json = is_string($value) ? $value : wp_json_encode($value);
            update_post_meta($post_id, '_ai_seo_optimizer_schema', wp_slash($json));
            return ['ok' => true];

        case 'image_alt':
            if (!$target) {
                return new WP_Error('ai_seo_optimizer_missing_target', 'The image src to match is required for image_alt fixes.', ['status' => 400]);
            }
            $attachment_id = ai_seo_optimizer_find_attachment_by_src($target);
            if (!$attachment_id) {
                return new WP_Error('ai_seo_optimizer_not_found', 'Could not find a media library item matching that image.', ['status' => 404]);
            }
            update_post_meta($attachment_id, '_wp_attachment_image_alt', sanitize_text_field($value));
            return ['ok' => true];

        default:
            return new WP_Error('ai_seo_optimizer_unsupported_field', 'Unsupported field: ' . $field, ['status' => 400]);
    }
}

function ai_seo_optimizer_find_attachment_by_src($src) {
    $path = wp_parse_url($src, PHP_URL_PATH);
    $filename = $path ? basename($path) : basename($src);
    // WordPress serves resized copies as "photo-300x200.jpg"; strip that suffix to match the original attachment.
    $filename = preg_replace('/-\d+x\d+(?=\.[a-zA-Z]+$)/', '', $filename);

    if (!$filename) {
        return 0;
    }

    global $wpdb;
    $like = '%' . $wpdb->esc_like($filename);
    $id = $wpdb->get_var($wpdb->prepare(
        "SELECT ID FROM {$wpdb->posts} WHERE post_type = 'attachment' AND guid LIKE %s ORDER BY ID DESC LIMIT 1",
        $like
    ));

    return $id ? (int) $id : 0;
}

// Outputs the fixes we can't write natively (meta description, structured data) into <head>,
// since a vanilla WordPress install has no field for either. Skips the meta description if a
// dedicated SEO plugin is already active, so the two never fight over the same tag.
add_action('wp_head', function () {
    if (!is_singular()) {
        return;
    }

    $post_id = get_queried_object_id();
    if (!$post_id) {
        return;
    }

    $meta_description = get_post_meta($post_id, '_ai_seo_optimizer_meta_description', true);
    if ($meta_description && !ai_seo_optimizer_seo_plugin_active()) {
        echo '<meta name="description" content="' . esc_attr($meta_description) . '">' . "\n";
    }

    $schema = get_post_meta($post_id, '_ai_seo_optimizer_schema', true);
    if ($schema) {
        echo '<script type="application/ld+json">' . wp_unslash($schema) . '</script>' . "\n";
    }
}, 1);

function ai_seo_optimizer_seo_plugin_active() {
    if (!function_exists('is_plugin_active')) {
        require_once ABSPATH . 'wp-admin/includes/plugin.php';
    }
    return is_plugin_active('wordpress-seo/wp-seo.php') || is_plugin_active('seo-by-rank-math/rank-math.php');
}
