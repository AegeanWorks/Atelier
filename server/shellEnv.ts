// A variable name is secret-shaped when KEY, TOKEN, SECRET, PASSWORD, PASSWD or CREDENTIAL(S) is a whole word in it
// (so KEYBOARD_LAYOUT, MONKEY_COUNT and TOKENIZERS_PARALLELISM stay), or it ends in a joined form such as APIKEY.
const WORD = /(^|[^A-Za-z0-9])(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)($|[^A-Za-z0-9])/i;
const JOINED = /(APIKEY|AUTHTOKEN|ACCESSKEY|SECRETKEY|PRIVATEKEY)$/i;

export function isSecretName(name: string): boolean {
  return WORD.test(name) || JOINED.test(name);
}

export interface ScrubOptions {
  /** Providers whose `apiKeyEnv` variable is always removed, whatever it is called. */
  providers: Array<{ apiKeyEnv?: string | undefined }>;
  /** Variable names the user chose to leave in, compared without regard to case. */
  passthrough: string[];
}

/**
 * The environment a command the agent runs may see: the server's own, without credentials. Provider key variables and
 * anything secret-shaped are removed unless the user listed them, so a prompt-injected command cannot just print them.
 * This narrows one leak; it is not a sandbox, because the same user's files are still readable by the command.
 */
export function scrubbedEnv(env: NodeJS.ProcessEnv, options: ScrubOptions): NodeJS.ProcessEnv {
  const allowed = new Set(options.passthrough.map((name) => name.toLowerCase()));
  const providerKeys = new Set(options.providers.flatMap((provider) => (provider.apiKeyEnv === undefined ? [] : [provider.apiKeyEnv.toLowerCase()])));
  const clean: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (!allowed.has(lower) && (providerKeys.has(lower) || isSecretName(name))) continue;
    clean[name] = value;
  }
  return clean;
}
