/**
 * Image cache for session persistence.
 *
 * Instead of storing base64-encoded images directly in session files (which causes
 * context overflow), we cache images to disk and store only references in sessions.
 *
 * Flow:
 * 1. When injecting images into history: cacheImage() → stores to disk, returns cacheId
 * 2. Session stores: { type: "image_ref", cacheId, mimeType } instead of base64
 * 3. Before model prompt: resolveImageRef() → loads from disk, returns ImageContent
 * 4. If cache file is missing: graceful fallback to placeholder text
 */

import type { ImageContent } from "@mariozechner/pi-ai";
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Reference to a cached image (stored in session files instead of base64 data).
 */
export interface ImageRefContent {
  type: "image_ref";
  /** Hash-based identifier for the cached image file */
  cacheId: string;
  /** MIME type of the image */
  mimeType: string;
}

/**
 * Content block that can be either an image or an image reference.
 */
export type ImageOrRefContent = ImageContent | ImageRefContent;

/**
 * Type guard to check if content is an image reference.
 */
export function isImageRef(content: unknown): content is ImageRefContent {
  return (
    content != null &&
    typeof content === "object" &&
    (content as { type?: string }).type === "image_ref" &&
    typeof (content as { cacheId?: unknown }).cacheId === "string"
  );
}

/**
 * Type guard to check if content is an actual image with base64 data.
 */
export function isImageContent(content: unknown): content is ImageContent {
  return (
    content != null &&
    typeof content === "object" &&
    (content as { type?: string }).type === "image" &&
    typeof (content as { data?: unknown }).data === "string"
  );
}

/**
 * Get the image cache directory path.
 * Creates the directory if it doesn't exist.
 */
export async function getImageCacheDir(): Promise<string> {
  const cacheDir = path.join(os.homedir(), ".openclaw", "image-cache");
  await fs.mkdir(cacheDir, { recursive: true });
  return cacheDir;
}

/**
 * Get the image cache directory path (synchronous version).
 * Creates the directory if it doesn't exist.
 */
function getImageCacheDirSync(): string {
  const cacheDir = path.join(os.homedir(), ".openclaw", "image-cache");
  fsSync.mkdirSync(cacheDir, { recursive: true });
  return cacheDir;
}

/**
 * Generate a cache ID from image data using SHA-256 hash.
 * This ensures deduplication - same image data = same cache file.
 */
function generateCacheId(data: string, mimeType: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(data);
  hash.update(mimeType);
  return hash.digest("hex").slice(0, 16); // Use first 16 chars for shorter filenames
}

/**
 * Get the file extension for a MIME type.
 */
function getExtensionForMimeType(mimeType: string): string {
  const extensions: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
    "image/tiff": ".tiff",
    "image/heic": ".heic",
    "image/heif": ".heif",
  };
  return extensions[mimeType] ?? ".bin";
}

/**
 * Cache an image to disk and return an ImageRefContent.
 *
 * @param image The image content with base64 data
 * @returns ImageRefContent with the cache ID
 */
export async function cacheImage(image: ImageContent): Promise<ImageRefContent> {
  const cacheId = generateCacheId(image.data, image.mimeType);
  const cacheDir = await getImageCacheDir();
  const ext = getExtensionForMimeType(image.mimeType);
  const filePath = path.join(cacheDir, `${cacheId}${ext}`);

  // Check if already cached (deduplication)
  try {
    await fs.access(filePath);
    // File exists, no need to write again
  } catch {
    // File doesn't exist, write it
    const buffer = Buffer.from(image.data, "base64");
    await fs.writeFile(filePath, buffer);
  }

  return {
    type: "image_ref",
    cacheId,
    mimeType: image.mimeType,
  };
}

/**
 * Cache an image to disk synchronously and return an ImageRefContent.
 * Used in synchronous code paths (like appendMessage) where async is not available.
 *
 * @param image The image content with base64 data
 * @returns ImageRefContent with the cache ID
 */
export function cacheImageSync(image: ImageContent): ImageRefContent {
  const cacheId = generateCacheId(image.data, image.mimeType);
  const cacheDir = getImageCacheDirSync();
  const ext = getExtensionForMimeType(image.mimeType);
  const filePath = path.join(cacheDir, `${cacheId}${ext}`);

  if (!fsSync.existsSync(filePath)) {
    const buffer = Buffer.from(image.data, "base64");
    fsSync.writeFileSync(filePath, buffer);
  }

  return {
    type: "image_ref",
    cacheId,
    mimeType: image.mimeType,
  };
}

