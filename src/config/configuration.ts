export const configuration = () => ({
  server: {
    wsPort: parseInt(process.env['WS_PORT'] ?? '8080', 10),
  },
  openai: {
    apiKey: process.env['OPENAI_API_KEY'] ?? '',
    model: process.env['OPENAI_MODEL'] ?? 'gpt-realtime-2',
    voice: process.env['OPENAI_VOICE'] ?? 'marin',
    reasoningEffort: (process.env['OPENAI_REASONING_EFFORT'] ?? 'low') as
      | 'minimal'
      | 'low'
      | 'medium'
      | 'high'
      | 'xhigh',
  },
  vad: {
    type: (process.env['VAD_TYPE'] ?? 'semantic_vad') as 'semantic_vad' | 'server_vad',
    eagerness: (process.env['VAD_EAGERNESS'] ?? 'high') as 'low' | 'medium' | 'high' | 'auto',
    silenceDurationMs: parseInt(process.env['VAD_SILENCE_MS'] ?? '300', 10),
    threshold: parseFloat(process.env['VAD_THRESHOLD'] ?? '0.5'),
    prefixPaddingMs: parseInt(process.env['VAD_PREFIX_MS'] ?? '300', 10),
  },
  reconnect: {
    maxRetries: parseInt(process.env['RECONNECT_MAX_RETRIES'] ?? '3', 10),
    initialDelayMs: parseInt(process.env['RECONNECT_INITIAL_DELAY_MS'] ?? '1000', 10),
    backoffMultiplier: parseFloat(process.env['RECONNECT_BACKOFF_MULTIPLIER'] ?? '2'),
  },
  inputTranscriptionLogging: {
    enabled: (process.env['INPUT_TRANSCRIPTION_LOGGING'] ?? 'true').toLowerCase() !== 'false',
    logDir: process.env['INPUT_TRANSCRIPTION_LOG_DIR'] ?? 'logs',
    language: process.env['INPUT_TRANSCRIPTION_LANGUAGE'] ?? 'de',
  },
});

export type AppConfig = ReturnType<typeof configuration>;
