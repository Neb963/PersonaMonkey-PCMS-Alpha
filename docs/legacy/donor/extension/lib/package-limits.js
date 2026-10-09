const MIB = 1024 * 1024;

export const ZIP_PATH_MAX_CHARS = 500;

// Defaults preserve the historical workflow-package envelope while adding a
// hard compressed-input ceiling and a byte bound for encoded archive paths.
export const ZIP_DEFAULT_LIMITS = Object.freeze({
  maxCompressedBytes: 12 * MIB,
  maxEntries: 128,
  maxEntryBytes: 4 * MIB,
  maxUncompressedBytes: 10 * MIB,
  maxPathBytes: 2048
});

export const WORKFLOW_PACKAGE_LIMITS = Object.freeze({
  ...ZIP_DEFAULT_LIMITS
});

export const PERSONA_PACKAGE_LIMITS = Object.freeze({
  maxCompressedBytes: 32 * MIB,
  maxEntries: 500,
  maxEntryBytes: 32 * MIB,
  maxUncompressedBytes: 32 * MIB,
  maxPathBytes: ZIP_DEFAULT_LIMITS.maxPathBytes
});
