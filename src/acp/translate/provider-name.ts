const PROVIDER_NAMES: Record<string, string> = {
  anthropic: 'Anthropic',
  cursor: 'Cursor',
  deepseek: 'DeepSeek',
  google: 'Google',
  openai: 'OpenAI',
  'openai-codex': 'OpenAI Codex',
  openrouter: 'OpenRouter',
  xai: 'xAI'
}

export function providerDisplayName(id: string): string {
  return Object.hasOwn(PROVIDER_NAMES, id) ? PROVIDER_NAMES[id]! : id.charAt(0).toUpperCase() + id.slice(1)
}
