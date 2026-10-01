(function (root) {
  class TranscriptHistory {
    constructor(sessionId, tabId, now = () => Date.now()) {
      this.sessionId = sessionId;
      this.tabId = tabId;
      this.startedAt = now();
      this.endedAt = null;
      this.segments = new Map();
    }

    commit(segments) {
      let changed = false;
      for (const segment of segments) {
        if (segment.completed !== true || typeof segment.text !== 'string' ||
            !Number.isFinite(Number(segment.start)) || !Number.isFinite(Number(segment.end))) continue;
        const key = String(Number(segment.start));
        const committed = { ...segment, start: Number(segment.start), end: Number(segment.end) };
        if (JSON.stringify(this.segments.get(key)) !== JSON.stringify(committed)) {
          this.segments.set(key, committed);
          changed = true;
        }
      }
      return changed;
    }

    snapshot() {
      return {
        sessionId: this.sessionId,
        tabId: this.tabId,
        startedAt: this.startedAt,
        endedAt: this.endedAt,
        segments: [...this.segments.values()].sort((left, right) => left.start - right.start),
      };
    }
  }

  root.TranscriptHistory = TranscriptHistory;
  if (typeof module !== 'undefined') module.exports = TranscriptHistory;
})(globalThis);
