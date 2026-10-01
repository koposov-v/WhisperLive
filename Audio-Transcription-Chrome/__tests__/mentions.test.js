const { MentionDetector, normalizeText, parseWatchWords } = require('../mentions.js');
const TranscriptHistory = require('../transcript-history.js');

test('normalizes case, ё, punctuation and whitespace', () => {
  expect(normalizeText('  СЕРЁЖ,\n можешь посмотреть billing?! ')).toBe('сереж можешь посмотреть billing');
  expect(parseWatchWords('Слава, слава\nСерёжа;Сережа\n')).toEqual(['Слава', 'Серёжа']);
});

test.each(['Вячеслав', 'Вячеслава', 'Вячеславу', 'Вячеславом', 'Вячеславе', 'Слав', 'Слава', 'Славы', 'Славе', 'Славу', 'Славой'])('matches default name form %s', name => {
  const detector = new MentionDetector();
  expect(detector.detect([{ start: '1.00', text: `${name}, можешь посмотреть billing?` }])).toEqual(expect.objectContaining({ segmentStart: 1 }));
});

test.each([
  ['Серёжа', 'Серёж'], ['Серёжа', 'Сережей'], ['Сергей', 'Сергею'],
  ['Александр', 'Александром'], ['Наталья', 'Наталье'], ['Мария', 'Марии'],
  ['Анна', 'Анной'], ['Дмитрий', 'Дмитрия'], ['Павел', 'Павлу'],
])('matches configured name %s in form %s', (word, form) => {
  const detector = new MentionDetector({ watchWords: [word] });
  expect(detector.detect([{ start: 0, text: form }])).not.toBeNull();
});

test.each(['прославился', 'славный', 'славянский', 'Вячеславович', 'billingservice'])('does not match substrings in %s', text => {
  const detector = new MentionDetector({ watchWords: ['Вячеслав', 'Слав', 'Слава', 'billing'] });
  expect(detector.detect([{ start: 0, text }])).toBeNull();
});

test('matches phrases with whole token boundaries', () => {
  const detector = new MentionDetector({ watchWords: ['release billing'] });
  expect(detector.detect([{ start: 0, text: 'release billingservice' }])).toBeNull();
  expect(detector.detect([{ start: 0, text: 'Release, billing!' }])).not.toBeNull();
});

test('detects a name added to a partial, then suppresses all revisions and its final', () => {
  let timestamp = 1000;
  const detector = new MentionDetector({}, () => timestamp);
  expect(detector.detect([{ start: 1, text: 'можешь посмотреть' }])).toBeNull();
  expect(detector.detect([{ start: '1.000', text: 'Слава, можешь посмотреть', completed: false }])).not.toBeNull();
  timestamp += 25000;
  expect(detector.detect([{ start: 1, text: 'Слава, можешь посмотреть billing?', completed: true }])).toBeNull();
  expect(detector.detect([{ start: 30, text: 'Слава, посмотри ещё' }])).not.toBeNull();
});

test('cooldown suppresses other segments permanently including replay after cooldown', () => {
  let timestamp = 0;
  const detector = new MentionDetector({}, () => timestamp);
  expect(detector.detect([{ start: 0, text: 'Слава' }])).not.toBeNull();
  timestamp = 19000;
  expect(detector.detect([{ start: 10, text: 'Вячеслав' }])).toBeNull();
  timestamp = 21000;
  expect(detector.detect([{ start: 10, text: 'Вячеслав, посмотрел?' }])).toBeNull();
  expect(detector.detect([{ start: 20, text: 'Слава' }])).not.toBeNull();
});

test('deduplicates overlapping partials and final segments when Whisper changes start timestamps', () => {
  let timestamp = 0;
  const detector = new MentionDetector({}, () => timestamp);
  expect(detector.detect([{ start: 1, end: 5, text: 'Слава' }])).not.toBeNull();
  timestamp = 25000;
  expect(detector.detect([{ start: 1.2, end: 6, text: 'Слава, можешь посмотреть?' }])).toBeNull();
  timestamp = 50000;
  expect(detector.detect([{ start: 0, end: 6, text: 'Слава, можешь посмотреть?', completed: true }])).toBeNull();
  expect(detector.detect([{ start: 6, end: 9, text: 'Слава' }])).not.toBeNull();
});

test('settings update without clearing deduplication state', () => {
  const detector = new MentionDetector({ mentionEnabled: false });
  expect(detector.detect([{ start: 0, text: 'Слава' }])).toBeNull();
  detector.configure({ mentionEnabled: true, watchWords: ['billing'] });
  expect(detector.detect([{ start: 0, text: 'Слава' }])).toBeNull();
  expect(detector.detect([{ start: 0, text: 'billing' }])).not.toBeNull();
  detector.configure({ watchWords: [] });
  expect(detector.detect([{ start: 50, text: 'billing' }])).toBeNull();
});

test('history keeps only committed segments, deduplicates replays and retains corrections', () => {
  const history = new TranscriptHistory('session', 123, () => 1000);
  expect(history.commit([{ start: 0, end: 2, text: 'partial', completed: false }])).toBe(false);
  const segment = { start: '0.0', end: '2.0', text: 'final', completed: true };
  expect(history.commit([segment])).toBe(true);
  expect(history.commit([segment])).toBe(false);
  history.commit([{ ...segment, text: 'corrected' }]);
  history.endedAt = 5000;
  expect(history.snapshot()).toEqual({
    sessionId: 'session', tabId: 123, startedAt: 1000, endedAt: 5000,
    segments: [{ start: 0, end: 2, text: 'corrected', completed: true }],
  });
});
