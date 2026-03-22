type ExperimentLogPayload = {
  event: string;
  prompt: string;
  type: string;
  requestData?: Record<string, unknown>;
  result?: unknown;
};

function summarizeResult(result: unknown) {
  if (Array.isArray(result)) {
    return {
      kind: 'array',
      count: result.length,
      labels: result
        .map((item) => (item && typeof item === 'object' && 'label' in item ? String((item as { label?: string }).label ?? '') : ''))
        .filter(Boolean)
        .slice(0, 10),
    };
  }

  if (result && typeof result === 'object') {
    return result;
  }

  return result ?? null;
}

export async function appendExperimentLog(payload: ExperimentLogPayload) {
  try {
    await fetch('/api/experiment-logs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...payload,
        result: summarizeResult(payload.result),
      }),
    });
  } catch (error) {
    console.warn('Failed to persist experiment log', error);
  }
}
