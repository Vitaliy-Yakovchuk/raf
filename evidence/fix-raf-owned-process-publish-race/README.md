# fix-raf-owned-process-publish-race:1.1

Послідовна атомарна публікація owned-process.json зберігає порядок викликів і останню ідентичність. Оброблене відхилення не завершує worker при void-виклику; наступна публікація може виконатися. Первинний await зберігає помилку для свого caller. Нових таймаутів, лімітів і вимог немає.

- [Зведення, команди, workspace та результати](summary.json).
- [Повний первинний red](red.stdout.json): runId 21c5af20-50f9-4079-9e52-50f8350eef00, три assertion-падіння: ENOENT та worker exit 1; CLI 1, child 1, cleanup complete, timeoutCount 0.
- [Повне hotfix-підтвердження](hotfix.stdout.json): runId f2f1f2f2-88d8-429a-bba8-aecd31024c63, 3 passed; CLI 0, child 0, cleanup complete. knownRed/unexecuted/unknown порожні, groupState/nextAction complete.
- [SHA, зміни та hashes перед hotfix](hotfix.workspace.txt). TestRunResult містить фактичні selection, ізольований QA HOME та команду runner. Стабільна група fix-raf-owned-process-publish-race/unit і QA HOME збережені між red та hotfix.

Повні stderr, CLI-коди та відповіді інструмента збережені окремо для обох прогонів. Попередження про unit inventory не завадило явному відбору нового файла; відбір виконався повністю.

Регресія ізольована: виконує продуктовий publisher із production-runtime.ts у VM з детермінованим асинхронним файловим портом і окремим Node worker з strict unhandled rejections. Це unit-доказ; реальний agy після релізу повторює main.
