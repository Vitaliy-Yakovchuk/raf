# Межі D01–D09

Це адресна карта перевірки, не заміна виконання. Файл `test/test-run-etchly-integration.test.ts` містить unit-контракти нижче. Перший спостережений unit passed мав урізаний capture; дозволений повтор збережено повністю, але він setup-failed до spawn. Тому жоден рядок нижче не оголошує підтвердженого unit-green.

| ID | Адреса автоматичного контракту | Живий доказ у цьому запуску |
|---|---|---|
| D01 | test/test-run-etchly-integration.test.ts:38 — adapter/exactIds, Node integration і legacy unit | Не підтверджено; окремі same-change регресії ще не виконані |
| D02 | :65, :71, :75, :251, :273 — класифікація, stale paths, import drift, missing inventory | Лише read-only context/source hashes; поведінковий результат відсутній |
| D03 | :80, :90, :96, :103, :107 — preset/exact files, відмови та argv | Host3 preset реально запустив рівно три файли з root-relative IDs та bridge/batch argv; 4 passed, 1 knownRed, 2 unexecuted. Exact-files та негативні відбори не досягнуті |
| D04 | :107, :121, :126 — integration budget і збереження deadline | Host4 D08: testKind=integration, callerPhase=qa, timeoutPolicy conf/flow.json integration timeout 60000; deadlines завершилися за 60 s без unit fallback. Продовження збереження deadline/recovery ще очікується |
| D05 | :140, :145, :149, :152 — ізоляція, залежності, credentials/build guard | Host2 відтворив setup-failure через відсутній corpus; власну prepare виправлено, host3/4 дійшли до реальних D1 тестів. Missing-build/workerd сценарії не досягнуті; marker містить SHA/dirty/config/build/corpus hashes |
| D06 | :189, :198, :208, :280, :287 — origin, повнота, skip/lost protocol, diagnostics | Host4 підтвердив green/assertions/import/skip з очікуваними CLI/child/result/cleanup; global-setup/hook/zero-tests/lost protocol лишаються unit-контрактами без власного підтвердженого виконання |
| D07 | :166, :171, :176, :180, :184 — own caller і відмови | Immutable assignment project=raf; own etchly authorization не одержано. Host API context синтетичний і цього не доводить |
| D08 | :208, :228, :236, :240, :244 — cleanup/recovery/concurrent | Host4: реальні forks/workerd, green та дві повні deadline-cleanup відповіді; власний observer дефект завадив SIGINT і решті випадків. dd69fee path hypothesis відкликано до live підтвердження; явний per-launch SQL proof path замінює вгадування TMPDIR, same-HOME/group continuation очікується. Це main-executed API-стенд, не broker/caller proof |
| D09 | Не є unit-сценарієм; etchly smoke через довірений канал самого QA | Не виконано: потрібні належне project=etchly доручення й сумісний канал. Main-executed host API smoke не замінює цей критерій |

Не виконані same-change unit-регресії: `add-raf-test-run/etchly-profiles` (`test/test-run-etchly-profiles.test.ts`) і `add-raf-test-run/integration-profiles` (`test/test-run-integration-profiles.test.ts`, `test/test-run-integration-runtime.test.ts`). Для foreign change декларації regressionGroups немає; чужі тести/задачі не виконувалися й не закривалися.

Усі наведені host-докази main виконав у керованому приватному стенді за скриптами цього QA; це явно обмежений інтеграційний API-доказ. Первісні failures і fixture regressions наведені у README.md та host*-result-index.json, повні незмінені файли — у host*/manifest.json. Без повного unit-green та власного D09 весь пункт залишається failed/open.