/**
 * Load a cached image from disk.
 *
 * @param ref The image reference
 * @returns ImageContent if found, null if cache miss
 */
export async function loadCachedImage(ref: ImageRefContent): Promise<ImageContent | null> {
  const cacheDir = await getImageCacheDir();
  const ext = getExtensionForMimeType(ref.mimeType);
  const filePath = path.join(cacheDir, `${ref.cacheId}${ext}`);

  try {
    const buffer = await fs.readFile(filePath);
    const data = buffer.toString("base64");
    return {
      type: "image",
      data,
      mimeType: ref.mimeType,
    };
  } catch {
    // Cache miss - file was deleted or never existed
    return null;
  }
}

/**
 * Convert an ImageContent to ImageRefContent by caching it.
 * If it's already an ImageRefContent, return as-is.
 */
export async function toImageRef(content: ImageOrRefContent): Promise<ImageRefContent> {
  if (isImageRef(content)) {
    return content;
  }
  return cacheImage(content);
}

/**
 * Convert an ImageRefContent back to ImageContent by loading from cache.
 * If it's already an ImageContent, return as-is.
 * If cache is missing, returns null.
 */
export async function fromImageRef(content: ImageOrRefContent): Promise<ImageContent | null> {
  if (isImageContent(content)) {
    return content;
  }
  return loadCachedImage(content);
}

/**
 * Resolve all image references in a message content array.
 * Converts image_ref → image by loading from cache.
 * Missing cache entries are replaced with a placeholder text block.
 *
 * @param content The message content array (may contain image_ref blocks)
 * @returns New content array with image_ref resolved to image
 */
export async function resolveImageRefsInContent(content: unknown[]): Promise<unknown[]> {
  const resolved: unknown[] = [];

  for (const block of content) {
    if (isImageRef(block)) {
      const image = await loadCachedImage(block);
      if (image) {
        resolved.push(image);
      } else {
        // Cache miss - add placeholder
        resolved.push({
          type: "text",
          text: "[Image no longer available in cache]",
        });
      }
    } else {
      resolved.push(block);
    }
  }

  return resolved;
}

/**
 * Convert all images in a message content array to image references.
 * This is used before persisting messages to session files.
 *
 * @param content The message content array (may contain image blocks)
 * @returns New content array with image → image_ref
 */
export async function convertImagesToRefs(content: unknown[]): Promise<unknown[]> {
  const converted: unknown[] = [];

  for (const block of content) {
    if (isImageContent(block)) {
      const ref = await cacheImage(block);
      converted.push(ref);
    } else {
      converted.push(block);
    }
  }

  return converted;
}

/**
 * Clean up old cache files that haven't been accessed recently.
 *
 * @param maxAgeDays Maximum age in days before a cache file is deleted
 * @returns Number of files deleted
 */
export async function cleanupOldCache(maxAgeDays: number = 7): Promise<number> {
  const cacheDir = await getImageCacheDir();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  let deleted = 0;

  try {
    const files = await fs.readdir(cacheDir);

    for (const file of files) {
      const filePath = path.join(cacheDir, file);
      try {
        const stat = await fs.stat(filePath);
        const age = now - stat.mtimeMs;
        if (age > maxAgeMs) {
          await fs.unlink(filePath);
          deleted++;
        }
      } catch {
        // Skip files that can't be stat'd or deleted
      }
    }
  } catch {
    // Cache directory doesn't exist or can't be read
  }

  return deleted;
}

/**
 * Get cache statistics.
 */
export async function getCacheStats(): Promise<{
  fileCount: number;
  totalSizeBytes: number;
}> {
  const cacheDir = await getImageCacheDir();
  let fileCount = 0;
  let totalSizeBytes = 0;

  try {
    const files = await fs.readdir(cacheDir);
    for (const file of files) {
      try {
        const stat = await fs.stat(path.join(cacheDir, file));
        fileCount++;
        totalSizeBytes += stat.size;
      } catch {
        // Skip files that can't be stat'd
      }
    }
  } catch {
    // Cache directory doesn't exist
  }

  return { fileCount, totalSizeBytes };
}
