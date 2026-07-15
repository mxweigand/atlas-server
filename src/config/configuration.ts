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
  deixis: {
    // Empirically measured end-to-end delay between the user speaking a word
    // and its delta arriving at the server. Subtracted from the delta wallclock
    // to estimate when the phrase was actually spoken.
    pipelineLatencyMs: parseInt(process.env['DEIXIS_PIPELINE_LATENCY_MS'] ?? '1000', 10),
    focusBufferMs: parseInt(process.env['DEIXIS_FOCUS_BUFFER_MS'] ?? '30000', 10),
    deltaBufferMs: parseInt(process.env['DEIXIS_DELTA_BUFFER_MS'] ?? '30000', 10),
    // Half-width of the window around the estimated speak time in which a focus
    // change makes the resolution ambiguous: if the pointed-at object switches
    // this close to spokenAtMs, a small latency-calibration error could flip the
    // result. Sized to the ~100ms measured spread of the calibrated latency.
    ambiguityWindowMs: parseInt(process.env['DEIXIS_AMBIGUITY_WINDOW_MS'] ?? '200', 10),
    // Maximum age of the most recent focus sample at or before spokenAtMs. If the
    // newest prior sample is older than this (or only a forward-tolerance fallback
    // sample exists) the pointing stream had a reporting gap. Sized above the
    // 250ms client heartbeat so a single missed heartbeat is still tolerated.
    staleThresholdMs: parseInt(process.env['DEIXIS_STALE_THRESHOLD_MS'] ?? '500', 10),
  },
  audio: {
    // Rolling mic buffer kept ahead of speech_started so the VAD-cut prefix
    // ("W" in "Was ist das?") can be prepended to the user_speech clip.
    lookbackMs: parseInt(process.env['AUDIO_LOOKBACK_MS'] ?? '1500', 10),
  },
  projects: {
    // Directory containing one JSON file per project. Loaded on demand at
    // activation. Manual edits between activations are picked up on the next
    // activation call.
    dataDir: process.env['PROJECTS_DATA_DIR'] ?? 'data/projects',
  },
});

export type AppConfig = ReturnType<typeof configuration>;
