const COMPATIBLE_AUDIO_TYPES = new Map([
  ['audio/x-flac', 'audio/flac'],
  ['audio/x-wav', 'audio/wav'],
  ['audio/mp3', 'audio/mpeg'],
  ['audio/x-m4a', 'audio/mp4'],
]);

export function normalizeStreamHeaders(headers) {
  const normalized = { ...headers };
  const contentTypeKey = Object.keys(normalized).find(
    (key) => key.toLowerCase() === 'content-type',
  );
  if (contentTypeKey) {
    const [mimeType, ...parameters] = String(normalized[contentTypeKey]).split(';');
    const compatibleType = COMPATIBLE_AUDIO_TYPES.get(mimeType.trim().toLowerCase());
    if (compatibleType) {
      normalized[contentTypeKey] = [compatibleType, ...parameters].join(';');
    }
  }
  return normalized;
}
