'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const DEFAULT_RENDERED_OUTPUT_BUCKET = 'metafi-content-assets';
const DEFAULT_SIGNED_URL_TTL_SECONDS = 300;

class RenderedOutputStorageError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'RenderedOutputStorageError';
    this.code = 'RENDERED_OUTPUT_STORAGE_FAILED';
    this.details = details;
  }
}

function segment(value, label) {
  const text = String(value || '');
  if (!/^[a-zA-Z0-9._-]+$/.test(text)) throw new RenderedOutputStorageError(`${label} is invalid`);
  return text;
}

function renderedOutputBasePath({ campaignId, slotId, postId, language }) {
  return `campaign/${segment(campaignId, 'campaign_id')}/slots/${segment(slotId, 'slot_id')}/posts/${segment(postId, 'post_id')}/${segment(language, 'language')}`;
}

function checksum(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }

function createStoreOnlyZip(files) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let i = 0; i < 8; i += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buffer) => { let c = 0xffffffff; for (const byte of buffer) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const parts = []; const central = []; let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name); const value = file.buffer; const valueCrc = crc(value);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(valueCrc, 14); local.writeUInt32LE(value.length, 18); local.writeUInt32LE(value.length, 22); local.writeUInt16LE(name.length, 26);
    parts.push(local, name, value);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt32LE(valueCrc, 16); directory.writeUInt32LE(value.length, 20); directory.writeUInt32LE(value.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, name); offset += local.length + name.length + value.length;
  }
  const centralSize = central.reduce((total, value) => total + value.length, 0); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

async function verifiedUpload(storage, key, buffer, contentType) {
  const expected = checksum(buffer);
  const { error } = await storage.upload(key, buffer, { contentType, upsert: true, cacheControl: '3600' });
  if (error) throw new RenderedOutputStorageError(`Unable to upload ${key}: ${error.message}`, { storage_key: key });
  const { data, error: downloadError } = await storage.download(key);
  if (downloadError) throw new RenderedOutputStorageError(`Unable to verify ${key}: ${downloadError.message}`, { storage_key: key });
  const downloaded = Buffer.from(await data.arrayBuffer());
  if (downloaded.length !== buffer.length || checksum(downloaded) !== expected) throw new RenderedOutputStorageError(`Checksum verification failed for ${key}`, { storage_key: key });
  return { storage_key: key, content_type: contentType, byte_size: buffer.length, checksum_sha256: expected };
}

class RenderedOutputStorage {
  constructor(client, { bucket = DEFAULT_RENDERED_OUTPUT_BUCKET, root = path.resolve(__dirname, '../..') } = {}) {
    if (!client) throw new RenderedOutputStorageError('Supabase client is required');
    this.client = client; this.bucket = bucket; this.root = root;
  }

  async persist({ campaignId, slotId, postId, language, postFolder, renderedFiles, generatedAt = new Date().toISOString() }) {
    const basePath = renderedOutputBasePath({ campaignId, slotId, postId, language });
    const folder = path.resolve(this.root, postFolder); const outputRoot = path.resolve(this.root, 'outputs', 'posts');
    if (folder !== outputRoot && !folder.startsWith(`${outputRoot}${path.sep}`)) throw new RenderedOutputStorageError('Post folder is outside outputs/posts');
    const files = [];
    for (const [index, relative] of renderedFiles.entries()) {
      const file = path.resolve(this.root, relative);
      if (!file.startsWith(`${folder}${path.sep}`)) throw new RenderedOutputStorageError('Rendered slide is outside its post folder');
      files.push({ order: index + 1, name: `slide-${String(index + 1).padStart(2, '0')}.png`, buffer: await fs.readFile(file) });
    }
    if (!files.length) throw new RenderedOutputStorageError('Rendered slides are missing', { temporary_path: folder, temporary_files_preserved: true });
    const storage = this.client.storage.from(this.bucket); const slides = [];
    try {
      for (const file of files) slides.push({ order: file.order, filename: file.name, ...(await verifiedUpload(storage, `${basePath}/slides/${file.name}`, file.buffer, 'image/png')) });
      const zipBuffer = createStoreOnlyZip(files); const zip = await verifiedUpload(storage, `${basePath}/${postId}-slides.zip`, zipBuffer, 'application/zip');
      const uploadedAt = new Date().toISOString();
      const manifestValue = { version: 1, status: 'complete', campaign_id: campaignId, slot_id: slotId, post_id: postId, language, bucket: this.bucket, base_path: basePath, generated_at: generatedAt, uploaded_at: uploadedAt, slides, zip };
      const manifestBuffer = Buffer.from(JSON.stringify(manifestValue, null, 2));
      const manifest = await verifiedUpload(storage, `${basePath}/manifest.json`, manifestBuffer, 'application/json');
      return { storage_provider: 'supabase_storage', status: 'complete', bucket: this.bucket, base_path: basePath, language, generated_at: generatedAt, uploaded_at: uploadedAt, slide_count: slides.length, slides, zip, manifest };
    } catch (error) {
      if (error instanceof RenderedOutputStorageError) {
        error.details = { ...error.details, temporary_path: folder, temporary_files_preserved: true };
        error.message = `${error.message}; temporary render files preserved at ${folder}`;
        throw error;
      }
      throw new RenderedOutputStorageError(error.message, { temporary_path: folder, temporary_files_preserved: true });
    }
  }

  async cleanupTemporary(postFolder) {
    const folder = path.resolve(this.root, postFolder); const outputRoot = path.resolve(this.root, 'outputs', 'posts');
    if (folder === outputRoot || !folder.startsWith(`${outputRoot}${path.sep}`)) throw new RenderedOutputStorageError('Refusing to remove an invalid temporary post folder');
    await fs.rm(folder, { recursive: true, force: true });
  }

  async signedSlide(output, order, expiresIn = DEFAULT_SIGNED_URL_TTL_SECONDS) {
    const slide = output?.slides?.find((item) => item.order === order); if (!slide) return null;
    return this.signed(output.bucket, slide.storage_key, expiresIn);
  }

  async signedZip(output, expiresIn = DEFAULT_SIGNED_URL_TTL_SECONDS) { return output?.zip ? this.signed(output.bucket, output.zip.storage_key, expiresIn) : null; }

  async signedPreviews(output, expiresIn = DEFAULT_SIGNED_URL_TTL_SECONDS) {
    if (!output?.slides?.length) return [];
    const { data, error } = await this.client.storage.from(output.bucket).createSignedUrls(output.slides.map((slide) => slide.storage_key), expiresIn);
    if (error) throw new RenderedOutputStorageError(`Unable to sign rendered slides: ${error.message}`);
    return data.map((item, index) => ({ order: output.slides[index].order, storage_key: output.slides[index].storage_key, signed_url: item.signedUrl }));
  }

  async signed(bucket, key, expiresIn) {
    const { data, error } = await this.client.storage.from(bucket).createSignedUrl(key, expiresIn);
    if (error) throw new RenderedOutputStorageError(`Unable to sign ${key}: ${error.message}`);
    return data.signedUrl;
  }
}

function createRenderedOutputStorage(options = {}) { return new RenderedOutputStorage(options.client, options); }

module.exports = { DEFAULT_RENDERED_OUTPUT_BUCKET, DEFAULT_SIGNED_URL_TTL_SECONDS, RenderedOutputStorageError, RenderedOutputStorage, createRenderedOutputStorage, renderedOutputBasePath, createStoreOnlyZip };
