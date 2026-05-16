/**
 * extension-manifest-schema.js
 *
 * IJFW v1.4.0 Wave 0 / t3 — Extension Manifest Schema
 *
 * Extensions are pure-markdown skill bundles (no JS commands in v1.4.0).
 * Each extension ships a manifest.json + skill files. The installer
 * verifies integrity (SHA256 hash) + runs Trident audit, then deploys the
 * skill files to all 14 platform skill dirs.
 *
 * Trust model:
 *   - `integrity` is SHA256 over canonical JSON. It detects tamper, NOT
 *     publisher identity. Asymmetric publisher signing is deferred to v1.5.0.
 *   - `permissions` is declarative intent. NOT runtime-enforced in v1.4.0.
 *     Enforcement = Trident audit + sandbox FORBID_LIST + blackboard claims.
 *   - `type: "full"` is reserved for v1.5.0. v1.4.0 only supports
 *     `type: "skill-only"`.
 *
 * Hand-rolled validator. Zero new prod deps.
 */

export const SCHEMA_VERSION = '1.0';

export const EXTENSION_TYPES = Object.freeze(['skill-only', 'full']);

/**
 * Declarative permission allowlists. Extensions list what they intend to
 * read/write — Trident audit at install time catches divergence between
 * intent and actual skill body behaviour.
 */
export const PERMISSION_READS = Object.freeze([
  './README.md',
  './docs/**',
  './src/**',
  './*.md',
  './*.json',
  'memory:read',
  'project:read',
  'blackboard:read',
]);

export const PERMISSION_WRITES = Object.freeze([
  './output/**',
  './build/**',
  './dist/**',
  'memory:write',
  'blackboard:write',
]);

export const REPLACE_MODES = Object.freeze(['override', 'extend', 'wrap']);

/**
 * v1.4.0 strict integrity hash format.
 *   sha256: <64 lowercase hex chars>
 * Reject `sha256:abc` and similar shortened values.
 */
export const INTEGRITY_PATTERN = /^sha256:[a-f0-9]{64}$/;

/**
 * v1.4.0 W7/B1: Ed25519 publisher signature format.
 *   ed25519:<base64 chars> -- 64 raw bytes -> 88 base64 chars (with `=` pad).
 * Allow standard or URL-safe base64 alphabet; trailing `=` padding optional.
 */
export const SIGNATURE_PATTERN = /^ed25519:[A-Za-z0-9+/_-]{86,90}={0,2}$/;

/**
 * v1.4.0 W7/B1: publisher key id format. sha256 fingerprint of the public
 * key (lowercase hex), no scheme prefix.
 */
export const PUBLISHER_KEY_ID_PATTERN = /^[a-f0-9]{64}$/;

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const IJFW_REQUIRES_PATTERN = /^(>=|>|=|<=|<)?\s*\d+\.\d+\.\d+/;
const EXTENSION_NAME_PATTERN = /^(@[a-z0-9-]+\/)?[a-z][a-z0-9-]*$/;
const SKILL_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const FILE_PATH_PATTERN = /^[a-zA-Z0-9_./-]+\.md$/;

function isString(v) {
  return typeof v === 'string';
}

function isNonNullObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function validatePermissionList(list, allowlist, fieldName, errors) {
  if (!Array.isArray(list)) {
    errors.push(`${fieldName}: must be an array`);
    return;
  }
  list.forEach((p, i) => {
    if (!isString(p)) {
      errors.push(`${fieldName}[${i}]: must be a string`);
      return;
    }
    if (!allowlist.includes(p)) {
      errors.push(
        `${fieldName}[${i}]: ${JSON.stringify(p)} not in allowlist`,
      );
    }
  });
}

