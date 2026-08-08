// Loads .env before anything reads process.env.
//
// Import this FIRST in every entry point (server, scripts). ESM evaluates
// imports in declaration order, so a `import './load-env.js'` above
// `import './env.js'` guarantees the file is read before config is validated.
//
// Railway injects real environment variables, so the absence of a .env file is
// normal in production and must not be an error.
try {
  process.loadEnvFile();
} catch {
  // No .env on disk. Fine — either the variables are already in the
  // environment, or env.ts is about to say exactly which ones are missing.
}
