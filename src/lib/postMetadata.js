'use strict';

function baseStatuses() {
  return { generation: 'completed', review: 'pending', upload: 'not_started', buffer: 'not_started', publish: 'not_started' };
}

function createPostMetadata({ postId, jobId, rawInput, createdAt, slideCount, hasCaption, paths } = {}) {
  const now = createdAt || new Date().toISOString();
  return {
    post_id: postId,
    job_id: jobId || null,
    created_at: now,
    updated_at: now,
    source: { raw_input: rawInput || null },
    statuses: baseStatuses(),
    assets: {
      slide_count: slideCount,
      slides_path: 'slides/',
      caption_path: 'caption.txt',
      publish_package_path: 'publish-package.json',
    },
    paths: paths || {},
    errors: [],
  };
}

function createPublishPackage({ postId, jobId, caption, hashtags, createdAt, slideCount } = {}) {
  const now = createdAt || new Date().toISOString();
  const slides = Array.from({ length: slideCount || 0 }, (_, i) => `slides/slide-${i + 1}.png`);
  return {
    post_id: postId,
    job_id: jobId || null,
    created_at: now,
    updated_at: now,
    statuses: baseStatuses(),
    caption: caption,
    hashtags: hashtags,
    assets: { slides, caption_path: 'caption.txt' },
    supabase: null,
    buffer: null,
    publish: null,
    errors: [],
  };
}

function markUploadSuccess(obj, { uploadedAt, bucket, basePath, slideUrls, captionUrl }) {
  return {
    ...obj,
    updated_at: uploadedAt,
    statuses: { ...obj.statuses, upload: 'uploaded' },
    supabase: { bucket, base_path: basePath, uploaded_at: uploadedAt, slide_urls: slideUrls, caption_url: captionUrl },
  };
}

function markUploadFailed(obj, errorMessage) {
  const at = new Date().toISOString();
  return {
    ...obj,
    updated_at: at,
    statuses: { ...obj.statuses, upload: 'failed' },
    errors: [...(obj.errors || []), { stage: 'upload', message: errorMessage, at }],
  };
}

module.exports = { createPostMetadata, createPublishPackage, markUploadSuccess, markUploadFailed };
