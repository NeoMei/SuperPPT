const CHILD_ENVIRONMENT_ALLOWLIST = new Set([
  "COMSPEC",
  "FORCE_COLOR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NO_COLOR",
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "WINDIR",
]);

export function isolatedChildEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && CHILD_ENVIRONMENT_ALLOWLIST.has(name.toUpperCase())) {
      environment[name] = value;
    }
  }
  return environment;
}
