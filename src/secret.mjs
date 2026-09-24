// secret.mjs - fail-closed credential key resolution.
// Added during local security review. The original code fell back to a
// hardcoded, publicly known key ("arena-bridge-local-key") whenever
// STORAGE_ENCRYPTION_KEY was absent. Because the KDF salt in crypto.mjs is
// also a fixed constant and this source is public, anyone could derive the
// key offline and decrypt credentials.json. A missing key is now a hard error.
export function requireSecret(dotEnv) {
  const secret = dotEnv && dotEnv.STORAGE_ENCRYPTION_KEY;
  if (!secret || secret === "arena-bridge-local-key") {
    throw new Error(
      "STORAGE_ENCRYPTION_KEY is missing or is the known insecure fallback. " +
      "Refusing to start with a publicly derivable key. " +
      "Set STORAGE_ENCRYPTION_KEY to 64 random hex chars in DATA_DIR/.env " +
      "(install.sh generates one via `openssl rand -hex 32`)."
    );
  }
  return secret;
}
