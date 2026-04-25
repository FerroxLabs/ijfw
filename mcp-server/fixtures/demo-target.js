// IJFW Demo Target - three deliberate bugs for the Trident to catch.
// Do not fix these - this file is shipped for `ijfw demo` and must stay broken.
//
// Contract (asserted by test-demo.js):
//   CWE-476 - Null pointer dereference
//   CWE-89  - SQL injection via string concatenation
//   CWE-755 - Silent error swallow; failure is indistinguishable from success

// Bug 1: CWE-476 - Null pointer dereference.
function getUserEmail(user) {
  return user.profile.email.toLowerCase();  // crashes if user.profile is null
}

// Bug 2: CWE-89 - SQL injection via string concatenation.
function findUserByName(db, name) {
  return db.query("SELECT * FROM users WHERE name = '" + name + "'");
}

// Bug 3: CWE-755 - Silent error swallow; failure is indistinguishable from success.
async function loadConfig(path) {
  try {
    return JSON.parse(await readFile(path));
  } catch (e) {
    return {};  // bug: silently returns empty config instead of surfacing read/parse errors
  }
}

export { getUserEmail, findUserByName, loadConfig };
