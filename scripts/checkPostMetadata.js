'use strict';

const { createPostMetadata, createPublishPackage, markUploadSuccess, markUploadFailed } = require('../src/lib/postMetadata');

const input = { postId: 'post-test', jobId: 'job-test', rawInput: 'sample raw idea', slideCount: 5 };
const meta = createPostMetadata(input);
const pkg  = createPublishPackage({ ...input, caption: 'sample caption', hashtags: ['#test'] });

function assert(cond, msg) { if (!cond) throw new Error(`FAIL: ${msg}`); }

assert(meta.statuses.generation === 'completed',  'meta statuses.generation');
assert(meta.statuses.review     === 'pending',     'meta statuses.review');
assert(meta.statuses.upload     === 'not_started', 'meta statuses.upload');
assert(meta.statuses.buffer     === 'not_started', 'meta statuses.buffer');
assert(meta.statuses.publish    === 'not_started', 'meta statuses.publish');
assert(pkg.assets.slides.length === 5,             'pkg slide count');

const uploadInput = { uploadedAt: new Date().toISOString(), bucket: 'b', basePath: 'posts/post-test', slideUrls: [], captionUrl: '' };
assert(markUploadSuccess(meta, uploadInput).statuses.upload === 'uploaded', 'markUploadSuccess meta');
assert(markUploadSuccess(pkg,  uploadInput).statuses.upload === 'uploaded', 'markUploadSuccess pkg');

const failed = markUploadFailed(meta, 'test error');
assert(failed.statuses.upload === 'failed', 'markUploadFailed status');
assert(failed.errors.length > meta.errors.length, 'markUploadFailed errors');

console.log('Post metadata check passed');
