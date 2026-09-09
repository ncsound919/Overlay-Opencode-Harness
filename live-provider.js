/**
 * live-provider.js — shared provider selection for the opt-in live tests.
 *
 * Phoenix Grove via Keywire (run-live-phoenix.js supplies PHOENIX_* in real
 * OS env) or the default opencode model. The inline custom-provider config
 * travels via opencode_env and is never logged — refer to it only as
 * "provider: phoenix-grove".
 */

function phoenixProviderFromEnv() {
  const apiKey = process.env.PHOENIX_API_KEY;
  const baseURL = process.env.PHOENIX_BASE_URL;
  const fastModel = process.env.PHOENIX_FAST_MODEL;
  if (!apiKey || !baseURL || !fastModel) {
    return { model: null, env: {} };
  }
  return {
    model: `phoenix-grove/${fastModel}`,
    env: {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        provider: {
          "phoenix-grove": {
            npm: "@ai-sdk/openai-compatible",
            name: "Phoenix Grove",
            options: { baseURL, apiKey },
            models: { [fastModel]: { name: "Phoenix Fast" } }
          }
        }
      })
    }
  };
}

module.exports = { phoenixProviderFromEnv };
