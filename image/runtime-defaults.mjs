// Run inside the native adapter after session/new has discovered its controls,
// before OpenAB receives the session or sends the first prompt. Never run on load.
export async function nuphosApplyRuntimeDefaults(agent, params, response) {
  const defaults = params._meta?.['ai.nuphos/runtimeDefaults']
  if (!defaults || Object.keys(defaults).length === 0) return response
  let options = response.configOptions
  const kindOf = (option) => {
    if (option.category === 'model' || option.id === 'model') return 'model'
    if (
      option.category === 'thought_level' ||
      ['reasoning_effort', 'effort', 'thinking'].includes(option.id)
    )
      return 'effort'
    if (['fast-mode', 'fast_mode', 'fast'].includes(option.id)) return 'fast'
  }
  for (const kind of ['model', 'fast', 'effort']) {
    const value = defaults[kind]
    if (value === undefined) continue
    const option = options?.find((entry) => kindOf(entry) === kind)
    if (!option?.options?.some((choice) => choice.value === value)) {
      throw new Error(
        `The default ${kind} is not supported. Update this runtime in Settings → Agent, then start a new conversation.`,
      )
    }
    if (option.currentValue === value) continue
    const updated = await agent.setSessionConfigOption({
      sessionId: response.sessionId,
      configId: option.id,
      value,
    })
    options = updated.configOptions
    if (!options?.some((entry) => entry.id === option.id && entry.currentValue === value)) {
      throw new Error(
        `The runtime did not accept the default ${kind}. Update Settings → Agent, then start a new conversation.`,
      )
    }
  }
  const model = options?.find((entry) => kindOf(entry) === 'model')
  return {
    ...response,
    configOptions: options,
    ...(response.models && model
      ? { models: { ...response.models, currentModelId: model.currentValue } }
      : {}),
  }
}

export function patchRuntimeDefaults(source) {
  const anchor = 'async newSession(params) {'
  if (source.split(anchor).length !== 2)
    throw new Error('Expected exactly one native ACP session/new handler.')
  const shebang = source.match(/^#![^\n]*\n/)?.[0] ?? ''
  return `${shebang}${nuphosApplyRuntimeDefaults.toString()}\n${source
    .slice(shebang.length)
    .replace(
      anchor,
      `async newSession(params) {
    return nuphosApplyRuntimeDefaults(this, params, await this.nuphosNewSession(params));
  }
  async nuphosNewSession(params) {`,
    )}`
}
