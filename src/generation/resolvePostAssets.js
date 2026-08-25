'use strict';

const fs = require('fs');
const path = require('path');
const { resolveCampaignAccount } = require('../campaigns/campaignService');

const ROOT = path.resolve(__dirname, '../..');
const VALID_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

const ASSET_BANKS = {
  visual_hooks: 'assets/hook-images',
  body_slides: 'assets/body-images',
  app_icon_home_screen: 'assets/app-icon-home-screen',
};

const LANGUAGE_LANES = {
  ar: 0,
  en: 1,
  es: 2,
  fr: 3,
};

const CTA_ASSET_BANK = 'app_icon_home_screen';
const USAGE_PATH = path.join(ROOT, 'data', 'asset-usage.json');

class AccountAssetValidationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AccountAssetValidationError';
    this.code = code;
    this.details = details;
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--post') {
      args.post = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--language-lane') {
      args.languageLane = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--account-id') {
      args.accountId = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--account-json') {
      try { args.account = JSON.parse(argv[i + 1]); } catch { throw new Error('--account-json must be valid JSON'); }
      i += 1;
    }
  }
  return args;
}

function repoRelative(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

function readUsage() {
  if (!fs.existsSync(USAGE_PATH) || !fs.readFileSync(USAGE_PATH, 'utf8').trim()) return { assets: {} };
  const usage = readJson(USAGE_PATH);
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return { assets: {} };
  if (!usage.assets || typeof usage.assets !== 'object' || Array.isArray(usage.assets)) usage.assets = {};
  return usage;
}

function validImages(assetFolder) {
  if (!fs.existsSync(assetFolder) || !fs.statSync(assetFolder).isDirectory()) {
    throw new Error(`Asset folder does not exist: ${repoRelative(assetFolder)}`);
  }

  return fs.readdirSync(assetFolder, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => VALID_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .sort((a, b) => a.localeCompare(b));
}

function isReadableSupportedImage(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    const extension = path.extname(filePath).toLowerCase();
    if (!VALID_EXTENSIONS.has(extension)) return false;
    const handle = fs.openSync(filePath, 'r');
    try {
      const header = Buffer.alloc(12);
      const bytesRead = fs.readSync(handle, header, 0, header.length, 0);
      if (bytesRead < 12) return false;
      if (extension === '.png') return header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      if (extension === '.jpg' || extension === '.jpeg') return header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
      return header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP';
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return false;
  }
}

function readableSupportedImages(assetFolder) {
  if (!fs.existsSync(assetFolder) || !fs.statSync(assetFolder).isDirectory()) return [];
  return fs.readdirSync(assetFolder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isReadableSupportedImage(path.join(assetFolder, entry.name)))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function assetInfo(assetFolderRelative, filename) {
  const parsed = path.parse(filename);
  return {
    asset_id: parsed.name,
    asset_path: `${assetFolderRelative}/${filename}`,
  };
}

function assetFolderFor(bank, language, account) {
  const baseFolder = ASSET_BANKS[bank];
  if (!baseFolder) return null;

  if (bank === CTA_ASSET_BANK) {
    if (!account) {
      throw new Error('Account ID is required to resolve asset_bank "app_icon_home_screen"');
    }
    if (language == null) {
      throw new Error('CTA language is required to resolve asset_bank "app_icon_home_screen"');
    }
    if (!Object.prototype.hasOwnProperty.call(LANGUAGE_LANES, language)) {
      throw new Error(`Unsupported CTA language: ${language}`);
    }
    return `assets/account-app-cta-images/${account.account_id}/${language}`;
  }

  if (account && bank === 'visual_hooks') return `assets/account-hook-images/${account.account_id}`;
  if (account && bank === 'body_slides' && account.gender === 'female') return `${baseFolder}/female`;

  return baseFolder;
}

function visualAccount(accountId, resolveAccount = resolveCampaignAccount) {
  if (!accountId) return null;
  const account = resolveAccount(accountId);
  if (!['male', 'female'].includes(account.gender)) throw new Error(`Account ${account.account_id} is missing a valid gender`);
  return account;
}

function emptyBankError(bank, account, folderRelative, language) {
  if (bank === 'visual_hooks' && account) {
    return new Error(`Account "${account.internal_name}" has no character hook images. Upload character hook slides to ${folderRelative}`);
  }
  if (bank === 'body_slides' && account) {
    return new Error(`Missing ${account.gender} body bank: no valid image files found in ${folderRelative}`);
  }
  if (bank === CTA_ASSET_BANK) {
    const languageName = ({ ar: 'Arabic', en: 'English', es: 'Spanish', fr: 'French' })[language] || language;
    return new Error(`${account.internal_name} has no ${languageName} App CTA images. Upload them from ${account.internal_name}'s account page before retrying.`);
  }
  return new Error(`No valid image files found in ${folderRelative}`);
}

function validateAccountVisualBanks(accountId, language, hookType = '', options = {}) {
  const root = options.root || ROOT;
  const account = options.account || visualAccount(accountId, options.resolveAccount);
  for (const bank of ['visual_hooks', CTA_ASSET_BANK]) {
    const folderRelative = assetFolderFor(bank, language, account);
    const folder = path.join(root, folderRelative);
    const images = readableSupportedImages(folder);
    if (images.length) continue;
    if (bank === 'visual_hooks') {
      throw new AccountAssetValidationError(
        'ACCOUNT_HOOK_ASSET_MISSING',
        `${account.internal_name} is missing a character hook image${hookType ? ` for ${hookType}` : ''}. Upload it in Accounts and retry.`,
        { account_id: account.account_id, hook_type: hookType || null, asset_folder: folderRelative },
      );
    }
    const languageName = ({ ar: 'Arabic', en: 'English', es: 'Spanish', fr: 'French' })[language] || language;
    const article = ['Arabic', 'English'].includes(languageName) ? 'an' : 'a';
    throw new AccountAssetValidationError(
      'ACCOUNT_CTA_MISSING',
      `${account.internal_name} is missing ${article} ${languageName} CTA image. Upload it in Accounts and retry.`,
      { account_id: account.account_id, language, asset_folder: folderRelative },
    );
  }
  return account;
}

function assertSlideBank(slide) {
  if (slide.slide_number === 1 || slide.role === 'hook') {
    if (slide.asset_bank !== 'visual_hooks') throw new Error(`Hook slide ${slide.slide_number} must use asset_bank "visual_hooks"`);
    return;
  }
  if (slide.role === 'cta' || slide.asset_bank === CTA_ASSET_BANK) {
    if (slide.asset_bank !== CTA_ASSET_BANK) throw new Error(`CTA slide ${slide.slide_number} must use asset_bank "${CTA_ASSET_BANK}"`);
    return;
  }
  if (slide.asset_bank !== 'body_slides') throw new Error(`Body slide ${slide.slide_number} must use asset_bank "body_slides"`);
}

function eligibleImages(bank, images, laneIndex, assetFolderRelative) {
  const isAccountHookBank = bank === 'visual_hooks'
    && typeof assetFolderRelative === 'string'
    && assetFolderRelative.startsWith('assets/account-hook-images/');

  // Account-owned character hooks are already isolated by account. They must rotate
  // across the full uploaded bank regardless of campaign language or campaign ID.
  if (laneIndex == null || bank === CTA_ASSET_BANK || isAccountHookBank) return images;

  return images.filter((_filename, index) => index % Object.keys(LANGUAGE_LANES).length === laneIndex);
}

function usageEntry(usage, assetPath, bank) {
  const current = usage.assets[assetPath];
  return {
    use_count: Number(current && current.use_count) || 0,
    last_used_at: current && typeof current.last_used_at === 'string' ? current.last_used_at : '',
    last_post_id: current && typeof current.last_post_id === 'string' ? current.last_post_id : '',
    bank_type: bank,
  };
}

function selectLeastUsed(bank, assetFolderRelative, images, usage, usedInPost) {
  const unused = images.filter((filename) => !usedInPost.has(`${assetFolderRelative}/${filename}`));
  const candidates = unused.length ? unused : images;
  return candidates.slice().sort((left, right) => {
    const leftPath = `${assetFolderRelative}/${left}`;
    const rightPath = `${assetFolderRelative}/${right}`;
    const leftUsage = usageEntry(usage, leftPath, bank);
    const rightUsage = usageEntry(usage, rightPath, bank);
    return leftUsage.use_count - rightUsage.use_count
      || leftUsage.last_used_at.localeCompare(rightUsage.last_used_at)
      || leftPath.localeCompare(rightPath);
  })[0];
}

function resolveSlide(slide, assetCache, assetFolders, usage, usedInPost, postId, usedAt, laneIndex) {
  assertSlideBank(slide);
  const assetFolderRelative = assetFolders[slide.asset_bank];
  if (!assetFolderRelative) {
    throw new Error(`Unknown asset_bank on slide ${slide.slide_number}: ${slide.asset_bank}`);
  }

  const images = eligibleImages(
    slide.asset_bank,
    assetCache[slide.asset_bank],
    laneIndex,
    assetFolderRelative
  );
  if (!images || images.length === 0) {
    throw new Error(`No valid image files found for asset_bank "${slide.asset_bank}"`);
  }

  const filename = selectLeastUsed(slide.asset_bank, assetFolderRelative, images, usage, usedInPost);
  const selected = assetInfo(assetFolderRelative, filename);
  const previous = usageEntry(usage, selected.asset_path, slide.asset_bank);
  usage.assets[selected.asset_path] = {
    use_count: previous.use_count + 1,
    last_used_at: usedAt,
    last_post_id: postId,
    bank_type: slide.asset_bank,
  };
  usedInPost.add(selected.asset_path);

  return {
    ...slide,
    ...selected,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.post) throw new Error('Missing required argument: --post outputs/posts/{post_id}');
  const laneIndex = args.languageLane == null ? null : LANGUAGE_LANES[args.languageLane];
  if (args.languageLane != null && laneIndex == null) {
    throw new Error(`Unsupported language lane: ${args.languageLane}`);
  }

  const postFolder = path.isAbsolute(args.post) ? args.post : path.join(ROOT, args.post);
  if (!fs.existsSync(postFolder) || !fs.statSync(postFolder).isDirectory()) {
    throw new Error(`Post folder does not exist: ${args.post}`);
  }

  const packagePath = path.join(postFolder, 'publish-package.json');
  if (!fs.existsSync(packagePath)) {
    throw new Error(`publish-package.json is missing: ${repoRelative(packagePath)}`);
  }

  const publishPackage = readJson(packagePath);
  if (!Array.isArray(publishPackage.slides)) {
    throw new Error('publish-package.json must contain slides array');
  }

  const outputPath = path.join(postFolder, 'publish-package-resolved.json');
  if (fs.existsSync(outputPath)) {
    const existing = readJson(outputPath);
    console.log(JSON.stringify({
      post_folder: repoRelative(postFolder),
      output_path: repoRelative(outputPath),
      slide_count: Array.isArray(existing.slides) ? existing.slides.length : 0,
      reused_existing_selection: true,
    }, null, 2));
    return;
  }

  const account = args.account || visualAccount(args.accountId);
  const assetCache = Object.fromEntries(
    Object.entries(ASSET_BANKS).map(([bank, folderRelative]) => {
      const resolvedFolderRelative = assetFolderFor(bank, args.languageLane, account);
      const folder = path.join(ROOT, resolvedFolderRelative);
      let images;
      try {
        images = account && ['visual_hooks', CTA_ASSET_BANK].includes(bank)
          ? readableSupportedImages(folder)
          : validImages(folder);
      } catch (error) {
        if (!fs.existsSync(folder)) throw emptyBankError(bank, account, resolvedFolderRelative, args.languageLane);
        throw error;
      }
      if (images.length === 0) {
        throw emptyBankError(bank, account, resolvedFolderRelative, args.languageLane);
      }
      return [bank, images];
    })
  );
  const assetFolders = Object.fromEntries(
    Object.keys(ASSET_BANKS).map((bank) => [bank, assetFolderFor(bank, args.languageLane, account)])
  );

  const usage = readUsage();
  const usedInPost = new Set();
  const usedAt = new Date().toISOString();
  const resolvedPackage = {
    ...publishPackage,
    slides: publishPackage.slides.map((slide) => resolveSlide(
      slide,
      assetCache,
      assetFolders,
      usage,
      usedInPost,
      publishPackage.post_id || path.basename(postFolder),
      usedAt,
      laneIndex
    )),
  };

  writeJsonAtomic(outputPath, resolvedPackage);
  const metadataPath = path.join(postFolder, 'metadata.json');
  if (fs.existsSync(metadataPath)) {
    const metadata = readJson(metadataPath);
    metadata.assets = {
      ...(metadata.assets || {}),
      selected_asset_paths: resolvedPackage.slides.map((slide) => ({
        slide_number: slide.slide_number,
        asset_path: slide.asset_path,
        bank_type: slide.asset_bank,
      })),
    };
    metadata.updated_at = usedAt;
    writeJsonAtomic(metadataPath, metadata);
  }
  writeJsonAtomic(USAGE_PATH, usage);

  console.log(JSON.stringify({
    post_folder: repoRelative(postFolder),
    output_path: repoRelative(outputPath),
    slide_count: resolvedPackage.slides.length,
  }, null, 2));
}

if (require.main === module) main();

module.exports = { AccountAssetValidationError, isReadableSupportedImage, validateAccountVisualBanks };
