export function choices(option) {
  return (option?.options || []).flatMap(item => Array.isArray(item.options)
    ? item.options.map(choice => ({ ...choice, provider: item.group, provider_name: item.name }))
    : [item]);
}

export function describeModel(choice) {
  let identity;
  try { identity = JSON.parse(choice.value); } catch {}
  return {
    selector: choice.value,
    provider: choice.provider,
    provider_name: choice.provider_name,
    // DSH 0.2.1 encodes this identity in its selector. Still send the original opaque value.
    model: Array.isArray(identity) && identity.length === 2 ? identity[1] : undefined,
    name: choice.name,
    description: choice.description,
  };
}

export function modelCatalog(options) {
  const modelOption = options?.find(o => o.id === 'model');
  return {
    models: choices(modelOption).map(c => ({ ...describeModel(c), current: c.value === modelOption.currentValue })),
    reasoning: options?.find(o => o.id === 'reasoning_effort') || null,
    review_reasoning_special_values: ['inherit', 'model-default'],
  };
}

export function selectModel(options, model, provider) {
  const available = choices(options?.find(o => o.id === 'model'));
  const matches = available.filter(c => {
    const d = describeModel(c);
    return (!provider || d.provider === provider) && (c.value === model || d.model === model || c.name === model);
  });
  if (matches.length !== 1) throw new Error(matches.length
    ? `Ambiguous model '${model}'; specify provider or use the exact selector from deepseek_list_models.`
    : `Model '${model}' is unavailable in this ACP profile. Use deepseek_list_models; no fallback was used.`);
  return matches[0];
}

export async function configureModel(worker, sessionId, options, model, provider, reasoning) {
  const chosen = selectModel(options, model, provider);
  const changed = await worker.request('session/set_config_option', {
    sessionId, configId: 'model', value: chosen.value,
  });
  options = changed.configOptions;
  if (options?.find(o => o.id === 'model')?.currentValue !== chosen.value) {
    throw new Error('DSH did not confirm the requested model; task was not submitted.');
  }
  if (reasoning !== undefined && reasoning !== 'model-default') {
    if (!choices(options?.find(o => o.id === 'reasoning_effort')).some(o => o.value === reasoning)) {
      throw new Error(`Reasoning effort '${reasoning}' is unsupported by the selected model.`);
    }
    options = (await worker.request('session/set_config_option', {
      sessionId, configId: 'reasoning_effort', value: reasoning,
    })).configOptions;
    if (options?.find(o => o.id === 'reasoning_effort')?.currentValue !== reasoning) {
      throw new Error('DSH did not confirm the requested reasoning effort.');
    }
  }
  return { ...describeModel(chosen), reasoning_effort:
    options?.find(o => o.id === 'reasoning_effort')?.currentValue ?? null,
    available_reasoning_efforts: choices(options?.find(o => o.id === 'reasoning_effort')).map(o => o.value) };
}