/**
 * validateExtensionManifest(manifest) — strict v1.4.0 validation.
 *
 * @param {unknown} obj
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateExtensionManifest(obj) {
  const errors = [];

  if (!isNonNullObject(obj)) {
    return { valid: false, errors: ['root: must be an object'] };
  }

  // schema_version
  if (obj.schema_version !== SCHEMA_VERSION) {
    errors.push(
      `schema_version: must equal "${SCHEMA_VERSION}", got ${JSON.stringify(obj.schema_version)}`,
    );
  }

  // name
  if (!isString(obj.name) || !EXTENSION_NAME_PATTERN.test(obj.name)) {
    errors.push(
      `name: must match ${EXTENSION_NAME_PATTERN} (kebab or @scope/kebab)`,
    );
  }

  // version
  if (!isString(obj.version) || !SEMVER_PATTERN.test(obj.version)) {
    errors.push('version: must be semver (e.g. "1.0.0")');
  }

  // description (optional but if present must be string)
  if (obj.description !== undefined && !isString(obj.description)) {
    errors.push('description: must be a string when present');
  }

  // author / license (optional, strings)
  if (obj.author !== undefined && !isString(obj.author)) {
    errors.push('author: must be a string when present');
  }
  if (obj.license !== undefined && !isString(obj.license)) {
    errors.push('license: must be a string when present');
  }

  // ijfw_requires
  if (obj.ijfw_requires !== undefined) {
    if (!isString(obj.ijfw_requires) || !IJFW_REQUIRES_PATTERN.test(obj.ijfw_requires)) {
      errors.push('ijfw_requires: must be a version range like ">=1.4.0"');
    }
  }

  // type
  if (!EXTENSION_TYPES.includes(obj.type)) {
    errors.push(
      `type: must be one of ${EXTENSION_TYPES.join('|')}, got ${JSON.stringify(obj.type)}`,
    );
  } else if (obj.type === 'full') {
    // v1.4.0 hard-line: full is reserved for 1.5.0.
    errors.push(
      'type: "full" is reserved for v1.5.0; v1.4.0 only supports "skill-only"',
    );
  }

  // skills (required, array)
  if (!Array.isArray(obj.skills)) {
    errors.push('skills: must be an array (may be empty)');
  } else {
    obj.skills.forEach((s, i) => {
      if (!isNonNullObject(s)) {
        errors.push(`skills[${i}]: must be an object`);
        return;
      }
      if (!isString(s.name) || !SKILL_NAME_PATTERN.test(s.name)) {
        errors.push(
          `skills[${i}].name: must be kebab-case matching ${SKILL_NAME_PATTERN}`,
        );
      }
      if (!isString(s.file) || !FILE_PATH_PATTERN.test(s.file)) {
        errors.push(
          `skills[${i}].file: must be a relative .md path matching ${FILE_PATH_PATTERN}`,
        );
      }
      if (s.replaces !== undefined) {
        if (!isNonNullObject(s.replaces)) {
          errors.push(`skills[${i}].replaces: must be an object`);
        } else {
          if (!isString(s.replaces.skill) || !SKILL_NAME_PATTERN.test(s.replaces.skill)) {
            errors.push(
              `skills[${i}].replaces.skill: must be a kebab-case skill name`,
            );
          }
          if (!REPLACE_MODES.includes(s.replaces.mode)) {
            errors.push(
              `skills[${i}].replaces.mode: must be one of ${REPLACE_MODES.join('|')}`,
            );
          }
        }
      }
    });
  }

  // overrides (optional)
  if (obj.overrides !== undefined) {
    if (!Array.isArray(obj.overrides)) {
      errors.push('overrides: must be an array when present');
    } else {
      obj.overrides.forEach((o, i) => {
        if (!isNonNullObject(o)) {
          errors.push(`overrides[${i}]: must be an object`);
          return;
        }
        if (!isString(o.skill) || !SKILL_NAME_PATTERN.test(o.skill)) {
          errors.push(`overrides[${i}].skill: must be a kebab-case skill name`);
        }
        if (!isString(o.file) || !FILE_PATH_PATTERN.test(o.file)) {
          errors.push(`overrides[${i}].file: must be a relative .md path`);
        }
      });
    }
  }

  // permissions
  if (!isNonNullObject(obj.permissions)) {
    errors.push('permissions: must be an object with reads/writes arrays');
  } else {
    validatePermissionList(obj.permissions.reads, PERMISSION_READS, 'permissions.reads', errors);
    validatePermissionList(obj.permissions.writes, PERMISSION_WRITES, 'permissions.writes', errors);
  }

  // integrity — strict format per R5
  if (!isString(obj.integrity)) {
    errors.push('integrity: must be a string');
  } else if (!INTEGRITY_PATTERN.test(obj.integrity)) {
    errors.push(
      `integrity: must match ${INTEGRITY_PATTERN} — full 64 hex char sha256 digest`,
    );
  }

  // signature (optional, W7/B1). When present, publisher_key_id is required
  // and both must match their patterns. When absent, manifest is "unsigned".
  if (obj.signature !== undefined) {
    if (!isString(obj.signature) || !SIGNATURE_PATTERN.test(obj.signature)) {
      errors.push(`signature: must match ${SIGNATURE_PATTERN}`);
    }
    if (obj.publisher_key_id === undefined) {
      errors.push('publisher_key_id: required when signature present');
    } else if (!isString(obj.publisher_key_id) || !PUBLISHER_KEY_ID_PATTERN.test(obj.publisher_key_id)) {
      errors.push(`publisher_key_id: must match ${PUBLISHER_KEY_ID_PATTERN}`);
    }
  } else if (obj.publisher_key_id !== undefined) {
    if (!isString(obj.publisher_key_id) || !PUBLISHER_KEY_ID_PATTERN.test(obj.publisher_key_id)) {
      errors.push(`publisher_key_id: must match ${PUBLISHER_KEY_ID_PATTERN}`);
    }
  }

  return { valid: errors.length === 0, errors };
}
