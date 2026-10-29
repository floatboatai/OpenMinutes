export function isBusyStatus(status: string): boolean {
  return status === 'queued_transcribe' || status === 'queued_organize'
    || status === 'transcribing' || status === 'analyzing';
}
