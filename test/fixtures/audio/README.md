# Audio fixtures

`question.wav` is made by `scripts/make-fixtures.ts` (`pnpm fixtures`): 3 seconds, 16 kHz, mono, 16-bit PCM, synthetic. It is speech-shaped (a wavering voice, four vowel-like syllables) so a voice detector reacts to it, but it says nothing. No one's voice is committed; a unit test fails if the committed file differs from what the script makes.

The `@live` test (`pnpm test:live`) plays it into Chromium's fake microphone. A model needs words to answer, so for a real run record yourself asking something about `test/fixtures/pdf/multi-page.pdf`, save it as 16 kHz mono 16-bit PCM WAV, keep it outside git (for example in `.private/`), and run:

```bash
LIVE_QUESTION_WAV=.private/question.wav pnpm test:live
```
