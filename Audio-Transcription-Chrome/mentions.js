(function (root) {
  const DEFAULT_SETTINGS = {
    mentionEnabled: true,
    mentionSound: true,
    watchWords: ['Вячеслав', 'Слав', 'Слава'],
  };

  function normalizeText(text) {
    return String(text).normalize('NFKC').toLowerCase().replace(/ё/g, 'е')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  }

  function parseWatchWords(value) {
    const words = Array.isArray(value) ? value : String(value).split(/[,;\n]/);
    const unique = new Map();
    words.forEach(word => {
      const clean = String(word).trim();
      const normalized = normalizeText(clean);
      if (normalized && !unique.has(normalized)) unique.set(normalized, clean);
    });
    return [...unique.values()];
  }

  function wordForms(word) {
    const forms = new Set([word]);
    if (!/^[а-я]+$/.test(word)) return forms;
    const irregularStems = { павел: 'павл', петр: 'петр', лев: 'льв', любовь: 'любов' };
    let stem;
    let endings;
    if (irregularStems[word]) {
      stem = irregularStems[word];
      endings = word === 'любовь' ? ['и', 'ью'] : ['а', 'у', 'ом', 'е'];
    } else if (word === 'слав') {
      stem = word;
      endings = ['а', 'ы', 'е', 'у', 'ой', 'ою', 'ом'];
    } else if (word.endsWith('ия')) {
      stem = word.slice(0, -1);
      endings = ['и', 'ю', 'ей'];
    } else if (word.endsWith('а')) {
      stem = word.slice(0, -1);
      endings = ['ы', 'и', 'е', 'у', 'ой', 'ою', ''];
      if (/[жчшщц]$/.test(stem)) endings.push('ей', 'ею');
    } else if (word.endsWith('я')) {
      stem = word.slice(0, -1);
      endings = ['и', 'е', 'ю', 'ей', 'ею', ''];
    } else if (/[йь]$/.test(word)) {
      stem = word.slice(0, -1);
      endings = ['я', 'ю', 'ем', 'е'];
    } else if (/[бвгджзклмнпрстфхцчшщ]$/.test(word)) {
      stem = word;
      endings = ['а', 'у', 'ом', 'е'];
    }
    if (endings) endings.forEach(ending => forms.add(stem + ending));
    return forms;
  }

  class MentionDetector {
    constructor(settings = {}, now = () => Date.now()) {
      this.now = now;
      this.seenSegments = new Set();
      this.seenRanges = [];
      this.lastAlertAt = -Infinity;
      this.configure(settings);
    }

    configure(settings) {
      this.settings = { ...DEFAULT_SETTINGS, ...this.settings, ...settings };
      this.patterns = parseWatchWords(this.settings.watchWords).map(word => ({
        word,
        tokens: normalizeText(word).split(' ').map(wordForms),
      }));
    }

    detect(segments) {
      if (!this.settings.mentionEnabled) return null;
      let mention = null;
      for (const segment of segments) {
        if (typeof segment.text !== 'string' || !Number.isFinite(Number(segment.start))) continue;
        const segmentId = String(Number(segment.start));
        const start = Number(segment.start);
        const end = Number(segment.end);
        const previous = this.seenRanges.find(range =>
          range.id === segmentId || (Number.isFinite(end) && start < range.end && end > range.start));
        if (this.seenSegments.has(segmentId) || previous) {
          this.seenSegments.add(segmentId);
          if (previous && Number.isFinite(end)) {
            previous.start = Math.min(previous.start, start);
            previous.end = Math.max(previous.end, end);
          }
          continue;
        }
        const tokens = normalizeText(segment.text).split(' ');
        const pattern = this.patterns.find(pattern => tokens.some((token, index) =>
          pattern.tokens.every((forms, offset) => forms.has(tokens[index + offset]))));
        if (!pattern) continue;
        this.seenSegments.add(segmentId);
        this.seenRanges.push({ id: segmentId, start, end: Number.isFinite(end) ? end : start });
        const timestamp = this.now();
        if (timestamp - this.lastAlertAt < 20000) continue;
        this.lastAlertAt = timestamp;
        mention = {
          word: pattern.word,
          text: segment.text.trim(),
          segmentStart: Number(segment.start),
          timestamp,
        };
      }
      return mention;
    }
  }

  const api = { DEFAULT_SETTINGS, normalizeText, parseWatchWords, MentionDetector };
  root.Mentions = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
